"""Tests for the persistent shell: session state, sentinels, background jobs, kill."""

import os
import time

import pytest

from coder_agent.tools import shell
from coder_agent.tools.base import ToolContext, ToolError


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


@pytest.fixture
def mgr(tmp_path):
    m = shell.ShellManager(tmp_path)
    yield m
    m.close()


def test_state_survives_between_calls(mgr):
    out, head = mgr.exec("default", "cd subdir 2>/dev/null || mkdir -p sub && cd sub; export MY_VAR=hello; echo start", 30, False, _ev())
    out, head = mgr.exec("default", "echo $MY_VAR $(pwd)", 30, False, _ev())
    assert "hello" in out
    assert "sub" in out
    assert "exit code: 0" in head


def test_exit_code_reported(mgr):
    out, head = mgr.exec("default", "(exit 7)", 30, False, _ev())
    assert "exit code: 7" in head


def test_timeout_kills_command_not_session(mgr):
    t0 = time.monotonic()
    out, head = mgr.exec("default", "sleep 30", 2, False, _ev())
    assert time.monotonic() - t0 < 15
    assert "timed out" in head
    # the session shell must still work after the kill
    out, head = mgr.exec("default", "echo alive", 30, False, _ev())
    assert "alive" in out
    assert "exit code: 0" in head


def test_background_job_output_and_kill(mgr):
    out, head = mgr.exec("default", "for i in 1 2 3 4 5; do echo item-$i; sleep 0.3; done", 30, True, _ev())
    job_id = _job_id(head)
    text = mgr.output(job_id, 0, 5, "item-3")
    assert "item-1" in text and "item-3" in text
    assert "next since=" in text
    since = int(text.split("next since=")[1].split("\n")[0])
    more = mgr.output(job_id, since, 5, None)
    assert "item-4" in more or "item-5" in more
    assert mgr.kill(job_id)
    with pytest.raises(ToolError):
        mgr.kill(job_id)


def test_output_unknown_job(mgr):
    with pytest.raises(ToolError, match="unknown job"):
        mgr.output("nope", 0, 0, None)


def test_background_log_written(tmp_path, mgr):
    out, head = mgr.exec("default", "echo to-the-log", 30, True, _ev())
    job_id = _job_id(head)
    mgr.output(job_id, 0, 5, "to-the-log")
    log = tmp_path / ".agent" / "outputs"
    files = list(log.glob("default-*.log"))
    assert files and any("to-the-log" in f.read_text() for f in files)


def test_session_log_full_output(tmp_path, mgr):
    mgr.exec("default", "seq 1 100", 30, False, _ev())
    log = tmp_path / ".agent" / "outputs" / "default.log"
    assert "100\n" in log.read_text()


def test_cancel_kills_command(mgr):
    ev = _ev()
    import threading
    t = threading.Thread(target=ev.set, daemon=True)
    t.start()
    time.sleep(0.2)
    out, head = mgr.exec("default", "sleep 30", 30, False, ev)
    assert "cancelled" in head


def test_windows_not_supported():
    if os.name == "nt":
        pytest.skip("persistent shell is Unix-only (PTY-free pipes + setsid)")


def _ev():
    import threading
    return threading.Event()


def _job_id(head: str) -> str:
    # head: "background job started: default-12345 (pid 12345, log: ...)"
    import re
    m = re.search(r"started: (\S+)", head)
    assert m, head
    return m.group(1)
