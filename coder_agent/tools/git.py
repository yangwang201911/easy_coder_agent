"""Git tools: dedicated read-only inspection + write operations with approval.

Read tools (kind=read, parallel-safe): git_status, git_diff, git_log, git_show.
Write tools (kind=exec, judged by the command approval policy): git_commit,
git_branch, git_checkout.

Safety:
- commit arguments are restricted (no --no-verify, no --amend, no -a);
- checkout requires a clean worktree (or an explicit ``force`` the user approves);
- branch names / revisions must look like identifiers (no shell metacharacters);
- all output is size-capped; the approval preview shows the exact command.
"""

from __future__ import annotations

import os
import re
import subprocess

from .base import Tool, ToolContext, ToolError

MAX_OUTPUT = 12000
DEFAULT_TIMEOUT = 60

_IDENT = re.compile(r"^[A-Za-z0-9._/~^]+$")  # git refs: allow ~ and ^ (HEAD~1, HEAD^)


def _check_ident(value: str, what: str) -> None:
    if not _IDENT.match(value):
        raise ToolError(f"invalid {what}: {value!r} (only letters, digits, . _ / - allowed)")


def _run_git(ctx: ToolContext, args: list[str], timeout: int = DEFAULT_TIMEOUT) -> str:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=str(ctx.root),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"},
        )
    except FileNotFoundError:
        raise ToolError("git is not installed")
    except subprocess.TimeoutExpired:
        raise ToolError(f"git {' '.join(args[:2])} timed out after {timeout}s")
    out = (proc.stdout or "") + (("\n[stderr] " + proc.stderr) if proc.stderr and proc.returncode else "")
    out = out.strip()
    if proc.returncode != 0:
        raise ToolError(f"git exited with {proc.returncode}: {out[:2000]}")
    if len(out) > MAX_OUTPUT:
        half = MAX_OUTPUT // 2
        out = out[:half] + f"\n... [truncated {len(out) - MAX_OUTPUT} chars] ...\n" + out[-half:]
    return out


# ----------------------------------------------------------------- read tools
def git_status(ctx: ToolContext, a: dict) -> str:
    out = _run_git(ctx, ["status", "--short", "--branch"])
    return out or "(working tree clean)"


def git_diff(ctx: ToolContext, a: dict) -> str:
    args = ["diff", "--no-color"]
    if a.get("staged"):
        args.append("--staged")
    if a.get("base"):
        _check_ident(a["base"], "base revision")
        args.append(a["base"])
    if a.get("path"):
        args += ["--", a["path"]]
    out = _run_git(ctx, args)
    return out or "(no differences)"


def git_log(ctx: ToolContext, a: dict) -> str:
    n = max(1, min(int(a.get("n", 10)), 100))
    args = ["log", "--no-color", f"-{n}", "--pretty=format:%h %ad %s", "--date=short"]
    if a.get("path"):
        args += ["--", a["path"]]
    return _run_git(ctx, args)


def git_show(ctx: ToolContext, a: dict) -> str:
    _check_ident(a["rev"], "revision")
    args = ["show", "--no-color", "--stat", a["rev"]]
    if a.get("path"):
        args += ["--", a["path"]]
    return _run_git(ctx, args)


# ----------------------------------------------------------------- write tools
def git_commit(ctx: ToolContext, a: dict) -> str:
    message = (a.get("message") or "").strip()
    if not message:
        raise ToolError("a commit message is required")
    if "\x00" in message:
        raise ToolError("invalid commit message")
    args = ["commit", "-m", message]  # never --no-verify / --amend
    if a.get("paths"):
        paths = a["paths"] if isinstance(a["paths"], list) else [a["paths"]]
        for p in paths:
            _check_ident(str(p), "path")
        args += ["--", *paths]
    out = _run_git(ctx, args)
    return f"committed: {out}"


def git_branch(ctx: ToolContext, a: dict) -> str:
    if a.get("name"):
        _check_ident(a["name"], "branch name")
        args = ["branch", a["name"]]
        if a.get("start_point"):
            _check_ident(a["start_point"], "start point")
            args.append(a["start_point"])
        return _run_git(ctx, args) + f"\ncreated branch {a['name']}"
    return _run_git(ctx, ["branch", "--list"])


def git_checkout(ctx: ToolContext, a: dict) -> str:
    target = a["target"]
    _check_ident(target, "checkout target")
    if not a.get("force"):
        st = _run_git(ctx, ["status", "--porcelain"])
        if st.strip():
            raise ToolError(
                "the worktree has uncommitted changes; commit/stash them first, "
                "or retry with force=true (the user will be asked to approve)"
            )
    args = ["checkout", target] if not a.get("force") else ["checkout", "-f", target]
    return _run_git(ctx, args)


# ------------------------------------------------------------------ registry
def git_tools() -> list[Tool]:
    return [
        Tool(
            "git_status",
            "Show the current branch and uncommitted changes (short format).",
            {"type": "object", "properties": {}},
            git_status,
            kind="read",
        ),
        Tool(
            "git_diff",
            "Show changes: unstaged by default, staged with staged=true, against a "
            "commit with base=<rev>, limited to a path with path.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "staged": {"type": "boolean"},
                    "base": {"type": "string", "description": "commit to diff against, e.g. HEAD~1"},
                },
            },
            git_diff,
            kind="read",
        ),
        Tool(
            "git_log",
            "Show recent commits (hash, date, subject); optionally limited to a path.",
            {
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "description": "number of commits, default 10"},
                    "path": {"type": "string"},
                },
            },
            git_log,
            kind="read",
        ),
        Tool(
            "git_show",
            "Show a commit: message, stats and (optionally) the diff for one path.",
            {
                "type": "object",
                "properties": {
                    "rev": {"type": "string"},
                    "path": {"type": "string"},
                },
                "required": ["rev"],
            },
            git_show,
            kind="read",
        ),
        Tool(
            "git_commit",
            "Commit changes. Without paths: commits what is already staged. With "
            "paths: commits exactly those paths. Never uses --no-verify or --amend.",
            {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "commit message"},
                    "paths": {"type": "array", "items": {"type": "string"}, "description": "limit the commit to these paths"},
                },
                "required": ["message"],
            },
            git_commit,
            kind="exec",
            command_of=lambda a: f"git commit -m {a.get('message', '')}",
            preview=lambda ctx, a: f"git commit -m {a.get('message', '')}"
                                   + (f" -- {a.get('paths')}" if a.get("paths") else ""),
        ),
        Tool(
            "git_branch",
            "With name: create a branch (optionally at start_point). Without: show the current branch.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "start_point": {"type": "string"},
                },
            },
            git_branch,
            kind="exec",
            command_of=lambda a: f"git branch {a.get('name', '')}",
            preview=lambda ctx, a: f"git branch {a.get('name', '')} {a.get('start_point', '')}".strip(),
        ),
        Tool(
            "git_checkout",
            "Switch branch or restore a path. Requires a clean worktree unless "
            "force=true (approved by the user).",
            {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "branch name, commit, or path"},
                    "force": {"type": "boolean", "description": "discard local changes (needs approval)"},
                },
                "required": ["target"],
            },
            git_checkout,
            kind="exec",
            command_of=lambda a: f"git checkout {'-f ' if a.get('force') else ''}{a.get('target', '')}",
            preview=lambda ctx, a: f"git checkout {'-f ' if a.get('force') else ''}{a.get('target', '')}",
        ),
    ]
