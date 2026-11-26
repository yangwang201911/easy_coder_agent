"""Shell tools.

Two flavours:

* ``run_command`` - stateless ``bash -c`` per call (auditable, default).
* ``shell_exec`` / ``shell_output`` / ``shell_kill`` - a persistent bash per
  session: cwd and environment survive between calls, long-running commands
  can go to the background and their output is read incrementally.

Persistent-session protocol: the command is written to the shell's stdin
followed by a sentinel line ``__AGENT_DONE_<uuid>__:$?``. A reader thread
appends every output line to a buffer; the call returns when the sentinel
appears (or the timeout kills the command's process group). Commands run via
``setsid`` so they get their own process group and can be killed without
killing the session shell.

Full output of every command is appended to ``.agent/outputs/<name>.log`` so
nothing is lost to truncation; the tool result carries head + tail + the path.
"""

from __future__ import annotations

import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from ..paths import project_cache_dir
from ..util import truncate_middle
from .base import Tool, ToolContext, ToolError

DEFAULT_TIMEOUT = 120
MAX_TIMEOUT = 3600
KEEP_CHARS = 10000


def _kill(proc: subprocess.Popen) -> None:
    # On Unix the child was started in its own session (start_new_session), so
    # the whole process group (the shell + its children) is signalled. On
    # Windows there is no process group: kill the process tree via taskkill.
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _kill_pgid(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    for _ in range(20):
        if _pgid_alive(pgid):
            time.sleep(0.1)
        else:
            return
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def _pgid_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _kill_children(shell_pid: int) -> None:
    """Kill the session shell's child processes (the running command and its
    descendants) without killing the shell itself. /proc is Linux-only; the
    persistent shell is Unix-only anyway."""
    pids: set[int] = set()
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat", "rb") as f:
                    stat = f.read().decode(errors="replace")
                # field 4 (ppid) is after the comm field, which may contain spaces
                ppid = int(stat.rsplit(")", 1)[1].split()[1])
            except (OSError, IndexError, ValueError):
                continue
            if ppid == shell_pid:
                pids.add(int(entry))
    except OSError:
        return
    for pid in pids:
        if _pid_alive(pid):
            _kill_pgid(pid)


def _shell_env() -> dict:
    env = dict(os.environ, TERM="dumb", NO_COLOR="1", PAGER="cat", GIT_PAGER="cat",
               GIT_TERMINAL_PROMPT="0", DEBIAN_FRONTEND="noninteractive",
               CI="1", PYTHONUNBUFFERED="1")
    return env


# --------------------------------------------------------------- run_command
def run_command(ctx: ToolContext, a: dict) -> str:
    cmd = a["command"].strip()
    if not cmd:
        raise ToolError("empty command")
    timeout = max(1, min(int(a.get("timeout", DEFAULT_TIMEOUT)), MAX_TIMEOUT))
    cwd = ctx.resolve(a.get("cwd", ".")).as_posix()
    return _run_piped(ctx, cmd, cwd, timeout)


def _run_piped(ctx: ToolContext, cmd: str, cwd: str, timeout: int) -> str:
    env = _shell_env()
    if sys.platform == "win32":
        # CREATE_NEW_PROCESS_GROUP: the child gets its own process group so it
        # can be killed as a tree (taskkill /T) and does not receive the
        # console's Ctrl-C; start_new_session is not available on Windows.
        proc = subprocess.Popen(
            cmd, shell=True, cwd=cwd, env=env,
            stdin=subprocess.DEVNULL,  # never wait for interactive input
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", bufsize=1,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
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


# -------------------------------------------------------- persistent session
class _Session:
    def __init__(self, name: str, root, log_path):
        self.name = name
        self.log_path = log_path
        self.proc = None
        self.buffer: deque[str] = deque(maxlen=20000)
        self.cond = threading.Condition()
        self.reader = None
        self._log_lock = threading.Lock()
        self._start(root)

    def _start(self, root) -> None:
        self.proc = subprocess.Popen(
            ["/bin/bash", "--norc", "--noprofile"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            cwd=str(root), env=_shell_env(), text=True, bufsize=1,
            start_new_session=True,
        )

        def reader() -> None:
            assert self.proc.stdout is not None
            for line in self.proc.stdout:
                with self._log_lock:
                    self.log_path.open("a", encoding="utf-8").write(line)
                with self.cond:
                    self.buffer.append(line)
                    self.cond.notify_all()

        self.reader = threading.Thread(target=reader, daemon=True, name=f"shell-{self.name}")
        self.reader.start()

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def close(self) -> None:
        if not self.alive():
            return
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _kill(self.proc)


class ShellManager:
    """Owns the persistent bash sessions and background jobs of one engine."""

    def __init__(self, root):
        self.root = root
        self._sessions: dict[str, _Session] = {}
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        out_dir = project_cache_dir(root) / "outputs"
        out_dir.mkdir(parents=True, exist_ok=True)
        self._out_dir = out_dir

    def _session(self, name: str) -> _Session:
        with self._lock:
            s = self._sessions.get(name)
            if s is None or not s.alive():
                if s is not None:
                    s.close()
                s = _Session(name, self.root, self._out_dir / f"{name}.log")
                self._sessions[name] = s
            return s

    def exec(self, name: str, command: str, timeout: int, background: bool,
             cancel: threading.Event) -> tuple[str, str]:
        if os.name == "nt":
            raise ToolError("the persistent shell is Unix-only; use run_command on Windows")
        s = self._session(name)
        if not s.alive():
            raise ToolError(f"shell session '{name}' is not running")
        if background:
            return self._start_background(s, name, command)
        sentinel = f"__AGENT_DONE_{uuid.uuid4().hex[:12]}__"
        # The command runs DIRECTLY in the session shell (not a subshell) so
        # cd/export/venv state survives between calls. On timeout we kill the
        # shell's child processes (found via /proc), not the shell itself.
        wrapped = f"{command}\necho {sentinel}:$?"
        with s.cond:
            start_len = len(s.buffer)
        s.proc.stdin.write(wrapped + "\n")
        s.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        status = ""
        code: str = ""
        with s.cond:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    status = f"timed out after {timeout}s and was killed"
                    break
                if cancel.is_set():
                    status = "cancelled by user"
                    break
                found = False
                for i in range(start_len, len(s.buffer)):
                    line = s.buffer[i]
                    if line.startswith(sentinel + ":"):
                        code = line[len(sentinel) + 1:].strip()
                        found = True
                        break
                if found:
                    break
                s.cond.wait(timeout=min(0.2, remaining))
        out = "".join(list(s.buffer)[start_len:])
        out = out.split(sentinel, 1)[0]
        if status and code == "":
            # the sentinel never arrived: kill the command (and its children)
            _kill_children(s.proc.pid)
            code = "killed"
        return out, f"exit code: {code}" + (f" ({status})" if status else "")

    def _start_background(self, s: _Session, name: str, command: str) -> tuple[str, str]:
        log = self._out_dir / f"{name}-{uuid.uuid4().hex[:8]}.log"
        sentinel = f"__AGENT_PID_{uuid.uuid4().hex[:12]}__"
        # setsid + & : the job runs in its own group, output goes to the log,
        # and $! is the job's pid (== its pgid, so shell_kill can signal it)
        wrapped = (f"setsid bash -c {shlex_quote(command)} > {log} 2>&1 & "
                   f"echo {sentinel}:$!")
        with s.cond:
            start_len = len(s.buffer)
        s.proc.stdin.write(wrapped + "\n")
        s.proc.stdin.flush()
        with s.cond:
            s.cond.wait(timeout=10)
            pid = ""
            for i in range(start_len, len(s.buffer)):
                line = s.buffer[i]
                if line.startswith(sentinel + ":"):
                    pid = line[len(sentinel) + 1:].strip()
                    break
        if not pid.isdigit():
            raise ToolError("failed to start the background job")
        job_id = f"{name}-{pid}"
        with self._lock:
            self._jobs[job_id] = {"pid": int(pid), "log": log, "name": name}
        return "", f"background job started: {job_id} (pid {pid}, log: {log})"

    def output(self, job_id: str, since: int, wait_s: float, pattern: str | None) -> str:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            known = ", ".join(sorted(self._jobs)) or "none"
            raise ToolError(f"unknown job '{job_id}' (running jobs: {known})")
        log: "os.PathLike" = job["log"]
        stop = time.monotonic() + max(0.0, min(wait_s, 300))
        deadline_hit = False
        while True:
            size = log.stat().st_size if log.exists() else 0
            data = b""
            if size > since:
                with open(log, "rb") as f:
                    f.seek(since)
                    data = f.read(size - since)
            text = data.decode("utf-8", errors="replace")
            if pattern is not None and text and re.search(pattern, text):
                break
            if not _pid_alive(job["pid"]):
                break
            if time.monotonic() >= stop:
                deadline_hit = True
                break
            if not text:
                time.sleep(0.2)
            else:
                time.sleep(0.05)
        since += len(data)
        running = _pid_alive(job["pid"])
        head = f"job {job_id}: {'running' if running else 'finished'}"
        if deadline_hit and running:
            head += f" (still running after {wait_s:.0f}s of waiting)"
        body = truncate_middle(text, KEEP_CHARS * 2) if text else "(no new output)"
        return f"{head}\nnext since={since}\n{body}"

    def kill(self, job_id: str) -> str:
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job is None:
            raise ToolError(f"unknown job '{job_id}'")
        if _pid_alive(job["pid"]):
            _kill_pgid(job["pid"])
        return f"killed job {job_id} (pid {job['pid']})"

    def jobs(self) -> list[str]:
        with self._lock:
            return [j for j, v in self._jobs.items() if _pid_alive(v["pid"])]

    def close(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            jobs = dict(self._jobs)
            self._jobs.clear()
        for jid, job in jobs.items():
            if _pid_alive(job["pid"]):
                _kill_pgid(job["pid"])
        for s in sessions:
            s.close()


def shlex_quote(s: str) -> str:
    import shlex
    return shlex.quote(s)


# -------------------------------------------------------------- tool wrappers
def _manager(ctx: ToolContext) -> ShellManager:
    from .base import ToolContext as _TC
    mgr = getattr(ctx, "shell", None)
    if mgr is None:
        mgr = ShellManager(ctx.root)
        ctx.shell = mgr
    return mgr


def shell_exec(ctx: ToolContext, a: dict) -> str:
    cmd = a["command"].strip()
    if not cmd:
        raise ToolError("empty command")
    name = a.get("session", "default")
    timeout = max(1, min(int(a.get("timeout", DEFAULT_TIMEOUT)), MAX_TIMEOUT))
    background = bool(a.get("background", False))
    mgr = _manager(ctx)
    out, head = mgr.exec(name, cmd, timeout, background, ctx.cancel)
    if background:
        return head
    if not out.strip():
        return head
    log = mgr._session(name).log_path
    body = truncate_middle(out, KEEP_CHARS * 2)
    return f"{head}\n{body}\n(full output: {log})"


def shell_output(ctx: ToolContext, a: dict) -> str:
    mgr = _manager(ctx)
    return mgr.output(a["job_id"], int(a.get("since", 0)),
                      float(a.get("wait_s", 0)), a.get("regex"))


def shell_kill(ctx: ToolContext, a: dict) -> str:
    mgr = _manager(ctx)
    return mgr.kill(a["job_id"])


# ------------------------------------------------------------------ registry
def shell_tools() -> list[Tool]:
    return [
        Tool(
            "run_command",
            "Run a shell command (bash) in the project. Use for building (cmake), "
            "tests, git status etc. Stateless: each call starts a fresh shell. "
            "Output is truncated if very long.",
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
        ),
        Tool(
            "shell_exec",
            "Run a command in a PERSISTENT bash session: cwd, env vars and venv "
            "activations survive between calls. Use background=true for long tasks "
            "(servers, builds, training) - it returns a job_id; read its output with "
            "shell_output and stop it with shell_kill.",
            {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "session": {"type": "string", "description": "session name, default 'default'"},
                    "timeout": {"type": "integer", "description": f"seconds, default {DEFAULT_TIMEOUT} (ignored for background)"},
                    "background": {"type": "boolean", "description": "run as a background job"},
                },
                "required": ["command"],
            },
            shell_exec,
            kind="exec",
            preview=lambda ctx, a: f"$ {a['command']}"
                                   + ("  [background]" if a.get("background") else "")
                                   + f"\n(session: {a.get('session', 'default')})",
        ),
        Tool(
            "shell_output",
            "Read new output of a background job (from shell_exec with background=true). "
            "Pass the 'since' offset from the previous call; wait_s>0 blocks until new "
            "output, the job finishes, or wait_s elapses; regex stops as soon as it matches.",
            {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string"},
                    "since": {"type": "integer", "description": "byte offset from the previous call, default 0"},
                    "wait_s": {"type": "number", "description": "seconds to wait for new output, default 0"},
                    "regex": {"type": "string", "description": "stop as soon as output matches"},
                },
                "required": ["job_id"],
            },
            shell_output,
            kind="read",
        ),
        Tool(
            "shell_kill",
            "Kill a background job started by shell_exec (its whole process group).",
            {
                "type": "object",
                "properties": {"job_id": {"type": "string"}},
                "required": ["job_id"],
            },
            shell_kill,
            kind="exec",
            preview=lambda ctx, a: f"kill job {a['job_id']}",
        ),
    ]
