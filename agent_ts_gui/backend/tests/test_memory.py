"""Structured memory: typed notes, index injection, dedupe, search, migration."""

from __future__ import annotations

import pytest

from coder_agent import knowledge, memory
from coder_agent.tools.base import ToolContext


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


# ------------------------------------------------------------------ storage
def test_write_and_read_note(ctx):
    n = memory.write_note(ctx.root, "build with cmake -B build", name="build-command",
                          description="how to build", type="project")
    assert n.name == "build-command" and n.type == "project"
    got = memory.find_note(ctx.root, "build-command")
    assert got is not None and "cmake" in got.body


def test_write_note_slug_when_unnamed(ctx):
    n = memory.write_note(ctx.root, "use bash not zsh for scripts")
    assert n.name == "use-bash-not-zsh-for"  # first 5 words
    assert memory.find_note(ctx.root, n.name) is not None


def test_upsert_by_name_does_not_duplicate(ctx):
    memory.write_note(ctx.root, "first version", name="a-note")
    memory.write_note(ctx.root, "second version", name="a-note")
    notes = memory.list_notes(ctx.root, "project")
    assert len(notes) == 1
    assert notes[0].body == "second version"


def test_dedupe_by_identical_body(ctx):
    memory.write_note(ctx.root, "always run lint before commit")
    memory.write_note(ctx.root, "always run lint before commit")
    assert len(memory.list_notes(ctx.root, "project")) == 1


def test_delete_note(ctx):
    memory.write_note(ctx.root, "to be deleted", name="gone")
    assert memory.delete_note(ctx.root, "gone") is True
    assert memory.find_note(ctx.root, "gone") is None
    assert memory.delete_note(ctx.root, "gone") is False


def test_search_ranks_by_hits(ctx):
    memory.write_note(ctx.root, "cmake builds go into build/", name="build-dir")
    memory.write_note(ctx.root, "the cmake cache is stale after switching branches",
                      name="cmake-stale-cache")
    hits = memory.search_notes(ctx.root, "cmake")
    assert [h.name for h in hits][0] == "cmake-stale-cache"  # more hits first
    assert memory.search_notes(ctx.root, "zzz-nothing") == []


def test_scopes_are_separate(ctx, monkeypatch, tmp_path):
    monkeypatch.setattr(memory, "user_dir", lambda: tmp_path / "home")
    memory.write_note(ctx.root, "project fact", name="p", scope="project")
    memory.write_note(ctx.root, "global fact", name="g", scope="global")
    assert [n.name for n in memory.list_notes(ctx.root, "project")] == ["p"]
    assert [n.name for n in memory.list_notes(ctx.root, "global")] == ["g"]
    # find_note sees both scopes
    assert memory.find_note(ctx.root, "g") is not None


def test_eviction_over_cap(ctx, monkeypatch):
    monkeypatch.setattr(memory, "MAX_NOTES_PER_SCOPE", 3)
    for i in range(5):
        memory.write_note(ctx.root, f"note number {i}", name=f"n{i}")
    names = [n.name for n in memory.list_notes(ctx.root, "project")]
    assert len(names) == 3
    assert "n0" not in names and "n4" in names  # oldest (by updated, then name) dropped


def test_bad_scope_rejected(ctx):
    with pytest.raises(Exception):
        memory.write_note(ctx.root, "x", scope="bogus")


# ------------------------------------------------------------------ prompt
def test_index_injection_and_truncation(ctx, monkeypatch):
    monkeypatch.setattr(memory, "MAX_INDEX_LINES", 2)
    for i in range(5):
        memory.write_note(ctx.root, f"fact {i}", name=f"n{i}")
    idx = memory.memory_index(ctx.root)
    lines = idx.splitlines()
    assert len(lines) == 2
    assert lines[0].startswith("...(")  # truncation notice
    assert "n4" in lines[1] and "n0" not in idx


def test_builder_injects_index_only(ctx):
    memory.write_note(ctx.root, "the long body that must NOT appear in the prompt",
                      name="secret-note", description="short index line")
    from coder_agent.prompts.builder import PromptBuilder
    from coder_agent.prompts.registry import TaskTypeRegistry

    reg = TaskTypeRegistry.load(ctx.root)
    prompt = PromptBuilder(ctx.root, reg).build(reg.get("general"))
    assert "secret-note: short index line" in prompt
    assert "the long body" not in prompt


# ------------------------------------------------------------------ tools
def test_memory_tools_roundtrip(ctx):
    tools = {t.name: t for t in knowledge.memory_tools()}
    assert set(tools) == {"remember", "memory_write", "memory_read", "memory_delete", "memory_search"}

    out = tools["remember"].func(ctx, {"note": "user prefers tabs"})
    assert "Saved memory" in out
    name = memory.find_note(ctx.root, "user-prefers-tabs").name
    assert "user-prefers-tabs" in tools["memory_read"].func(ctx, {"name": name})

    assert "prefers tabs" in tools["memory_search"].func(ctx, {"query": "tabs"})
    assert "Deleted" in tools["memory_delete"].func(ctx, {"name": name})
    assert "No memory named" in tools["memory_read"].func(ctx, {"name": name})


def test_legacy_memory_md_migration(ctx):
    legacy = ctx.root / ".agent" / "memory.md"
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("- 2026-11-23: build with cmake\n- 2026-11-23: tests need the venv\n", encoding="utf-8")
    notes = memory.list_notes(ctx.root, "project")
    assert len(notes) == 2
    assert legacy.exists() is False  # migrated and removed
    assert any("cmake" in n.body for n in notes)
