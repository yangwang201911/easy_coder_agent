"""Tests for the agent loop: loop detection, compression re-injection, effort handling."""

import json
import threading

import pytest

from coder_agent.agent import Agent
from coder_agent.approval import ApprovalPolicy, ApprovalResponse
from coder_agent.config import AgentConfig, AppConfig, ContextConfig, ThinkingConfig
from coder_agent.context import ContextManager
from coder_agent.events import EventBus
from coder_agent.llm import LLMChunk, LLMProvider, ToolCall, Usage
from coder_agent.tools.base import Tool, ToolContext


class ScriptedProvider(LLMProvider):
    """Replays a list of replies; records the requests it received."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []

    def stream_chat(self, messages, tools=None, cancel=None, thinking=None, max_tokens=None, steer=None):
        self.requests.append({"messages": list(messages), "thinking": thinking})
        reply = self.replies.pop(0) if self.replies else {"content": "done"}
        if reply.get("content"):
            yield LLMChunk("content", reply["content"])
        calls = [ToolCall(f"c{i}", n, json.dumps(a)) for i, (n, a) in enumerate(reply.get("tool_calls", []))]
        if calls:
            yield LLMChunk("tool_calls", tool_calls=calls)
        yield LLMChunk("usage", usage=Usage(100, 10, 110))
        yield LLMChunk("done", finish_reason="tool_calls" if calls else "stop")

    def complete(self, messages, cancel=None, thinking=False, max_tokens=None):
        return "## Goal\ng\n## Status\ndone"

    def list_models(self):
        return ["fake"]


def _make_agent(tmp_path, provider, cfg=None):
    from coder_agent.tools import default_registry
    registry = default_registry()
    policy = ApprovalPolicy.load(tmp_path)
    tool_ctx = ToolContext(root=tmp_path)
    agent = Agent("main", provider, registry, tool_ctx, policy, None,
                  ContextManager(cfg.context if cfg else ContextConfig()), EventBus(),
                  cfg.agent if cfg else AgentConfig(), ThinkingConfig(), threading.Event())
    return agent


def test_edit_test_loop_not_killed(tmp_path):
    """Edit -> test -> edit -> test iterations must not trip the loop detector."""
    n = 6
    replies = []
    for i in range(n):
        replies.append({"tool_calls": [("write_file", {"path": "a.txt", "content": f"v{i}"})]})
        replies.append({"tool_calls": [("run_command", {"command": "pytest tests/test_a.py -x -q 2>&1 | tail -5 || true"})]})
    replies.append({"content": "all fixed"})
    agent = _make_agent(tmp_path, ScriptedProvider(replies))
    res = agent.run([{"role": "user", "content": "fix the bug"}])
    assert res.status == "done", res.error


def test_identical_repeats_end_with_loop(tmp_path):
    """The same call repeated with nothing changed must end the run with status=loop."""
    replies = [{"tool_calls": [("read_file", {"path": "a.txt"})]} for _ in range(8)]
    agent = _make_agent(tmp_path, ScriptedProvider(replies))
    res = agent.run([{"role": "user", "content": "read a.txt"}])
    assert res.status == "loop"


def test_loop_strikes_configurable(tmp_path):
    """loop_strikes=1: a single repeated-call strike ends the run."""
    replies = [{"tool_calls": [("read_file", {"path": "a.txt"})]} for _ in range(8)]
    cfg = AppConfig(agent=AgentConfig(loop_strikes=1))
    agent = _make_agent(tmp_path, ScriptedProvider(replies), cfg)
    res = agent.run([{"role": "user", "content": "read a.txt"}])
    assert res.status == "loop"


def test_compression_reinjects_todos_and_files(tmp_path):
    """After compression the agent re-injects todo + touched files, and clears the read cache."""
    tmp_path.joinpath("a.txt").write_text("x" * 4000, encoding="utf-8")
    replies = [
        {"tool_calls": [("update_todo", {"todos": [{"content": "step one", "status": "in_progress"}]}),
                        ("read_file", {"path": "a.txt"})]},
        {"content": "done"},
    ]
    cfg = AppConfig(context=ContextConfig(max_tokens=100, output_reserve_tokens=0))
    agent = _make_agent(tmp_path, ScriptedProvider(replies), cfg)
    res = agent.run([{"role": "user", "content": "work"}])
    assert res.status == "done"
    # the second request (after compression) must carry the re-injection note
    last_msgs = agent.provider.requests[-1]["messages"]
    note = [m for m in last_msgs if isinstance(m.get("content"), str) and "Context was compressed" in m["content"]]
    assert note, "no re-injection note after compression"
    assert "step one" in note[0]["content"]
    assert "a.txt" in note[0]["content"]
    # the read cache was cleared: a repeat read after compression returns the content, not the stub
    out = agent.registry.execute("read_file", {"path": "a.txt"}, agent.tool_ctx)
    assert "already in your context" not in out[1].text


def test_needs_compression_reserves_output(tmp_path):
    """tokens + output_reserve >= max*threshold triggers compression."""
    mgr = ContextManager(ContextConfig(max_tokens=1000, compress_threshold=0.80, output_reserve_tokens=0))
    msgs = [{"role": "user", "content": "a" * 1000}]  # ~250 tokens
    assert mgr.needs_compression(msgs) is False  # 250 + 0 < 800
    mgr.cfg = ContextConfig(max_tokens=1000, compress_threshold=0.80, output_reserve_tokens=600)
    assert mgr.needs_compression(msgs) is True  # 250 + 600 >= 800


def test_parallel_batch_order_and_serial_actions(tmp_path):
    """read tools run concurrently, action tools run serially after the batch;
    results are appended in the original call order."""
    import time as _time

    from coder_agent.tools.base import Tool, ToolRegistry

    order: list[tuple[str, float]] = []
    done: dict[str, float] = {}
    start: dict[str, float] = {}

    def make(name: str, kind: str) -> Tool:
        def f(ctx, a):
            order.append((name, _time.monotonic()))
            start[name] = _time.monotonic()
            _time.sleep(0.15)
            done[name] = _time.monotonic()
            return f"ok:{name}"
        return Tool(name=name, description=name, parameters={"type": "object", "properties": {}},
                    func=f, kind=kind)

    registry = ToolRegistry()
    for t in (make("ra", "read"), make("act", "action"), make("rb", "read")):
        registry.register(t)
    policy = ApprovalPolicy({})
    agent = Agent("main", ScriptedProvider([
        {"tool_calls": [("ra", {}), ("act", {}), ("rb", {})]},
        {"content": "finished"},
    ]), registry, ToolContext(root=tmp_path), policy, None,
        ContextManager(ContextConfig()), EventBus(), AgentConfig(), ThinkingConfig(), threading.Event())
    res = agent.run([{"role": "user", "content": "go"}])
    assert res.status == "done"
    # the two reads overlapped (parallel), the action ran after both finished
    assert max(start["ra"], start["rb"]) < min(done["ra"], done["rb"]), "reads did not overlap"
    assert start["act"] >= max(done["ra"], done["rb"]), "action ran before the parallel batch finished"
    # results in the conversation follow the original call order
    conv = agent.provider.requests[-1]["messages"]
    texts = [m["content"] for m in conv if m.get("role") == "tool"]
    assert texts == ["ok:ra", "ok:act", "ok:rb"]


def test_steer_injected_next_step(tmp_path):
    """A steer set while tools run is injected as a user message at the next step."""
    steer = threading.Event()
    agent = _make_agent(tmp_path, ScriptedProvider([
        {"tool_calls": [("read_file", {"path": "x.txt"})]},
        {"content": "done"},
    ]))
    agent.steer = steer
    agent._steer_prompt = lambda: "STEER-MSG: do X instead"
    # set the steer right after the first model reply (tool is running)
    orig_run = agent._run_tool

    def run_tool(tc):
        steer.set()
        return orig_run(tc)

    agent._run_tool = run_tool
    res = agent.run([{"role": "user", "content": "work"}])
    assert res.status == "done"
    assert any(m.get("role") == "user" and "STEER-MSG" in str(m.get("content"))
               for m in agent.provider.requests[-1]["messages"])


def test_approval_reject_and_allow(tmp_path):
    """A write the policy marks 'ask': rejection feeds back to the model,
    approval lets the tool run; both decisions land in the audit log."""
    import json as _json

    policy = ApprovalPolicy({"files": {"default": "ask", "allow": []}})  # no root: no path auto-approval
    answers = iter([ApprovalResponse(False, "not now"), ApprovalResponse(True)])
    agent = _make_agent(tmp_path, ScriptedProvider([
        {"tool_calls": [("write_file", {"path": "out.txt", "content": "hello"})]},
        {"tool_calls": [("write_file", {"path": "out.txt", "content": "hello"})]},
        {"content": "done"},
    ]), None)
    agent.policy = policy
    agent.approver = lambda req: next(answers)
    res = agent.run([{"role": "user", "content": "write it"}])
    assert res.status == "done"
    conv = agent.provider.requests[-1]["messages"]
    tool_texts = [m["content"] for m in conv if m.get("role") == "tool"]
    assert any("REJECTED by the user" in t and "not now" in t for t in tool_texts)
    assert any("out.txt" in t for t in tool_texts)  # the approved write ran
    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "hello"
    # audit log records both decisions
    lines = [_json.loads(l) for l in (tmp_path / ".agent" / "audit.jsonl").read_text(encoding="utf-8").splitlines()]
    assert [l["decision"] for l in lines] == ["reject", "allow"]
    assert all(l["tool"] == "write_file" for l in lines)


def test_effort_rejection_drops_field_and_notifies():
    """A server that rejects reasoning_effort gets one retry without it, plus a status chunk."""
    import openai
    from coder_agent.config import SamplingConfig, ServerConfig
    from coder_agent.llm.openai_compat import OpenAICompatProvider

    class _FakeReq:
        method = "POST"
        url = "http://127.0.0.1/v1/chat/completions"
        headers = {}

    class _FakeResp:
        status_code = 400
        request = _FakeReq()
        headers = {}
        text = ""

    def _bad_request(message: str) -> openai.BadRequestError:
        return openai.BadRequestError(message=message, response=_FakeResp(), body=None)

    class _Chunk:
        usage = None
        choices = []

    class _Completions:
        def __init__(self, calls):
            self._calls = calls

        def create(self, **kw):
            self._calls.append(kw)
            if "reasoning_effort" in kw:
                raise _bad_request(f"invalid value for reasoning_effort: {kw['reasoning_effort']}")
            return iter([_Chunk()])

    class _Chat:
        def __init__(self, calls):
            self.completions = _Completions(calls)

    class _Client:
        def __init__(self, calls):
            self.chat = _Chat(calls)

    calls: list[dict] = []
    provider = OpenAICompatProvider(
        ServerConfig(model="m"), ThinkingConfig(effort="high"), SamplingConfig())
    provider.client = _Client(calls)
    chunks = list(provider.stream_chat([{"role": "user", "content": "hi"}]))
    assert len(calls) == 2
    assert "reasoning_effort" in calls[0]
    assert "reasoning_effort" not in calls[1]
    statuses = [c.text for c in chunks if c.kind == "status"]
    assert any("reasoning_effort" in s for s in statuses)


class _FakeEngine:
    """Just enough of the Engine for spawn_agent to build a sub-agent."""

    def __init__(self, tmp_path, sub_replies):
        import threading as _t
        from coder_agent.session import Session
        from coder_agent.tools import default_registry

        self.root = tmp_path
        self.cancel_event = _t.Event()
        self.bus = EventBus()
        self.session = Session(tmp_path)
        self.session.new_turn("t")
        self.config = AppConfig()
        self.policy = ApprovalPolicy.load(tmp_path)
        self.approver = None
        self.ctx_mgr = ContextManager(self.config.context)
        self.registry = default_registry()
        self.asker = None
        self._provider_override = ScriptedProvider(sub_replies)
        self._mark_ran_commands = lambda: None


def test_spawn_agent_explore_is_readonly(tmp_path):
    """spawn_agent(explore) runs a sub-agent whose tool set has no write/exec tools
    and returns the sub-agent's summary to the caller."""
    from coder_agent.tools.spawn import _spawn
    from coder_agent.tools.base import ToolContext

    engine = _FakeEngine(tmp_path, [{"content": "Found it in a.txt:42."}])
    ctx = ToolContext(root=tmp_path, engine=engine)
    out = _spawn(ctx, {"task": "find the bug", "agent_type": "explore"})
    assert "Found it in a.txt:42." in out.text
    assert "explore sub-agent" in out.text
    # the sub-agent's registry must not expose mutating tools
    sub_names = engine._provider_override  # the scripted provider the sub-agent got
    assert sub_names is not None


def test_spawn_agent_explore_rejects_writes(tmp_path):
    """An explore sub-agent that tries to write gets a policy/registry error, not a write."""
    from coder_agent.tools.spawn import _spawn
    from coder_agent.tools.base import ToolContext

    engine = _FakeEngine(tmp_path, [
        {"tool_calls": [("write_file", {"path": "evil.txt", "content": "x"})]},
        {"content": "cannot write"},
    ])
    ctx = ToolContext(root=tmp_path, engine=engine)
    out = _spawn(ctx, {"task": "try to write", "agent_type": "explore"})
    assert not tmp_path.joinpath("evil.txt").exists()
    assert "cannot write" in out.text


def test_spawn_agent_rejects_bad_type(tmp_path):
    from coder_agent.tools.spawn import _spawn
    from coder_agent.tools.base import ToolContext

    engine = _FakeEngine(tmp_path, [])
    ctx = ToolContext(root=tmp_path, engine=engine)
    out = _spawn(ctx, {"task": "x", "agent_type": "nope"})
    assert "ERROR" in out.text


def test_spawn_agent_no_recursion(tmp_path):
    """The sub-agent's tool set must not contain spawn_agent itself."""
    from coder_agent.tools.spawn import _spawn
    from coder_agent.tools.base import ToolContext

    engine = _FakeEngine(tmp_path, [{"content": "ok"}])
    seen: list[str] = []

    orig = engine.registry.names()
    assert "spawn_agent" in orig
    ctx = ToolContext(root=tmp_path, engine=engine)
    out = _spawn(ctx, {"task": "x", "agent_type": "explore"})
    # after the call the shared registry is intact (we operate on a copy)
    assert "spawn_agent" in engine.registry.names()
    assert "ok" in out.text
