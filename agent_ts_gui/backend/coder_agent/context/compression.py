"""Pluggable context-compression strategies.

Add an algorithm:

    from coder_agent.context.compression import CompressionStrategy, register_strategy

    class MyStrategy(CompressionStrategy):
        name = "mine"
        def compress(self, messages, target_tokens, ctx): ...

    register_strategy(MyStrategy())

then set ``context.algorithm = "mine"`` in the config.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable, Optional

from ..util import truncate_middle
from .tokens import TokenCounter

Summarizer = Callable[[list[dict]], str]  # messages -> summary text (may raise)


@dataclass
class CompressionContext:
    counter: TokenCounter
    summarizer: Optional[Summarizer] = None
    keep_recent_units: int = 10
    tools: Optional[list[dict]] = None
    max_tokens: int = 131072  # for sizing the summarizer input

    def count(self, messages: list[dict]) -> int:
        return self.counter.count(messages, self.tools)


class CompressionStrategy(ABC):
    name = "base"

    @abstractmethod
    def compress(self, messages: list[dict], target_tokens: int, ctx: CompressionContext) -> list[dict]:
        """Return a shorter, still valid message list (system messages first, tool results
        always following the assistant message that requested them)."""


_REGISTRY: dict[str, CompressionStrategy] = {}


def register_strategy(strategy: CompressionStrategy) -> None:
    _REGISTRY[strategy.name] = strategy


def get_strategy(name: str) -> CompressionStrategy:
    if name not in _REGISTRY:
        raise KeyError(f"unknown compression algorithm '{name}' (available: {', '.join(sorted(_REGISTRY))})")
    return _REGISTRY[name]


def available_strategies() -> list[str]:
    return sorted(_REGISTRY)


# ------------------------------------------------------------------ helpers
def split_units(messages: list[dict]) -> list[list[dict]]:
    """Group messages into units: a user message, or an assistant message plus the tool
    results answering it. Units are the smallest pieces that may be dropped safely."""
    units: list[list[dict]] = []
    for m in messages:
        if m.get("role") == "tool" and units:
            units[-1].append(m)
        else:
            units.append([m])
    return units


def _flatten(units: list[list[dict]]) -> list[dict]:
    return [m for u in units for m in u]


def trim_tool_outputs(messages: list[dict], max_chars: int) -> list[dict]:
    out = []
    for m in messages:
        c = m.get("content")
        if m.get("role") == "tool" and isinstance(c, str) and len(c) > max_chars:
            m = {**m, "content": truncate_middle(c, max_chars, "\n...[old tool output trimmed: {n} chars]...\n")}
        out.append(m)
    return out


def strip_old_images(messages: list[dict], keep_last: int = 1) -> list[dict]:
    """Replace image parts in old messages with a text placeholder (they are the
    biggest token consumers); the newest ``keep_last`` images stay intact."""
    img_idx = [i for i, m in enumerate(messages)
               if isinstance(m.get("content"), list)
               and any(isinstance(p, dict) and p.get("type") == "image_url" for p in m["content"])]
    drop = set(img_idx[:-keep_last] if keep_last > 0 else img_idx)
    out = []
    for i, m in enumerate(messages):
        if i in drop:
            parts = [
                {"type": "text", "text": "[image removed to save context]"}
                if isinstance(p, dict) and p.get("type") == "image_url" else p
                for p in m["content"]
            ]
            m = {**m, "content": parts}
        out.append(m)
    return out


def render_transcript(messages: list[dict], per_message_chars: int = 1500) -> str:
    lines = []
    for m in messages:
        role = m.get("role", "?")
        content = m.get("content") or ""
        if isinstance(content, list):  # multimodal (text + image parts)
            content = "\n".join(
                p.get("text", f"[image: {p.get('image_url', {}).get('url', '')[:60]}]")
                for p in content if isinstance(p, dict)
            )
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function", {})
            content += f"\n[call {fn.get('name')}({truncate_middle(fn.get('arguments', ''), 400)})]"
        lines.append(f"## {role}\n{truncate_middle(content, per_message_chars)}")
    return "\n\n".join(lines)


SUMMARY_PROMPT = (
    "You are compacting the history of a coding-agent session so work can continue with a smaller "
    "context. Write a dense summary (max ~600 words) in the same language the user used, using "
    "EXACTLY this structure (drop a section only if it is empty):\n"
    "## Goal\nThe user's goal and constraints, in 1-3 sentences.\n"
    "## Files\nFiles created/modified and why (path: one-line reason).\n"
    "## Facts\nImportant facts learned: build/test commands, errors and their fixes, APIs, paths.\n"
    "## Decisions\nDecisions made and why.\n"
    "## Status\nWhat is done, what remains (next concrete step).\n"
    "Do not invent anything. No preamble, no other headings."
)
SUMMARY_HEADER = "[Summary of earlier conversation - older messages were compacted]\n"


# --------------------------------------------------------- default algorithm
class SummarizeStrategy(CompressionStrategy):
    """1. keep system messages and the newest ``keep_recent_units`` units untouched;
    2. shrink old tool outputs; 3. replace everything older by an LLM summary;
    4. if still too large (or no summarizer / summarizer fails) drop oldest units."""

    name = "summarize"

    def compress(self, messages: list[dict], target_tokens: int, ctx: CompressionContext) -> list[dict]:
        system = [m for m in messages if m.get("role") == "system"]
        rest = [m for m in messages if m.get("role") != "system"]
        units = split_units(rest)
        keep_n = max(1, min(ctx.keep_recent_units, len(units)))
        old_units, recent_units = units[:-keep_n], units[-keep_n:]

        # Step 1: cheap - trim old tool outputs and drop old images.
        old = strip_old_images(trim_tool_outputs(_flatten(old_units), 600), keep_last=0)
        recent = strip_old_images(_flatten(recent_units), keep_last=1)
        candidate = system + old + recent
        if ctx.count(candidate) <= target_tokens:
            return candidate

        # Step 2: summarise old part.
        summary_msg: Optional[dict] = None
        if old and ctx.summarizer:
            try:
                budget_chars = int(ctx.max_tokens * 0.6 * 3)
                transcript = render_transcript(old)
                transcript = truncate_middle(transcript, budget_chars)
                text = ctx.summarizer(
                    [
                        {"role": "system", "content": SUMMARY_PROMPT},
                        {"role": "user", "content": transcript},
                    ]
                )
                if text.strip():
                    summary_msg = {"role": "user", "content": SUMMARY_HEADER + text.strip()}
            except Exception:  # noqa: BLE001 - fall back to dropping
                summary_msg = None
        head = system + ([summary_msg] if summary_msg else [])
        candidate = head + recent
        if ctx.count(candidate) <= target_tokens:
            return candidate

        # Step 3: shrink recent tool outputs, then drop oldest recent units.
        for limit in (3000, 1200, 400):
            recent = strip_old_images(trim_tool_outputs(_flatten(recent_units), limit), keep_last=1)
            candidate = head + recent
            if ctx.count(candidate) <= target_tokens:
                return candidate
        units_left = list(recent_units)
        note = {"role": "user", "content": "[Some earlier steps were dropped to fit the context window.]"}
        while len(units_left) > 1:
            units_left.pop(0)
            candidate = head + [note] + strip_old_images(trim_tool_outputs(_flatten(units_left), 400), keep_last=1)
            if ctx.count(candidate) <= target_tokens:
                break
        return candidate


class TruncateStrategy(CompressionStrategy):
    """No LLM call: trim tool outputs, then drop the oldest units. Fast fallback."""

    name = "truncate"

    def compress(self, messages: list[dict], target_tokens: int, ctx: CompressionContext) -> list[dict]:
        return SummarizeStrategy().compress(messages, target_tokens, CompressionContext(
            ctx.counter, None, ctx.keep_recent_units, ctx.tools, ctx.max_tokens))


register_strategy(SummarizeStrategy())
register_strategy(TruncateStrategy())
