"""MCP client: exposes the tools of MCP servers as agent tools.

Servers come from ``mcpServers`` in ``~/.coder_agent/mcp.json`` and, when the user policy
sets ``[mcp] project_servers = true``, from ``<project>/.mcp.json``. Three transports:

- ``command``: stdio (spawned process)
- ``url``: Streamable HTTP (optionally ``headers``; ``${ENV_VAR}`` is expanded so
  secrets stay in the environment, not in the config file)
- ``url`` + ``"transport": "sse"``: legacy SSE

Each remote tool is registered as ``mcp__<server>__<tool>`` and needs approval
(kind ``mcp``) unless allowed; a tool whose server marks it ``readOnlyHint`` is
registered as ``read`` (parallel, no approval) when ``[mcp] readonly_hint = true``
(the default). Servers that expose resources/prompts get ``mcp__<s>__list_resources``
/ ``mcp__<s>__read_resource`` / ``mcp__<s>__get_prompt`` tools.

When the total MCP tool count exceeds ``LAZY_THRESHOLD`` the individual tools are
NOT registered; instead ``mcp_search`` (list names + descriptions) and
``mcp_call`` (run one by full name) are registered, and ``mcp_search`` loads the
requested tool's schema into the registry on demand - keeping the prompt small
for local models.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Optional

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client

from ..paths import user_dir
from .base import Tool, ToolError, ToolOutput

log = logging.getLogger(__name__)
CONNECT_TIMEOUT = 60
CALL_TIMEOUT = 300
LAZY_THRESHOLD = 20  # more MCP tools than this: switch to mcp_search/mcp_call lazy loading

_ENV_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _expand_env(s: str) -> str:
    """Expand ``${VAR}`` references (missing vars expand to the empty string)."""
    return _ENV_RE.sub(lambda m: os.environ.get(m.group(1), ""), s)


def load_servers(root: Path, policy_data: dict) -> dict[str, dict]:
    files = [user_dir() / "mcp.json"]
    if (policy_data.get("mcp") or {}).get("project_servers"):
        files.append(Path(root) / ".mcp.json")
    servers: dict[str, dict] = {}
    for f in files:
        if not f.is_file():
            continue
        try:
            servers.update(json.loads(f.read_text(encoding="utf-8")).get("mcpServers", {}))
        except (ValueError, AttributeError) as e:
            log.warning("ignoring invalid MCP config %s: %s", f, e)
    return servers


class McpHub:
    """Owns one asyncio loop on a background thread; each server runs as a long-lived task."""

    def __init__(self, servers: dict[str, dict], readonly_hint: bool = True) -> None:
        self.specs = servers
        self.readonly_hint = readonly_hint
        self.errors: dict[str, str] = {}
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="mcp", daemon=True)
        self._sessions: dict[str, ClientSession] = {}
        self._stops: dict[str, asyncio.Event] = {}
        self._lazy: dict[str, tuple[str, Any]] = {}  # full tool name -> (server, spec)

    def start(self) -> list[Tool]:
        self._thread.start()
        tools: list[Tool] = []
        for name, spec in self.specs.items():
            try:
                listed = self._run(self._connect(name, spec), CONNECT_TIMEOUT)
            except Exception as e:  # noqa: BLE001 - one broken server must not stop the agent
                self.errors[name] = f"{type(e).__name__}: {e}"
                log.warning("MCP server %s unavailable: %s", name, self.errors[name])
                continue
            extras = self._extra_tools(name, listed)
            tools += [self._tool(name, t) for t in listed] + extras
        # too many tools would bloat the prompt (local models): lazy-load them instead
        if len(tools) > LAZY_THRESHOLD:
            log.info("MCP: %d tools > %d - using lazy loading (mcp_search/mcp_call)", len(tools), LAZY_THRESHOLD)
            return self.lazy_tools()
        return tools

    def lazy_tools(self) -> list[Tool]:
        return [self._search_tool(), self._call_tool()]

    def status(self) -> dict:
        """Per-server state for the GUI: connected / tool count / error text."""
        out: dict[str, dict] = {}
        for name in self.specs:
            if name in self._sessions:
                out[name] = {"ok": True, "tools": sum(1 for t in self._lazy if t.startswith(f"mcp__{name}__"))}
            else:
                out[name] = {"ok": False, "error": self.errors.get(name, "not connected")}
        return out

    def close(self) -> None:
        if not self._thread.is_alive():
            return

        async def shutdown() -> None:
            for ev in list(self._stops.values()):
                ev.set()
            for _ in range(50):  # let each server task leave its transport context
                if not self._stops:
                    break
                await asyncio.sleep(0.1)
            self._loop.stop()

        asyncio.run_coroutine_threadsafe(shutdown(), self._loop)

    def _run(self, coro, timeout: float):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout=timeout)

    async def _connect(self, name: str, spec: dict):
        ready: asyncio.Future = self._loop.create_future()
        self._loop.create_task(self._serve(name, spec, ready))
        return await ready

    async def _serve(self, name: str, spec: dict, ready: asyncio.Future) -> None:
        stop = asyncio.Event()
        self._stops[name] = stop
        try:
            if spec.get("url"):  # Streamable HTTP (default) or legacy SSE
                headers = {k: _expand_env(v) for k, v in (spec.get("headers") or {}).items()}
                if spec.get("transport") == "sse":
                    async with sse_client(spec["url"], headers=headers or None) as (read, write):
                        await self._session(name, ready, stop, read, write)
                else:
                    client = httpx.AsyncClient(headers=headers, follow_redirects=True)
                    try:
                        async with streamable_http_client(spec["url"], http_client=client) as (read, write, _):
                            await self._session(name, ready, stop, read, write)
                    finally:
                        await client.aclose()
            else:
                env = {**os.environ, **spec["env"]} if spec.get("env") else None
                params = StdioServerParameters(command=spec["command"], args=list(spec.get("args", [])), env=env)
                async with stdio_client(params) as (read, write):
                    await self._session(name, ready, stop, read, write)
        except Exception as e:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(e)
            else:
                log.warning("MCP server %s stopped: %s", name, e)
        finally:
            self._sessions.pop(name, None)
            self._stops.pop(name, None)

    async def _session(self, name: str, ready: asyncio.Future, stop: asyncio.Event, read, write) -> None:
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = (await session.list_tools()).tools
            self._sessions[name] = session
            ready.set_result(listed)
            await stop.wait()

    def call(self, server: str, tool: str, args: dict, ctx: Any = None) -> ToolOutput:
        session = self._sessions.get(server)
        if session is None:
            raise ToolError(f"MCP server '{server}' is not connected")
        if ctx is not None and ctx.cancel.is_set():
            raise ToolError("cancelled")

        async def go():
            return await session.call_tool(tool, args)

        result = self._run(go(), CALL_TIMEOUT)
        text, images = self._content(result)
        if getattr(result, "is_error", None) or getattr(result, "isError", False):
            raise ToolError(text or f"MCP tool {tool} failed")
        from .web import _untrusted
        return ToolOutput(text=_untrusted(f"mcp:{server}:{tool}", text or "(no text output)"), images=images)

    @staticmethod
    def _content(result: Any) -> tuple[str, list[dict]]:
        text = "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")
        images = [
            {"name": "mcp", "data_url": f"data:{getattr(c, 'mime_type', None) or c.mimeType};base64,{c.data}"}
            for c in result.content if getattr(c, "type", "") == "image"
        ]
        return text, images

    # ------------------------------------------------------- resources/prompts
    def _extra_tools(self, server: str, listed: list) -> list[Tool]:
        """Resource/prompt access tools for one server (only when it has the capability)."""
        session = self._sessions.get(server)
        out: list[Tool] = []
        if session is None:
            return out

        async def has(cap: str) -> bool:
            try:
                r = await getattr(session, cap)()
                return any(getattr(r, a, None) for a in ("resources", "prompts"))
            except Exception:  # noqa: BLE001 - capability missing or server quirk
                return False

        try:
            if self._run(has("list_resources"), 10):
                out.append(Tool(
                    name=f"mcp__{server}__list_resources",
                    description=f"List the resources exposed by MCP server '{server}'.",
                    parameters={"type": "object", "properties": {}},
                    func=lambda ctx, a, s=server: self._list_resources(s, ctx),
                    kind="mcp", target_of=lambda a, n=f"mcp__{server}__list_resources": n,
                ))
                out.append(Tool(
                    name=f"mcp__{server}__read_resource",
                    description=f"Read one resource (by uri) from MCP server '{server}'.",
                    parameters={"type": "object", "properties": {"uri": {"type": "string"}}, "required": ["uri"]},
                    func=lambda ctx, a, s=server: self._read_resource(s, a, ctx),
                    kind="mcp", target_of=lambda a, n=f"mcp__{server}__read_resource": n,
                ))
            if self._run(has("list_prompts"), 10):
                out.append(Tool(
                    name=f"mcp__{server}__get_prompt",
                    description=(f"Expand a prompt template (by name, optional arguments) from MCP server "
                                 f"'{server}' and use its text as a starting point."),
                    parameters={"type": "object",
                                "properties": {"name": {"type": "string"},
                                               "arguments": {"type": "object", "description": "template variables"}},
                                "required": ["name"]},
                    func=lambda ctx, a, s=server: self._get_prompt(s, a, ctx),
                    kind="mcp", target_of=lambda a, n=f"mcp__{server}__get_prompt": n,
                ))
        except Exception as e:  # noqa: BLE001 - capability probing must never break startup
            log.warning("MCP server %s capability probe failed: %s", server, e)
        return out

    def _list_resources(self, server: str, ctx: Any) -> ToolOutput:
        if ctx.cancel.is_set():
            raise ToolError("cancelled")

        async def go():
            return await self._sessions[server].list_resources()

        r = self._run(go(), CALL_TIMEOUT)
        lines = [f"{res.uri}  -  {res.name} ({getattr(res, 'mime_type', None) or getattr(res, 'mimeType', '')})" for res in r.resources]
        from .web import _untrusted
        return ToolOutput(_untrusted(f"mcp:{server}:resources", "\n".join(lines) or "(no resources)"))

    def _read_resource(self, server: str, args: dict, ctx: Any) -> ToolOutput:
        if ctx.cancel.is_set():
            raise ToolError("cancelled")

        async def go():
            return await self._sessions[server].read_resource(str(args["uri"]))

        r = self._run(go(), CALL_TIMEOUT)
        parts = []
        for c in r.contents:
            if getattr(c, "text", None) is not None:
                parts.append(c.text)
            elif getattr(c, "blob", None) is not None:
                parts.append(f"[binary {c.mimeType}: {len(c.blob)} bytes]")
        from .web import _untrusted
        return ToolOutput(_untrusted(f"mcp:{server}:{args['uri']}", "\n".join(parts) or "(empty resource)"))

    def _get_prompt(self, server: str, args: dict, ctx: Any) -> ToolOutput:
        if ctx.cancel.is_set():
            raise ToolError("cancelled")

        async def go():
            return await self._sessions[server].get_prompt(str(args["name"]), args.get("arguments"))

        r = self._run(go(), CALL_TIMEOUT)
        parts = []
        for m in r.messages:
            c = m.content if hasattr(m, "content") else m.get("content")
            if isinstance(c, dict):
                parts.append(c.get("text", ""))
            elif hasattr(c, "text"):
                parts.append(c.text)
            else:
                parts.append(str(c))
        text = "\n".join(parts)
        from .web import _untrusted
        return ToolOutput(_untrusted(f"mcp:{server}:prompt:{args['name']}", text or "(empty prompt)"))

    # ---------------------------------------------------------------- lazy load
    def _search_tool(self) -> Tool:
        def run(ctx, args: dict) -> ToolOutput:
            q = str(args.get("query", "")).lower()
            names = sorted(self._lazy)
            hits = [n for n in names if q in n.lower() or q in self._lazy[n][1].description.lower()] if q else names
            lines = [f"{n}  -  {self._lazy[n][1].description[:120]}" for n in hits[:50]]
            if not lines:
                return ToolOutput("No MCP tools match. Use mcp_call with a full name mcp__<server>__<tool>.")
            # load the matching tools into the registry on demand (the agent
            # refreshes its tool list every step, so they are usable next step)
            for n in hits[:50]:
                server, spec = self._lazy[n]
                if ctx.engine is not None and ctx.engine.registry.get(n) is None:
                    ctx.engine.registry.register(self._tool(server, spec))
            return ToolOutput(
                "Available MCP tools (loaded - you can now call them directly):\n" + "\n".join(lines)
                + "\nIf you want to run one immediately, you may also use mcp_call with the full name.")
        return Tool(
            name="mcp_search",
            description=("Search the available MCP tools (name/description) and load the matches so you can "
                         "call them. MCP tools are lazy-loaded: search first, then call by full name."),
            parameters={"type": "object", "properties": {"query": {"type": "string", "description": "substring to search"}}},
            func=run, kind="action",
        )

    def _call_tool(self) -> Tool:
        def run(ctx, args: dict) -> ToolOutput:
            name = str(args.get("name", ""))
            if name not in self._lazy:
                known = ", ".join(sorted(self._lazy)[:20])
                return ToolOutput(f"ERROR: unknown MCP tool '{name}'. Try mcp_search. Known: {known}")
            server, spec = self._lazy[name]
            tool = self._tool(server, spec)
            if ctx.engine is not None:
                ctx.engine.registry.register(tool)  # so the model can call it directly next step
            clean = ctx.engine.registry.normalize_args(tool, args.get("arguments") or {}) if ctx.engine is not None else dict(args.get("arguments") or {})
            return self.call(server, spec.name, clean, ctx)
        return Tool(
            name="mcp_call",
            description="Run one MCP tool by its full name (mcp__<server>__<tool>) with JSON arguments. Use mcp_search to find names.",
            parameters={"type": "object",
                        "properties": {"name": {"type": "string"},
                                       "arguments": {"type": "object", "description": "the tool's arguments"}},
                        "required": ["name"]},
            func=run, kind="mcp",
            target_of=lambda a: str(a.get("name", "")),
        )

    # ------------------------------------------------------------------ tools
    def _tool(self, server: str, spec: Any) -> Tool:
        name = f"mcp__{server}__{spec.name}"
        self._lazy[name] = (server, spec)
        schema = getattr(spec, "input_schema", None) or getattr(spec, "inputSchema", None)
        params = dict(schema or {"type": "object", "properties": {}})
        ann = getattr(spec, "annotations", None)
        read_only = bool(getattr(ann, "read_only_hint", None) or getattr(ann, "readOnlyHint", None)) if ann is not None else False
        kind = "read" if (read_only and self.readonly_hint) else "mcp"
        return Tool(
            name=name,
            description=(spec.description or "")[:1000],
            parameters=params,
            func=lambda ctx, a, s=server, t=spec.name: self.call(s, t, a, ctx),
            kind=kind,
            target_of=lambda a, n=name: n,
        )
