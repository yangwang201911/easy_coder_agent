"""Knowledge sources injected into the system prompt.

Where things live
-----------------
* repo-specific  -> inside the target repo: ``.github/`` (instructions, skills) and
                    ``.agent/memory.md`` (agent notes about *this* repo)
* shared         -> agent's own area ``~/.coder_agent/`` (skills/, memory/global.md)

Large documents are not pasted into the prompt; only a short index is, and the
model reads the files on demand (keeps the context small for local models).
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .paths import builtin_skills_dir, github_dir, project_cache_dir, user_dir
from .tools.base import Tool, ToolContext, ToolError
from .util import parse_front_matter

IGNORED = {".git", "node_modules", ".venv", "venv", "__pycache__", ".agent", "build", "out", "third_party"}


@dataclass
class IndexEntry:
    name: str
    description: str
    path: str  # as shown to the model (relative to root when possible)


# ------------------------------------------------------------- instructions
def load_general_instructions(root: Path) -> str:
    """``.github/copilot-instructions.md`` + instruction files whose applyTo is global."""
    parts: list[str] = []
    gh = github_dir(root)
    main = gh / "copilot-instructions.md"
    if main.is_file():
        parts.append(main.read_text(encoding="utf-8", errors="replace").strip())
    for f in sorted((gh / "instructions").glob("*.instructions.md")):
        meta, body = parse_front_matter(f.read_text(encoding="utf-8", errors="replace"))
        if meta.get("applyTo", "**").strip() in ("**", "*", "**/*"):
            parts.append(body.strip())
    return "\n\n".join(p for p in parts if p)


def scoped_instruction_index(root: Path) -> list[IndexEntry]:
    out: list[IndexEntry] = []
    for f in sorted((github_dir(root) / "instructions").glob("*.instructions.md")):
        meta, _ = parse_front_matter(f.read_text(encoding="utf-8", errors="replace"))
        scope = meta.get("applyTo", "**").strip()
        if scope not in ("**", "*", "**/*"):
            out.append(IndexEntry(f.name, f"applies to {scope}. {meta.get('description', '')}".strip(), f.relative_to(root).as_posix()))
    return out


def instructions_for_paths(root: Path, rel_paths: list[str]) -> str:
    """Bodies of scoped instruction files matching any of ``rel_paths``."""
    parts: list[str] = []
    for f in sorted((github_dir(root) / "instructions").glob("*.instructions.md")):
        meta, body = parse_front_matter(f.read_text(encoding="utf-8", errors="replace"))
        globs = [g.strip() for g in meta.get("applyTo", "").split(",") if g.strip()]
        if globs and any(fnmatch.fnmatch(p, g) or fnmatch.fnmatch(os.path.basename(p), g) for p in rel_paths for g in globs):
            parts.append(body.strip())
    return "\n\n".join(parts)


# ------------------------------------------------------------------- skills
@dataclass
class Skill:
    name: str
    description: str
    path: Path
    body: str
    triggers: Optional[re.Pattern] = None  # when a failing command's output matches, the body is injected
    source: str = "project"  # builtin | user | project

    def shown_path(self, root: Path) -> str:
        try:
            return self.path.relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            return str(self.path)  # outside the project: readable through read_file (see agent_read_roots)


def load_skills(root: Path) -> dict[str, Skill]:
    """All skills by name. Later layers override earlier ones: builtin < ~/.coder_agent/skills < .github/skills."""
    root = Path(root).resolve()
    skills: dict[str, Skill] = {}
    for source, base in (
        ("builtin", builtin_skills_dir()),
        ("user", user_dir() / "skills"),
        ("project", github_dir(root) / "skills"),
    ):
        for f in sorted(base.glob("*/SKILL.md")):
            meta, body = parse_front_matter(f.read_text(encoding="utf-8", errors="replace"))
            trig = None
            if meta.get("triggers"):
                try:
                    trig = re.compile(meta["triggers"], re.IGNORECASE)
                except re.error:
                    trig = None  # a bad pattern must not break the agent
            name = meta.get("name", f.parent.name)
            skills[name] = Skill(name, meta.get("description", ""), f.resolve(), body.strip(), trig, source)
    return skills


def skill_index(root: Path) -> list[IndexEntry]:
    return [IndexEntry(s.name, s.description, s.shown_path(root)) for s in load_skills(root).values()]


def matching_skills(root: Path, text: str, exclude: Optional[set[str]] = None) -> list[Skill]:
    """Skills whose ``triggers`` pattern matches ``text`` (e.g. the output of a failed build)."""
    return [s for s in load_skills(root).values()
            if s.triggers and s.name not in (exclude or set()) and s.triggers.search(text)]


# ---------------------------------------------------------- module docs
def module_index(root: Path, max_depth: int = 5, limit: int = 60) -> list[IndexEntry]:
    """Every directory holding a MODULE.md, with its one-line description."""
    entries: list[IndexEntry] = []
    root = Path(root)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).relative_to(root).parts)
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED and depth < max_depth)
        if "MODULE.md" in filenames:
            f = Path(dirpath) / "MODULE.md"
            _, body = parse_front_matter(f.read_text(encoding="utf-8", errors="replace"))
            heading = desc = ""
            for line in body.splitlines():
                s = line.strip()
                if not s:
                    continue
                if s.startswith("#"):
                    heading = heading or s.lstrip("#").strip()
                    continue
                desc = s
                break
            desc = desc or heading
            rel = f.relative_to(root).as_posix()
            entries.append(IndexEntry(f.parent.relative_to(root).as_posix() or ".", desc[:160], rel))
            if len(entries) >= limit:
                break
    return entries


# ------------------------------------------------------------------- memory
# Structured notes live in memory.py; this module keeps the prompt injection and
# the model-facing tools. Each note is one md file (front-matter typed); only
# the one-line index is injected, bodies are read on demand with memory_read.
from . import memory as _memory  # noqa: E402  (local import: memory depends on tools.base)


def load_memory(root: Path) -> str:
    """The memory index (one line per note) for the system prompt."""
    return _memory.memory_index(root)


def append_memory(root: Path, note: str, scope: str = "project") -> Path:
    return _memory.write_note(root, note, scope=scope).path


def extract_memory(provider, root: Path, prompt: str, final_text: str,
                   cancel: Optional[threading.Event] = None) -> list[str]:
    """Ask the model (thinking off, small budget) for durable facts from this turn.

    Only facts that are long-term useful AND not derivable from the code itself
    qualify. Returns the notes that were actually saved (empty when nothing is
    worth keeping). Never raises: extraction is best-effort and must not break
    the turn.
    """
    try:
        transcript = (f"User asked: {prompt[:1500]}\n\nAgent's final answer: {final_text[:3000]}")
        reply = provider.complete(
            [
                {"role": "system", "content":
                    "You review a finished coding-agent turn and extract durable facts for future sessions. "
                    "Only save facts that are (a) long-term useful AND (b) NOT derivable from the code itself: "
                    "build/test commands, project conventions, environment quirks, pitfalls discovered, user preferences. "
                    "Never save: file contents, line numbers, temporary state, anything grep/read_file can find again. "
                    "Reply with a JSON array of short strings (one sentence each, max 3). "
                    "If nothing qualifies, reply []."},
                {"role": "user", "content": transcript},
            ],
            cancel=cancel, thinking=False, max_tokens=300,
        )
        notes = json.loads(reply[reply.find("["): reply.rfind("]") + 1])
        saved = []
        for note in notes[:3]:
            if isinstance(note, str) and note.strip():
                append_memory(root, note.strip(), "project")
                saved.append(note.strip())
        return saved
    except Exception:  # noqa: BLE001 - best effort
        return []


def memory_tools() -> list[Tool]:
    def remember(ctx: ToolContext, a: dict) -> str:
        n = _memory.write_note(ctx.root, a["note"], scope=a.get("scope", "project"))
        return f"Saved memory '{n.name}' ({n.type}) to {n.path}"

    def memory_read(ctx: ToolContext, a: dict) -> str:
        n = _memory.find_note(ctx.root, a["name"])
        if n is None:
            return f"No memory named '{a['name']}'. Use memory_search to find it."
        return f"[memory '{n.name}' ({n.type}, updated {n.updated})]\n{n.body}"

    def memory_delete(ctx: ToolContext, a: dict) -> str:
        if _memory.delete_note(ctx.root, a["name"]):
            return f"Deleted memory '{a['name']}'."
        return f"No memory named '{a['name']}'."

    def memory_search(ctx: ToolContext, a: dict) -> str:
        hits = _memory.search_notes(ctx.root, a["query"], limit=a.get("limit", 10))
        if not hits:
            return f"No memories match '{a['query']}'."
        return "\n".join(f"- [{n.type}] {n.name}: {n.description}" for n in hits)

    scope = {"type": "string", "enum": ["project", "global"],
             "description": "'project' = this repo only, 'global' = all projects"}
    return [
        Tool(
            "remember",
            "Save a short, durable fact for future sessions (build commands, conventions, pitfalls). "
            "One sentence per note; saving the same fact again updates it instead of duplicating.",
            {
                "type": "object",
                "properties": {"note": {"type": "string"}, "scope": scope},
                "required": ["note"],
            },
            remember,
            kind="action",  # writes a memory file: must run serially, in call order
        ),
        Tool(
            "memory_write",
            "Create or update a named memory note (upsert). Use it to revise an existing note "
            "(same name) instead of adding a duplicate. type: user (user preferences) | feedback "
            "(corrections given by the user) | project (repo facts) | reference (external pointers).",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "short hyphenated note name, e.g. build-command"},
                    "note": {"type": "string", "description": "the full note text"},
                    "description": {"type": "string", "description": "one-line summary shown in the index"},
                    "type": {"type": "string", "enum": list(_memory.MEMORY_TYPES)},
                    "scope": scope,
                },
                "required": ["name", "note"],
            },
            lambda ctx, a: f"Saved memory '{_memory.write_note(ctx.root, a['note'], scope=a.get('scope', 'project'), name=a['name'], description=a.get('description', ''), type=a.get('type', '')).name}'",
            kind="action",
        ),
        Tool(
            "memory_read",
            "Read the full text of a memory note by name (the system prompt only shows the index).",
            {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            memory_read,
        ),
        Tool(
            "memory_delete",
            "Delete a memory note by name.",
            {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
            memory_delete,
            kind="action",
        ),
        Tool(
            "memory_search",
            "Keyword-search all memory notes (name, description, body). Returns matching index lines.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "description": "max results, default 10"},
                },
                "required": ["query"],
            },
            memory_search,
        ),
    ]
