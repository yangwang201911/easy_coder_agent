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
            kind="read",
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
            kind="read",
        )
    ]
