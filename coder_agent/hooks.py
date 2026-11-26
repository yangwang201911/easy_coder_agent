"""User hooks: ``.agent/hooks.toml`` runs shell commands at lifecycle points.

Format::

    [[hooks]]
    event = "pre_tool"          # pre_tool | post_tool | pre_compact | turn_end | session_start
    tool = "write_file"         # optional: only fire for this tool (glob, e.g. "write_*")
    command = "black {path}"    # placeholders: {event} {tool} {path} {args} {status} {output}

Exit codes: 0 = ok (stdout is appended to the model-visible text for post_tool);
2 = block (pre_tool: the tool is not run and stderr is returned to the model;
pre_compact: compression is skipped for this step); other = warning, continue.
Hooks are best effort: a missing/broken hook never breaks the agent (except the
explicit exit-2 semantics above). Commands run in the project root with a timeout.
"""

from __future__ import annotations

import fnmatch
import json
import subprocess
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

HOOK_EVENTS = ("pre_tool", "post_tool", "pre_compact", "turn_end", "session_start")
TIMEOUT = 60
OUTPUT_LIMIT = 2000  # chars of tool output passed to {output}


@dataclass
class Hook:
    event: str
    tool: str = ""  # empty = all tools
    command: str = ""


@dataclass
class HookResult:
    blocked: bool = False
    messages: list[str] = field(default_factory=list)  # text to show the model / log


class HookRunner:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.file = self.root / ".agent" / "hooks.toml"
        self.hooks: list[Hook] = []
        self.reload()

    def reload(self) -> None:
        self.hooks = []
        try:
            data = tomllib.loads(self.file.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            return
        for h in data.get("hooks", []):
            event = str(h.get("event", ""))
            command = str(h.get("command", ""))
            if event not in HOOK_EVENTS or not command:
                continue
            self.hooks.append(Hook(event, str(h.get("tool", "")), command))

    def run(
        self,
        event: str,
        tool: str = "",
        args: Optional[dict] = None,
        status: str = "",
        output: str = "",
    ) -> HookResult:
        """Fire all hooks for ``event`` (and ``tool``). Returns the combined result."""
        res = HookResult()
        args = args or {}
        for h in self.hooks:
            if h.event != event:
                continue
            if h.tool and not fnmatch.fnmatch(tool, h.tool):
                continue
            cmd = (
                h.command.replace("{event}", event)
                .replace("{tool}", tool)
                .replace("{path}", str(args.get("path", "")))
                .replace("{status}", status)
                .replace("{output}", output[:OUTPUT_LIMIT])
                .replace("{args}", json.dumps(args, ensure_ascii=False)[:OUTPUT_LIMIT])
            )
            try:
                p = subprocess.run(
                    cmd, shell=True, cwd=self.root, capture_output=True, text=True, timeout=TIMEOUT
                )
            except (subprocess.TimeoutExpired, OSError) as e:
                res.messages.append(f"hook {h.command!r} failed: {e}")
                continue
            out = (p.stdout or "").strip()
            err = (p.stderr or "").strip()
            if p.returncode == 2:
                res.blocked = True
                res.messages.append(err or out or "blocked by hook (no message)")
            elif p.returncode != 0:
                res.messages.append(f"hook {h.command!r} exited {p.returncode}: {err or out}")
            elif out:
                res.messages.append(out)
        return res
