"""Tests for web tool domain filtering (5.13)."""

from coder_agent.tools import web
from coder_agent.tools.base import ToolContext


def _rows():
    return [
        {"title": "a", "url": "https://docs.python.org/3/", "snippet": ""},
        {"title": "b", "url": "https://x.docs.python.org/guide/", "snippet": ""},
        {"title": "c", "url": "https://evil.example.com/x", "snippet": ""},
        {"title": "d", "url": "https://news.python.org/blog", "snippet": ""},
    ]


def test_filter_allowed_suffix_matches_subdomains():
    out = web._filter_domains(_rows(), ["docs.python.org"], [])
    assert [r["title"] for r in out] == ["a", "b"]


def test_filter_blocked_drops_matching():
    out = web._filter_domains(_rows(), [], ["evil.example.com"])
    assert [r["title"] for r in out] == ["a", "b", "d"]


def test_filter_allowed_and_blocked_combined():
    out = web._filter_domains(_rows(), ["python.org"], ["news.python.org"])
    assert [r["title"] for r in out] == ["a", "b"]


def test_filter_no_match_returns_empty():
    assert web._filter_domains(_rows(), ["nowhere.io"], []) == []


def test_domain_match_exact_and_suffix():
    assert web._domain_match("docs.python.org", "docs.python.org")
    assert web._domain_match("x.docs.python.org", "docs.python.org")
    assert not web._domain_match("evildocs.python.org", "docs.python.org")
    assert not web._domain_match("docs.python.org.evil.io", "docs.python.org")


def test_web_search_applies_filter(monkeypatch, tmp_path):
    """web_search with allowed_domains keeps only matching rows (fetches extra)."""
    seen = {}

    def fake_duckduckgo(query, n):
        seen["n"] = n
        return _rows()

    monkeypatch.setattr(web, "_duckduckgo", fake_duckduckgo)
    ctx = ToolContext(root=tmp_path)
    out = web.web_search(ctx, {"query": "python", "max_results": 2, "allowed_domains": ["docs.python.org"]})
    # extra rows were fetched to survive the filter
    assert seen["n"] >= 6
    assert "docs.python.org" in out
    assert "evil.example.com" not in out
    assert "news.python.org" not in out


def test_web_search_no_filter_unchanged(monkeypatch, tmp_path):
    def fake_duckduckgo(query, n):
        return _rows()[:n]

    monkeypatch.setattr(web, "_duckduckgo", fake_duckduckgo)
    ctx = ToolContext(root=tmp_path)
    out = web.web_search(ctx, {"query": "python", "max_results": 3})
    assert "evil.example.com" in out  # no filter: everything passes
