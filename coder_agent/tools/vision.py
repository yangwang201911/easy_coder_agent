"""Image viewing: read a local image file and hand it to a vision model.

Pillow is optional: when it is installed, images are downscaled (long side
<= max_side, JPEG quality 80) to keep the visual token cost low; without it,
small PNG/JPEG files are passed through and large files are rejected with a
clear hint.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path

from .base import Tool, ToolContext, ToolError

MAX_SIDE = 1280
JPEG_QUALITY = 80
PASSTHROUGH_MAX = 512 * 1024  # without Pillow, only pass small files through
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def resize_jpeg(data: bytes, max_side: int = MAX_SIDE, quality: int = JPEG_QUALITY) -> bytes:
    """Downscale an image to long side <= max_side and re-encode as JPEG."""
    from PIL import Image  # optional dependency

    img = Image.open(io.BytesIO(data))
    img.load()
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    w, h = img.size
    scale = max_side / max(w, h)
    if scale < 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def encode_image(data: bytes, max_side: int = MAX_SIDE) -> tuple[bytes, str]:
    """Return (jpeg_bytes, data_url). Falls back to passthrough without Pillow."""
    try:
        jpeg = resize_jpeg(data, max_side)
        return jpeg, "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
    except ImportError:
        if len(data) > PASSTHROUGH_MAX:
            raise ToolError(
                "image is too large to pass through unrescaled; install Pillow "
                "(pip install pillow) to enable downscaling"
            )
        mime = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
        return data, f"data:{mime};base64," + base64.b64encode(data).decode()


def view_image(ctx: ToolContext, a: dict) -> "ToolOutput":
    from .base import ToolOutput

    path = ctx.resolve_readable(a["path"])
    if not path.is_file():
        raise ToolError(f"file not found: {a['path']}")
    if path.suffix.lower() not in IMAGE_EXTS:
        raise ToolError(f"not an image file: {path.name} (supported: {', '.join(sorted(IMAGE_EXTS))})")
    data = path.read_bytes()
    if not data:
        raise ToolError("empty file")
    jpeg, data_url = encode_image(data, int(a.get("max_side", MAX_SIDE)))
    return ToolOutput(
        text=f"image {ctx.rel(path)} attached below ({len(jpeg) // 1024} KB after scaling).",
        images=[{"name": path.name, "data_url": data_url}],
    )


def view_image_tool() -> Tool:
    return Tool(
        name="view_image",
        description=(
            "Read a local image file (png/jpg/webp/gif/bmp) and attach it for visual inspection. "
            "The image is downscaled to fit max_side pixels. Needs a vision-capable model."
        ),
        parameters={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "image path relative to the project root"},
                "max_side": {"type": "integer", "description": f"long side in pixels, default {MAX_SIDE}"},
            },
            "required": ["path"],
        },
        func=view_image,
        kind="read",
    )
