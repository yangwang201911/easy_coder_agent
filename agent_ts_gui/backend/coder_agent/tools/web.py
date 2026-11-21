"""Web page tools: open a page in the GUI and screenshot local web servers.

``web_screenshot`` renders a page with a headless Chrome (the same browser the
GUI ships with) and returns the screenshot as an image the model can see -
this closes the "agent starts a web server, looks at the page, fixes it" loop.
``web_open`` asks the GUI to show the page in a browser tab next to the file
viewer, so the user can follow along.
"""

from __future__ import annotations

import base64
import ipaddress
import os
import shutil
import subprocess
import tempfile
import urllib.parse
from typing import Optional

from .base import Tool, ToolContext, ToolError, ToolOutput

DEFAULT_TIMEOUT = 30  # headless chrome is slow to start on busy machines
MAX_TIMEOUT = 90
MAX_EDGE = 1280  # keep the screenshot token-friendly for common vision models


def _find_chrome() -> Optional[str]:
    for name in ("google-chrome", "chromium", "chromium-browser", "google-chrome-stable", "chrome"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _check_url(url: str) -> str:
    """Only local / private hosts are allowed (the agent must not screenshot arbitrary sites)."""
    try:
        u = urllib.parse.urlparse(url)
    except ValueError as e:
        raise ToolError(f"invalid url: {e}")
    if u.scheme not in ("http", "https"):
        raise ToolError(f"only http(s) urls are supported, got '{u.scheme}'")
    host = u.hostname or ""
    if host in ("localhost",):
        return url
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # not an IP literal: only allow hostnames that look local (no public lookups here)
        if not (host.endswith(".local") or host.endswith(".lan") or "." not in host):
            raise ToolError(f"host '{host}' is not a local/private address")
        return url
    if not (ip.is_loopback or ip.is_private or ip.is_link_local):
        raise ToolError(f"host '{host}' is not a local/private address; only local web servers can be screenshotted")
    return url


def web_screenshot(ctx: ToolContext, a: dict) -> ToolOutput:
    url = _check_url(str(a["url"]).strip())
    timeout = max(1, min(int(a.get("timeout", DEFAULT_TIMEOUT)), MAX_TIMEOUT))
    chrome = _find_chrome()
    if not chrome:
        raise ToolError(
            "no Chrome/Chromium found on this machine - install google-chrome or chromium "
            "to enable web_screenshot"
        )
    profile = tempfile.mkdtemp(prefix="agent-chrome-")
    # --virtual-time-budget: fast-forwards timers so headless chrome exits once the
    # page has settled (plain --headless=new hangs in some environments)
    cmd = [
        chrome, "--headless", "--no-sandbox", "--disable-gpu",
        f"--user-data-dir={profile}",
        f"--window-size={MAX_EDGE},900",
        "--virtual-time-budget=6000",
        f"--screenshot={profile}/shot.png",
        url,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ToolError(f"screenshot timed out after {timeout}s (is the server at {url} running?)")
    except FileNotFoundError:
        raise ToolError("chrome binary disappeared; cannot screenshot")
    shot = f"{profile}/shot.png"
    if not os.path.exists(shot) or os.path.getsize(shot) < 100:
        err = (proc.stderr or proc.stdout or "").strip()[-300:]
        raise ToolError(f"page did not render (server down or error page): {err or 'unknown error'}")
    with open(shot, "rb") as f:
        data = f.read()
    if len(data) > 8 * 1024 * 1024:  # a few MB of PNG is plenty for a page
        raise ToolError("screenshot too large; the page is probably not a normal web view")
    shutil.rmtree(profile, ignore_errors=True)
    name = url.replace("://", "_")[:60]
    return ToolOutput(
        text=f"screenshot of {url} attached below ({len(data) // 1024} KB). "
             "Inspect the rendered page and keep going.",
        images=[{"name": name, "data_url": "data:image/png;base64," + base64.b64encode(data).decode()}],
    )


def web_open(ctx: ToolContext, a: dict) -> str:
    url = _check_url(str(a["url"]).strip())
    ctx.emit("web_open", {"url": url})
    return f"asked the GUI to open {url} in a browser tab (the user can now see it)"


def web_tools() -> list[Tool]:
    return [
        Tool(
            name="web_screenshot",
            description=(
                "Render a local web page (http://localhost:PORT/...) in a headless browser and return a "
                "screenshot that you can see. Use it after starting a web server to check how the page "
                "looks, and after fixing it to verify the change. Only local/private hosts are allowed."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "the page to render, e.g. http://localhost:8000/"},
                    "timeout": {"type": "integer", "description": "seconds to wait for the page (default 15)"},
                },
                "required": ["url"],
            },
            func=web_screenshot,
            kind="read",
        ),
        Tool(
            name="web_open",
            description=(
                "Open a local web page in the GUI's browser tab (next to the file viewer) so the user can "
                "follow along. Does not block."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "the page to open, e.g. http://localhost:8000/"},
                },
                "required": ["url"],
            },
            func=web_open,
            kind="read",
        ),
    ]
