"""spawn_agent: the model can delegate a bounded sub-task to a fresh sub-agent.

``explore``: read-only tools (read/action/network) - research the codebase or the
web without touching anything; only its final summary enters the main context.
``general``: the full tool set with a step limit (write/exec tools still go through
the normal approval policy). The sub-agent's tool set never contains ``spawn_agent``
itself (no recursion).
"""

from __future__ import annotations

from ..context import ContextManager
from ..llm import create_provider
from .base import Tool, ToolContext, ToolOutput

MAX_STEPS_EXPLORE = 20
MAX_STEPS_GENERAL = 40

_EXPLORE_SYSTEM = (
    "You are a read-only exploration sub-agent. You can read files, search, run the "
    "browser/web tools, but you CANNOT modify anything (no writes, no commands, no git). "
    "Research the question thoroughly, then reply with a concise summary (max ~300 words): "
    "the key findings, exact file paths and line numbers, and what the main agent should "
    "do next. Do not pad; cite paths for every claim."
)

_GENERAL_SYSTEM = (
    "You are a sub-agent with a bounded step budget. Complete the given task using the "
    "available tools. When done, reply with a concise summary: what you changed (files), "
    "how you verified it, and anything the main agent must know. If you cannot finish, "
    "say exactly why."
)


def _spawn(ctx: ToolContext, args: dict) -> ToolOutput:
    task = str(args.get("task", "")).strip()
    agent_type = str(args.get("agent_type", "explore"))
    if not task:
        return ToolOutput("ERROR: 'task' is required")
    if agent_type not in ("explore", "general"):
        return ToolOutput("ERROR: agent_type must be 'explore' or 'general'")

    from ..agent import Agent  # local import: agent imports knowledge -> tools (circular)

    parent = getattr(ctx, "engine", None)
    if parent is None:
        return ToolOutput("ERROR: spawn_agent is unavailable in this context")

    # build an isolated sub-agent: fresh context, its own ToolContext, no spawn_agent
    if agent_type == "explore":
        registry = parent.registry.readonly()
        system = _EXPLORE_SYSTEM
        max_steps = MAX_STEPS_EXPLORE
    else:
        registry = parent.registry
        system = _GENERAL_SYSTEM
        max_steps = MAX_STEPS_GENERAL
    if "spawn_agent" in registry.names():
        registry.unregister("spawn_agent")

    aid = f"sub:{agent_type}"
    tool_ctx = ToolContext(
        root=parent.root,
        cancel=parent.cancel_event,
        emit=lambda kind, data, _aid=aid: parent.bus.emit(kind, _aid, **data),
        snapshots=parent.session.snapshots,
        agent_id=aid,
        max_output_chars=parent.config.context.tool_output_max_chars,
        extra_roots=parent.policy.extra_roots,
        ask_user=parent.asker,
    )
    provider = parent._provider_override or create_provider(parent.config)
    from ..config import AgentConfig

    cfg = parent.config.agent.model_copy(update={"max_steps": max_steps, "loop_strikes": 3})
    agent = Agent(
        aid, provider, registry, tool_ctx, parent.policy, parent.approver,
        ContextManager(parent.config.context, parent.ctx_mgr.counter), parent.bus,
        cfg, parent.config.thinking, parent.cancel_event,
    )
    parent.bus.emit("status", state="running", detail=f"sub-agent ({agent_type}) started")
    try:
        res = agent.run([
            {"role": "system", "content": system},
            {"role": "user", "content": task},
        ])
    finally:
        parent.bus.emit("status", state="running", detail="")
    text = res.final_text or res.error or f"({res.status})"
    if res.status == "cancelled":
        return ToolOutput("[sub-agent was cancelled]")
    if res.status != "done":
        text = f"[sub-agent stopped: {res.status}] {text}"
    if agent.ran_commands:
        parent._mark_ran_commands()
    return ToolOutput(f"[{agent_type} sub-agent, {res.steps} steps]\n{text}")


def spawn_agent_tool() -> Tool:
    return Tool(
        name="spawn_agent",
        description=(
            "Delegate a bounded sub-task to a fresh sub-agent with its own context. "
            "agent_type='explore' (default): read-only research (files/search/web), "
            "returns a summary - use it to investigate without polluting your context. "
            "agent_type='general': full tool set with a step limit (writes are still "
            "subject to approval). The sub-agent cannot spawn further sub-agents."
        ),
        parameters={
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "the self-contained task for the sub-agent"},
                "agent_type": {"type": "string", "description": "'explore' (read-only) or 'general' (full tools, step-limited)"},
            },
            "required": ["task"],
        },
        func=_spawn,
        kind="action",  # long-running: must run serially, never in the parallel read pool
    )
