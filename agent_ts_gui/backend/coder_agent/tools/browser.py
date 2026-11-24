"""Browser tools on Playwright: navigate, snapshot, click, type, screenshot, console.

The tool set follows the Playwright MCP server. ``browser_snapshot`` gives the model
element refs (``e12``) and page text, so it never has to write selectors. Navigation
to non-local hosts needs approval (network kind); page requests that try to navigate
to an unapproved host are blocked. All Playwright calls run on one dedicated thread.
"""

from __future__ import annotations

import base64
import concurrent.futures
import os
import queue
import re
import shutil
import threading
import urllib.parse
from typing import Callable, Optional

from ..util import is_local_host
from .base import Tool, ToolContext, ToolError, ToolOutput

CALL_TIMEOUT = 90  # seconds one browser tool call may block the agent
NAV_TIMEOUT_MS = 30000
VIEWPORT = {"width": 1280, "height": 800}
MAX_ELEMENTS = 200
MAX_TEXT_CHARS = 8000
MAX_CONSOLE = 200
MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024
CHROME_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")
_REF_RE = re.compile(r"^e\d{1,5}$")

_SNAPSHOT_JS = r"""
(limit) => {
  document.querySelectorAll('[data-agent-ref]').forEach(e => e.removeAttribute('data-agent-ref'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],' +
              '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=combobox],[contenteditable=true]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= limit) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const ref = 'e' + (out.length + 1);
    el.setAttribute('data-agent-ref', ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (type || 'text') : tag);
    let label = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '';
    if (!label && tag !== 'input') label = el.innerText || '';
    if (!label && tag === 'input' && type !== 'password') label = el.value || '';
    label = label.replace(/\s+/g, ' ').trim().slice(0, 100);
    out.push('[' + ref + '] ' + role + ' "' + label + '"' + (el.disabled ? ' (disabled)' : ''));
  }
  return out.join('\n');
}
"""


def _find_chrome() -> Optional[str]:
    for name in CHROME_NAMES:
        p = shutil.which(name)
        if p:
            return p
    return None


class _Browser:
    """One browser per process; every Playwright call runs on the thread started here."""

    def __init__(self) -> None:
        self._q: queue.Queue = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._start_lock = threading.Lock()
        self._pw = None
        self._browser = None
        self._context = None
        self._pages: list = []
        self._tab = 0  # index of the active tab in _pages
        self._console: list[str] = []
        self.approved_hosts: set[str] = set()

    @property
    def _page(self):
        return self._pages[self._tab] if self._pages else None

    def call(self, fn: Callable[[], object]):
        with self._start_lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="browser", daemon=True)
                self._thread.start()
        fut: concurrent.futures.Future = concurrent.futures.Future()
        self._q.put((fn, fut))
        try:
            return fut.result(timeout=CALL_TIMEOUT)
        except concurrent.futures.TimeoutError:
            raise ToolError(f"browser call timed out after {CALL_TIMEOUT}s")

    def _loop(self) -> None:
        while True:
            fn, fut = self._q.get()
            if not fut.set_running_or_notify_cancel():
                continue
            try:
                fut.set_result(fn())
            except BaseException as e:  # noqa: BLE001 - re-raised in the calling tool
                fut.set_exception(e)

    # ---- everything below runs on the browser thread
    def ensure_started(self):
        if self._page is not None and not self._page.is_closed():
            return self._page
        self._new_tab()
        return self._page

    def _new_tab(self, url: Optional[str] = None):
        from playwright.sync_api import sync_playwright

        if self._pw is None:
            self._pw = sync_playwright().start()
        if self._browser is None or not self._browser.is_connected():
            self._browser = self._launch()
            self._context = self._browser.new_context(viewport=VIEWPORT)
            self._context.route("**/*", self._route)
        page = self._context.new_page()
        page.on("console", lambda m: self._log(f"console.{m.type}: {m.text}"))
        page.on("pageerror", lambda e: self._log(f"pageerror: {e}"))
        self._pages.append(page)
        self._tab = len(self._pages) - 1
        if url:
            page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        return page

    def _launch(self):
        # executable None = Playwright's bundled Chromium; system Chrome is the fallback
        # (old system builds can stall for ~50s on the first page)
        exe = os.environ.get("BROWSER_EXECUTABLE")
        system = _find_chrome()
        candidates = [exe] if exe else [None, system] if system else [None]
        errors = []
        for path in candidates:
            try:
                return self._pw.chromium.launch(executable_path=path, headless=True)
            except Exception as e:  # noqa: BLE001
                errors.append(str(e).splitlines()[0] if str(e) else type(e).__name__)
        raise ToolError(
            f"cannot start Chromium ({'; '.join(errors)}); run 'playwright install chromium' or set BROWSER_EXECUTABLE"
        )

    def page_or_raise(self):
        if self._page is None or self._page.is_closed():
            raise ToolError("no page open; call browser_navigate first")
        return self._page

    def close(self) -> None:
        for obj in (self._context, self._browser):
            try:
                if obj is not None:
                    obj.close()
            except Exception:  # noqa: BLE001 - best effort during shutdown
                pass
        try:
            if self._pw is not None:
                self._pw.stop()
        except Exception:  # noqa: BLE001
            pass
        self._pw = self._browser = self._context = None
        self._pages.clear()
        self._tab = 0
        self._console.clear()
        self.approved_hosts.clear()

    def console_messages(self) -> list[str]:
        return list(self._console)

    def _log(self, text: str) -> None:
        self._console.append(text)
        del self._console[:-MAX_CONSOLE]

    def _route(self, route, request) -> None:
        parsed = urllib.parse.urlparse(request.url)
        host = parsed.hostname or ""
        # only top-level navigations are gated; page resources may load from anywhere
        if (request.is_navigation_request() and parsed.scheme in ("http", "https")
                and not is_local_host(host) and host not in self.approved_hosts):
            route.abort("blockedbyclient")
        else:
            route.continue_()


_BROWSER = _Browser()


def _http_url(raw: object) -> str:
    url = str(raw).strip()
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ToolError("only absolute http(s) urls are supported")
    return url


def _url_host(a: dict) -> str:
    return urllib.parse.urlparse(str(a.get("url", ""))).hostname or ""


def _ref(a: dict) -> str:
    ref = str(a["ref"]).strip()
    if not _REF_RE.match(ref):
        raise ToolError("ref must look like e12 (take it from browser_snapshot)")
    return ref


def _act(loc, action: str, *args):
    # Actionability can stall without animation frames (some headless setups); the forced retry still clicks at the element.
    try:
        return getattr(loc, action)(*args, timeout=5000)
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ != "TimeoutError":
            raise
        return getattr(loc, action)(*args, force=True, timeout=5000)


def _snapshot_text(page) -> str:
    title = page.title()
    refs = page.evaluate(_SNAPSHOT_JS, MAX_ELEMENTS)
    text = page.evaluate("() => document.body ? document.body.innerText : ''")
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()[:MAX_TEXT_CHARS]
    return f"Page: {title}\nURL: {page.url}\n\n## Interactive elements\n{refs or '(none)'}\n\n## Text\n{text}"


def browser_navigate(ctx: ToolContext, a: dict) -> str:
    url = _http_url(a["url"])
    host = urllib.parse.urlparse(url).hostname or ""

    def run():
        _BROWSER.approved_hosts.add(host)
        page = _BROWSER.ensure_started()
        try:
            resp = page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001 - Playwright navigation errors
            raise ToolError(f"navigation failed: {str(e).splitlines()[0]}")
        status = resp.status if resp else "n/a"
        return f"navigated (HTTP {status})\n\n" + _snapshot_text(page)

    return _BROWSER.call(run)


def browser_snapshot(ctx: ToolContext, a: dict) -> str:
    return _BROWSER.call(lambda: _snapshot_text(_BROWSER.page_or_raise()))


def browser_click(ctx: ToolContext, a: dict) -> str:
    ref = _ref(a)

    def run():
        page = _BROWSER.page_or_raise()
        loc = page.locator(f'[data-agent-ref="{ref}"]')
        if loc.count() == 0:
            raise ToolError(f"{ref} not found; the page changed - call browser_snapshot again")
        try:
            _act(loc.first, "click")
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"click {ref} failed: {str(e).splitlines()[0]}")
        try:
            page.wait_for_load_state("load", timeout=5000)
        except Exception:  # noqa: BLE001 - no navigation happened
            pass
        return f"clicked {ref}. Call browser_snapshot to see the new state."

    return _BROWSER.call(run)


def browser_type(ctx: ToolContext, a: dict) -> str:
    ref = _ref(a)
    text = str(a["text"])
    submit = bool(a.get("submit", False))

    def run():
        page = _BROWSER.page_or_raise()
        loc = page.locator(f'[data-agent-ref="{ref}"]')
        if loc.count() == 0:
            raise ToolError(f"{ref} not found; the page changed - call browser_snapshot again")
        try:
            _act(loc.first, "fill", text)
            if submit:
                loc.first.press("Enter")
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"typing into {ref} failed: {str(e).splitlines()[0]}")
        return f"typed into {ref}" + (" and pressed Enter" if submit else "")

    return _BROWSER.call(run)


def browser_take_screenshot(ctx: ToolContext, a: dict) -> ToolOutput:
    full_page = bool(a.get("full_page", False))

    def run():
        # CDP directly: Playwright's screenshot waits for a frame that some headless setups never paint
        page = _BROWSER.page_or_raise()
        cdp = page.context.new_cdp_session(page)
        try:
            res = cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 70, "captureBeyondViewport": full_page})
        finally:
            cdp.detach()
        return base64.b64decode(res["data"]), page.url

    data, url = _BROWSER.call(run)
    if len(data) > MAX_SCREENSHOT_BYTES:
        raise ToolError("screenshot too large; retry with full_page=false")
    return ToolOutput(
        text=f"screenshot of {url} attached below ({len(data) // 1024} KB). Inspect the rendered page.",
        images=[{"name": "screenshot", "data_url": "data:image/jpeg;base64," + base64.b64encode(data).decode()}],
    )


def browser_console_messages(ctx: ToolContext, a: dict) -> str:
    msgs = _BROWSER.call(_BROWSER.console_messages)
    return "\n".join(msgs[-50:]) or "(no console messages)"


def browser_close(ctx: ToolContext, a: dict) -> str:
    _BROWSER.call(_BROWSER.close)
    return "browser closed"


def browser_new_tab(ctx: ToolContext, a: dict) -> str:
    url = _http_url(a["url"])
    host = urllib.parse.urlparse(url).hostname or ""

    def run():
        _BROWSER.approved_hosts.add(host)
        page = _BROWSER._new_tab()
        try:
            resp = page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"navigation failed: {str(e).splitlines()[0]}")
        status = resp.status if resp else "n/a"
        n = len(_BROWSER._pages)
        return f"opened tab {n} (HTTP {status}), now active\n\n" + _snapshot_text(page)

    return _BROWSER.call(run)


def browser_switch_tab(ctx: ToolContext, a: dict) -> str:
    index = int(a.get("index", 0))

    def run():
        pages = [p for p in _BROWSER._pages if not p.is_closed()]
        if not pages:
            raise ToolError("no tabs open; call browser_navigate first")
        if not 1 <= index <= len(pages):
            raise ToolError(f"tab index must be 1-{len(pages)}")
        _BROWSER._pages = pages
        _BROWSER._tab = index - 1
        page = pages[index - 1]
        return f"switched to tab {index} ({len(pages)} open)\n\n" + _snapshot_text(page)

    return _BROWSER.call(run)


def web_open(ctx: ToolContext, a: dict) -> str:
    url = _http_url(a["url"])
    if not is_local_host(urllib.parse.urlparse(url).hostname or ""):
        raise ToolError("web_open only shows local pages; use browser_navigate for other sites")
    ctx.emit("web_open", {"url": url})
    return f"asked the GUI to open {url} in a browser tab (the user can now see it)"


def browser_tools() -> list[Tool]:
    url_param = {"type": "object", "properties": {"url": {"type": "string", "description": "absolute http(s) URL"}},
                 "required": ["url"]}
    ref_param = {"type": "string", "description": "element ref from browser_snapshot, e.g. e12"}
    return [
        Tool(
            name="browser_navigate",
            description=(
                "Open a URL in the browser and return a snapshot of the page. Local and private addresses "
                "need no approval; other sites ask the user first."
            ),
            parameters=url_param,
            func=browser_navigate,
            kind="network",
            target_of=_url_host,
        ),
        Tool(
            name="browser_snapshot",
            description=(
                "Return the current page: title, URL, interactive elements with refs (e.g. [e3] button \"Save\"), "
                "and visible text. Use refs with browser_click and browser_type."
            ),
            parameters={"type": "object", "properties": {}},
            func=browser_snapshot,
            kind="read",
        ),
        Tool(
            name="browser_click",
            description="Click an element by ref from the latest browser_snapshot.",
            parameters={"type": "object", "properties": {"ref": ref_param}, "required": ["ref"]},
            func=browser_click,
            kind="action",  # mutates the page: must run serially, in call order
        ),
        Tool(
            name="browser_type",
            description="Type text into an input by ref. Set submit=true to press Enter afterwards.",
            parameters={
                "type": "object",
                "properties": {
                    "ref": ref_param,
                    "text": {"type": "string", "description": "text to enter"},
                    "submit": {"type": "boolean", "description": "press Enter after typing"},
                },
                "required": ["ref", "text"],
            },
            func=browser_type,
            kind="action",  # mutates the page: must run serially, in call order
        ),
        Tool(
            name="browser_take_screenshot",
            description="Screenshot the current page so you can see the layout. Needs a vision-capable model.",
            parameters={
                "type": "object",
                "properties": {"full_page": {"type": "boolean", "description": "capture the whole scrollable page"}},
            },
            func=browser_take_screenshot,
            kind="read",
        ),
        Tool(
            name="browser_console_messages",
            description="List the page's console messages and uncaught errors since the page was opened.",
            parameters={"type": "object", "properties": {}},
            func=browser_console_messages,
            kind="read",
        ),
        Tool(
            name="browser_new_tab",
            description=(
                "Open a URL in a NEW tab and switch to it (the previous tab stays open). "
                "Use it to keep a second page alongside the current one."
            ),
            parameters=url_param,
            func=browser_new_tab,
            kind="network",
            target_of=_url_host,
        ),
        Tool(
            name="browser_switch_tab",
            description="Switch back to an earlier tab (1-based index) and return its snapshot.",
            parameters={
                "type": "object",
                "properties": {"index": {"type": "integer", "description": "tab number, 1-based"}},
                "required": ["index"],
            },
            func=browser_switch_tab,
            kind="action",  # mutates browser state: must run serially, in call order
        ),
        Tool(
            name="browser_close",
            description="Close the browser (all tabs).",
            parameters={"type": "object", "properties": {}},
            func=browser_close,
            kind="action",
        ),
        Tool(
            name="web_open",
            description=(
                "Open a local web page in the GUI's browser tab (next to the file viewer) so the user can "
                "follow along. Does not block."
            ),
            parameters=url_param,
            func=web_open,
            kind="read",
        ),
    ]
