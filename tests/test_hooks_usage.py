"""Tests for hooks (.agent/hooks.toml) and per-turn usage stats."""

import json
import threading

from coder_agent.agent import Agent
from coder_agent.approval import ApprovalPolicy
from coder_agent.config import AgentConfig, AppConfig, ContextConfig, ThinkingConfig
from coder_agent.context import ContextManager
from coder_agent.events import EventBus
from coder_agent.hooks import HookRunner
from coder_agent.llm import LLMChunk, LLMProvider, ToolCall, Usage
from coder_agent.tools import default_registry
from coder_agent.tools.base import ToolContext


class ScriptedProvider(LLMProvider):
    def __init__(self, replies):
        self.replies = list(replies)

    def stream_chat(self, messages, tools=None, cancel=None, thinking=None, max_tokens=None, steer=None):
        reply = self.replies.pop(0) if self.replies else {"content": "done"}
        if reply.get("content"):
            yield LLMChunk("content", reply["content"])
        calls = [ToolCall(f"c{i}", n, json.dumps(a)) for i, (n, a) in enumerate(reply.get("tool_calls", []))]
        if calls:
            yield LLMChunk("tool_calls", tool_calls=calls)
        yield LLMChunk("usage", usage=Usage(100, 10, 110))
        yield LLMChunk("done", finish_reason="tool_calls" if calls else "stop")

    def complete(self, messages, cancel=None, thinking=False, max_tokens=None):
        return "summary"

    def list_models(self):
        return ["fake"]


def _make_agent(tmp_path, provider, hooks=None):
    policy = ApprovalPolicy.load(tmp_path)
    tool_ctx = ToolContext(root=tmp_path, hooks=hooks)
    return Agent("main", provider, default_registry(), tool_ctx, policy, None,
                 ContextManager(ContextConfig()), EventBus(), AgentConfig(),
                 ThinkingConfig(), threading.Event())


# ------------------------------------------------------------------- hooks
def test_hook_pre_tool_blocks(tmp_path):
    (tmp_path / ".agent").mkdir()
    (tmp_path / ".agent" / "hooks.toml").write_text(
        '[[hooks]]\nevent = "pre_tool"\ntool = "write_file"\ncommand = "echo protected >&2; exit 2"\n'
    )
    hooks = HookRunner(tmp_path)
    res = hooks.run("pre_tool", tool="write_file", args={"path": "x"})
    assert res.blocked
    assert "protected" in res.messages[0]


def test_hook_tool_matcher_and_passthrough(tmp_path):
    (tmp_path / ".agent").mkdir()
    (tmp_path / ".agent" / "hooks.toml").write_text(
        '[[hooks]]\nevent = "pre_tool"\ntool = "write_*"\ncommand = "exit 2"\n'
        '[[hooks]]\nevent = "post_tool"\ncommand = "echo formatted"\n'
    )
    hooks = HookRunner(tmp_path)
    assert hooks.run("pre_tool", tool="write_file").blocked
    assert not hooks.run("pre_tool", tool="read_file").blocked
    res = hooks.run("post_tool", tool="read_file", status="ok", output="x")
    assert not res.blocked and res.messages == ["formatted"]


def test_hook_missing_file_is_noop(tmp_path):
    hooks = HookRunner(tmp_path)
    res = hooks.run("pre_tool", tool="write_file")
    assert not res.blocked and res.messages == []


def test_hook_pre_tool_blocks_tool_in_agent(tmp_path):
    (tmp_path / ".agent").mkdir()
    (tmp_path / ".agent" / "hooks.toml").write_text(
        '[[hooks]]\nevent = "pre_tool"\ntool = "write_file"\ncommand = "echo no writes >&2; exit 2"\n'
    )
    provider = ScriptedProvider([
        {"tool_calls": [("write_file", {"path": "a.txt", "content": "x"})]},
        {"content": "ok"},
    ])
    agent = _make_agent(tmp_path, provider, HookRunner(tmp_path))
    msgs = [{"role": "user", "content": "write a.txt"}]
    res = agent.run(msgs)
    assert res.status == "done"
    assert not (tmp_path / "a.txt").exists()
    # the model saw the block message
    assert any("BLOCKED by hook" in m.get("content", "") for m in msgs if m.get("role") == "tool")


def test_hook_post_tool_appends_to_result(tmp_path):
    (tmp_path / ".agent").mkdir()
    (tmp_path / ".agent" / "hooks.toml").write_text(
        '[[hooks]]\nevent = "post_tool"\ntool = "read_file"\ncommand = "echo lint-ok"\n'
    )
    (tmp_path / "a.txt").write_text("hello")
    provider = ScriptedProvider([
        {"tool_calls": [("read_file", {"path": "a.txt"})]},
        {"content": "ok"},
    ])
    agent = _make_agent(tmp_path, provider, HookRunner(tmp_path))
    msgs = [{"role": "user", "content": "read a.txt"}]
    res = agent.run(msgs)
    assert res.status == "done"
    # the tool result fed to the model contains the hook output
    tool_msgs = [m for m in msgs if m.get("role") == "tool"]
    assert tool_msgs and "[hook] lint-ok" in tool_msgs[0]["content"]


def test_hook_pre_compact_blocks(tmp_path):
    hooks = HookRunner(tmp_path)
    (tmp_path / ".agent").mkdir()
    (tmp_path / ".agent" / "hooks.toml").write_text(
        '[[hooks]]\nevent = "pre_compact"\ncommand = "exit 2"\n'
    )
    hooks.reload()
    assert hooks.run("pre_compact").blocked


# ------------------------------------------------------------- usage stats
def test_usage_stats_in_result(tmp_path):
    provider = ScriptedProvider([
        {"tool_calls": [("read_file", {"path": "a.txt"})]},
        {"content": "done"},
    ])
    agent = _make_agent(tmp_path, provider)
    res = agent.run([{"role": "user", "content": "read a.txt"}])
    assert res.status == "done"
    u = res.usage
    assert u["steps"] == 2
    assert u["prompt"] == 200  # two calls x 100 prompt tokens
    assert u["completion"] == 20
    assert u["ttft_avg_s"] >= 0
    assert u["tool_s"] >= 0
    assert u["wall_s"] >= 0
