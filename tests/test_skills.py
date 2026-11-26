"""Skills: front-matter, use_skill tool (dedupe), index injection, skill_body RPC."""

from __future__ import annotations

import pytest

from coder_agent import knowledge
from coder_agent.tools.base import ToolContext


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


def _project_skill(root, name, body, **meta):
    d = root / ".github" / "skills" / name
    d.mkdir(parents=True, exist_ok=True)
    lines = ["---", f"name: {name}", f"description: desc of {name}"]
    for k, v in meta.items():
        lines.append(f"{k}: {v}")
    lines += ["---", body]
    (d / "SKILL.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ------------------------------------------------------------------ loading
def test_load_skill_front_matter(ctx):
    _project_skill(ctx.root, "my-skill", "the body", tools="read_file,grep_search", effort="low", globs="*.py,*.cpp")
    s = knowledge.skill_by_name(ctx.root, "my-skill")
    assert s is not None
    assert s.tools == ["read_file", "grep_search"]
    assert s.effort == "low"
    assert s.globs == ["*.py", "*.cpp"]
    assert s.body == "the body"


def test_skill_without_extra_meta(ctx):
    _project_skill(ctx.root, "plain", "body only")
    s = knowledge.skill_by_name(ctx.root, "plain")
    assert s.tools is None and s.effort is None and s.globs == []


def test_builtin_skills_present(ctx):
    skills = knowledge.load_skills(ctx.root)
    for name in ("debug-cpp", "windows-linux-scripts", "git-workflow", "code-review",
                 "write-tests", "web-research", "python-debug"):
        assert name in skills, f"builtin skill {name} missing"


def test_skill_index_in_prompt(ctx):
    _project_skill(ctx.root, "indexed-skill", "hidden body")
    from coder_agent.prompts.builder import PromptBuilder
    from coder_agent.prompts.registry import TaskTypeRegistry

    reg = TaskTypeRegistry.load(ctx.root)
    prompt = PromptBuilder(ctx.root, reg).build(reg.get("general"))
    assert "indexed-skill" in prompt
    assert "hidden body" not in prompt  # index only, body not injected


# ------------------------------------------------------------------ use_skill
def test_use_skill_loads_body(ctx):
    _project_skill(ctx.root, "loadable", "step one\nstep two")
    tool = knowledge.use_skill_tool()
    out = tool.func(ctx, {"name": "loadable"})
    assert "step one" in out and "step two" in out
    assert "[skill 'loadable'" in out


def test_use_skill_dedupes_per_run(ctx):
    _project_skill(ctx.root, "once", "the full body here")
    tool = knowledge.use_skill_tool()
    first = tool.func(ctx, {"name": "once"})
    assert "the full body here" in first
    second = tool.func(ctx, {"name": "once"})
    assert "the full body here" not in second
    assert "already loaded" in second


def test_use_skill_unknown_lists_available(ctx):
    tool = knowledge.use_skill_tool()
    out = tool.func(ctx, {"name": "nope"})
    assert "No skill named 'nope'" in out
    assert "debug-cpp" in out  # available skills listed


def test_use_skill_max_chars(ctx):
    _project_skill(ctx.root, "long", "x" * 10000)
    tool = knowledge.use_skill_tool()
    out = tool.func(ctx, {"name": "long", "max_chars": 500})
    assert len(out) < 1000  # truncated, not the full 10k body


def test_use_skill_reports_tools_and_effort(ctx):
    _project_skill(ctx.root, "constrained", "body", tools="read_file", effort="high")
    tool = knowledge.use_skill_tool()
    out = tool.func(ctx, {"name": "constrained"})
    assert "read_file" in out and "high" in out


# ------------------------------------------------------------------ registry
def test_use_skill_in_default_registry():
    from coder_agent.tools import default_registry

    reg = default_registry()
    assert reg.get("use_skill") is not None
    assert reg.get("use_skill").kind == "read"


# ------------------------------------------------------------------ skill_body RPC
def test_skill_body_rpc(ctx, monkeypatch):
    from coder_agent import server as server_mod

    _project_skill(ctx.root, "rpc-skill", "rpc body content")

    class FakeEngine:
        root = ctx.root

    class FakeServer:
        def __init__(self):
            self._engine = FakeEngine()

        def _require_engine(self):
            return self._engine

    s = FakeServer()
    out = server_mod.Server.skill_body(s, {"name": "rpc-skill"})
    assert out["name"] == "rpc-skill" and "rpc body content" in out["body"]

    bad = server_mod.Server.skill_body(s, {"name": "missing"})
    assert "unknown skill" in bad["error"] and "rpc-skill" in bad["available"]
