"""Tool abstraction, sandboxed context and registry."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from ..paths import agent_read_roots
from ..util import truncate_middle


class ToolError(Exception):
    """Expected failure; the message is returned to the model."""


class SnapshotRecorder(Protocol):
    def record(self, path: Path) -> None: ...


@dataclass
class ToolContext:
    root: Path
    cancel: threading.Event = field(default_factory=threading.Event)
    emit: Callable[[str, dict], None] = lambda kind, data: None
    snapshots: Optional[SnapshotRecorder] = None
    agent_id: str = "main"
    max_output_chars: int = 12000
    read_roots: list[Path] = field(default_factory=agent_read_roots)  # extra READ-only locations
    extra_roots: list[Path] = field(default_factory=list)  # trusted dirs outside the root (read + write), from the approval policy
    ask_user: Optional[Callable[[dict], Optional[dict]]] = None  # blocks until the user answers; None when headless
    todos: list[dict] = field(default_factory=list)  # the model's task checklist (update_todo)
    turn_cache: dict = field(default_factory=dict)  # per-turn cache: (tool, args, mtime) -> ToolOutput
    read_mtimes: dict = field(default_factory=dict)  # path -> st_mtime_ns of the last read_file (stale-write detection)

    def __post_init__(self) -> None:
        self.root = Path(self.root).resolve()

    def resolve_readable(self, p: str) -> Path:
        """Like ``resolve`` but also accepts files inside ``read_roots`` (the agent's own skills)."""
        path = Path(p).expanduser()
        if path.is_absolute():
            real = path.resolve()
            for r in self.read_roots:
                r = Path(r).resolve()
                if real == r or r in real.parents:
                    return real
        return self.resolve(p)

    def resolve(self, p: str) -> Path:
        """Resolve ``p`` (relative to root or absolute) and refuse to leave the root / trusted dirs."""
        path = Path(p).expanduser()
        if not path.is_absolute():
            path = self.root / path
        path = path.resolve()
        for r in (self.root, *self.extra_roots):
            if path == r or r in path.parents:
                return path
        raise ToolError(f"path '{p}' is outside the project root {self.root} and the trusted paths")

    def rel(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(self.root).as_posix()
        except ValueError:
            return str(path)


@dataclass
class ToolOutput:
    """A tool's result: text for the model, plus optional images (data URLs) that
    are injected into the conversation as image_url parts (vision models)."""
    text: str
    images: list[dict] = field(default_factory=list)  # [{"name": str, "data_url": "data:image/..."}]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict  # JSON schema
    func: Callable[[ToolContext, dict], "str | ToolOutput"]
    kind: str = "read"  # read (parallel, no approval) | action (serial, no approval) | write | exec | network | mcp
    preview: Optional[Callable[[ToolContext, dict], str]] = None  # diff / detail for approval
    command_of: Optional[Callable[[dict], str]] = None  # exec tools: the command line the approval policy judges
    target_of: Optional[Callable[[dict], str]] = None  # network tools: the host the approval policy judges
    cacheable: bool = False  # True: repeat calls with an unchanged target file return a stub (saves tokens)

    def schema(self) -> dict:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": self.parameters},
        }


def _coerce(value: Any, spec: dict) -> Any:
    t = spec.get("type")
    try:
        if t == "integer" and not isinstance(value, bool):
            return int(value)
        if t == "number":
            return float(value)
        if t == "boolean" and isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes")
    except (TypeError, ValueError):
        raise ToolError(f"parameter must be of type {t}, got {value!r}")
    return value


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return list(self._tools)

    def schemas(self, names: Optional[list[str]] = None) -> list[dict]:
        return [t.schema() for n, t in self._tools.items() if names is None or n in names]

    def subset(self, names: list[str]) -> "ToolRegistry":
        sub = ToolRegistry()
        for n in names:
            if n in self._tools:
                sub.register(self._tools[n])
        return sub

    def normalize_args(self, tool: Tool, args: dict) -> dict:
        props = tool.parameters.get("properties", {})
        missing = [r for r in tool.parameters.get("required", []) if r not in args]
        if missing:
            raise ToolError(
                f"missing required parameter(s): {', '.join(missing)}. "
                f"Expected parameters: {json.dumps(props, ensure_ascii=False)}"
            )
        return {k: _coerce(v, props.get(k, {})) for k, v in args.items() if k in props}

    def execute(self, name: str, args: dict, ctx: ToolContext) -> tuple[bool, ToolOutput]:
        """Run a tool. Returns ``(ok, ToolOutput)``; never raises for tool-level errors."""
        tool = self._tools.get(name)
        if tool is None:
            return False, ToolOutput(f"ERROR: unknown tool '{name}'. Available: {', '.join(self._tools)}")
        try:
            clean = self.normalize_args(tool, args)
            key = None
            if tool.cacheable:
                # (tool, args, mtime of the target file): a repeat read of an
                # unchanged file returns a stub instead of the whole content again
                try:
                    p = ctx.resolve_readable(str(clean.get("path", "")))
                except ToolError:
                    p = None
                mtime = p.stat().st_mtime_ns if p is not None and p.is_file() else 0
                key = (name, json.dumps(clean, sort_keys=True, ensure_ascii=False), mtime)
                prev = ctx.turn_cache.get(key)
                if prev is not None:
                    return True, ToolOutput(
                        f"[unchanged since your earlier {name} call in this turn: "
                        f"{prev.text.splitlines()[0] if prev.text else name} - the content is already in "
                        "your context; do not re-read it]"
                    )
            out = tool.func(ctx, clean)
            if isinstance(out, str):
                out = ToolOutput(out)
            out.text = truncate_middle(out.text, ctx.max_output_chars)
            if key is not None:
                ctx.turn_cache[key] = out
            return True, out
        except ToolError as e:
            return False, ToolOutput(f"ERROR: {e}")
        except Exception as e:  # noqa: BLE001 - report anything to the model
            return False, ToolOutput(f"ERROR: {type(e).__name__}: {e}")
