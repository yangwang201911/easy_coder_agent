"""Shell command tool with timeout, cancellation and streamed output.

By default the command runs in a PTY terminal (``ctx.command_runner``): the GUI
shows live I/O in a terminal tab and the user can type into the command's stdin.
Without a runner (CLI / ``commands_in_terminal = false``) it falls back to the
classic pipe-based execution.
"""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import threading
import time

from ..util import truncate_middle
from .base import Tool, ToolContext, ToolError

DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 3600
KEEP_CHARS = 10000


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_command(ctx: ToolContext, a: dict) -> str:
    cmd = a["command"].strip()
    if not cmd:
        raise ToolError("empty command")
    timeout = max(1, min(int(a.get("timeout", DEFAULT_TIMEOUT)), MAX_TIMEOUT))
    cwd = ctx.resolve(a.get("cwd", ".")).as_posix()
    if ctx.command_runner is not None:
        return _run_in_terminal(ctx, cmd, cwd, timeout)
    return _run_piped(ctx, cmd, cwd, timeout)


# --------------------------------------------------------------- PTY terminal
def _run_in_terminal(ctx: ToolContext, cmd: str, cwd: str, timeout: int) -> str:
    """Run ``cmd`` in a PTY terminal tab; return the classic result text."""
    term_id, done, get_output, get_exit_code = ctx.command_runner(cmd, cwd)  # type: ignore[misc]
    deadline = time.monotonic() + timeout
    status = ""
    while not done.is_set():
        if ctx.cancel.is_set():
            if ctx.close_terminal:
                ctx.close_terminal(term_id)
            status = "cancelled by user"
            break
        if time.monotonic() > deadline:
            if ctx.close_terminal:
                ctx.close_terminal(term_id)
            status = f"timed out after {timeout}s and was killed"
            break
        done.wait(timeout=0.2)
    out = truncate_middle(get_output(), KEEP_CHARS * 2)
    code = -1
    for _ in range(20):  # on_exit (which records the exit code) may lag done.set()
        code = get_exit_code()
        if code != -1:
            break
        time.sleep(0.05)
    head = f"exit code: {code}" + (f" ({status})" if status else "")
    return f"{head}\n{out}".rstrip()


# ------------------------------------------------------------------ pipe mode
def _run_piped(ctx: ToolContext, cmd: str, cwd: str, timeout: int) -> str:
    env = dict(os.environ, TERM="dumb", NO_COLOR="1", PAGER="cat", GIT_PAGER="cat")
    proc = subprocess.Popen(
        cmd,
        shell=True,
        executable="/bin/bash" if os.path.exists("/bin/bash") else None,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,  # never wait for interactive input
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        bufsize=1,
        start_new_session=True,
    )
    q: "queue.Queue[str | None]" = queue.Queue()

    def reader() -> None:
        assert proc.stdout
        for line in proc.stdout:
            q.put(line)
        q.put(None)

    threading.Thread(target=reader, daemon=True).start()

    chunks: list[str] = []
    deadline = time.monotonic() + timeout
    status = ""
    done = False
    while not done:
        if ctx.cancel.is_set():
            _kill(proc)
            status = "cancelled by user"
            break
        if time.monotonic() > deadline:
            _kill(proc)
            status = f"timed out after {timeout}s and was killed"
            break
        try:
            line = q.get(timeout=0.2)
        except queue.Empty:
            continue
        if line is None:
            done = True
        else:
            chunks.append(line)
            ctx.emit("command_output", {"text": line})
    # drain whatever is left after kill
    while True:
        try:
            line = q.get_nowait()
        except queue.Empty:
            break
        if line is not None:
            chunks.append(line)

    try:
        code = proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _kill(proc)
        code = -9
    out = truncate_middle("".join(chunks), KEEP_CHARS * 2)
    head = f"exit code: {code}" + (f" ({status})" if status else "")
    return f"{head}\n{out}".rstrip()


def shell_tools() -> list[Tool]:
    return [
        Tool(
            "run_command",
            "Run a shell command (bash) in the project. The command runs in the GUI's "
            "terminal panel (live output; the user can type into it). Use for building "
            "(cmake), tests, git status etc. Output is truncated if very long.",
            {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "cwd": {"type": "string", "description": "working directory relative to project root"},
                    "timeout": {"type": "integer", "description": f"seconds, default {DEFAULT_TIMEOUT}"},
                },
                "required": ["command"],
            },
            run_command,
            kind="exec",
            preview=lambda ctx, a: f"$ {a['command']}\n(cwd: {a.get('cwd', '.')})",
        )
    ]
