"""The agent loop: model call -> tool calls (with approval) -> repeat."""

from __future__ import annotations

import difflib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Optional

from . import knowledge
from .approval import ApprovalPolicy, ApprovalRequest, ApprovalResponse, split_command
from .config import AgentConfig, ThinkingConfig
from .context import ContextManager
from .events import EventBus
from .llm import LLMCancelled, LLMError, LLMProvider, ToolCall, extract_text_tool_calls
from .llm.prompt_dump import set_agent_id
from .llm.server_info import probe_vision
from .tools.base import ToolContext, ToolOutput, ToolRegistry
from .tools.interact import todo_block
from .util import truncate_middle

Approver = Callable[[ApprovalRequest], ApprovalResponse]

# Commands that say nothing about whether the code under work is fixed: they do not reset the failure streak.
NEUTRAL_COMMANDS = {"ls", "cat", "pwd", "echo", "cd", "head", "tail", "grep", "rg", "find", "which", "tree",
                    "wc", "stat", "file", "git", "diff", "sort", "uniq", "mkdir"}

FAILURE_MARKERS = re.compile(
    r"\berror:|fatal error|undefined reference|\*\*\* \[|Segmentation fault|core dumped|\bAborted\b|"
    r"terminate called|AddressSanitizer|runtime error:|Assertion .* failed")

SUSPECT_HINT = (
    "[agent hint] {n} commands in a row failed. STOP trying fixes. In your next reply, write 2-3 suspected causes "
    "(most likely first) based on the code you just wrote, each with its evidence (error text / line) and one cheap "
    "check. Then verify them ONE at a time. Do not change any file before you have listed them."
)
GDB_HINT = (
    "[agent hint] {n} failed attempts in a row - guessing is not working. If the program crashes, hangs or prints "
    "wrong results: build with -g -O0 and call the debug_backtrace tool, then base your next hypothesis on the "
    "backtrace and locals. For compile errors: re-read the FIRST error and the exact lines it points to before "
    "editing again. Revert changes that did not help."
)


def _command_failed(ok: bool, text: str) -> bool:
    m = re.match(r"exit code: (-?\d+)", text)
    return (not ok) or bool(m and m.group(1) != "0")


@dataclass
class AgentResult:
    status: str  # done | cancelled | error | max_steps | loop
    final_text: str = ""
    steps: int = 0
    error: str = ""


class _ThinkLimit(Exception):
    pass


class _Steered(Exception):
    """A user steer arrived while the model was streaming; the stream is aborted."""


class Agent:
    def __init__(
        self,
        agent_id: str,
        provider: LLMProvider,
        registry: ToolRegistry,
        tool_ctx: ToolContext,
        policy: ApprovalPolicy,
        approver: Optional[Approver],
        ctx_mgr: ContextManager,
        bus: EventBus,
        cfg: AgentConfig,
        thinking_cfg: ThinkingConfig,
        cancel: threading.Event,
        steer: Optional[threading.Event] = None,
        steer_prompt: Optional[Callable[[], str]] = None,
    ) -> None:
        self.id = agent_id
        set_agent_id(agent_id)  # labelled in prompt dumps (thread-local)
        self.provider = provider
        self.registry = registry
        self.tool_ctx = tool_ctx
        self.policy = policy
        self.approver = approver
        self.ctx_mgr = ctx_mgr
        self.bus = bus
        self.cfg = cfg
        self.thinking_cfg = thinking_cfg
        self.cancel = cancel
        # Steer: the user sends a new message while this run is in flight. The
        # stream is aborted (if streaming) and the message is injected as a
        # user message at the top of the next step.
        self.steer = steer
        self._steer_prompt = steer_prompt
        self.ran_commands = False
        self._fail_streak = 0  # consecutive failing build/run commands
        self._injected: set[str] = set()  # skills already injected during this run
        self._touched: list[str] = []  # file paths read/written this turn (re-injected after compression)
        self._tools = registry.schemas()

    # -------------------------------------------------------------- events
    def _emit(self, kind: str, **data) -> None:
        self.bus.emit(kind, self.id, **data)

    # ----------------------------------------------------------- compaction
    def _summarize(self, msgs: list[dict]) -> str:
        self._emit("status", state="waiting_model", detail="summarising old context")
        return self.provider.complete(msgs, self.cancel, thinking=False, max_tokens=1500)

    def _maybe_compress(self, messages: list[dict], on_compact) -> None:
        tokens = self.ctx_mgr.tokens(messages, self._tools)
        self._emit("context_usage", tokens=tokens, max_tokens=self.ctx_mgr.cfg.max_tokens,
                   ratio=tokens / max(1, self.ctx_mgr.cfg.max_tokens), exact=False)
        if not self.ctx_mgr.needs_compression(messages, self._tools):
            return
        self._emit("status", state="waiting_model", detail="compressing context")
        new, info = self.ctx_mgr.compress(messages, self._tools, self._summarize)
        messages[:] = new
        # the read cache is now stale: the cached content was summarised away,
        # so a repeat read must return the full content again, not the stub
        self.tool_ctx.turn_cache.clear()
        # re-inject the working state the summary cannot carry: the todo list
        # (also shown every step) and the files touched this turn, so the model
        # knows what to re-read instead of guessing
        note = ["[Context was compressed. Current state:]"]
        todo = todo_block(self.tool_ctx.todos)
        if todo:
            note.append(todo)
        if self._touched:
            recent = list(dict.fromkeys(self._touched))[-10:]
            note.append("Files read/modified in this session (re-read what you need): " + ", ".join(recent))
        messages.append({"role": "user", "content": "\n".join(note)})
        if on_compact:
            on_compact(list(new))
        self._emit("context_compressed", before=info.before, after=info.after, algorithm=info.algorithm)
        self._emit("context_usage", tokens=info.after, max_tokens=self.ctx_mgr.cfg.max_tokens,
                   ratio=info.after / max(1, self.ctx_mgr.cfg.max_tokens), exact=False)

    # ------------------------------------------------------------ model call
    def _call_llm(self, messages: list[dict], thinking: Optional[bool]):
        content: list[str] = []
        think_chars = 0
        calls: list[ToolCall] = []
        finish = None
        usage = None
        start = time.time()
        ttft = None
        limit = self.thinking_cfg.max_think_chars if thinking is not False else 0
        for ch in self.provider.stream_chat(messages, self._tools, self.cancel, thinking, steer=self.steer):
            if ttft is None and ch.kind in ("thinking", "content", "tool_calls"):
                ttft = time.time() - start
            if ch.kind == "thinking":
                think_chars += len(ch.text)
                self._emit("thinking_delta", text=ch.text)
                if limit and think_chars > limit and not content:
                    raise _ThinkLimit()
            elif ch.kind == "content":
                content.append(ch.text)
                self._emit("content_delta", text=ch.text)
            elif ch.kind == "tool_calls":
                calls = ch.tool_calls or []
            elif ch.kind == "usage":
                usage = ch.usage
            elif ch.kind == "done":
                finish = ch.finish_reason
            elif ch.kind == "status":
                self._emit("warning", text=ch.text)
        return "".join(content), calls, finish, usage, time.time() - start, ttft

    # ------------------------------------------------------------- tool exec
    def _run_tool(self, tc: ToolCall) -> tuple[str, list[dict]]:
        """Run one tool call. Returns ``(text, images)``; images are data-url dicts the
        caller injects into the conversation (a vision model must see them)."""
        try:
            args = json.loads(tc.arguments) if tc.arguments.strip() else {}
            if not isinstance(args, dict):
                raise ValueError("arguments must be a JSON object")
        except (json.JSONDecodeError, ValueError) as e:
            self._emit("tool_call", name=tc.name, args={"raw": tc.arguments}, id=tc.id)
            self._emit("tool_result", name=tc.name, ok=False, text=f"bad arguments: {e}", id=tc.id)
            return f"ERROR: arguments are not valid JSON ({e}). Send a JSON object matching the tool schema.", []

        self._emit("tool_call", name=tc.name, args=args, id=tc.id)
        tool = self.registry.get(tc.name)
        if tool is None:
            text = f"ERROR: unknown tool '{tc.name}'. Available: {', '.join(self.registry.names())}"
            self._emit("tool_result", name=tc.name, ok=False, text=text, id=tc.id)
            return text, []

        denied = self._authorise(tool, args)
        if denied is not None:
            self._emit("tool_result", name=tc.name, ok=False, text=denied, id=tc.id)
            return denied, []

        if tool.kind == "exec":
            self.ran_commands = True
        if tool.name in ("read_file", "write_file", "apply_patch") and args.get("path"):
            self._touched.append(str(args["path"]))
        self._emit("status", state="running_tool", detail=tc.name)
        ok, out = self.registry.execute(tc.name, args, self.tool_ctx)
        text = self._after_tool(tool, args, ok, out.text)
        self._emit("tool_result", name=tc.name, ok=ok, text=text, id=tc.id)
        return text, (out.images if ok else [])

    def _images_supported(self) -> bool:
        server = getattr(self.provider, "server", None)
        return server is None or probe_vision(server) is not False

    def _after_tool(self, tool, args: dict, ok: bool, text: str) -> str:
        """Discipline for debugging: skill injection on failures and a nudge when commands keep failing."""
        if tool.name == "debug_backtrace":
            self._fail_streak = 0  # the model escalated to the debugger: start counting afresh
            return text
        if tool.name != "run_command":
            return text
        segs, _ = split_command(args.get("command", ""))
        neutral = all((s.split() or [""])[0] in NEUTRAL_COMMANDS for s in segs)
        # `... | tail` or `; echo $?` hide the exit status, so real failure markers in the output count too
        failed = _command_failed(ok, text) or (not neutral and bool(FAILURE_MARKERS.search(text)))
        if not failed:
            if not neutral:
                self._fail_streak = 0
            return text

        self._fail_streak += 1
        n, extra = self._fail_streak, []
        if self.cfg.auto_skills:
            for s in knowledge.matching_skills(self.tool_ctx.root, text, self._injected):
                self._injected.add(s.name)
                extra.append(f"[skill '{s.name}' was loaded because this command failed - follow it]\n"
                             + truncate_middle(s.body, 4500))
                self._emit("warning", text=f"skill '{s.name}' injected after a failed command")
        a, b = self.cfg.failure_hint_after, self.cfg.gdb_hint_after
        if b and n >= b and (n - b) % 2 == 0:
            extra.append(GDB_HINT.format(n=n))
        elif a and n == a:
            extra.append(SUSPECT_HINT.format(n=n))
        if n in (a, b) or (b and n > b and (n - b) % 2 == 0):
            self._emit("warning", text=f"{n} failed commands in a row - nudging the model to list suspects / use the debugger")
        return text + ("\n\n" + "\n\n".join(extra) if extra else "")

    def _authorise(self, tool, args: dict) -> Optional[str]:
        """Return an error text if the call must not run, else None."""
        if tool.kind in ("read", "action"):  # actions (browser clicks, todos, ...) need no approval
            return None
        ctx = self.tool_ctx
        if tool.kind == "network":
            kind = "network"
            subject = tool.target_of(args) if tool.target_of else ""
            decision = self.policy.check_network(subject)
        elif tool.kind == "mcp":
            kind = "mcp"
            subject = tool.name
            decision = self.policy.check_mcp(subject)
        elif tool.kind == "exec":
            kind = "command"
            subject = tool.command_of(args) if tool.command_of else args.get("command", "")
            try:
                cwd = ctx.resolve(args.get("cwd") or ".")
            except Exception as e:  # noqa: BLE001
                return f"ERROR: {e}"
            decision = self.policy.check_command(subject, cwd)
        else:
            kind = "write"
            try:
                subject = ctx.rel(ctx.resolve(args.get("path", "")))
            except Exception as e:  # noqa: BLE001
                return f"ERROR: {e}"
            decision = self.policy.check_write(subject)

        if decision.action == "deny":
            self._emit("approval_resolved", allow=False, auto=True, reason=decision.reason)
            return f"DENIED by policy ({decision.reason}). Do not retry this; choose a different approach."
        if decision.action == "allow":
            self._emit("approval_resolved", allow=True, auto=True, reason=decision.reason)
            return None

        try:
            detail = tool.preview(ctx, args) if tool.preview else json.dumps(args, ensure_ascii=False)
        except Exception as e:  # noqa: BLE001 - e.g. patch does not apply: tell the model directly
            return f"ERROR: {e}"
        req = ApprovalRequest(
            kind=kind,
            tool=tool.name,
            title=subject if kind == "write" else (
                f"Network: {subject}" if kind == "network"
                else f"MCP tool: {subject}" if kind == "mcp" else f"Run command ({decision.reason})"
            ),
            detail=detail,
            args=args,
            suggested_rule=self.policy.suggest_rule(
                kind, {"path": subject} if kind == "write"
                else {"host": subject} if kind == "network"
                else {"name": subject} if kind == "mcp" else {"command": subject}),
        )
        self._emit("status", state="waiting_user", detail=req.title)
        self._emit("approval_requested", request=req)
        resp = self.approver(req) if self.approver else ApprovalResponse(False, "no approver available")
        self._emit("approval_resolved", allow=resp.allow, auto=False, reason=resp.feedback)
        if resp.allow and resp.remember_rule:
            self.policy.remember(kind, resp.remember_rule, resp.remember_scope)
        if not resp.allow:
            fb = f" User feedback: {resp.feedback}" if resp.feedback else ""
            return f"REJECTED by the user.{fb}"
        return None

    # ------------------------------------------------------------------ run
    def run(self, messages: list[dict], on_append=None, on_compact=None) -> AgentResult:
        """Run until the model stops calling tools. ``messages`` (incl. system) is mutated in place."""

        def add(msg: dict) -> None:
            messages.append(msg)
            if on_append:
                on_append(msg)

        seen: dict[str, int] = {}
        seen_at: dict[str, int] = {}  # mutation count when the call was last seen
        strikes = 0
        mutations = 0  # writes/execs since the turn started
        cutoffs = 0
        known = set(self.registry.names())
        final_text = ""
        try:
            for step in range(1, self.cfg.max_steps + 1):
                if self.cancel.is_set():
                    raise LLMCancelled()
                # a steer arrived (stream aborted on the previous step, or queued
                # while a tool was running): inject the user's message and continue
                if self.steer is not None and self.steer.is_set():
                    self.steer.clear()
                    prompt = self._steer_prompt() if self._steer_prompt else ""
                    add({"role": "user", "content": prompt})
                    self._emit("steer_injected", text=prompt)
                self._maybe_compress(messages, on_compact)
                self._emit("status", state="waiting_model", detail=f"step {step}")

                est_raw = self.ctx_mgr.counter.count_raw(messages, self._tools)
                # Ephemeral per-step reminder: the current todo checklist (not persisted,
                # appended at the end where the model attends most).
                todo = todo_block(self.tool_ctx.todos)
                view = (messages + [{"role": "user", "content": todo}]) if todo else messages
                try:
                    try:
                        text, calls, finish, usage, elapsed, ttft = self._call_llm(view, None)
                    except _ThinkLimit:
                        self._emit("warning", text="thinking too long - retrying with thinking disabled")
                        text, calls, finish, usage, elapsed, ttft = self._call_llm(view, False)
                    except LLMCancelled:
                        # the stream was aborted by a steer (cancel is checked at the
                        # top of the step): the steer message is injected next step
                        if self.steer is not None and self.steer.is_set():
                            continue
                        raise
                except LLMError as e:
                    self._emit("error", text=str(e))
                    return AgentResult("error", final_text, step, str(e))

                if usage:
                    self.ctx_mgr.counter.calibrate(est_raw, usage.prompt_tokens)
                self._emit(
                    "llm_done",
                    usage={"prompt": usage.prompt_tokens, "completion": usage.completion_tokens} if usage else {},
                    elapsed=elapsed,
                    ttft=ttft,
                    finish=finish,
                )
                if usage:  # what the server really holds now: prompt + what it just generated
                    used = usage.prompt_tokens + usage.completion_tokens
                    self._emit("context_usage", tokens=used, max_tokens=self.ctx_mgr.cfg.max_tokens,
                               ratio=used / max(1, self.ctx_mgr.cfg.max_tokens), exact=True)

                if not calls and text:
                    text, calls = extract_text_tool_calls(text, known)

                msg: dict = {"role": "assistant", "content": text}
                if calls:
                    msg["tool_calls"] = [
                        {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
                        for c in calls
                    ]
                add(msg)

                if not calls:
                    if finish == "length" and cutoffs < 2:
                        cutoffs += 1
                        self._emit("warning", text="response was cut off (length); asking the model to continue")
                        add({"role": "user", "content": "Your previous reply was cut off. Continue, be brief, and call a tool or give the final answer."})
                        continue
                    final_text = text
                    self._emit("agent_finished", status="done", steps=step)
                    return AgentResult("done", text, step)

                # Split the batch: read-only tools run in parallel (they cannot
                # interfere with each other), everything else runs one by one in
                # the original order. Results are appended in call order.
                def _kind_of(tc: ToolCall) -> str:
                    t = self.registry.get(tc.name)
                    return t.kind if t is not None else "exec"  # unknown tools stay serial

                parallel = [tc for tc in calls if _kind_of(tc) == "read"]
                serial = [tc for tc in calls if tc not in parallel]
                results: dict[str, tuple[str, list[dict]]] = {}
                if len(parallel) > 1:
                    with ThreadPoolExecutor(max_workers=min(8, len(parallel)), thread_name_prefix="tool") as pool:
                        futs = {pool.submit(self._run_tool, tc): tc for tc in parallel}
                        for fut in futs:
                            tc = futs[fut]
                            results[tc.id] = fut.result()
                else:
                    for tc in parallel:  # 0 or 1 read tool: run it inline
                        results[tc.id] = self._run_tool(tc)
                for tc in serial:
                    results[tc.id] = self._run_tool(tc)
                for tc in calls:
                    if self.cancel.is_set():
                        add({"role": "tool", "tool_call_id": tc.id, "content": "Cancelled by the user before running."})
                        continue
                    key = tc.name + "|" + tc.arguments
                    # A write/exec since the previous identical call means the agent changed
                    # something (e.g. re-running the same test after an edit): that is a
                    # debug iteration, not a loop - reset the counter for this call.
                    prev_mut = seen_at.get(key, mutations)
                    if key in seen_at and seen_at[key] != mutations:
                        seen[key] = 0
                    seen[key] = seen.get(key, 0) + 1
                    seen_at[key] = mutations
                    # A loop is the same exact call repeated beyond the limit with
                    # NOTHING changed in between. Re-running a command after an edit
                    # (or with slightly different args) is iteration, not a loop.
                    dup = seen[key] > self.cfg.loop_limit and prev_mut == mutations
                    if dup:
                        strikes += 1
                        result = (
                            "ERROR: you already made this call (or a nearly identical one) several times with "
                            "the same result. Stop repeating it: try a different approach or finish with what you have."
                        )
                        self._emit("warning", text=f"repeated call to {tc.name}")
                        images = []
                    else:
                        result, images = results[tc.id]
                        t = self.registry.get(tc.name)
                        if t is not None and t.kind in ("write", "exec"):
                            mutations += 1
                    if images and not self._images_supported():
                        result += "\n[image omitted: the configured model is text-only]"
                        images = []
                    add({"role": "tool", "tool_call_id": tc.id, "content": result})
                    if images:
                        # a tool produced a picture (e.g. browser_take_screenshot): hand it to the
                        # model as a user message with image parts - tool-role messages
                        # cannot carry images in the OpenAI wire format
                        add({"role": "user", "content": [
                            {"type": "text", "text": f"[result of {tc.name}: see the attached image]"},
                            *[{"type": "image_url", "image_url": {"url": im["data_url"]}} for im in images],
                        ]})
                if strikes >= self.cfg.loop_strikes:
                    self._emit("agent_finished", status="loop", steps=step)
                    return AgentResult("loop", final_text, step, "agent kept repeating the same calls")

            self._emit("agent_finished", status="max_steps", steps=self.cfg.max_steps)
            return AgentResult("max_steps", final_text, self.cfg.max_steps)
        except LLMCancelled:
            self._emit("agent_finished", status="cancelled", steps=0)
            return AgentResult("cancelled", final_text, 0)
