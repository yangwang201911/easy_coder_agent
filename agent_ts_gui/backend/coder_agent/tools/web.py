"""Web search and page fetch over HTTP. Browser tools live in browser.py."""

from __future__ import annotations

import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Optional

from .base import Tool, ToolContext, ToolError

# ------------------------------------------------------------ web search / fetch

SEARCH_TIMEOUT = 20
FETCH_TIMEOUT = 30
MAX_FETCH_BYTES = 2 * 1024 * 1024
MAX_FETCH_TEXT = 20000  # chars of extracted text returned to the model
MAX_PROMPT_TEXT = 6000  # chars returned when web_fetch is given a prompt
CACHE_TTL = 900  # seconds a fetched page stays in the cache
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) coder-agent/0.1"
_fetch_cache: dict[str, tuple[float, str]] = {}  # url -> (ts, extracted text)
_TAG_RE = re.compile(r"<[^>]+>")
_BLOCK_TAGS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "pre"}
_SKIP_TAGS = {"script", "style", "noscript", "svg", "head", "template"}


class _TextExtractor(HTMLParser):
    """Collects the visible text and the <title> of an HTML document."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _SKIP_TAGS:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skip:
            self.parts.append(data)


def _http_get(url: str, headers: dict, timeout: float) -> tuple[str, bytes]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **headers})
    try:
        # honours HTTP(S)_PROXY, needed for internet access on this host
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.headers.get("Content-Type", ""), resp.read(MAX_FETCH_BYTES)
    except urllib.error.HTTPError as e:
        raise ToolError(f"HTTP {e.code} from {urllib.parse.urlparse(url).netloc}")
    except OSError as e:  # URLError, timeouts, connection resets
        raise ToolError(f"request failed: {getattr(e, 'reason', e)}")


def _clean(s: Optional[str]) -> str:
    return " ".join(html.unescape(_TAG_RE.sub("", s or "")).split())


def _searxng(base: str, query: str, n: int) -> list[dict]:
    url = base.rstrip("/") + "/search?" + urllib.parse.urlencode({"q": query, "format": "json"})
    _, body = _http_get(url, {"Accept": "application/json"}, SEARCH_TIMEOUT)
    rows = json.loads(body).get("results", [])[:n]
    return [{"title": _clean(r.get("title")), "url": r.get("url", ""), "snippet": _clean(r.get("content"))} for r in rows]


def _brave(key: str, query: str, n: int) -> list[dict]:
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({"q": query, "count": n})
    _, body = _http_get(url, {"Accept": "application/json", "X-Subscription-Token": key}, SEARCH_TIMEOUT)
    rows = json.loads(body).get("web", {}).get("results", [])[:n]
    return [{"title": _clean(r.get("title")), "url": r.get("url", ""), "snippet": _clean(r.get("description"))} for r in rows]


_DDG_LINK_RE = re.compile(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>')
_DDG_SNIP_RE = re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.S)


def _ddg_real_url(href: str) -> str:
    """DuckDuckGo wraps results in a redirect (/l/?uddg=<url-encoded>); unwrap it."""
    if href.startswith("//"):
        href = "https:" + href
    q = urllib.parse.urlparse(href).query
    if "uddg=" in q:
        return urllib.parse.parse_qs(q).get("uddg", [href])[0]
    return href


def _duckduckgo(query: str, n: int) -> list[dict]:
    """Keyless fallback: the public DuckDuckGo HTML endpoint."""
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    _, body = _http_get(url, {"Accept": "text/html"}, SEARCH_TIMEOUT)
    text = body.decode("utf-8", errors="replace")
    links = _DDG_LINK_RE.findall(text)
    snips = [_clean(s) for s in _DDG_SNIP_RE.findall(text)]
    rows = []
    for i, (href, title) in enumerate(links[:n]):
        rows.append({"title": _clean(title), "url": _ddg_real_url(href),
                     "snippet": snips[i] if i < len(snips) else ""})
    return rows


def web_search(ctx: ToolContext, a: dict) -> str:
    query = str(a["query"]).strip()
    if not query:
        raise ToolError("query is empty")
    n = max(1, min(int(a.get("max_results", 5)), 10))
    if os.environ.get("SEARXNG_URL"):
        rows = _searxng(os.environ["SEARXNG_URL"], query, n)
    elif os.environ.get("BRAVE_API_KEY"):
        rows = _brave(os.environ["BRAVE_API_KEY"], query, n)
    else:
        rows = _duckduckgo(query, n)  # keyless fallback
    if not rows:
        return f"no results for '{query}'"
    body = "\n\n".join(
        f"{i}. {r['title']}\n   {r['url']}" + (f"\n   {r['snippet']}" if r["snippet"] else "")
        for i, r in enumerate(rows, 1)
    )
    return _untrusted(f"search:{query}", body)


def web_fetch(ctx: ToolContext, a: dict) -> str:
    url = str(a["url"]).strip()
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ToolError("only absolute http(s) urls are supported")
    prompt = str(a.get("prompt") or "").strip()
    now = time.time()
    cached = _fetch_cache.get(url)
    if cached and now - cached[0] < CACHE_TTL:
        title, text, from_cache = "", cached[1], True
    else:
        ctype, body = _http_get(url, {"Accept": "text/html,text/plain,application/json;q=0.9"}, FETCH_TIMEOUT)
        charset = "utf-8"
        if "charset=" in ctype:
            charset = ctype.split("charset=", 1)[1].split(";")[0].strip().strip('"') or "utf-8"
        try:
            raw = body.decode(charset, errors="replace")
        except LookupError:
            raw = body.decode("utf-8", errors="replace")
        title = ""
        if "html" in ctype or raw.lstrip()[:1] == "<":
            parser = _TextExtractor()
            parser.feed(raw)
            parser.close()
            title, text = " ".join(parser.title.split()), "".join(parser.parts)
        else:
            text = raw
        text = re.sub(r"[ \t\r\f\v]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        _fetch_cache[url] = (now, text)
        from_cache = False
    if prompt:
        # extract only the parts relevant to the question: lines containing
        # query terms, plus their neighbours - keeps the context small
        text = _extract_relevant(text, prompt, MAX_PROMPT_TEXT)
        more = ""
    else:
        more = "\n[... truncated]" if len(text) > MAX_FETCH_TEXT else ""
        text = text[:MAX_FETCH_TEXT]
    head = f"{title}\n" if title else ""
    head += url + ("  [cached]" if from_cache else "") + "\n\n"
    return _untrusted(url, head + text + more)


def _extract_relevant(text: str, prompt: str, limit: int) -> str:
    """Return the paragraphs of ``text`` that mention any of the prompt's terms."""
    terms = [t for t in re.split(r"[\s,，;；]+", prompt.lower()) if len(t) >= 3]
    if not terms:
        return text[:limit]
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    picked: list[str] = []
    for i, p in enumerate(paragraphs):
        low = p.lower()
        if any(t in low for t in terms):
            picked.append(paragraphs[max(0, i - 1)] if i > 0 else "")
            picked.append(p)
    out = "\n\n".join(dict.fromkeys(p for p in picked if p.strip()))
    if len(out) > limit:
        out = out[:limit] + "\n[... truncated]"
    return out or "(no part of the page mentions the requested terms)"


def _untrusted(source: str, body: str) -> str:
    """Wrap external content: it is data, never instructions (prompt-injection guard)."""
    return f"<untrusted_content source={source!r}>\n{body}\n</untrusted_content>"


def _search_host(a: dict) -> str:
    base = (os.environ.get("SEARXNG_URL")
            or ("https://api.search.brave.com" if os.environ.get("BRAVE_API_KEY") else None)
            or "https://html.duckduckgo.com")
    return urllib.parse.urlparse(base).hostname or ""


def _url_host(a: dict) -> str:
    return urllib.parse.urlparse(str(a.get("url", ""))).hostname or ""


def web_tools() -> list[Tool]:
    return [
        Tool(
            name="web_search",
            description=(
                "Search the internet and return the top results (title, URL, snippet). Use it for "
                "current facts, library/API documentation, or error messages. Call web_fetch on a "
                "result URL to read the page."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "the search query"},
                    "max_results": {"type": "integer", "description": "1-10, default 5"},
                },
                "required": ["query"],
            },
            func=web_search,
            kind="network",
            target_of=_search_host,
        ),
        Tool(
            name="web_fetch",
            description=(
                "Download a public web page or text file and return its readable text (HTML is converted "
                "to plain text). Long pages are truncated. With prompt, only the parts of the page that "
                "answer the question are returned (much smaller). Pages are cached for 15 minutes."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "absolute http(s) URL"},
                    "prompt": {"type": "string", "description": "optional: what to extract from the page, e.g. 'the supported Python versions'"},
                },
                "required": ["url"],
            },
            func=web_fetch,
            kind="network",
            target_of=_url_host,
        ),
    ]
