"""Default tool set."""

from __future__ import annotations

from .base import SnapshotRecorder, Tool, ToolContext, ToolError, ToolOutput, ToolRegistry
from .debug import debug_tools
from .fs import fs_tools
from .git import git_tools
from .interact import interact_tools
from .shell import shell_tools
from .browser import browser_tools
from .web import web_tools
from .vision import view_image_tool


def default_registry() -> ToolRegistry:
    from ..knowledge import memory_tools  # local import: knowledge depends on tools.base

    reg = ToolRegistry()
    for t in [*fs_tools(), *shell_tools(), *git_tools(), *debug_tools(), *memory_tools(), *web_tools(), *browser_tools(), *interact_tools(), view_image_tool()]:
        reg.register(t)
    return reg


__all__ = ["SnapshotRecorder", "Tool", "ToolContext", "ToolError", "ToolOutput", "ToolRegistry", "default_registry"]
