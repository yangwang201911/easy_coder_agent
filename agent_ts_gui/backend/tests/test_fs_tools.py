"""Tests for file tools: encoding detection, large-file streaming, patch hints, stale-write detection."""

import os
import time

import pytest

from coder_agent.tools import fs
from coder_agent.tools.base import ToolContext, ToolError


@pytest.fixture
def ctx(tmp_path):
    return ToolContext(root=tmp_path)


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
