"""ask_user (question to the user) and update_todo (the model's task checklist)."""

from __future__ import annotations

from typing import Optional

from .base import Tool, ToolContext, ToolError

MAX_OPTIONS = 8
MAX_TODOS = 20
MAX_TODO_CHARS = 300
_TODO_STATUSES = ("pending", "in_progress", "done")


def _todos(raw: object) -> list[dict]:
    out: list[dict] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            content, status = item, "pending"
        elif isinstance(item, dict):
            content = str(item.get("content", "")).strip()
            status = str(item.get("status", "pending")).strip()
        else:
            continue
        if not content:
            continue
        if status not in _TODO_STATUSES:
            status = "pending"
        out.append({"content": content[:MAX_TODO_CHARS], "status": status})
    return out[:MAX_TODOS]


def _todo_block(todos: list[dict]) -> str:
    marks = {"pending": "[ ]", "in_progress": "[~]", "done": "[x]"}
    return "\n".join(f"{marks[t['status']]} {t['content']}" for t in todos)


def update_todo(ctx: ToolContext, a: dict) -> str:
    todos = _todos(a.get("todos"))
    if not todos:
        raise ToolError("todos is empty; give at least one item, e.g. [{content: 'fix the bug', status: 'in_progress'}]")
    ctx.todos = todos
    ctx.emit("todo_updated", {"todos": todos})
    done = sum(1 for t in todos if t["status"] == "done")
    extra = ""
    if done == len(todos):
        extra = " All items are done - give the final answer now."
    return f"Todo list updated ({done}/{len(todos)} done):\n{_todo_block(todos)}{extra}"


def todo_block(todos: Optional[list[dict]]) -> str:
    """The reminder injected into the agent loop while a checklist is active."""
    if not todos:
        return ""
    open_ = [t for t in todos if t["status"] != "done"]
    head = (
        "# Current todo list (keep it up to date with update_todo; work on the in_progress item)\n"
        + _todo_block(todos)
    )
    if not open_:
        head += "\nAll todos are done - finish with the final answer."
    return head


def _options(raw: object) -> list[dict]:
    out: list[dict] = []
    for item in raw if isinstance(raw, list) else []:
        if isinstance(item, str):
            label, desc = item, ""
        elif isinstance(item, dict):
            label, desc = str(item.get("label", "")), str(item.get("description", ""))
        else:
            continue
        if label.strip():
            out.append({"label": label.strip(), "description": desc.strip()})
    return out[:MAX_OPTIONS]


def ask_user(ctx: ToolContext, a: dict) -> str:
    if ctx.ask_user is None:
        raise ToolError("no user is available to answer; make a reasonable assumption and say so")
    question = str(a["question"]).strip()
    if not question:
        raise ToolError("question is empty")
    options = _options(a.get("options"))
    allow_freeform = bool(a.get("allow_freeform", True)) or not options
    resp = ctx.ask_user({
        "header": str(a.get("header", "")).strip()[:60],
        "question": question,
        "options": options,
        "allow_freeform": allow_freeform,
    })
    if not resp or resp.get("dismissed") or not str(resp.get("answer", "")).strip():
        return ("The user dismissed the question without answering. Continue with a reasonable assumption "
                "or finish and state what you still need.")
    kind = "typed their own answer" if resp.get("custom") else "chose"
    return f"The user {kind}: {str(resp['answer']).strip()}"


def _plan_todos(markdown: str) -> list[dict]:
    """Turn a plan's bullet/numbered lines into a todo checklist."""
    out: list[dict] = []
    for line in markdown.splitlines():
        s = line.strip()
        if s[:2] in ("- ", "* ") or (len(s) > 2 and s[0].isdigit() and s[1] in ".)"):
            content = s.lstrip("-*0123456789. )").strip()
            if content:
                out.append({"content": content[:MAX_TODO_CHARS], "status": "pending"})
        if len(out) >= MAX_TODOS:
            break
    return out


def exit_plan_mode(ctx: ToolContext, a: dict) -> str:
    """Plan mode: present the plan to the user; on approval switch to the full tool set."""
    running = getattr(ctx, "agent", None)  # the running Agent (set by the Engine)
    if running is None or not getattr(running, "plan_mode", False):
        raise ToolError("not in plan mode - you already have the full tool set, just do the work")
    plan = str(a.get("plan_markdown", "")).strip()
    if not plan:
        raise ToolError("plan_markdown is empty")
    req = {
        "header": "Plan approval",
        "question": "Approve this plan and switch to execution mode?",
        "options": [{"label": "Approve - start executing", "description": "the plan becomes your todo list"},
                    {"label": "Reject - keep exploring", "description": "tell the model what to change"}],
        "allow_freeform": True,
    }
    if ctx.ask_user is None:
        raise ToolError("no user is available to approve the plan")
    resp = ctx.ask_user(req)
    approved = resp and not resp.get("dismissed") and "approve" in str(resp.get("answer", "")).lower()
    if not approved:
        extra = f" User feedback: {resp.get('answer', '')}" if resp and resp.get("answer") else ""
        return f"The user did NOT approve the plan. Revise it and call exit_plan_mode again.{extra}"
    todos = _plan_todos(plan)
    if todos:
        ctx.todos = todos
        ctx.emit("todo_updated", {"todos": todos})
    running.plan_mode = False
    full = getattr(ctx, "engine", None)
    full = getattr(full, "registry", None) if full is not None else None
    if full is not None:
        running.registry = full
        running._tools = full.schemas()
        known = getattr(running, "_known_tools", None)
        if known is not None:
            known.clear()
            known.update(full.names())
    ctx.emit("plan_approved", {"plan": plan})
    return "Plan APPROVED. You now have the full tool set. Work through the plan (it is your todo list); " \
           "update statuses as you go."


def interact_tools() -> list[Tool]:
    return [
        Tool(
            name="update_todo",
            description=(
                "Maintain your task checklist for multi-step work. Call it at the start of a non-trivial task "
                "with the planned steps, then update statuses as you go (pending -> in_progress -> done). "
                "Keep at most one item in_progress. The current list is shown to you every step."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "the full checklist (replaces the previous one)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {"type": "string", "description": "the step, imperative, <= 80 chars"},
                                "status": {"type": "string", "enum": list(_TODO_STATUSES)},
                            },
                            "required": ["content"],
                        },
                    },
                },
                "required": ["todos"],
            },
            func=update_todo,
            kind="action",  # mutates the checklist: must run serially, in call order
        ),
        Tool(
            name="ask_user",
            description=(
                "Ask the user a question and wait for the reply. Use it when a decision is theirs to make or "
                "required information is missing and cannot be found in the project; do not ask what you can "
                "check yourself. Give 2-4 short options when the answers are predictable."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "the question to show"},
                    "header": {"type": "string", "description": "short title, e.g. 'Build type'"},
                    "options": {
                        "type": "array",
                        "description": "choices; each is a string or {label, description}",
                        "items": {"type": ["string", "object"]},
                    },
                    "allow_freeform": {"type": "boolean", "description": "let the user type their own answer (default true)"},
                },
                "required": ["question"],
            },
            func=ask_user,
            kind="action",  # blocks on the user: must never run in parallel
        ),
        Tool(
            name="exit_plan_mode",
            description=(
                "PLAN MODE ONLY: you are exploring read-only. When you have a concrete plan, call this "
                "with the full plan as markdown (bullet steps with the files to touch). The user must "
                "approve it; on approval you get the full tool set and the plan becomes your todo list. "
                "Do not call it until the plan is ready to execute."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "plan_markdown": {"type": "string", "description": "the plan as markdown; bullet/numbered steps become the todo list"},
                },
                "required": ["plan_markdown"],
            },
            func=exit_plan_mode,
            kind="action",  # blocks on the user: must never run in parallel
        ),
    ]
