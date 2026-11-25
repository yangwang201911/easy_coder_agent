"""Symbol search: find functions/classes/variables by name across the project.

Backend: universal-ctags when installed (fast, many languages); otherwise a
pure-Python extractor for Python / C++ / TypeScript. Results are cached per
file with an mtime key, so a turn that searches twice pays the scan once.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from .base import Tool, ToolContext, ToolError
from .fs import _walk, _read_text

MAX_SYMBOLS = 200
MAX_SIG_CHARS = 160

# ---------------------------------------------------------------- ctags path
def _ctags_symbols(ctx: ToolContext, base: Path) -> list[dict]:
    """One ctags pass over the tree (honours .gitignore via our file list)."""
    files = [str(f) for f in _walk(base) if _is_code(f)]
    if not files:
        return []
    try:
        proc = subprocess.run(
            ["ctags", "-f", "-", "--_xformat=json", "-R", *files],
            capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ToolError(f"ctags failed: {e}")
    if proc.returncode != 0:
        raise ToolError(f"ctags failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    out: list[dict] = []
    for line in proc.stdout.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("type") != "tag":
            continue
        name = d.get("name") or ""
        path = d.get("path") or ""
        if not name or not path:
            continue
        sig = (d.get("signature") or "").strip()
        out.append({
            "name": name,
            "kind": d.get("kind") or "?",
            "file": ctx.rel(Path(path)),
            "line": int(d.get("line") or 0),
            "sig": sig[:MAX_SIG_CHARS],
        })
    return out


# ------------------------------------------------------- python fallback path
# (keyword, regex, kind) - deliberately conservative: precision over recall.
_PY_PATTERNS = [
    ("def", re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\("), "function"),
    ("class", re.compile(r"^\s*class\s+([A-Za-z_]\w*)"), "class"),
]
_CPP_PATTERNS = [
    ("class", re.compile(r"^\s*(?:class|struct)\s+([A-Za-z_]\w*)"), "class"),
    ("fn", re.compile(r"^\s*(?:[A-Za-z_][\w:<>,\s\*&]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:->\s*[\w:<>,\s\*&]+)?\s*\{"), "function"),
]
_TS_PATTERNS = [
    ("class", re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)"), "class"),
    ("fn", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)"), "function"),
    ("arrow", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*[:=]?\s*(?::\s*[^=]+)?=>"), "function"),
]


def _is_code(f: Path) -> bool:
    return f.suffix.lower() in {".py", ".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh", ".c", ".ts", ".tsx", ".js", ".jsx"}


def _scan_file(path: Path) -> list[tuple[str, str, int]]:
    """(name, kind, line_no) from one file via the regex extractor."""
    try:
        text = _read_text(path)
    except ToolError:
        return []
    ext = path.suffix.lower()
    pats = _PY_PATTERNS if ext == ".py" else _CPP_PATTERNS if ext in {".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh", ".c"} \
        else _TS_PATTERNS if ext in {".ts", ".tsx", ".js", ".jsx"} else []
    out: list[tuple[str, str, int]] = []
    for n, line in enumerate(text.splitlines(), 1):
        for _, rx, kind in pats:
            m = rx.match(line)
            if m:
                out.append((m.group(1), kind, n))
                break
    return out


def _python_symbols(ctx: ToolContext, base: Path) -> list[dict]:
    out: list[dict] = []
    for f in _walk(base):
        if not _is_code(f):
            continue
        for name, kind, line in _scan_file(f):
            sig = ""
            try:
                sig = _read_text(f).splitlines()[line - 1].strip()[:MAX_SIG_CHARS]
            except (ToolError, IndexError):
                pass
            out.append({"name": name, "kind": kind, "file": ctx.rel(f), "line": line, "sig": sig})
    return out


# --------------------------------------------------------------------- cache
_sym_cache: dict[str, tuple[int, list[dict]]] = {}  # base str -> (mtime-ish, symbols)


def code_symbols(ctx: ToolContext, a: dict) -> str:
    query = str(a["query"]).strip()
    if not query:
        raise ToolError("query must not be empty")
    base = ctx.resolve(a.get("path", "."))
    kind = (a.get("kind") or "").lower()
    limit = max(1, min(int(a.get("limit", 50)), MAX_SYMBOLS))

    # cache: valid while the file set under base is unchanged (cheap check:
    # count + newest mtime of code files)
    key = str(base)
    stamp = _scan_stamp(base)
    cached = _sym_cache.get(key)
    if cached and cached[0] == stamp:
        symbols = cached[1]
    else:
        if shutil.which("ctags"):
            symbols = _ctags_symbols(ctx, base)
        else:
            symbols = _python_symbols(ctx, base)
        _sym_cache[key] = (stamp, symbols)

    hits = [s for s in symbols if s["name"].lower() == query.lower() if (not kind or s["kind"] == kind)]
    if not hits:  # fall back to substring
        hits = [s for s in symbols if query.lower() in s["name"].lower() if (not kind or s["kind"] == kind)]
    hits.sort(key=lambda s: (s["file"], s["line"]))
    if not hits:
        return f"(no symbols matching '{query}'" + (f" of kind '{kind}'" if kind else "") + ")"
    out = [f"{s['file']}:{s['line']}  [{s['kind']}] {s['name']}" + (f"  {s['sig']}" if s["sig"] else "")
           for s in hits[:limit]]
    more = f"\n...({len(hits) - limit} more)" if len(hits) > limit else ""
    return "\n".join(out) + more


def _scan_stamp(base: Path) -> int:
    """Newest mtime of code files under base (cheap enough for a cache key)."""
    newest = 0
    for f in _walk(base):
        if not _is_code(f):
            continue
        try:
            newest = max(newest, f.stat().st_mtime_ns)
        except OSError:
            continue
    return newest


def code_symbols_tool() -> Tool:
    return Tool(
        "code_symbols",
        "Find code symbols (functions, classes) by name across the project. "
        "Faster and more precise than grep for 'where is X defined/used'. "
        "kind: function | class (omit for both). Results: file:line [kind] name signature.",
        {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "symbol name (exact match first, then substring)"},
                "path": {"type": "string", "description": "directory to search in (default: project root)"},
                "kind": {"type": "string", "enum": ["function", "class"]},
                "limit": {"type": "integer", "description": f"max results (default 50, max {MAX_SYMBOLS})"},
            },
            "required": ["query"],
        },
        code_symbols,
        kind="read",
    )
