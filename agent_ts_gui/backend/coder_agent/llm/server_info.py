"""Ask the server how large its context (KV cache) really is.

* Ollama: ``GET /api/ps`` -> ``context_length`` of the loaded model (what it actually runs with);
  ``POST /api/show`` -> the model's trained maximum (``*.context_length``) and the Modelfile ``num_ctx``.
* vLLM / OVMS style: ``GET /v1/models`` -> ``max_model_len``.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from typing import Optional

import openai
from openai import DefaultHttpxClient

from ..config import ServerConfig


@dataclass
class ContextInfo:
    loaded: Optional[int] = None  # context length the server is running the model with
    model_max: Optional[int] = None  # the model's own maximum
    source: str = ""  # ollama | vllm | ""
    loaded_is_configured: bool = False  # model not loaded yet: value comes from the Modelfile num_ctx
    error: str = ""

    def describe(self) -> str:
        if self.error and self.loaded is None and self.model_max is None:
            return f"unavailable ({self.error})"
        parts = []
        if self.loaded:
            parts.append(f"server cache {self.loaded:,}" + (" (configured, model not loaded)" if self.loaded_is_configured else ""))
        if self.model_max:
            parts.append(f"model maximum {self.model_max:,}")
        return ", ".join(parts) or "server did not report a context length"


# Tiny 1x1 red PNG, base64 - enough to ask the server "do you accept images?".
_PROBE_IMAGE = ("data:image/png;base64,"
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


# (base_url, model) -> (result, monotonic ts); a re-probe costs a model call, so
# the answer is cached for a while. ``None`` results are NOT cached.
_vision_cache: dict[tuple[str, str], tuple[Optional[bool], float]] = {}
_vision_lock = threading.Lock()
_VISION_TTL = 600.0  # seconds


def probe_vision(server: ServerConfig, timeout: float = 15.0) -> Optional[bool]:
    """Ask the server whether the configured model accepts image inputs.

    Sends a 1x1 PNG in a non-streaming chat completion and inspects the HTTP
    status: ``True`` on 2xx, ``False`` when the server explicitly rejects image
    input (Ollama without a vision projector answers 500 "image input is not
    supported"), ``None`` when it cannot be determined (network error, unknown
    status) - callers must treat ``None`` as "unknown, let the real request try".
    Results are cached per (base_url, model) for a few minutes.
    """
    key = (server.base_url, server.model)
    now = time.monotonic()
    with _vision_lock:
        hit = _vision_cache.get(key)
        if hit and now - hit[1] < _VISION_TTL:
            return hit[0]
    result = _probe_vision_uncached(server, timeout)
    if result is not None:
        with _vision_lock:
            _vision_cache[key] = (result, now)
    return result


def _probe_vision_uncached(server: ServerConfig, timeout: float) -> Optional[bool]:
    client = DefaultHttpxClient(timeout=openai.Timeout(timeout), trust_env=not server.bypass_proxy)
    try:
        r = client.post(
            server.base_url.rstrip("/") + "/chat/completions",
            json={
                "model": server.model,
                "stream": False,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": "ok"},
                    {"type": "image_url", "image_url": {"url": _PROBE_IMAGE}},
                ]}],
            },
        )
    except Exception:  # noqa: BLE001 - informational probe, never fatal
        return None
    finally:
        client.close()
    if r.status_code == 200:
        return True
    if r.status_code >= 400:
        try:
            body = r.text.lower()
        except Exception:  # noqa: BLE001
            body = ""
        if "image" in body or "mmproj" in body or "vision" in body:
            return False
    return None


def _norm(name: str) -> str:
    name = (name or "").strip()
    return name if ":" in name else name + ":latest"


def fetch_context_info(server: ServerConfig, timeout: float = 5.0) -> ContextInfo:
    root = server.base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    info = ContextInfo()
    client = DefaultHttpxClient(timeout=openai.Timeout(timeout), trust_env=not server.bypass_proxy)
    try:
        r = client.get(root + "/api/ps")
        if r.status_code == 200 and isinstance(r.json().get("models"), list):
            info.source = "ollama"
            for m in r.json()["models"]:
                if _norm(m.get("name") or m.get("model", "")) == _norm(server.model) and m.get("context_length"):
                    info.loaded = int(m["context_length"])
            sh = client.post(root + "/api/show", json={"model": server.model})
            if sh.status_code == 200:
                d = sh.json()
                for k, v in (d.get("model_info") or {}).items():
                    if k.endswith(".context_length") and isinstance(v, int):
                        info.model_max = v
                if info.loaded is None:
                    m = re.search(r"^\s*num_ctx\s+(\d+)", d.get("parameters") or "", re.MULTILINE)
                    if m:
                        info.loaded, info.loaded_is_configured = int(m.group(1)), True
            return info

        r = client.get(root + "/v1/models")
        if r.status_code == 200:
            for m in r.json().get("data", []):
                if m.get("id") == server.model and m.get("max_model_len"):
                    info.source = "vllm"
                    info.loaded = info.model_max = int(m["max_model_len"])
        if not info.source:
            info.error = "server does not expose its context length"
    except Exception as e:  # noqa: BLE001 - purely informational, never fatal
        info.error = f"{type(e).__name__}: {e}"
    finally:
        client.close()
    return info
