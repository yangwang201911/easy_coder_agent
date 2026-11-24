"""OpenAI-compatible provider (works for Ollama, vLLM, OVMS ... via /v1)."""

from __future__ import annotations

import copy
import logging
import threading
import time
from pathlib import Path
from typing import Iterator, Optional

import openai
from openai import DefaultHttpxClient, OpenAI

from ..config import SamplingConfig, ServerConfig, ThinkingConfig
from .base import LLMCancelled, LLMChunk, LLMError, LLMProvider, ToolCall, Usage
from .prompt_dump import dump_request
from .server_info import probe_vision
from .think_parser import ThinkParser

log = logging.getLogger(__name__)

# Transient server/load errors worth retrying with backoff; other 4xx fail fast.
# 500 is deliberately NOT retryable: a request the server rejects (bad parameter
# value, unsupported field) fails identically on every retry, so retrying only
# wastes ~7s of backoff before surfacing the same error.
_RETRYABLE_STATUS = {408, 409, 429, 502, 503, 504}
_MAX_RETRIES = 3
_BACKOFF_BASE = 1.5  # seconds; attempt n waits base * 2**(n-1) (+ jitter)


def _is_retryable(e: openai.OpenAIError) -> bool:
    status = getattr(e, "status_code", None)
    if status is not None:
        return status in _RETRYABLE_STATUS
    return isinstance(e, (openai.APIConnectionError, openai.APITimeoutError))


def _has_image(messages: list[dict]) -> bool:
    for m in messages:
        c = m.get("content")
        if isinstance(c, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in c):
            return True
    return False


class OpenAICompatProvider(LLMProvider):
    def __init__(
        self,
        server: ServerConfig,
        thinking: ThinkingConfig,
        sampling: SamplingConfig,
        dump: bool = False,
        root: Optional[Path] = None,
    ) -> None:
        self.server = server
        self.thinking = thinking
        self.sampling = sampling
        self.dump = dump
        self.dump_root = root
        http_client = DefaultHttpxClient(
            timeout=openai.Timeout(server.timeout, connect=server.connect_timeout),
            trust_env=not server.bypass_proxy,
        )
        self.client = OpenAI(
            base_url=server.base_url,
            api_key=server.api_key or "EMPTY",
            http_client=http_client,
            max_retries=1,
        )

    # ----------------------------------------------------------- request
    def build_request(
        self,
        messages: list[dict],
        tools: Optional[list[dict]],
        thinking: Optional[bool],
        max_tokens: Optional[int],
        send_effort: Optional[bool] = None,
    ) -> dict:
        kw: dict = {
            "model": self.server.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            kw["tools"] = tools
        s, t = self.sampling, self.thinking
        if s.temperature is not None:
            kw["temperature"] = s.temperature
        if s.top_p is not None:
            kw["top_p"] = s.top_p
        mt = max_tokens if max_tokens is not None else s.max_tokens
        if mt:
            kw["max_tokens"] = mt

        extra = copy.deepcopy(t.extra_body)
        if thinking is False:
            extra.setdefault("chat_template_kwargs", {})["enable_thinking"] = False
        else:
            if (t.send_effort if send_effort is None else send_effort) and t.effort != "default":
                kw["reasoning_effort"] = t.effort
            if t.enable_thinking is not None:
                extra.setdefault("chat_template_kwargs", {})["enable_thinking"] = t.enable_thinking
            if t.token_budget:
                extra["thinking_token_budget"] = t.token_budget
        if extra:
            kw["extra_body"] = extra
        return kw

    # ------------------------------------------------------------ stream
    def stream_chat(
        self,
        messages: list[dict],
        tools: Optional[list[dict]] = None,
        cancel: Optional[threading.Event] = None,
        thinking: Optional[bool] = None,
        max_tokens: Optional[int] = None,
        steer: Optional[threading.Event] = None,
    ) -> Iterator[LLMChunk]:
        # A text-only model (e.g. Ollama without a vision projector) answers
        # 500 "image input is not supported" - fail fast with an actionable
        # message instead of letting the raw server error surface. The probe
        # result is cached; it only runs when the request actually carries images.
        if _has_image(messages) and probe_vision(self.server) is False:
            raise LLMError(
                "the model server rejects image input (text-only model - e.g. Ollama "
                "needs a vision-capable model / mmproj). Remove the image attachments "
                "or switch to a vision model in Settings.")
        kw = self.build_request(messages, tools, thinking, max_tokens)
        if self.dump:
            dump_request(self.dump_root, kw)
        stream = None
        dropped_effort = False
        for attempt in range(1, _MAX_RETRIES + 1):
            if cancel is not None and cancel.is_set():
                raise LLMCancelled()
            try:
                stream = self.client.chat.completions.create(**kw)
                break
            except openai.OpenAIError as e:
                if (not dropped_effort and "reasoning_effort" in kw
                        and "reasoning_effort" in str(e).lower()):
                    # the server rejects the effort value (e.g. Ollama without
                    # reasoning support): drop the field and retry once instead
                    # of burning all retries on a deterministic 500
                    kw.pop("reasoning_effort")
                    dropped_effort = True
                    log.warning("server rejected reasoning_effort; retrying without it")
                    continue
                if attempt >= _MAX_RETRIES or not _is_retryable(e):
                    raise LLMError(f"{type(e).__name__}: {e}") from e
                delay = _BACKOFF_BASE * (2 ** (attempt - 1))
                log.warning("LLM request failed (%s), retry %d/%d in %.1fs",
                            type(e).__name__, attempt, _MAX_RETRIES, delay)
                yield LLMChunk("status", f"LLM server error ({type(e).__name__}), retrying {attempt}/{_MAX_RETRIES}...")
                # sleep in small slices so cancel/steer stay responsive
                deadline = time.monotonic() + delay
                while time.monotonic() < deadline:
                    if (cancel is not None and cancel.is_set()) or (steer is not None and steer.is_set()):
                        raise LLMCancelled()
                    time.sleep(min(0.2, max(0.0, deadline - time.monotonic())))
        assert stream is not None

        parser = ThinkParser()
        acc: dict[int, dict] = {}
        finish: Optional[str] = None
        try:
            for chunk in stream:
                if (cancel is not None and cancel.is_set()) or (steer is not None and steer.is_set()):
                    raise LLMCancelled()
                if getattr(chunk, "usage", None):
                    u = chunk.usage
                    yield LLMChunk("usage", usage=Usage(u.prompt_tokens or 0, u.completion_tokens or 0, u.total_tokens or 0))
                if not chunk.choices:
                    continue
                choice = chunk.choices[0]
                delta = choice.delta
                if choice.finish_reason:
                    finish = choice.finish_reason

                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if reasoning:
                    yield LLMChunk("thinking", reasoning)
                if delta.content:
                    for kind, text in parser.feed(delta.content):
                        yield LLMChunk(kind, text)
                for tc in delta.tool_calls or []:
                    slot = acc.setdefault(tc.index, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function:
                        if tc.function.name:
                            slot["name"] += tc.function.name
                        if tc.function.arguments:
                            slot["arguments"] += tc.function.arguments
            for kind, text in parser.flush():
                yield LLMChunk(kind, text)
        except openai.OpenAIError as e:
            if cancel is not None and cancel.is_set():
                raise LLMCancelled() from e
            raise LLMError(f"{type(e).__name__}: {e}") from e
        finally:
            close = getattr(stream, "close", None)
            if close:
                try:
                    close()
                except Exception:
                    pass

        if acc:
            calls = [
                ToolCall(v["id"] or f"call_{i}", v["name"], v["arguments"] or "{}")
                for i, v in sorted(acc.items())
            ]
            yield LLMChunk("tool_calls", tool_calls=calls)
        yield LLMChunk("done", finish_reason=finish)

    def list_models(self) -> list[str]:
        try:
            return [m.id for m in self.client.models.list().data]
        except openai.OpenAIError as e:
            raise LLMError(f"{type(e).__name__}: {e}") from e
