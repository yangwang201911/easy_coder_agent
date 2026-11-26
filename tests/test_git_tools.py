"""Tests for the git tools on a throwaway repository."""

import subprocess

import pytest

from coder_agent.tools import git
from coder_agent.tools.base import ToolContext, ToolError


@pytest.fixture
def repo(tmp_path):
    def sh(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True,
                       capture_output=True, text=True)
    sh("init", "-b", "main")
    sh("config", "user.email", "t@t.t")
    sh("config", "user.name", "t")
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    sh("add", "a.txt")
    sh("commit", "-m", "first commit")
    return ToolContext(root=tmp_path)


def test_git_status(repo):
    out = git.git_status(repo, {})
    assert "main" in out
    assert "b.txt" not in out
    (repo.root / "b.txt").write_text("x\n", encoding="utf-8")
    out = git.git_status(repo, {})
    assert "b.txt" in out


def test_git_diff(repo):
    (repo.root / "a.txt").write_text("one\ntwo\n", encoding="utf-8")
    out = git.git_diff(repo, {})
    assert "+two" in out
    assert git.git_diff(repo, {"staged": True}) == "(no differences)"


def test_git_diff_against_base(repo):
    (repo.root / "a.txt").write_text("one\nv2\n", encoding="utf-8")
    subprocess.run(["git", "commit", "-am", "second"], cwd=repo.root,
                   check=True, capture_output=True)
    # diff against HEAD~1 = the committed change from the second commit
    out = git.git_diff(repo, {"base": "HEAD~1"})
    assert "+v2" in out
    out = git.git_diff(repo, {"base": "HEAD~1", "path": "a.txt"})
    assert "+v2" in out
    out = git.git_diff(repo, {"base": "HEAD"})
    assert out == "(no differences)"


def test_git_log(repo):
    out = git.git_log(repo, {"n": 5})
    assert "first commit" in out


def test_git_show(repo):
    out = git.git_show(repo, {"rev": "HEAD"})
    assert "first commit" in out


def test_git_commit_with_paths(repo):
    (repo.root / "a.txt").write_text("one\nedited\n", encoding="utf-8")
    (repo.root / "c.txt").write_text("c\n", encoding="utf-8")
    out = git.git_commit(repo, {"message": "edit a", "paths": ["a.txt"]})
    assert "committed" in out
    st = git.git_status(repo, {})
    assert "a.txt" not in st  # a.txt is committed
    assert "c.txt" in st      # c.txt is not


def test_git_commit_requires_message(repo):
    with pytest.raises(ToolError, match="message"):
        git.git_commit(repo, {"message": "  "})


def test_git_branch_create_and_list(repo):
    out = git.git_branch(repo, {"name": "feature/x"})
    assert "created branch" in out
    assert "feature/x" in git.git_branch(repo, {})


def test_git_checkout_dirty_worktree_refused(repo):
    (repo.root / "a.txt").write_text("dirty\n", encoding="utf-8")
    subprocess.run(["git", "branch", "other"], cwd=repo.root, check=True, capture_output=True)
    with pytest.raises(ToolError, match="uncommitted changes"):
        git.git_checkout(repo, {"target": "other"})
    # force=true goes through (approval is enforced by the agent layer)
    out = git.git_checkout(repo, {"target": "other", "force": True})
    assert "other" in git.git_branch(repo, {})


def test_git_rejects_bad_identifiers(repo):
    with pytest.raises(ToolError, match="invalid"):
        git.git_show(repo, {"rev": "HEAD; rm -rf /"})
    with pytest.raises(ToolError, match="invalid"):
        git.git_branch(repo, {"name": "bad;name"})
    with pytest.raises(ToolError, match="invalid"):
        git.git_diff(repo, {"base": "HEAD~1 && evil"})


def test_tools_registered():
    from coder_agent.tools import default_registry
    reg = default_registry()
    for name in ("git_status", "git_diff", "git_log", "git_show",
                 "git_commit", "git_branch", "git_checkout"):
        assert name in reg._tools, name
    assert reg._tools["git_status"].kind == "read"
    assert reg._tools["git_commit"].kind == "exec"
    assert reg._tools["git_commit"].command_of({"message": "m"}) == "git commit -m m"
