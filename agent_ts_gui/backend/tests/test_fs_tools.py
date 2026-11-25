"""Tests for file tools: encoding detection, large-file streaming, patch hints, stale-write detection."""

import os
import time

import pytest

from coder_agent.session.snapshots import SnapshotStore
from coder_agent.tools import fs
from coder_agent.tools.base import ToolContext, ToolError


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


@pytest.fixture
def snap_ctx(tmp_path):
    ctx = ToolContext(root=tmp_path)
    ctx.snapshots = SnapshotStore(tmp_path, tmp_path / "snaps")
    return ctx


# --------------------------------------------------------------- encoding
def test_read_detects_gbk(ctx, tmp_path):
    p = tmp_path / "gbk.txt"
    p.write_bytes("你好世界".encode("gb18030"))
    out = fs.read_file(ctx, {"path": "gbk.txt"})
    assert "你好世界" in out
    assert "gb18030" in out  # header reports the encoding used


def test_read_utf8_no_encoding_note(ctx, tmp_path):
    (tmp_path / "a.txt").write_text("hello", encoding="utf-8")
    out = fs.read_file(ctx, {"path": "a.txt"})
    assert "decoded as" not in out


def test_decode_latin1_fallback():
    data = "caf\xe9".encode("latin-1")  # invalid utf-8, no CJK lead bytes
    assert fs._decode(data) == "café"
    assert fs._encoding_name(data) == "latin-1"


# ---------------------------------------------------------- large files
def test_large_file_streams_range(ctx, tmp_path, monkeypatch):
    p = tmp_path / "big.txt"
    n = 60_000  # ~6 MB
    with open(p, "w", encoding="utf-8") as f:
        for i in range(n):
            f.write(f"line {i}\n")
    # prove the whole file is NOT loaded: the small path would read it all
    monkeypatch.setattr(fs, "STREAM_READ_BYTES", 100)
    out = fs.read_file(ctx, {"path": "big.txt", "start_line": 50_000, "end_line": 50_010})
    assert f"(lines 50000-50010 of {n})" in out
    assert "line 49999" in out
    assert "line 50009" in out


def test_large_file_count_lines(tmp_path):
    p = tmp_path / "big.txt"
    with open(p, "w") as f:
        for i in range(10_000):
            f.write(f"x{i}\n")
    assert fs._count_lines(p) == 10_000
    # final line without trailing newline
    with open(p, "a") as f:
        f.write("tail")
    assert fs._count_lines(p) == 10_001


# ------------------------------------------------------------ patch hints
def test_apply_patch_failure_shows_closest_lines(ctx, tmp_path):
    (tmp_path / "a.py").write_text(
        "def foo():\n    return 42\n\ndef bar():\n    return 7\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.py"})
    with pytest.raises(ToolError) as e:
        fs.apply_patch(ctx, {"path": "a.py", "search": "def foo:\n    return 41", "replace": "x"})
    msg = str(e.value)
    assert "not found" in msg
    assert "Closest lines" in msg
    assert "return 42" in msg  # the actual line is shown for comparison


def test_apply_patch_no_hint_when_nothing_close(ctx, tmp_path):
    (tmp_path / "a.py").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.py"})
    with pytest.raises(ToolError) as e:
        fs.apply_patch(ctx, {"path": "a.py", "search": "zzzzzzzzzzzz", "replace": "x"})
    assert "Closest lines" not in str(e.value)


# ---------------------------------------------------------- edit_file (multi-edit, atomic)
def test_edit_file_multi_applies_in_order(ctx, tmp_path):
    (tmp_path / "a.py").write_text("def foo():\n    return 42\n\ndef bar():\n    return 7\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.py"})
    out = fs.edit_file(ctx, {"path": "a.py", "edits": [
        {"search": "return 42", "replace": "return 43"},
        {"search": "return 7", "replace": "return 8"},
    ]})
    assert "2 replacements" in out
    text = (tmp_path / "a.py").read_text(encoding="utf-8")
    assert "return 43" in text and "return 8" in text


def test_edit_file_second_edit_builds_on_first(ctx, tmp_path):
    """Edits are applied in order: the second search sees the first edit's result."""
    (tmp_path / "a.txt").write_text("aaa\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    fs.edit_file(ctx, {"path": "a.txt", "edits": [
        {"search": "aaa", "replace": "bbb"},
        {"search": "bbb", "replace": "ccc"},
    ]})
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "ccc\n"


def test_edit_file_atomic_on_late_failure(ctx, tmp_path):
    """If a later edit fails, NOTHING is written (not even the earlier edits)."""
    (tmp_path / "a.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    with pytest.raises(ToolError) as e:
        fs.edit_file(ctx, {"path": "a.txt", "edits": [
            {"search": "one", "replace": "ONE"},
            {"search": "does-not-exist", "replace": "x"},
        ]})
    assert "not found" in str(e.value)
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "one\ntwo\nthree\n"


def test_edit_file_duplicate_search_fails_atomically(ctx, tmp_path):
    (tmp_path / "a.txt").write_text("x\nx\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    with pytest.raises(ToolError):
        fs.edit_file(ctx, {"path": "a.txt", "edits": [{"search": "x", "replace": "y"}]})
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "x\nx\n"


def test_edit_file_rejected_by_stale_check(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("one\ntwo\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    _bump(p)
    with pytest.raises(ToolError, match="changed on disk"):
        fs.edit_file(ctx, {"path": "a.txt", "edits": [{"search": "one", "replace": "ONE"}]})
    assert p.read_text(encoding="utf-8").endswith("# external edit\n")


def test_edit_file_recorded_in_snapshot(snap_ctx, tmp_path):
    snap_ctx.snapshots.begin("t1")
    (tmp_path / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    fs.read_file(snap_ctx, {"path": "a.txt"})
    fs.edit_file(snap_ctx, {"path": "a.txt", "edits": [{"search": "one", "replace": "ONE"}]})
    restored = snap_ctx.snapshots.restore("t1")
    assert restored == ["a.txt"]
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "one\ntwo\n"


# ------------------------------------------------------- stale detection
def _bump(path):
    """Make the file's mtime strictly newer than the last read."""
    t = time.time() + 5
    os.utime(path, (t, t))
    path.write_text(path.read_text(encoding="utf-8") + "# external edit\n", encoding="utf-8")
    os.utime(path, (t, t))


def test_write_rejected_after_external_change(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("v1\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    _bump(p)
    with pytest.raises(ToolError, match="changed on disk"):
        fs.write_file(ctx, {"path": "a.txt", "content": "v2\n"})


def test_patch_rejected_after_external_change(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("one\ntwo\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    _bump(p)
    with pytest.raises(ToolError, match="changed on disk"):
        fs.apply_patch(ctx, {"path": "a.txt", "search": "two", "replace": "three"})


def test_write_allowed_without_prior_read(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("old\n", encoding="utf-8")
    out = fs.write_file(ctx, {"path": "a.txt", "content": "new\n"})
    assert "warning" in out  # overwrite without read: allowed but warned
    assert p.read_text(encoding="utf-8") == "new\n"


def test_write_after_read_no_warning(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("old\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    out = fs.write_file(ctx, {"path": "a.txt", "content": "new\n"})
    assert "warning" not in out


def test_write_new_file_no_warning(ctx, tmp_path):
    out = fs.write_file(ctx, {"path": "brand_new.txt", "content": "hi\n"})
    assert "warning" not in out


def test_read_mtimes_updated_by_patch(ctx, tmp_path):
    p = tmp_path / "a.txt"
    p.write_text("one\ntwo\n", encoding="utf-8")
    fs.read_file(ctx, {"path": "a.txt"})
    fs.apply_patch(ctx, {"path": "a.txt", "search": "two", "replace": "three"})
    # a patch refreshes the baseline: no stale error on the next write
    out = fs.write_file(ctx, {"path": "a.txt", "content": "fresh\n"})
    assert "changed on disk" not in out


# ------------------------------------------------------- grep enhancements
def test_grep_output_modes(ctx, tmp_path):
    (tmp_path / "a.py").write_text("needle\nneedle\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("needle\n", encoding="utf-8")
    out = fs.grep_search(ctx, {"pattern": "needle", "output_mode": "files_with_matches"})
    assert out.splitlines() == ["a.py", "b.txt"]
    out = fs.grep_search(ctx, {"pattern": "needle", "output_mode": "count"})
    assert "2\ta.py" in out and "1\tb.txt" in out
    out = fs.grep_search(ctx, {"pattern": "needle"})
    assert "a.py:1: needle" in out


def test_grep_type_filter(ctx, tmp_path):
    (tmp_path / "a.py").write_text("token\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("token\n", encoding="utf-8")
    out = fs.grep_search(ctx, {"pattern": "token", "type": "py"})
    assert "a.py" in out and "b.txt" not in out


def test_grep_offset_and_head_limit(ctx, tmp_path):
    (tmp_path / "a.txt").write_text("\n".join(f"m{i}" for i in range(10)), encoding="utf-8")
    out = fs.grep_search(ctx, {"pattern": "m", "head_limit": 3})
    assert out.count(": m") == 3 and "use offset=3" in out
    out = fs.grep_search(ctx, {"pattern": "m", "head_limit": 3, "offset": 7})
    assert "m7" in out and "m8" in out and "m9" in out and "m6" not in out


def test_grep_multiline(ctx, tmp_path):
    (tmp_path / "a.py").write_text("def f(a,\n           b):\n    pass\n", encoding="utf-8")
    out = fs.grep_search(ctx, {"pattern": "a,\\s+b", "is_regex": True, "multiline": True})
    assert "a.py:1" in out
    # without multiline the pattern cannot span the newline
    out = fs.grep_search(ctx, {"pattern": "a,\\s+b", "is_regex": True})
    assert out == "(no matches)"


def test_grep_context_lines_after(ctx, tmp_path):
    (tmp_path / "a.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
    out = fs.grep_search(ctx, {"pattern": "two", "context_lines": 1})
    assert "a.py" not in out and "a.txt:2: two" in out and "a.txt:3- three" in out


def test_walk_honours_gitignore(tmp_path):
    import subprocess
    (tmp_path / ".gitignore").write_text("build/\n", encoding="utf-8")
    (tmp_path / "build").mkdir()
    (tmp_path / "build" / "gen.py").write_text("x", encoding="utf-8")
    (tmp_path / "src.py").write_text("x", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    files = {p.name for p in fs._walk(tmp_path)}
    assert "src.py" in files and "gen.py" not in files


def test_walk_without_git_uses_ignored_dirs(tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "lib.js").write_text("x", encoding="utf-8")
    (tmp_path / "main.js").write_text("x", encoding="utf-8")
    files = {p.name for p in fs._walk(tmp_path)}
    assert "main.js" in files and "lib.js" not in files


# ------------------------------------------------------------- code_symbols
def test_code_symbols_python_and_cpp(ctx, tmp_path):
    from coder_agent.tools import symbols

    (tmp_path / "a.py").write_text(
        "class Alpha:\n    def method(self):\n        return 1\n\n\ndef top_func(x, y):\n    return x + y\n",
        encoding="utf-8")
    (tmp_path / "b.cpp").write_text(
        "class Beta {\npublic:\n    int run(int v);\n};\n\nint free_fn() {\n    return 0;\n}\n",
        encoding="utf-8")
    out = symbols.code_symbols(ctx, {"query": "top_func"})
    assert "a.py:6" in out and "[function] top_func" in out
    out = symbols.code_symbols(ctx, {"query": "Alpha", "kind": "class"})
    assert "a.py:1" in out and "[class] Alpha" in out
    out = symbols.code_symbols(ctx, {"query": "method", "kind": "function"})
    assert "a.py:2" in out
    # substring fallback: 'top' matches top_func only
    out = symbols.code_symbols(ctx, {"query": "top"})
    assert "top_func" in out and "Beta" not in out
    # kind filter excludes functions
    out = symbols.code_symbols(ctx, {"query": "method", "kind": "class"})
    assert out.startswith("(no symbols")
    # no match
    assert symbols.code_symbols(ctx, {"query": "zzz"}) .startswith("(no symbols")


def test_code_symbols_cache_invalidated_on_edit(ctx, tmp_path):
    import time as _time

    from coder_agent.tools import symbols

    (tmp_path / "a.py").write_text("def one():\n    pass\n", encoding="utf-8")
    assert "one" in symbols.code_symbols(ctx, {"query": "one"})
    # external edit bumps the mtime -> the cache must be rebuilt
    t = _time.time() + 5
    (tmp_path / "a.py").write_text("def two():\n    pass\n", encoding="utf-8")
    _time.sleep(0.01)
    import os as _os
    _os.utime(tmp_path / "a.py", (t, t))
    assert "two" in symbols.code_symbols(ctx, {"query": "two"})
    assert symbols.code_symbols(ctx, {"query": "one"}).startswith("(no symbols")


# ------------------------------------------------- move / delete / make_dir
def test_make_dir(ctx, tmp_path):
    assert "Created" in fs.make_dir(ctx, {"path": "a/b/c"})
    assert (tmp_path / "a/b/c").is_dir()
    with pytest.raises(ToolError):
        fs.make_dir(ctx, {"path": "a/b/c"})  # already exists


def test_move_path(ctx, tmp_path):
    (tmp_path / "src.txt").write_text("x", encoding="utf-8")
    assert "Moved" in fs.move_path(ctx, {"source": "src.txt", "destination": "sub/dst.txt"})
    assert (tmp_path / "sub/dst.txt").is_file()
    assert not (tmp_path / "src.txt").exists()
    with pytest.raises(ToolError):
        fs.move_path(ctx, {"source": "missing.txt", "destination": "y.txt"})


def test_delete_path(ctx, tmp_path):
    (tmp_path / "gone.txt").write_text("x", encoding="utf-8")
    assert "Deleted" in fs.delete_path(ctx, {"path": "gone.txt"})
    assert not (tmp_path / "gone.txt").exists()
    with pytest.raises(ToolError):
        fs.delete_path(ctx, {"path": "a-dir"})  # not a file


def test_move_delete_rewind(snap_ctx, tmp_path):
    """move + delete are recorded in the snapshot and restored by rewind."""
    snap = snap_ctx.snapshots
    snap.begin("t1")
    (tmp_path / "orig.txt").write_text("original", encoding="utf-8")
    (tmp_path / "temp.txt").write_text("temp", encoding="utf-8")
    fs.move_path(snap_ctx, {"source": "orig.txt", "destination": "renamed.txt"})
    fs.delete_path(snap_ctx, {"path": "temp.txt"})
    assert (tmp_path / "renamed.txt").is_file()
    assert not (tmp_path / "orig.txt").exists()
    assert not (tmp_path / "temp.txt").exists()
    changed = set(snap.changed_files("t1"))
    assert {"orig.txt", "renamed.txt", "temp.txt"} <= changed
    snap.restore("t1")
    assert (tmp_path / "orig.txt").read_text(encoding="utf-8") == "original"
    assert (tmp_path / "temp.txt").read_text(encoding="utf-8") == "temp"
    assert not (tmp_path / "renamed.txt").exists()


def test_code_symbols_tool_registered():
    from coder_agent.tools import default_registry

    reg = default_registry()
    t = reg.get("code_symbols")
    assert t is not None and t.kind == "read"
    assert "query" in t.parameters["required"]
