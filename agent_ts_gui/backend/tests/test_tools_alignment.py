"""Tests for network approval, web search/fetch, browser tools, vision fallback and MCP."""

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

from coder_agent import agent as agent_mod
from coder_agent.approval import ApprovalPolicy
from coder_agent.config import ServerConfig
from coder_agent.tools import browser, web
from coder_agent.tools.base import ToolContext, ToolError
from coder_agent.tools.mcp_client import McpHub, load_servers
from coder_agent.util import is_local_host

PAGE = b"""<html><head><title>Demo</title></head><body>
<h1>Hello page</h1>
<input placeholder="Your name">
<button onclick="console.log('clicked!'); document.title='Clicked'">Press me</button>
</body></html>"""


class _Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/search"):
            body = json.dumps({"results": [
                {"title": "Python <b>docs</b>", "url": "https://docs.python.org", "content": "Official &amp; docs"},
                {"title": "Second", "url": "https://b.example", "content": ""},
            ]}).encode()
            ctype = "application/json"
        elif self.path == "/page":
            body, ctype = (b"<html><head><title> My  Page </title><style>x{}</style></head>"
                           b"<body><script>evil()</script><p>World &amp; more</p></body></html>"), "text/html"
        elif self.path == "/demo":
            body, ctype = PAGE, "text/html"
        elif self.path == "/other":
            body, ctype = (b"<html><head><title>Other</title></head><body><h1>Other page</h1></body></html>"), "text/html"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture(scope="module")
def site():
    srv = HTTPServer(("127.0.0.1", 0), _Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


def test_is_local_host():
    assert is_local_host("localhost") and is_local_host("127.0.0.1") and is_local_host("10.1.2.3")
    assert is_local_host("intranet") and is_local_host("box.lan")
    assert is_local_host("::1")
    assert not is_local_host("example.com") and not is_local_host("8.8.8.8")


def test_ask_user_tool(ctx):
    from coder_agent.tools.interact import ask_user

    with pytest.raises(ToolError, match="no user"):
        ask_user(ctx, {"question": "q"})
    seen = {}

    def fake(data):
        seen.update(data)
        return {"answer": "b", "custom": True}

    ctx.ask_user = fake
    out = ask_user(ctx, {"question": " Pick? ", "options": ["a", {"label": "b", "description": "d"}, 5, {"label": " "}]})
    assert out == "The user typed their own answer: b"
    assert seen["options"] == [{"label": "a", "description": ""}, {"label": "b", "description": "d"}]
    assert seen["question"] == "Pick?" and seen["allow_freeform"] is True
    ctx.ask_user = lambda data: {"dismissed": True}
    assert "dismissed" in ask_user(ctx, {"question": "q"})
    ctx.ask_user = lambda data: None
    assert "dismissed" in ask_user(ctx, {"question": "q", "options": ["x"], "allow_freeform": False})


def test_update_todo_tool(ctx):
    from coder_agent.tools.interact import todo_block, update_todo

    with pytest.raises(ToolError, match="todos is empty"):
        update_todo(ctx, {"todos": []})
    events = []
    ctx.emit = lambda kind, data: events.append((kind, data))
    out = update_todo(ctx, {"todos": [
        "step one",
        {"content": "  step two  ", "status": "in_progress"},
        {"content": "step three", "status": "done"},
        {"content": "bad", "status": "nope"},
        5,
    ]})
    assert "1/4 done" in out and "[x] step three" in out and "[~] step two" in out
    assert ctx.todos == [
        {"content": "step one", "status": "pending"},
        {"content": "step two", "status": "in_progress"},
        {"content": "step three", "status": "done"},
        {"content": "bad", "status": "pending"},
    ]
    assert events[0][0] == "todo_updated"
    assert "All items are done" in update_todo(ctx, {"todos": [{"content": "a", "status": "done"}]})
    assert "Current todo list" in todo_block(ctx.todos) and "finish with the final answer" in todo_block(ctx.todos)
    assert todo_block([]) == ""


def test_network_and_mcp_approval_defaults():
    policy = ApprovalPolicy({"network": {"default": "ask", "allow": ["*.docs.example"]}, "mcp": {"allow": ["mcp__fs__read_*"]}})
    assert policy.check_network("127.0.0.1").action == "allow"
    assert policy.check_network("example.com").action == "ask"
    assert policy.check_network("x.docs.example").action == "allow"
    assert policy.check_mcp("mcp__fs__read_file").action == "allow"
    assert policy.check_mcp("mcp__git__push").action == "ask"
    policy.session_approve = True
    assert policy.check_network("example.com").action == "allow"


def test_web_search_and_fetch(site, ctx, monkeypatch):
    monkeypatch.setenv("SEARXNG_URL", site)
    out = web.web_search(ctx, {"query": "python", "max_results": 2})
    assert "1. Python docs" in out and "Official & docs" in out and "https://b.example" in out
    text = web.web_fetch(ctx, {"url": site + "/page"})
    assert text.startswith("My Page") and "World & more" in text and "evil" not in text
    with pytest.raises(ToolError):
        web.web_fetch(ctx, {"url": "file:///etc/passwd"})


def test_search_unconfigured_raises(ctx, monkeypatch):
    monkeypatch.delenv("SEARXNG_URL", raising=False)
    monkeypatch.delenv("BRAVE_API_KEY", raising=False)
    with pytest.raises(ToolError, match="not configured"):
        web.web_search(ctx, {"query": "x"})


def test_strip_old_images():
    from coder_agent.context.compression import strip_old_images

    img = lambda tag: [{"type": "text", "text": tag}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAA"}}]
    msgs = [{"role": "user", "content": "old shot"},
            {"role": "user", "content": img("one")},
            {"role": "user", "content": "plain"},
            {"role": "user", "content": img("two")}]
    out = strip_old_images(msgs, keep_last=1)
    assert out[0]["content"] == "old shot" and out[2]["content"] == "plain"
    assert out[1]["content"][1]["type"] == "text" and "removed" in out[1]["content"][1]["text"]
    assert out[3]["content"][1]["type"] == "image_url"  # newest image kept
    out = strip_old_images(msgs, keep_last=0)
    assert all(p["type"] == "text" for m in out for p in m["content"] if isinstance(p, dict) and ("type" in p))
    assert strip_old_images([{"role": "user", "content": "x"}]) == [{"role": "user", "content": "x"}]


def test_grep_search_with_context(tmp_path):
    from coder_agent.tools import fs

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("line one\nneedle here\nline three\nline four\n", encoding="utf-8")
    (tmp_path / "src" / "b.py").write_text("nothing\nNEEDLE upper\n", encoding="utf-8")
    ctx = ToolContext(root=tmp_path)

    out = fs.grep_search(ctx, {"pattern": "needle", "path": "src"})
    assert "a.py:2" in out and "b.py:2" in out  # case-insensitive by default
    out = fs.grep_search(ctx, {"pattern": "needle", "path": "src", "context_lines": 1})
    assert "a.py:1- line one" in out and "a.py:3- line three" in out
    assert "b.py:1- nothing" in out
    out = fs.grep_search(ctx, {"pattern": "needle", "path": "src", "case_sensitive": True})
    assert "a.py" in out and "b.py" not in out
    out = fs.grep_search(ctx, {"pattern": "^line", "path": "src", "is_regex": True, "glob": "*.py"})
    assert "a.py:1" in out
    assert fs.grep_search(ctx, {"pattern": "zzz-nope"}) == "(no matches)"
    with pytest.raises(ToolError, match="invalid regex"):
        fs.grep_search(ctx, {"pattern": "(", "is_regex": True})


def test_route_blocks_unapproved_public_navigation():
    b = browser._Browser()

    class Req:
        def __init__(self, url, nav):
            self.url, self._nav = url, nav

        def is_navigation_request(self):
            return self._nav

    class Route:
        def __init__(self):
            self.action = None

        def abort(self, reason):
            self.action = ("abort", reason)

        def continue_(self):
            self.action = ("continue",)

    r = Route()
    b._route(r, Req("http://public.example/x", True))
    assert r.action[0] == "abort"
    r = Route()
    b._route(r, Req("http://public.example/img.png", False))
    assert r.action == ("continue",)
    b.approved_hosts.add("public.example")
    r = Route()
    b._route(r, Req("http://public.example/x", True))
    assert r.action == ("continue",)


def test_browser_flow(site, ctx):
    try:
        nav = browser.browser_navigate(ctx, {"url": site + "/demo"})
    except ToolError as e:
        pytest.skip(str(e))
    assert "navigated (HTTP 200)" in nav and "Hello page" in nav
    snap = browser.browser_snapshot(ctx, {})
    button = next(r for r in snap.splitlines() if 'button "Press me"' in r)
    field = next(r for r in snap.splitlines() if '"Your name"' in r)
    browser.browser_click(ctx, {"ref": button.split("]")[0].lstrip("[")})
    assert "Clicked" in browser.browser_snapshot(ctx, {})
    assert "console.log: clicked!" in browser.browser_console_messages(ctx, {})
    typed = browser.browser_type(ctx, {"ref": field.split("]")[0].lstrip("["), "text": "Ada"})
    assert "typed into" in typed
    shot = browser.browser_take_screenshot(ctx, {})
    assert shot.images[0]["data_url"].startswith("data:image/jpeg;base64,")
    with pytest.raises(ToolError, match="ref must look like"):
        browser.browser_click(ctx, {"ref": "button"})
    # multi-tab: open a second page, switch back, close everything
    tab2 = browser.browser_new_tab(ctx, {"url": site + "/other"})
    assert "opened tab 2" in tab2 and "Other page" in tab2
    back = browser.browser_switch_tab(ctx, {"index": 1})
    assert "switched to tab 1 (2 open)" in back and "Hello page" in back
    with pytest.raises(ToolError, match="tab index must be"):
        browser.browser_switch_tab(ctx, {"index": 9})
    browser.browser_close(ctx, {})


def test_vision_fallback_drops_images_for_text_only_model(monkeypatch):
    class Provider:
        server = ServerConfig(base_url="http://127.0.0.1:1/v1", model="m")

    a = agent_mod.Agent.__new__(agent_mod.Agent)
    a.provider = Provider()
    monkeypatch.setattr(agent_mod, "probe_vision", lambda server: False)
    assert a._images_supported() is False
    monkeypatch.setattr(agent_mod, "probe_vision", lambda server: None)
    assert a._images_supported() is True


SERVER_SRC = '''
from mcp.server.mcpserver import MCPServer

srv = MCPServer("demo")


@srv.tool()
def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    srv.run()
'''


def test_mcp_round_trip(tmp_path):
    script = tmp_path / "demo_server.py"
    script.write_text(SERVER_SRC, encoding="utf-8")
    cfg = tmp_path / "mcp.json"
    cfg.write_text(json.dumps({"mcpServers": {"demo": {"command": __import__("sys").executable, "args": [str(script)]}}}))
    servers = load_servers(tmp_path, {})
    assert servers == {}  # project .mcp.json is ignored unless the policy opts in
    hub = McpHub({"demo": {"command": __import__("sys").executable, "args": [str(script)]}})
    try:
        tools = {t.name: t for t in hub.start()}
        assert "mcp__demo__add" in tools and tools["mcp__demo__add"].kind == "mcp"
        out = tools["mcp__demo__add"].func(ToolContext(root=tmp_path), {"a": 2, "b": 3})
        assert "5" in out.text
    finally:
        hub.close()
    hub._thread.join(timeout=10)
    assert not hub._thread.is_alive() and not hub._stops
