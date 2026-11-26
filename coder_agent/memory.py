"""Structured memory: one md file per note, front-matter typed, index injected.

Layout (per scope):
    project -> <root>/.agent/memory/<name>.md
    global  -> ~/.coder_agent/memory/<name>.md

Each note file::

    ---
    name: build-command
    description: how to build this repo
    type: project
    updated: 2026-11-24
    ---
    <body>

Only the one-line index (name + type + description) goes into the system
prompt; the model reads full notes on demand with ``memory_read``. This keeps
the prompt small for local models and lets memory grow without eating context.

Legacy ``memory.md`` files (plain bullet lists) are migrated on first access.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .paths import project_cache_dir, user_dir
from .tools.base import ToolError
from .util import parse_front_matter

MEMORY_TYPES = ("user", "feedback", "project", "reference")
MAX_NOTES_PER_SCOPE = 200
MAX_INDEX_LINES = 200
MAX_DESC_CHARS = 150


def _scope_dir(scope: str, root: Path) -> Path:
    if scope == "project":
        return Path(root) / ".agent" / "memory"
    if scope == "global":
        return user_dir() / "memory"
    raise ToolError("scope must be 'project' or 'global'")


def _slug(note: str) -> str:
    """File-system-safe name for a note: first 5 words, lowercased, hyphenated."""
    words = re.findall(r"[a-z0-9]+", note.lower())[:5]
    return "-".join(words) or "note"


@dataclass
class MemoryNote:
    name: str
    description: str
    type: str
    updated: str
    body: str
    path: Path


# ------------------------------------------------------------------ storage
def _read_note(path: Path) -> Optional[MemoryNote]:
    try:
        meta, body = parse_front_matter(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None
    return MemoryNote(
        name=meta.get("name", path.stem),
        description=meta.get("description", "").strip(),
        type=meta.get("type", "project"),
        updated=meta.get("updated", ""),
        body=body.strip(),
        path=path,
    )


def _migrate_legacy(root: Path) -> None:
    """Old ``memory.md`` bullet lists become one note per bullet."""
    legacy = {
        "project": project_cache_dir(root) / "memory.md",
        "global": user_dir() / "memory" / "global.md",
    }
    for scope, legacy_path in legacy.items():
        if not legacy_path.is_file():
            continue
        lines = [l.strip() for l in legacy_path.read_text(encoding="utf-8", errors="replace").splitlines()]
        notes = [l for l in lines if l.startswith("- ")]
        if not notes:
            continue
        d = _scope_dir(scope, root)
        d.mkdir(parents=True, exist_ok=True)
        for note in notes:
            text = note[2:].strip()
            # bullets were "- 2026-11-23: text"
            m = re.match(r"\d{4}-\d{2}-\d{2}:\s*(.*)", text)
            if m:
                text = m.group(1)
            if not text:
                continue
            p = d / (_slug(text) + ".md")
            if not p.exists():
                p.write_text(
                    f"---\nname: {p.stem}\ndescription: {text[:MAX_DESC_CHARS]}\n"
                    f"type: project\nupdated: {time.strftime('%Y-%m-%d')}\n---\n{text}\n",
                    encoding="utf-8",
                )
        legacy_path.unlink(missing_ok=True)


def _dedupe(notes: list[MemoryNote], text: str) -> Optional[MemoryNote]:
    """A note whose body is (almost) the same as an existing one."""
    norm = re.sub(r"\s+", " ", text.strip().lower())
    if not norm:
        return None
    for n in notes:
        nb = re.sub(r"\s+", " ", n.body.strip().lower())
        if nb == norm:
            return n
    return None


def _evict(d: Path, notes: list[MemoryNote]) -> None:
    """Over the per-scope cap: drop the least recently updated notes."""
    while len(notes) > MAX_NOTES_PER_SCOPE:
        notes.sort(key=lambda n: (n.updated, n.name))
        victim = notes.pop(0)
        victim.path.unlink(missing_ok=True)


def list_notes(root: Path, scope: str) -> list[MemoryNote]:
    _migrate_legacy(root)
    d = _scope_dir(scope, root)
    if not d.is_dir():
        return []
    notes = []
    for f in sorted(d.glob("*.md")):
        n = _read_note(f)
        if n is not None:
            notes.append(n)
    return notes


def find_note(root: Path, name: str) -> Optional[MemoryNote]:
    for scope in ("project", "global"):
        for n in list_notes(root, scope):
            if n.name == name:
                return n
    return None


def write_note(root: Path, note: str, *, scope: str = "project", name: str = "",
               description: str = "", type: str = "") -> MemoryNote:
    """Upsert a note. ``name`` empty -> derived from the text; an existing note
    with the same name (or identical body) is updated in place, never duplicated."""
    text = " ".join(note.split())
    if not text:
        raise ToolError("empty note")
    _migrate_legacy(root)
    d = _scope_dir(scope, root)
    d.mkdir(parents=True, exist_ok=True)
    notes = list_notes(root, scope)
    today = time.strftime("%Y-%m-%d")
    ntype = type if type in MEMORY_TYPES else "project"
    desc = " ".join(description.split())[:MAX_DESC_CHARS] or text[:MAX_DESC_CHARS]

    existing = None
    if name:
        existing = next((n for n in notes if n.name == name), None)
    if existing is None:
        existing = _dedupe(notes, text)
    if existing is not None:
        existing.body, existing.updated = text, today
        if desc:
            existing.description = desc
        if type:
            existing.type = ntype
        existing.path.write_text(
            f"---\nname: {existing.name}\ndescription: {existing.description}\n"
            f"type: {existing.type}\nupdated: {existing.updated}\n---\n{existing.body}\n",
            encoding="utf-8",
        )
        return existing

    p = d / ((name or _slug(text)) + ".md")
    # avoid clobbering an unrelated note with the same derived slug
    i = 2
    while p.exists():
        p = d / (f"{name or _slug(text)}-{i}.md")
        i += 1
    p.write_text(
        f"---\nname: {p.stem}\ndescription: {desc}\ntype: {ntype}\nupdated: {today}\n---\n{text}\n",
        encoding="utf-8",
    )
    notes.append(_read_note(p))
    _evict(d, notes)
    return _read_note(p)


def delete_note(root: Path, name: str) -> bool:
    for scope in ("project", "global"):
        for n in list_notes(root, scope):
            if n.name == name:
                n.path.unlink(missing_ok=True)
                return True
    return False


def search_notes(root: Path, query: str, limit: int = 10) -> list[MemoryNote]:
    """Keyword search over name + description + body, ranked by hit count."""
    terms = [t for t in re.split(r"\s+", query.lower()) if len(t) >= 2]
    if not terms:
        return []
    scored: list[tuple[int, MemoryNote]] = []
    for scope in ("project", "global"):
        for n in list_notes(root, scope):
            hay = (n.name + " " + n.description + " " + n.body).lower()
            score = sum(hay.count(t) for t in terms)
            if score:
                scored.append((score, n))
    scored.sort(key=lambda sn: (-sn[0], sn[1].name))
    return [n for _, n in scored[:limit]]


# ------------------------------------------------------------------ prompt
def memory_index(root: Path) -> str:
    """One line per note (name | type | description) for the system prompt."""
    lines: list[str] = []
    for scope in ("project", "global"):
        for n in list_notes(root, scope):
            lines.append(f"- [{n.type}] {n.name}: {n.description}")
    if len(lines) > MAX_INDEX_LINES:
        lines = lines[-(MAX_INDEX_LINES - 1):]
        lines.insert(0, f"...(more notes exist - use memory_search)")
    return "\n".join(lines)
