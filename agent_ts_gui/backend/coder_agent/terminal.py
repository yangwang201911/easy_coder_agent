"""Interactive PTY terminals for the GUI's Terminals tab.

Each terminal is a forked login shell on a pseudo-terminal. A reader thread
drains the master fd and pushes ``terminal_output`` events through the
server's push_event (thread-safe); the shell exiting pushes
``terminal_exited``. Input and resize arrive from the GUI as RPCs.
"""

from __future__ import annotations

import fcntl
import os
import pty
import select
import signal
import struct
import termios
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class Terminal:
    id: str
    master_fd: int
    pid: int
    shell: str
    cwd: str
    created: float = field(default_factory=time.time)
    cols: int = 80
    rows: int = 24
    closed: bool = False
    exit_code: Optional[int] = None
    on_exit: Optional[Callable[["Terminal"], None]] = field(default=None, repr=False)
    _thread: Optional[threading.Thread] = field(default=None, repr=False)

    # ------------------------------------------------------------- lifecycle
    def start(self, push: Callable[[str, dict], None]) -> None:
        """Start the reader thread (push(kind, data) is thread-safe)."""
        self._thread = threading.Thread(target=self._read_loop, args=(push,),
                                        name=f"term-{self.id}", daemon=True)
        self._thread.start()

    def _read_loop(self, push: Callable[[str, dict], None]) -> None:
        # Do NOT rely on read-EOF to detect the shell exiting: a login shell may
        # leave a slave fd open in a forked child, so the master stays readable.
        # Select with a timeout and reap the child explicitly; on exit, drain
        # whatever is left in the fd and stop.
        while not self.closed:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.2)
            except (OSError, ValueError):  # fd closed by close()
                return
            if r:
                try:
                    data = os.read(self.master_fd, 65536)
                except OSError:
                    break
                if data:
                    push("terminal_output", {"id": self.id, "text": data.decode("utf-8", "replace")})
            if self._reap():  # child exited
                break
        # drain remaining output (exit messages, final prompt)
        while True:
            try:
                r, _, _ = select.select([self.master_fd], [], [], 0.05)
                if not r:
                    break
                data = os.read(self.master_fd, 65536)
                if not data:
                    break
                push("terminal_output", {"id": self.id, "text": data.decode("utf-8", "replace")})
            except OSError:
                break
        # make sure the child is reaped so exit_code is set
        for _ in range(20):
            if self._reap():
                break
            time.sleep(0.05)
        if not self.closed:
            self.closed = True
            push("terminal_exited", {"id": self.id, "exit_code": self.exit_code})
            if self.on_exit:
                try:
                    self.on_exit(self)
                except Exception:  # noqa: BLE001 - cleanup must not kill the thread
                    pass

    def _reap(self) -> bool:
        """Reap the child if it has exited; return True once it is gone."""
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            self.exit_code = 0
            return True
        if pid == self.pid:
            self.exit_code = os.waitstatus_to_exitcode(status)
            return True
        return False

    def write(self, data: str) -> None:
        if self.closed:
            raise RuntimeError(f"terminal {self.id} is closed")
        os.write(self.master_fd, data.encode("utf-8"))

    def resize(self, cols: int, rows: int) -> None:
        cols = max(2, min(int(cols), 500))
        rows = max(1, min(int(rows), 300))
        self.cols, self.rows = cols, rows
        try:
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except OSError:
            pass

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        try:
            os.kill(self.pid, signal.SIGHUP)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        if self.on_exit:
            try:
                self.on_exit(self)
            except Exception:  # noqa: BLE001
                pass


def open_terminal(term_id: str, shell: Optional[str] = None,
                  cwd: Optional[str] = None, cols: int = 80, rows: int = 24) -> Terminal:
    """Fork a login shell on a new PTY. ``shell`` defaults to $SHELL or bash."""
    shell = shell or os.environ.get("SHELL") or "/bin/bash"
    pid, master_fd = pty.fork()
    if pid == 0:  # child: become the shell, then exec it
        try:
            if cwd:
                os.chdir(cwd)
        except OSError:
            pass
        os.execvpe(shell, [shell], os.environ)
        os._exit(127)  # exec failed
    term = Terminal(id=term_id, master_fd=master_fd, pid=pid, shell=shell,
                    cwd=cwd or "", cols=cols, rows=rows)
    term.resize(cols, rows)  # the forked child may not have read the size yet
    return term
