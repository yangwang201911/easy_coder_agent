"""File-system tools: read / list / find / grep / write / patch."""

from __future__ import annotations

import codecs
import difflib
import fnmatch
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from .base import Tool, ToolContext, ToolError

IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".agent", ".idea", ".vscode", ".cache"}
MAX_READ_LINES = 500
MAX_FILE_BYTES = 2_000_000
HAS_RG = shutil.which("rg") is not None
HAS_CTAGS = shutil.which("ctags") is not None
MAX_GREP_MATCHES = 100
MAX_GREP_CONTEXT = 10

# grep_search type= : language -> file extensions (rg has its own --type, we map ourselves)
GREP_TYPES = {
    "py": [".py"], "python": [".py"],
    "cpp": [".cpp", ".cc", ".cxx", ".hpp", ".h", ".hh"], "c": [".c", ".h"],
    "ts": [".ts", ".tsx"], "javascript": [".js", ".jsx", ".mjs", ".cjs"], "js": [".js", ".jsx"],
    "json": [".json"], "toml": [".toml"], "md": [".md"], "sh": [".sh", ".bash"],
    "cmake": ["cmakelists.txt"],
}


def _is_git_repo(root: Path) -> bool:
    return (root / ".git").exists()


def _git_files(root: Path) -> Optional[set[Path]]:
    """Tracked + untracked-but-not-ignored files (honours .gitignore). None if git fails."""
    try:
        out = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=str(root), capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return None
        return {root / line for line in out.stdout.splitlines() if line}
    except (OSError, subprocess.TimeoutExpired):
        return None


def _walk(root: Path, gitignore: bool = True):
    """Files under root. In a git repo, .gitignore is honoured (via git ls-files);
    elsewhere the fixed IGNORED_DIRS set applies."""
    git_files = _git_files(root) if (gitignore and _is_git_repo(root)) else None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS and d != ".git")
        for f in sorted(filenames):
            p = Path(dirpath) / f
            if git_files is not None and p not in git_files:
                continue
            yield p


def _read_text(path: Path) -> str:
    if not path.is_file():
        raise ToolError(f"file not found: {path.name}")
    data = path.read_bytes()
    if b"\x00" in data[:4096]:
        raise ToolError("binary file")
    return _decode(data)


def _decode(data: bytes) -> str:
    """Try UTF-8 first, then GB18030 (only when CJK lead bytes are present - it
    decodes almost anything and would mangle latin-1), then latin-1 (always works)."""
    for enc in ("utf-8-sig", "utf-8"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    if any(0x81 <= b <= 0xFE for b in data):
        try:
            return data.decode("gb18030")
        except UnicodeDecodeError:
            pass
    return data.decode("latin-1")


def _encoding_name(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8"):
        try:
            data.decode(enc)
            return "utf-8"
        except UnicodeDecodeError:
            continue
    if any(0x81 <= b <= 0xFE for b in data):
        try:
            data.decode("gb18030")
            return "gb18030"
        except UnicodeDecodeError:
            pass
    return "latin-1"


# ---------------------------------------------------------------- read_file
STREAM_READ_BYTES = 1_000_000  # larger files are read line by line, not loaded whole


def _iter_lines(path: Path):
    """Yield lines without loading the whole file (large-file path)."""
    enc = _encoding_name(path.read_bytes()[:65536])
    dec = codecs.getincrementaldecoder(enc)()
    buf = ""
    with open(path, "rb") as f:
        while chunk := f.read(1 << 16):
            buf += dec.decode(chunk)
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                yield line
    tail = dec.decode(b"", True)
    if buf:
        yield buf + tail
    elif tail:
        yield tail


def _count_lines(path: Path) -> int:
    n = 0
    last = b""
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            n += chunk.count(b"\n")
            last = chunk[-1:]
    if last and last != b"\n":
        n += 1  # final line without a trailing newline
    return n


def read_file(ctx: ToolContext, a: dict) -> str:
    path = ctx.resolve_readable(a["path"])
    if not path.is_file():
        raise ToolError(f"file not found: {path.name}")
    start = max(1, a.get("start_line", 1))
    small = path.stat().st_size <= STREAM_READ_BYTES
    total = len(_read_text(path).splitlines()) if small else _count_lines(path)
    if start > total and total:
        raise ToolError(f"start_line {start} is past the end of file ({total} lines)")
    end = a.get("end_line") or min(total, start + MAX_READ_LINES - 1)
    end = min(end, total, start + MAX_READ_LINES - 1)
    lines = []
    if small:
        all_lines = _read_text(path).splitlines()
        lines = all_lines[start - 1:end]
    else:  # stream: only the requested range is decoded
        for i, line in enumerate(_iter_lines(path), 1):
            if i > end:
                break
            if i >= start:
                lines.append(line)
    body = "\n".join(f"{i:>5} | {l}" for i, l in enumerate(lines, start))
    head = f"{ctx.rel(path)} (lines {start}-{end} of {total})"
    enc = _encoding_name(path.read_bytes()[:65536])
    if enc != "utf-8":
        head += f" [decoded as {enc}]"
    if end < total:
        head += f" - more available, call again with start_line={end + 1}"
    # remember when we last saw this file: a later write to a newer mtime is stale
    ctx.read_mtimes[str(path)] = path.stat().st_mtime_ns
    return head + "\n" + body


# ----------------------------------------------------------------- list_dir
def list_dir(ctx: ToolContext, a: dict) -> str:
    base = ctx.resolve_readable(a.get("path", "."))
    if not base.is_dir():
        raise ToolError(f"not a directory: {a.get('path', '.')}")
    depth = max(1, min(a.get("depth", 1), 4))
    out: list[str] = []

    def rec(d: Path, level: int) -> None:
        for e in sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name)):
            if e.name in IGNORED_DIRS:
                continue
            out.append("  " * level + e.name + ("/" if e.is_dir() else ""))
            if len(out) >= 300:
                return
            if e.is_dir() and level + 1 < depth:
                rec(e, level + 1)

    rec(base, 0)
    text = "\n".join(out) or "(empty)"
    return text + ("\n...(truncated at 300 entries)" if len(out) >= 300 else "")


# ---------------------------------------------------------------- find_files
def find_files(ctx: ToolContext, a: dict) -> str:
    pat = a["pattern"]
    base = ctx.resolve(a.get("path", "."))
    hits = []
    for f in _walk(base):
        rel = ctx.rel(f)
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(f.name, pat):
            hits.append(rel)
            if len(hits) >= 200:
                break
    return "\n".join(hits) if hits else "(no matches)"


# --------------------------------------------------------------- grep_search
def _grep_files(ctx: ToolContext, base: Path, glob: Optional[str],
                type_name: Optional[str]) -> list[Path]:
    """Candidate files: a single file, or the walk (gitignore-aware) filtered by glob/type."""
    if base.is_file():
        return [base]
    exts = GREP_TYPES.get((type_name or "").lower())
    out: list[Path] = []
    for f in _walk(base):
        if glob and not (fnmatch.fnmatch(f.name, glob) or fnmatch.fnmatch(ctx.rel(f), glob)):
            continue
        if exts and f.suffix.lower() not in exts and not (
                type_name == "cmake" and f.name.lower() == "cmakelists.txt"):
            continue
        out.append(f)
    return out


def _grep_py(ctx: ToolContext, a: dict, base: Path, pattern: str, is_regex: bool,
             case_sensitive: bool, glob: Optional[str], context_lines: int,
             type_name: Optional[str], output_mode: str, multiline: bool,
             offset: int, head_limit: Optional[int]) -> str:
    """Pure-Python scan (always works; the ripgrep fast path shares the same interface)."""
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        rx = re.compile(pattern if is_regex else re.escape(pattern), flags | (re.DOTALL if multiline else 0))
    except re.error as e:
        raise ToolError(f"invalid regex: {e}")
    limit = max(1, head_limit) if head_limit else MAX_GREP_MATCHES
    # (file, line_no, line_text, is_match) tuples, in file/line order
    hits: list[tuple[Path, int, str, bool]] = []
    per_file: dict[str, int] = {}
    for f in _grep_files(ctx, base, glob, type_name):
        try:
            if f.stat().st_size > MAX_FILE_BYTES:
                continue
            data = f.read_bytes()
        except OSError:
            continue
        if b"\x00" in data[:4096]:
            continue
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        if multiline:
            for m in rx.finditer(text):
                n = text.count("\n", 0, m.start()) + 1
                hits.append((f, n, m.group(0).replace("\n", " ⏎ ")[:300], True))
                if len(hits) >= limit * 4:
                    break
        else:
            for n, line in enumerate(lines, 1):
                if rx.search(line):
                    hits.append((f, n, line.strip()[:200], True))
                    if len(hits) >= limit * 4:
                        break
        if len(hits) >= limit * 4:
            break
    matches = [h for h in hits if h[3]]
    total = len(matches)
    if not matches:
        return "(no matches)"
    if output_mode == "files_with_matches":
        files = list(dict.fromkeys(h[0] for h in matches))
        return "\n".join(ctx.rel(f) for f in files[:200]) + (f"\n...({total} matches in more files)" if len(files) > 200 else "")
    if output_mode == "count":
        for h in matches:
            per_file[ctx.rel(h[0])] = per_file.get(ctx.rel(h[0]), 0) + 1
        return "\n".join(f"{n}\t{p}" for p, n in sorted(per_file.items()))
    # content mode: offset/limit apply to matches, context lines expand around them
    sel = matches[offset:offset + limit]
    out: list[str] = []
    for f, n, line, _ in sel:
        out.append(f"{ctx.rel(f)}:{n}: {line}")
        if context_lines:
            try:
                body = _read_text(f).splitlines()
            except ToolError:
                continue
            for i in range(max(1, n - context_lines), n):
                out.append(f"{ctx.rel(f)}:{i}- {body[i - 1].strip()[:200]}")
            for i in range(n + 1, min(len(body), n + context_lines) + 1):
                out.append(f"{ctx.rel(f)}:{i}- {body[i - 1].strip()[:200]}")
    more = f"\n...({total - offset - len(sel)} more matches; use offset={offset + limit})" if total > offset + len(sel) else ""
    return "\n".join(out) + more


def _grep_rg(ctx: ToolContext, a: dict, base: Path, pattern: str, is_regex: bool,
             case_sensitive: bool, glob: Optional[str], context_lines: int,
             type_name: Optional[str], output_mode: str, multiline: bool,
             offset: int, head_limit: Optional[int]) -> str:
    """Fast path: system ripgrep (honours .gitignore, skips binaries, parallel)."""
    limit = max(1, head_limit) if head_limit else MAX_GREP_MATCHES
    cmd = ["rg", "--line-number", "--color", "never", "--no-heading"]
    if not is_regex:
        cmd.append("--fixed-strings")
    if not case_sensitive:
        cmd.append("-i")
    if multiline:
        cmd += ["--multiline", "--dotall"]
    if context_lines:
        cmd += ["-A", str(context_lines)]
    if glob:
        cmd += ["--glob", glob]
    if type_name:
        exts = GREP_TYPES.get(type_name.lower())
        if exts:
            cmd += ["--glob", f"*{exts[0]}"]  # first extension only; keep it simple
    if output_mode == "files_with_matches":
        cmd.append("-l")
    elif output_mode == "count":
        cmd.append("-c")
    else:
        cmd += ["--max-count", str(limit + offset)]
    search_path = base if base == ctx.root else ctx.rel(base)
    cmd += ["--", pattern, search_path]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                              cwd=str(ctx.root), env={**os.environ, "NO_COLOR": "1"})
    except (OSError, subprocess.TimeoutExpired) as e:
        raise ToolError(f"ripgrep failed: {e}")
    if proc.returncode not in (0, 1):  # 1 = no matches
        raise ToolError(f"ripgrep failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if output_mode == "content" and offset:
        lines = lines[offset:]
    return "\n".join(lines) if lines else "(no matches)"


def grep_search(ctx: ToolContext, a: dict) -> str:
    pattern = a["pattern"]
    base = ctx.resolve(a.get("path", "."))
    is_regex = bool(a.get("is_regex", False))
    context_lines = max(0, min(int(a.get("context_lines", 0)), MAX_GREP_CONTEXT))
    common = dict(is_regex=is_regex, case_sensitive=bool(a.get("case_sensitive", False)),
                  glob=a.get("glob"), context_lines=context_lines,
                  type_name=a.get("type"),
                  output_mode=a.get("output_mode", "content"),
                  multiline=bool(a.get("multiline", False)),
                  offset=max(0, int(a.get("offset", 0))),
                  head_limit=a.get("head_limit"))
    if HAS_RG:
        return _grep_rg(ctx, a, base, pattern, **common)
    return _grep_py(ctx, a, base, pattern, **common)


# --------------------------------------------------------------- write_file
def _unified(old: str, new: str, name: str) -> str:
    diff = difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True), f"a/{name}", f"b/{name}"
    )
    text = "".join(d if d.endswith("\n") else d + "\n" for d in diff)
    return text or "(no changes)"


def _current(path: Path) -> str:
    return path.read_bytes().decode("utf-8", errors="replace") if path.is_file() else ""


def _check_stale(ctx: ToolContext, path: Path) -> None:
    """Refuse to write a file that changed on disk after the model last read it."""
    seen = ctx.read_mtimes.get(str(path))
    if seen is not None and path.is_file():
        cur = path.stat().st_mtime_ns
        if cur > seen:
            raise ToolError(
                f"file changed on disk since your last read_file (external modification). "
                f"Read it again with read_file and re-do the edit."
            )


def write_file(ctx: ToolContext, a: dict) -> str:
    path = ctx.resolve(a["path"])
    if path.is_dir():
        raise ToolError("path is a directory")
    existed = path.is_file()
    read_before = str(path) in ctx.read_mtimes  # the model saw the current content
    _check_stale(ctx, path)
    if ctx.snapshots:
        ctx.snapshots.record(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    content = a["content"]
    path.write_text(content, encoding="utf-8", newline="")
    ctx.read_mtimes[str(path)] = path.stat().st_mtime_ns
    msg = f"Wrote {len(content.splitlines())} lines to {ctx.rel(path)}"
    if existed and not read_before:
        msg += ("\n[warning] you overwrote an existing file without reading it first - "
                "read_file it before overwriting next time")
    return msg


def write_file_preview(ctx: ToolContext, a: dict) -> str:
    path = ctx.resolve(a["path"])
    return _unified(_current(path), a["content"], ctx.rel(path))


# -------------------------------------------------------------- apply_patch
def _norm(s: str) -> str:
    return s.replace("\r\n", "\n")


def _replace(text: str, search: str, replace: str, replace_all: bool) -> tuple[str, int]:
    if not search:
        raise ToolError("'search' must not be empty (use write_file to create or overwrite files)")
    n = text.count(search)
    if n == 1 or (n > 1 and replace_all):
        return text.replace(search, replace), n
    if n > 1:
        raise ToolError(f"'search' matches {n} places; add more surrounding context or set replace_all=true")
    # Fallback: ignore trailing whitespace differences line by line.
    lines = text.split("\n")
    s_lines = [l.rstrip() for l in search.split("\n")]
    hits = [
        i
        for i in range(len(lines) - len(s_lines) + 1)
        if all(lines[i + k].rstrip() == s_lines[k] for k in range(len(s_lines)))
    ]
    if len(hits) == 1:
        i = hits[0]
        return "\n".join(lines[:i] + replace.split("\n") + lines[i + len(s_lines):]), 1
    if len(hits) > 1 and replace_all:
        for i in reversed(hits):
            lines[i:i + len(s_lines)] = replace.split("\n")
        return "\n".join(lines), len(hits)
    if len(hits) > 1:
        raise ToolError(f"'search' matches {len(hits)} places; add more surrounding context")
    hint = _similar_hint(text, search)
    raise ToolError(
        "'search' text not found. It must match the file exactly (do not include the line-number "
        "prefix shown by read_file). Re-read the file and try again."
        + (f"\n{hint}" if hint else "")
    )


def _similar_hint(text: str, search: str) -> str:
    """Point the model at the closest lines in the file so it can fix the search text."""
    t_lines = text.split("\n")
    s_lines = search.split("\n")
    if not t_lines or not s_lines:
        return ""
    best_i, best_ratio = 0, 0.0
    first = s_lines[0]
    for i, line in enumerate(t_lines):
        ratio = difflib.SequenceMatcher(None, first, line).ratio()
        if ratio > best_ratio:
            best_i, best_ratio = i, ratio
    if best_ratio < 0.6:
        return ""
    lo, hi = max(0, best_i - 2), min(len(t_lines), best_i + len(s_lines) + 2)
    snippet = "\n".join(f"{i + 1:>5} | {l}" for i, l in enumerate(t_lines[lo:hi], lo))
    return (f"Closest lines (around line {best_i + 1}, similarity {best_ratio:.0%}) - "
            "compare them with your search text:\n" + snippet)


def _patched(ctx: ToolContext, a: dict) -> tuple[Path, str, str, bool]:
    path = ctx.resolve(a["path"])
    _check_stale(ctx, path)
    raw = _read_text(path)
    crlf = "\r\n" in raw
    old = _norm(raw)
    new, _ = _replace(old, _norm(a["search"]), _norm(a["replace"]), bool(a.get("replace_all", False)))
    return path, old, new, crlf


def apply_patch(ctx: ToolContext, a: dict) -> str:
    path, old, new, crlf = _patched(ctx, a)
    if ctx.snapshots:
        ctx.snapshots.record(path)
    path.write_text(new.replace("\n", "\r\n") if crlf else new, encoding="utf-8", newline="")
    ctx.read_mtimes[str(path)] = path.stat().st_mtime_ns
    return f"Patched {ctx.rel(path)}\n" + _unified(old, new, ctx.rel(path))


def apply_patch_preview(ctx: ToolContext, a: dict) -> str:
    path, old, new, _ = _patched(ctx, a)
    return _unified(old, new, ctx.rel(path))


# ------------------------------------------------- move / delete / make_dir
def move_path(ctx: ToolContext, a: dict) -> str:
    src = ctx.resolve(a["source"])
    dst = ctx.resolve(a["destination"])
    if not src.exists():
        raise ToolError(f"source does not exist: {ctx.rel(src)}")
    if dst.exists():
        raise ToolError(f"destination already exists: {ctx.rel(dst)} (delete it first or choose another name)")
    if ctx.snapshots:
        ctx.snapshots.record(src)      # existed -> restored on rewind
        ctx.snapshots.record(dst)      # not existed -> removed on rewind
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    ctx.read_mtimes.pop(str(src), None)
    return f"Moved {ctx.rel(src)} -> {ctx.rel(dst)}"


def move_path_preview(ctx: ToolContext, a: dict) -> str:
    return f"move {ctx.rel(ctx.resolve(a['source']))} -> {ctx.rel(ctx.resolve(a['destination']))}"


def delete_path(ctx: ToolContext, a: dict) -> str:
    path = ctx.resolve(a["path"])
    if not path.is_file():
        raise ToolError(f"not a file (or does not exist): {ctx.rel(path)} (use a shell command to remove directories)")
    if ctx.snapshots:
        ctx.snapshots.record(path)
    path.unlink()
    ctx.read_mtimes.pop(str(path), None)
    return f"Deleted {ctx.rel(path)}"


def delete_path_preview(ctx: ToolContext, a: dict) -> str:
    return f"delete {ctx.rel(ctx.resolve(a['path']))}"


def make_dir(ctx: ToolContext, a: dict) -> str:
    path = ctx.resolve(a["path"])
    if path.exists():
        raise ToolError(f"path already exists: {ctx.rel(path)}")
    path.mkdir(parents=True, exist_ok=False)
    return f"Created directory {ctx.rel(path)}"


def make_dir_preview(ctx: ToolContext, a: dict) -> str:
    return f"mkdir {ctx.rel(ctx.resolve(a['path']))}"


def fs_tools() -> list[Tool]:
    P = "path relative to the project root (absolute paths are accepted only inside trusted dirs such as /tmp)"
    return [
        Tool(
            "read_file",
            "Read a text file with line numbers (the 'N |' prefix is NOT part of the file). "
            f"Returns at most {MAX_READ_LINES} lines per call.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": P},
                    "start_line": {"type": "integer", "description": "1-based first line"},
                    "end_line": {"type": "integer", "description": "1-based last line (inclusive)"},
                },
                "required": ["path"],
            },
            read_file,
            cacheable=True,
        ),
        Tool(
            "list_dir",
            "List a directory (dirs end with '/').",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": P},
                    "depth": {"type": "integer", "description": "levels to descend, 1-4"},
                },
            },
            list_dir,
        ),
        Tool(
            "find_files",
            "Find files by glob pattern, e.g. '*.cpp' or 'src/**/CMakeLists.txt'.",
            {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "description": "directory to search in"},
                },
                "required": ["pattern"],
            },
            find_files,
        ),
        Tool(
            "grep_search",
            "Search file contents. Case-insensitive plain text by default. "
            "output_mode: content (default, file:line: text) | files_with_matches | count. "
            "type filters by language (py, cpp, c, ts, js, json, toml, md, sh, cmake). "
            "multiline matches across line breaks (regex). offset/head_limit page through many matches.",
            {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string", "description": "file or directory"},
                    "glob": {"type": "string", "description": "only files matching, e.g. '*.hpp'"},
                    "is_regex": {"type": "boolean"},
                    "case_sensitive": {"type": "boolean"},
                    "context_lines": {"type": "integer", "description": f"lines after each match, 0-{MAX_GREP_CONTEXT}"},
                    "output_mode": {"type": "string", "enum": ["content", "files_with_matches", "count"]},
                    "type": {"type": "string", "description": "language filter: py, cpp, c, ts, js, json, toml, md, sh, cmake"},
                    "multiline": {"type": "boolean", "description": "regex may span line breaks"},
                    "offset": {"type": "integer", "description": "skip the first N matches"},
                    "head_limit": {"type": "integer", "description": "max matches to return (default 100)"},
                },
                "required": ["pattern"],
            },
            grep_search,
        ),
        Tool(
            "write_file",
            "Create a new file or fully overwrite an existing one. For small changes to existing "
            "files use apply_patch instead.",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": P},
                    "content": {"type": "string", "description": "complete file content"},
                },
                "required": ["path", "content"],
            },
            write_file,
            kind="write",
            preview=write_file_preview,
        ),
        Tool(
            "apply_patch",
            "Edit an existing file by replacing exact text. 'search' must match the file content "
            "exactly and be unique (include a few surrounding lines).",
            {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": P},
                    "search": {"type": "string", "description": "exact text to find"},
                    "replace": {"type": "string", "description": "replacement text"},
                    "replace_all": {"type": "boolean", "description": "replace every occurrence"},
                },
                "required": ["path", "search", "replace"],
            },
            apply_patch,
            kind="write",
            preview=apply_patch_preview,
        ),
        Tool(
            "move_path",
            "Move or rename a file (or directory). The destination must not already exist. "
            "These operations are recorded in the turn snapshot, so rewind can undo them.",
            {
                "type": "object",
                "properties": {
                    "source": {"type": "string", "description": P},
                    "destination": {"type": "string", "description": P},
                },
                "required": ["source", "destination"],
            },
            move_path,
            kind="write",
            preview=move_path_preview,
        ),
        Tool(
            "delete_path",
            "Delete a file. Directories are not supported (use a shell command). Recorded in the "
            "turn snapshot, so rewind can restore the file.",
            {
                "type": "object",
                "properties": {"path": {"type": "string", "description": P}},
                "required": ["path"],
            },
            delete_path,
            kind="write",
            preview=delete_path_preview,
        ),
        Tool(
            "make_dir",
            "Create a directory (including parents).",
            {
                "type": "object",
                "properties": {"path": {"type": "string", "description": P}},
                "required": ["path"],
            },
            make_dir,
            kind="write",
            preview=make_dir_preview,
        ),
    ]
