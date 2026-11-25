"""Engine: the facade used by GUI / CLI. Owns session, policy, provider creation and one agent run per turn."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable, Optional

from .agent import Agent, AgentResult, Approver
from .approval import ApprovalPolicy
from .config import AppConfig
from .context import ContextManager
from .events import EventBus
from .llm import LLMError, LLMProvider, create_provider
from .orchestrator import Orchestrator, Plan, PlanError, PlanResult, Planner, StageConfirm
from .prompts import PromptBuilder, PromptSections, TaskTypeRegistry
from .session import Session, Turn
from .tools import ToolContext, ToolRegistry, default_registry
from .tools.mcp_client import McpHub, load_servers


def _serialised(approver: Optional[Approver]) -> Optional[Approver]:
    """Parallel sub-agents may need approval at the same time; ask the user one question at a time."""
    if approver is None:
        return None
    lock = threading.Lock()

    def ask(req):
        with lock:
            return approver(req)

    return ask


class Engine:
    def __init__(
        self,
        config: AppConfig,
        project_root: Path,
        bus: Optional[EventBus] = None,
        approver: Optional[Approver] = None,
        session: Optional[Session] = None,
        provider: Optional[LLMProvider] = None,  # injectable for tests
    ) -> None:
        self.config = config
        self.root = Path(project_root).resolve()
        self.bus = bus or EventBus()
        self.approver = _serialised(approver)
        self.session = session or Session(self.root)
        self._provider_override = provider
        self.policy = ApprovalPolicy.load(self.root)
        self.task_types = TaskTypeRegistry.load(self.root, config.paths.prompt_dirs)
        self.sections = PromptSections()
        self.ctx_mgr = ContextManager(config.context)
        self.registry: ToolRegistry = default_registry()
        self.mcp = McpHub(load_servers(self.root, self.policy.data),
                         readonly_hint=(self.policy.data.get("mcp") or {}).get("readonly_hint", True))
        self.mcp_tool_names: list[str] = []
        for t in self.mcp.start():
            self.registry.register(t)
            self.mcp_tool_names.append(t.name)
        self.asker: Optional[Callable[[dict], Optional[dict]]] = None  # set by the server: asks the user a question
        from .hooks import HookRunner
        self.hooks = HookRunner(self.root)
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()
        from .tools.shell import ShellManager  # persistent shell sessions + background jobs
        self._shell_manager = ShellManager(self.root)
        # Steer: the user sends a new message while a turn is running. The agent
        # loop picks it up at the next safe point (top of step) and continues.
        self._steer_event = threading.Event()
        self._steer_prompt: str = ""

    # ------------------------------------------------------------- settings
    def close(self) -> None:
        self.mcp.close()
        # persistent shell sessions and their background jobs die with the engine
        try:
            if self._shell_manager is not None:
                self._shell_manager.close()
        except Exception:  # noqa: BLE001 - best effort during shutdown
            pass

    def _config_for(self, effort: Optional[str]) -> AppConfig:
        """The config for one turn: an explicit ``effort`` (GUI selector) overrides the saved setting."""
        if not effort:
            return self.config
        thinking = self.config.thinking.model_copy(update={"effort": effort})
        return self.config.model_copy(update={"thinking": thinking})

    def apply_config(self, config: AppConfig) -> None:
        """Call between runs after the user edited settings."""
        self.config = config
        self.ctx_mgr = ContextManager(config.context, self.ctx_mgr.counter)
        self.task_types = TaskTypeRegistry.load(self.root, config.paths.prompt_dirs)

    def reload_policy(self) -> None:
        self.policy.reload()

    def cancel(self) -> None:
        self.cancel_event.set()

    def _mark_ran_commands(self) -> None:
        """A sub-agent ran shell commands: the current turn has side effects (no rollback)."""
        path = self.session.path()
        if path:
            path[-1].ran_commands = True

    def steer(self, prompt: str) -> None:
        """Queue a user message for the running turn (the GUI's "send while running").

        The agent loop injects it at the next safe point: immediately if the
        model is not streaming (a tool is running / it is between steps), or as
        soon as the current stream is aborted (a command is running: the model
        is not mid-stream, the steer is picked up at the top of the next step).
        Raises RuntimeError if no turn is running."""
        if not self._lock.locked():
            raise RuntimeError("no turn is running")
        self._steer_prompt = prompt
        self._steer_event.set()

    # ----------------------------------------------------------------- run
    def submit(
        self,
        prompt: str,
        task_type: Optional[str] = None,
        images: Optional[list[dict]] = None,
        effort: Optional[str] = None,
        plan: bool = False,
    ) -> AgentResult:
        """Run one user turn to completion (blocking - call from a worker thread).

        ``images``: [{"name": str, "data_url": "data:image/..."}] sent to the model
        as image_url parts of the user message (needs a vision-capable model).
        ``effort``: thinking effort for this turn (GUI selector); overrides the
        saved setting when given.
        ``plan``: plan mode - the agent explores with read-only tools and must
        call exit_plan_mode (user approval) before it may write anything."""
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("a turn is already running")
        turn: Optional[Turn] = None
        try:
            self.cancel_event.clear()
            self._steer_event.clear()
            self._steer_prompt = ""
            tt = self.task_types.get(task_type or self.task_types.detect(prompt))
            turn = self.session.new_turn(prompt, tt.name, images)
            self.session.save()
            self.bus.emit("turn_started", turn_id=turn.id, task_type=tt.name, prompt=prompt, images=turn.images)

            # effort for this turn: GUI selector > task type suggestion > saved setting
            turn_effort = effort or tt.effort
            cfg = self._config_for(turn_effort)
            provider = self._provider_override or create_provider(cfg)
            registry = self.registry.subset([*tt.tools, *self.mcp_tool_names]) if tt.tools else self.registry
            # carry the checklist over from the previous turn so it survives across turns
            prev = self.session.path()
            prev_todos = prev[-2].todos if len(prev) >= 2 else []
            tool_ctx = ToolContext(
                root=self.root,
                cancel=self.cancel_event,
                emit=lambda kind, data: self.bus.emit(kind, "main", **data),
                snapshots=self.session.snapshots,
                shell=self._shell_manager,
                max_output_chars=self.config.context.tool_output_max_chars,
                extra_roots=self.policy.extra_roots,
                ask_user=self.asker,
                todos=list(prev_todos),
                engine=self,
                hooks=self.hooks,
            )
            self.hooks.run("session_start", status="turn_start")
            # plan mode: explore with read-only tools; exit_plan_mode (user approval)
            # swaps in the full registry mid-run
            if plan:
                registry = registry.readonly()
                tool_ctx.todos = []
            agent = Agent(
                "main", provider, registry, tool_ctx, self.policy, self.approver,
                self.ctx_mgr, self.bus, self.config.agent, self.config.thinking, self.cancel_event,
                steer=self._steer_event, steer_prompt=lambda: self._steer_prompt,
                plan_mode=plan,
            )
            tool_ctx.agent = agent
            system = PromptBuilder(self.root, self.task_types, self.sections).build(tt)
            if plan:
                system += (
                    "\n\n# PLAN MODE (this turn)\n"
                    "You are in plan mode: you can ONLY read/explore (files, search, web). "
                    "You cannot write files, run commands or use git. Explore the codebase thoroughly, "
                    "then call exit_plan_mode with a concrete plan as markdown (bullet steps, naming the "
                    "files to touch). The user must approve it; only after approval do you get write access. "
                    "If the user rejects the plan, revise it and call exit_plan_mode again."
                )
            messages = [{"role": "system", "content": system}, *self.session.build_messages()]

            def on_append(msg: dict) -> None:
                turn.messages.append(msg)

            def on_compact(new_full: list[dict]) -> None:
                turn.archive.extend(turn.messages)
                turn.messages = []
                turn.base_messages = [m for m in new_full if m.get("role") != "system"]

            # The user message is already in turn.messages and in `messages`.
            result = agent.run(messages, on_append=on_append, on_compact=on_compact)
            turn.ran_commands = agent.ran_commands
            turn.todos = list(tool_ctx.todos)
            turn.usage = result.usage
            self.session.finish_turn(turn, result.status, result.final_text)
            self.hooks.run("turn_end", status=result.status)
            self.bus.emit("turn_finished", turn_id=turn.id, status=result.status, error=result.error, usage=result.usage)
            self.bus.emit("status", state="idle", detail="")
            if self.config.agent.memory_extraction and result.status == "done":
                # background: extraction must not hold the turn lock
                threading.Thread(
                    target=self._extract_memory, args=(provider, prompt, result.final_text),
                    daemon=True, name="memory-extract",
                ).start()
            return result
        finally:
            self._lock.release()

    def _extract_memory(self, provider: LLMProvider, prompt: str, final_text: str) -> None:
        """Best-effort: persist durable facts from this turn (never breaks the turn)."""
        from .knowledge import extract_memory
        saved = extract_memory(provider, self.root, prompt, final_text)
        if saved:
            self.bus.emit("memory_saved", notes=saved)

    def compact(self, hint: str = "") -> dict:
        """User-triggered compaction (the GUI's ``/compact`` command).

        Summarises the whole conversation along the active path into a structured
        summary and stores it as the new base history. Returns the token counts
        before/after. Blocked while a turn is running (the lock is held)."""
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("a turn is running - cannot compact now")
        try:
            msgs = self.session.build_messages()
            if len(msgs) < 4:
                return {"ok": False, "reason": "conversation too short to compact"}
            provider = self._provider_override or create_provider(self.config)

            def summarize(m: list[dict]) -> str:
                return provider.complete(m, self.cancel_event, thinking=False, max_tokens=2500)

            before = self.ctx_mgr.tokens(msgs)
            new, info = self.ctx_mgr.compress(msgs, None, summarize)
            # store as the base history of a synthetic "compaction" turn so the
            # next turn starts from the summary; the old messages are archived
            path = self.session.path()
            if path:
                head = path[-1]
                head.archive.extend(head.messages)
                head.messages = []
                head.base_messages = [m for m in new if m.get("role") != "system"]
            else:
                self.session.save()
            self.session.save()
            self.bus.emit("context_compressed", before=info.before, after=info.after, algorithm=info.algorithm, manual=True)
            return {"ok": True, "before": before, "after": info.after, "algorithm": info.algorithm}
        finally:
            self._lock.release()

    # ------------------------------------------------------ plan (subtasks)
    def submit_plan(
        self,
        goal: str,
        confirm_plan: Optional[Callable[[Plan], Optional[Plan]]] = None,
        confirm_stage: Optional[StageConfirm] = None,
        plan: Optional[Plan] = None,
    ) -> PlanResult | None:
        """Split ``goal`` into subtasks, let the user review the plan, run it stage by stage.

        Pass ``plan`` to skip the planner (e.g. a saved or hand-written plan).
        Blocking. Returns ``None`` if planning failed or the user rejected the plan."""
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("a turn is already running")
        try:
            self.cancel_event.clear()
            turn = self.session.new_turn(goal, "plan")
            self.session.save()
            self.bus.emit("turn_started", turn_id=turn.id, task_type="plan", prompt=goal)
            provider = self._provider_override or create_provider(self.config)
            status, text, result = "error", "", None
            try:
                self.bus.emit("status", "planner", state="waiting_model", detail="planning")
                if plan is None:
                    plan = Planner(
                        provider, self.root, self.task_types, self.config.orchestrator.max_subtasks,
                        self.config.orchestrator.planner_thinking, self.cancel_event,
                    ).make_plan(goal)
                else:
                    plan.validate()
                self.bus.emit("plan_created", "planner", plan=plan.to_dict())
                if confirm_plan:
                    self.bus.emit("status", "planner", state="waiting_user", detail="review the plan")
                    plan = confirm_plan(plan)
                if plan is None:
                    status, text = "cancelled", "Plan rejected by the user."
                else:
                    result = Orchestrator(self, provider, turn).run(plan, confirm_stage)
                    status, text = result.status, result.summary
                    turn.ran_commands = result.ran_commands
                    turn.subtasks = [
                        {"id": s.id, "title": s.title, "status": s.status, "summary": s.summary}
                        for s in plan.subtasks
                    ]
            except (PlanError, LLMError) as e:
                text = f"Planning failed: {e}"
                self.bus.emit("error", "planner", text=text)
            turn.messages.append({"role": "assistant", "content": text})
            self.session.finish_turn(turn, status, text)
            self.bus.emit("turn_finished", turn_id=turn.id, status=status, error="")
            self.bus.emit("status", state="idle", detail="")
            return result
        finally:
            self._lock.release()

    # ------------------------------------------------------ rewind / edit
    def rewind(self, turn_id: str, keep_branch: bool = False) -> tuple[list[str], bool]:
        """Undo ``turn_id`` and later turns. Returns (restored_files, has_unrevertable_commands)."""
        if self._lock.locked():
            raise RuntimeError("cannot rewind while a turn is running")
        side = self.session.side_effects_after(turn_id)
        restored = self.session.rewind(turn_id, keep_branch)
        self.bus.emit("session_rewound", turn_id=turn_id, restored=restored)
        return restored, side

    def edit_and_resubmit(self, turn_id: str, new_prompt: str, task_type: Optional[str] = None,
                          keep_branch: bool = False) -> AgentResult:
        self.rewind(turn_id, keep_branch)
        return self.submit(new_prompt, task_type)

    @property
    def active_turns(self) -> list[Turn]:
        return self.session.path()
