"""Integration tests for the WebSocket server: RPC, event stream, async approvals.

A real server process is started with a scripted FakeProvider (same style as
tests/conftest.py in the old project); the test talks to it over a real
WebSocket connection, exactly like the Electron GUI will.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
import websockets

HERE = Path(__file__).parent
BACKEND = HERE.parent


class FakeProvider:
    """Scripted LLM, runs inside the server subprocess (imported by name there)."""

    def __init__(self):
        self.script = [
            {"tool_calls": [("write_file", {"path": "hello.txt", "content": "hi"})]},
            {"content": "all done"},
        ]

    def stream_chat(self, messages, tools=None, cancel=None, thinking=None, max_tokens=None, steer=None):
        from coder_agent.llm import LLMChunk, ToolCall, Usage
        reply = self.script.pop(0) if self.script else {"content": "done"}
        if reply.get("content"):
            yield LLMChunk("content", reply["content"])
        calls = [ToolCall(f"c{i}", n, json.dumps(a)) for i, (n, a) in enumerate(reply.get("tool_calls", []))]
        if calls:
            yield LLMChunk("tool_calls", tool_calls=calls)
        yield LLMChunk("usage", usage=Usage(100, 10, 110))
        yield LLMChunk("done", finish_reason="tool_calls" if calls else "stop")

    def list_models(self):
        return ["fake"]


# ---------------------------------------------------------------------------
@pytest.fixture
def server_process(tmp_path, request):
    """Start the server with the fake provider and yield (url, proc).

    ``request.param`` (optional) is a string: leading digits set how many
    write_file calls the fake provider scripts (default 1), and "FAKE_STEER"
    makes the first stream block until a steer arrives; a tuple
    ``(n_writes, block_n)`` blocks the n-th stream (used by the steer test)."""
    param = getattr(request, "param", None)
    if param is None:
        n_writes, fake_steer = 1, ""
    elif isinstance(param, int):
        n_writes, fake_steer = param, ""
    elif isinstance(param, tuple):
        n_writes, fake_steer = param[0], str(param[1])
    else:
        n_writes = int("".join(ch for ch in param if ch.isdigit()) or 1)
        fake_steer = param
    home = tmp_path / "home"
    project = tmp_path / "proj"
    project.mkdir()
    # strict approval policy: every write must be asked
    (project / ".agent").mkdir()
    (project / ".agent" / "approval.toml").write_text("[paths]\nauto_approve = false\n", encoding="utf-8")

    env = dict(os.environ, CODER_AGENT_HOME=str(home), FAKE_WRITES=str(n_writes),
               FAKE_STEER=fake_steer)
    code = (
        "import asyncio, json, os, sys, threading\n"
        "from coder_agent.llm import LLMProvider\n"
        "from coder_agent.server import Server, handler, run\n"
        "import websockets\n"
        "class Fake(LLMProvider):\n"
        "    def __init__(self):\n"
        "        self.script = [\n"
        "            {'content': 'writing', 'tool_calls': [('write_file', {'path': 'hello.txt', 'content': 'hi'})]}\n"
        "            for _ in range(int(os.environ.get('FAKE_WRITES', '1')))\n"
        "        ] + [{'content': 'all done'}]\n"
        "        self.steer_gate = threading.Event()  # set by the steer RPC (test hook)\n"
        "        self._n_calls = 0\n"
        "        self._block_n = int(os.environ.get('FAKE_STEER', '0') or 0)  # block this stream n\n"
        "        self._hello_done = False\n"
        "        self._bye_done = False\n"
        "        self._parked = set()  # call indexes that already parked (a re-run parks again)\n"
        "    def stream_chat(self, messages, tools=None, cancel=None, thinking=None, max_tokens=None, steer=None):\n"
        "        from coder_agent.llm import LLMChunk, ToolCall, Usage, LLMCancelled\n"
        "        self._n_calls += 1\n"
        "        if self._block_n:  # steer test: the model obeys the steer once it is in the conversation\n"
        "            steered = any('bye' in str(m.get('content', '')) for m in messages)\n"
        "            if steered and not self._bye_done:  # write bye.txt exactly once, then finish\n"
        "                self._bye_done = True\n"
        "                calls = [ToolCall('c0', 'write_file', json.dumps({'path': 'bye.txt', 'content': 'hi'}))]\n"
        "            elif not self._hello_done:  # the original request: write hello.txt once\n"
        "                self._hello_done = True\n"
        "                calls = [ToolCall('c0', 'write_file', json.dumps({'path': 'hello.txt', 'content': 'hi'}))]\n"
        "            else:\n"
        "                calls = []\n"
        "            # the blocked stream yields 'parked' so the test knows it is mid-stream\n"
        "            # and safe to steer; a re-run of the same blocked call parks again\n"
        "            blocked = self._n_calls == self._block_n and self._n_calls not in self._parked\n"
        "            if blocked:\n"
        "                self._parked.add(self._n_calls)\n"
        "            yield LLMChunk('content', 'parked' if blocked else ('writing' if calls else 'all done'))\n"
        "            if blocked:  # a long stream: park until a steer arrives\n"
        "                self.steer_gate.clear()\n"
        "                while not self.steer_gate.is_set():\n"
        "                    self.steer_gate.wait(timeout=0.05)\n"
        "                if steer is not None and steer.is_set():\n"
        "                    raise LLMCancelled()  # the steer aborted the (long) stream\n"
        "            if calls:\n"
        "                yield LLMChunk('tool_calls', tool_calls=calls)\n"
        "        else:  # scripted: reply by call number (a re-run gets the same reply)\n"
        "            reply = self.script[self._n_calls - 1] if self._n_calls <= len(self.script) else {'content': 'done'}\n"
        "            calls = [ToolCall(f'c{i}', n, json.dumps(a)) for i, (n, a) in enumerate(reply.get('tool_calls', []))]\n"
        "            if reply.get('content'):\n"
        "                yield LLMChunk('content', reply['content'])\n"
        "            if calls:\n"
        "                yield LLMChunk('tool_calls', tool_calls=calls)\n"
        "        yield LLMChunk('usage', usage=Usage(100, 10, 110))\n"
        "        yield LLMChunk('done', finish_reason='tool_calls' if calls else 'stop')\n"
        "    def list_models(self):\n"
        "        return ['fake']\n"
        "async def main():\n"
        f"    server = Server(r'{project}', Fake)\n"
        "    srv = await websockets.serve(lambda ws, *a: handler(ws, server), '127.0.0.1', 0)\n"
        "    print('WS_URL=ws://127.0.0.1:' + str(srv.sockets[0].getsockname()[1]), flush=True)\n"
        "    await asyncio.Future()\n"
        "asyncio.run(main())\n"
    )
    proc = subprocess.Popen(
        [sys.executable, "-c", code],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=str(BACKEND),
    )
    line = proc.stdout.readline().strip()
    assert line.startswith("WS_URL="), f"server failed to start: {line}\n{proc.stderr.read()}"
    url = line.split("=", 1)[1]
    yield url, project, home
    proc.terminate()
    proc.wait(timeout=10)


# ---------------------------------------------------------------------------
class Client:
    """Tiny RPC client mirroring what the Electron renderer will do."""

    def __init__(self, ws):
        self.ws = ws
        self.next_id = 0
        self.events: list[dict] = []
        self._lock = asyncio.Lock()  # one RPC in flight at a time (responses are matched by id)

    async def call(self, method: str, **params) -> dict:
        async with self._lock:
            self.next_id += 1
            await self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params}))
            while True:
                msg = json.loads(await self.ws.recv())
                if "event" in msg:
                    self.events.append(msg)
                    continue
                assert msg.get("id") == self.next_id, msg
                if "error" in msg:
                    raise AssertionError(f"{method} failed: {msg['error']}")
                return msg["result"]

    async def wait_output(self, needle: str, timeout: float = 15.0) -> str:
        """Drain the socket until ``needle`` appears in the terminal_output events."""
        deadline = time.time() + timeout
        out = "".join(e["data"].get("text", "") for e in self.events if e["event"] == "terminal_output")
        while needle not in out and time.time() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.5))
            except (asyncio.TimeoutError, TimeoutError):
                continue
            if "event" in msg:
                self.events.append(msg)
                out = "".join(e["data"].get("text", "")
                              for e in self.events if e["event"] == "terminal_output")
        return out

    async def wait_event(self, kind: str, timeout: float = 15.0, match=None) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for i, ev in enumerate(self.events):
                if ev["event"] == kind and (match is None or match(ev)):
                    return self.events.pop(i)
            # drain whatever is already queued
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.2))
                    if "event" in msg:
                        self.events.append(msg)
            except (asyncio.TimeoutError, TimeoutError):
                pass
        raise AssertionError(f"event {kind!r} not received; got {[e['event'] for e in self.events]}")


def test_full_turn_with_approval(server_process):
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            r = await c.call("open_project", root=str(project))
            assert r["root"] == str(project)
            assert "general" in r["task_types"]

            await c.call("submit", prompt="write hello.txt", task_type="general")

            # the model wants to write a file -> approval is asked
            ev = await c.wait_event("approval_requested")
            assert ev["data"]["kind"] == "write"
            assert "hello.txt" in ev["data"]["title"] or "hello.txt" in ev["data"]["detail"]
            req_id = ev["data"]["req_id"]

            # answer from the "GUI"
            await c.call("answer", req_id=req_id, response={"allow": True})

            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done", fin
            assert (project / "hello.txt").read_text() == "hi"
            kinds = [e["event"] for e in c.events]
            assert "turn_started" in kinds and "tool_call" in kinds and "context_usage" in kinds

    asyncio.run(scenario())


def test_reject_approval_with_feedback(server_process):
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            await c.call("open_project", root=str(project))
            await c.call("submit", prompt="write hello.txt")
            ev = await c.wait_event("approval_requested")
            await c.call("answer", req_id=ev["data"]["req_id"],
                         response={"allow": False, "feedback": "do not write files"})
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done"  # the model gets the feedback and stops
            assert not (project / "hello.txt").exists()

    asyncio.run(scenario())


@pytest.mark.parametrize("server_process", [3], indirect=True)
def test_session_approve_all(server_process):
    """'Allow all in this session': one answer enables auto-approval for the rest
    of the session (deny rules still win); a new session resets it."""
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            await c.call("open_project", root=str(project))

            # first write: approval is asked
            await c.call("submit", prompt="write hello.txt")
            ev = await c.wait_event("approval_requested")
            await c.call("answer", req_id=ev["data"]["req_id"],
                         response={"allow": True, "session_approve": True})
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done", fin
            assert (project / "hello.txt").read_text() == "hi"

            # the GUI gets the session_approve event and open_project reports it
            ev = await c.wait_event("session_approve")
            assert ev["data"]["active"] is True
            r = await c.call("open_project", root=str(project))
            assert r["resumed"] is True and r["session_approve"] is True

            # second write: auto-approved (session_approve, or the rule remembered in
            # turn 1), so no approval is asked at all
            c.events.clear()
            await c.call("submit", prompt="write hello.txt again")
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done", fin
            assert not [e for e in c.events if e["event"] == "approval_requested"], c.events

            # a new session resets the session-wide auto-approve: the first write
            # must be asked again (the fake provider gets a fresh script, so every
            # write is asked - answer them all until the turn finishes)
            await c.call("new_session")
            c.events.clear()
            await c.call("submit", prompt="write hello.txt third")
            ev = await c.wait_event("approval_requested")
            assert ev["data"]["kind"] == "write"
            while True:
                await c.call("answer", req_id=ev["data"]["req_id"], response={"allow": True})
                try:
                    ev = await c.wait_event("approval_requested", timeout=3)
                except AssertionError:
                    break
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done", fin
            r = await c.call("open_project", root=str(project))
            assert r["session_approve"] is False

    asyncio.run(scenario())


@pytest.mark.parametrize("server_process", [(2, "1"), (2, "2")], indirect=True)
def test_steer_while_running(server_process, request):
    """'Send while running': a steer sent while the agent is working is injected
    at the next safe point and the agent continues; the turn finishes normally.
    Param "1": the agent is mid-stream; the steer aborts the stream.
    Param "2": the agent is between model calls; the steer is queued and injected
    at the top of the next step.

    The fake provider parks the blocked stream on a gate (after yielding its
    content chunk), so the test must steer only once the provider is known to be
    mid-stream (a content_delta has arrived) - otherwise the steer would land
    before the stream starts and the gate would be cleared after it was set."""
    url, project, home = server_process
    block_n = int(getattr(request, "param", (1, "1"))[1])

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            await c.call("open_project", root=str(project))
            await c.call("submit", prompt="write hello.txt")
            if block_n > 1:
                # the agent is parked on the first approval: answer it, then steer
                # while the second model call is running (blocked)
                ev = await c.wait_event("approval_requested")
                await c.call("answer", req_id=ev["data"]["req_id"], response={"allow": True})
            # the blocked stream yields a 'parked' content chunk before it parks on
            # the gate: once it is seen the provider is mid-stream and safe to steer
            ev = await c.wait_event("content_delta", match=lambda e: e["data"].get("text") == "parked")
            r = await c.call("steer", prompt="also write bye.txt")
            assert r["ok"]
            ev = await c.wait_event("steer_injected")
            assert ev["data"]["text"] == "also write bye.txt"
            # the agent continues with the steer: it asks to write the (last) file
            ev = await c.wait_event("approval_requested")
            await c.call("answer", req_id=ev["data"]["req_id"], response={"allow": True})
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] == "done", fin
            # the steer was obeyed: the model wrote bye.txt
            assert (project / "bye.txt").read_text() == "hi"
            # steer with no running turn -> error
            with pytest.raises(AssertionError):
                await c.call("steer", prompt="late steer")

    asyncio.run(scenario())


def test_cancel_while_waiting_approval(server_process):
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            await c.call("open_project", root=str(project))
            await c.call("submit", prompt="write hello.txt")
            ev = await c.wait_event("approval_requested")
            await c.call("cancel")
            fin = await c.wait_event("turn_finished")
            assert fin["data"]["status"] in ("cancelled", "done")
            assert not (project / "hello.txt").exists()

    asyncio.run(scenario())


def test_busy_guard_and_sessions(server_process):
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            await c.call("open_project", root=str(project))
            sid = (await c.call("open_project", root=str(project)))["session_id"]
            # unknown method
            c.next_id += 1
            await c.ws.send(json.dumps({"id": c.next_id, "method": "nope", "params": {}}))
            while True:
                msg = json.loads(await c.ws.recv())
                if msg.get("id") == c.next_id:
                    assert "error" in msg
                    break

            # rewind of a non-existent turn -> error, not crash
            with pytest.raises(AssertionError):
                await c.call("rewind", turn_id="nope")

            # context estimate works on an empty session
            r = await c.call("context_estimate")
            assert r["max_tokens"] > 0

            # system prompt is non-empty
            r = await c.call("system_prompt", task_type="general")
            assert len(r["text"]) > 100

    asyncio.run(scenario())


def test_turn_survives_disconnect(server_process):
    """Remote mode: the GUI drops the connection while a turn waits for an
    approval; the server must keep the turn alive, and re-ask the question
    when the GUI reconnects (open_project must not rebuild the engine)."""
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            r = await c.call("open_project", root=str(project))
            assert "resumed" not in r
            await c.call("submit", prompt="write hello.txt")
            ev = await c.wait_event("approval_requested")
            # the GUI goes away (network blip): the turn must NOT be cancelled
            await ws.close()
            await asyncio.sleep(0.5)

            async with websockets.connect(url) as ws2:
                c2 = Client(ws2)
                r2 = await c2.call("open_project", root=str(project))
                assert r2["resumed"] is True, r2
                # the pending question is re-asked with its original payload
                ev2 = await c2.wait_event("approval_requested")
                assert ev2["data"]["req_id"] == ev["data"]["req_id"]
                assert ev2["data"].get("reasked") is True
                assert ev2["data"]["tool"] == "write_file"
                await c2.call("answer", req_id=ev2["data"]["req_id"], response={"allow": True})
                fin = await c2.wait_event("turn_finished")
                assert fin["data"]["status"] == "done", fin
                assert (project / "hello.txt").read_text() == "hi"

    asyncio.run(scenario())


def test_delete_sessions(server_process):
    url, project, home = server_process

    async def scenario():
        async with websockets.connect(url) as ws:
            c = Client(ws)
            # open_project is idempotent (reusing the engine), so extra sessions
            # are created with new_session
            (await c.call("open_project", root=str(project)))
            others = [(await c.call("new_session"))["session_id"] for _ in range(2)]
            current = (await c.call("open_project", root=str(project)))["session_id"]
            assert current not in others
            # delete two non-current sessions
            r = await c.call("delete_sessions", session_ids=others)
            assert r["ok"] and r["deleted"] == 2 and "new_session" not in r
            # (summaries only list sessions with turns, so just check the deleted ones are gone)
            left = [s["id"] for s in (await c.call("session_summaries"))["sessions"]]
            assert not (set(others) & set(left))
            # deleting the current session starts a fresh one
            r = await c.call("delete_sessions", session_ids=[current])
            assert r["ok"] and r["new_session"] != current

    asyncio.run(scenario())
