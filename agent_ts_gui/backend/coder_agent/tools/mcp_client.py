"""MCP client: exposes the tools of stdio MCP servers as agent tools.

Servers come from ``mcpServers`` in ``~/.coder_agent/mcp.json`` and, when the user policy
sets ``[mcp] project_servers = true``, from ``<project>/.mcp.json``. Each remote tool is
registered as ``mcp__<server>__<tool>`` and needs approval (kind ``mcp``) unless allowed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from ..paths import user_dir
from .base import Tool, ToolError, ToolOutput

log = logging.getLogger(__name__)
CONNECT_TIMEOUT = 60
CALL_TIMEOUT = 300


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

    def __init__(self, servers: dict[str, dict]) -> None:
        self.specs = servers
        self.errors: dict[str, str] = {}
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="mcp", daemon=True)
        self._sessions: dict[str, ClientSession] = {}
        self._stops: dict[str, asyncio.Event] = {}

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
            tools += [self._tool(name, t) for t in listed]
        return tools

    def close(self) -> None:
        if not self._thread.is_alive():
            return

        async def shutdown() -> None:
            for ev in list(self._stops.values()):
                ev.set()
            for _ in range(50):  # let each server task leave its stdio context
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
        env = {**os.environ, **spec["env"]} if spec.get("env") else None
        params = StdioServerParameters(command=spec["command"], args=list(spec.get("args", [])), env=env)
        stop = asyncio.Event()
        self._stops[name] = stop
        try:
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    listed = (await session.list_tools()).tools
                    self._sessions[name] = session
                    ready.set_result(listed)
                    await stop.wait()
        except Exception as e:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(e)
            else:
                log.warning("MCP server %s stopped: %s", name, e)
        finally:
            self._sessions.pop(name, None)
            self._stops.pop(name, None)

    def call(self, server: str, tool: str, args: dict) -> ToolOutput:
        session = self._sessions.get(server)
        if session is None:
            raise ToolError(f"MCP server '{server}' is not connected")

        async def go():
            return await session.call_tool(tool, args)

        result = self._run(go(), CALL_TIMEOUT)
        text = "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")
        images = [
            {"name": tool, "data_url": f"data:{getattr(c, 'mime_type', None) or c.mimeType};base64,{c.data}"}
            for c in result.content if getattr(c, "type", "") == "image"
        ]
        if getattr(result, "is_error", None) or getattr(result, "isError", False):
            raise ToolError(text or f"MCP tool {tool} failed")
        from .web import _untrusted
        return ToolOutput(text=_untrusted(f"mcp:{server}:{tool}", text or "(no text output)"), images=images)

    def _tool(self, server: str, spec: Any) -> Tool:
        name = f"mcp__{server}__{spec.name}"
        schema = getattr(spec, "input_schema", None) or getattr(spec, "inputSchema", None)
        params = dict(schema or {"type": "object", "properties": {}})
        return Tool(
            name=name,
            description=(spec.description or "")[:1000],
            parameters=params,
            func=lambda ctx, a, s=server, t=spec.name: self.call(s, t, a),
            kind="mcp",
            target_of=lambda a, n=name: n,
        )
