"""Tests for MCP enhancements: readOnlyHint mapping, resources/prompts tools,
lazy loading, ${ENV} header expansion, failing servers not affecting others."""

import json
import sys

from coder_agent.tools.base import ToolContext
from coder_agent.tools.mcp_client import McpHub, _expand_env, load_servers

SERVER_SRC = '''
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

srv = MCPServer("demo")


@srv.tool(annotations=ToolAnnotations(readOnlyHint=True))
def ro(a: int) -> int:
    """read-only tool"""
    return a


@srv.tool()
def add(a: int, b: int) -> int:
    return a + b


@srv.resource("res://greeting")
def greeting() -> str:
    return "hello resource"


@srv.prompt()
def greet(name: str) -> str:
    return f"hello {name}"


if __name__ == "__main__":
    srv.run()
'''


def _make_hub(tmp_path, servers=None):
    script = tmp_path / "demo_server.py"
    script.write_text(SERVER_SRC, encoding="utf-8")
    spec = {"command": sys.executable, "args": [str(script)]}
    if servers is None:
        servers = {"demo": spec}
    hub = McpHub(servers)
    return hub


def test_readonly_hint_maps_to_read_kind(tmp_path):
    hub = _make_hub(tmp_path)
    try:
        tools = {t.name: t for t in hub.start()}
        assert tools["mcp__demo__ro"].kind == "read"  # readOnlyHint -> parallel, no approval
        assert tools["mcp__demo__add"].kind == "mcp"
    finally:
        hub.close()


def test_readonly_hint_disabled(tmp_path):
    script = tmp_path / "demo_server.py"
    script.write_text(SERVER_SRC, encoding="utf-8")
    hub = McpHub({"demo": {"command": sys.executable, "args": [str(script)]}}, readonly_hint=False)
    try:
        tools = {t.name: t for t in hub.start()}
        assert tools["mcp__demo__ro"].kind == "mcp"
    finally:
        hub.close()


def test_resources_and_prompts_tools(tmp_path):
    hub = _make_hub(tmp_path)
    try:
        tools = {t.name: t for t in hub.start()}
        ctx = ToolContext(root=tmp_path)
        assert "mcp__demo__list_resources" in tools
        assert "mcp__demo__read_resource" in tools
        assert "mcp__demo__get_prompt" in tools
        out = tools["mcp__demo__list_resources"].func(ctx, {})
        assert "res://greeting" in out.text
        out = tools["mcp__demo__read_resource"].func(ctx, {"uri": "res://greeting"})
        assert "hello resource" in out.text
        out = tools["mcp__demo__get_prompt"].func(ctx, {"name": "greet", "arguments": {"name": "bob"}})
        assert "hello bob" in out.text
    finally:
        hub.close()


def test_lazy_loading_above_threshold(tmp_path):
    script = tmp_path / "demo_server.py"
    script.write_text(SERVER_SRC, encoding="utf-8")
    # 21 tools: the demo server has 2, add 19 dummies
    servers = {"demo": {"command": sys.executable, "args": [str(script)]}}
    hub = McpHub(servers)
    try:
        tools = {t.name: t for t in hub.start()}
        assert "mcp__demo__add" in tools  # only 5 tools: no lazy loading
        # force lazy mode
        for i in range(19):
            from types import SimpleNamespace
            hub._lazy[f"mcp__demo__t{i}"] = ("demo", SimpleNamespace(name=f"t{i}", description=f"tool {i}", input_schema={"type": "object"}))
        lazy = {t.name: t for t in hub.lazy_tools()}
        assert "mcp_search" in lazy and "mcp_call" in lazy
        out = lazy["mcp_search"].func(ToolContext(root=tmp_path), {"query": "tool 3"})
        assert "mcp__demo__t3" in out.text
        out = lazy["mcp_call"].func(ToolContext(root=tmp_path), {"name": "mcp__demo__add", "arguments": {"a": 1, "b": 2}})
        assert "3" in out.text
    finally:
        hub.close()


def test_failing_server_does_not_stop_others(tmp_path):
    script = tmp_path / "demo_server.py"
    script.write_text(SERVER_SRC, encoding="utf-8")
    hub = McpHub({
        "demo": {"command": sys.executable, "args": [str(script)]},
        "broken": {"command": "/nonexistent/binary"},
    })
    try:
        tools = {t.name: t for t in hub.start()}
        assert "mcp__demo__add" in tools
        assert "broken" in hub.errors
        st = hub.status()
        assert st["demo"]["ok"] and st["broken"]["ok"] is False
        assert st["broken"]["error"]
    finally:
        hub.close()


def test_expand_env():
    import os
    os.environ["MY_TEST_TOKEN"] = "sekrit"
    assert _expand_env("Bearer ${MY_TEST_TOKEN}") == "Bearer sekrit"
    assert _expand_env("x-${NO_SUCH_VAR_XYZ}") == "x-"
    os.environ.pop("MY_TEST_TOKEN")


def test_load_servers_project_opt_in(tmp_path):
    (tmp_path / ".mcp.json").write_text(json.dumps({"mcpServers": {"p": {"command": "x"}}}))
    assert load_servers(tmp_path, {}) == {}
    assert load_servers(tmp_path, {"mcp": {"project_servers": True}}) == {"p": {"command": "x"}}
