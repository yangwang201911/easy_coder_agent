"""Audit log: append-only JSONL of approval decisions at ``<root>/.agent/audit.jsonl``.

One line per decision: time, tool, argument summary, decision and the rule/reason
that produced it. Best-effort: a full or unwritable log is never an error."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

_lock = threading.Lock()


def record(root: Path, *, tool: str, args: dict, decision: str, reason: str, auto: bool) -> None:
    """Append one audit line. ``decision`` is allow | deny | reject (user)."""
    try:
        p = Path(root) / ".agent" / "audit.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "tool": tool,
                "args": {k: str(v)[:200] for k, v in list(args.items())[:5]},
                "decision": decision,
                "reason": reason[:300],
                "auto": auto,
            },
            ensure_ascii=False,
        )
        with _lock:
            with open(p, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except OSError:
        pass  # auditing must never break the agent
