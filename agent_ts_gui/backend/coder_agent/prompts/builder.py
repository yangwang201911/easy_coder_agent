"""Assemble the system prompt from independent, individually switchable sections."""

from __future__ import annotations

import platform
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .. import knowledge
from .registry import TaskType, TaskTypeRegistry


@dataclass
class PromptSections:
    base: bool = True
    task_prefix: bool = True
    instructions: bool = True
    indexes: bool = True  # skills / module docs / scoped instructions
    memory: bool = True
    environment: bool = True  # live facts: time, OS, git branch/dirty state


def _git_info(root: Path) -> str:
    try:
        out = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root,
                             capture_output=True, text=True, timeout=5)
        branch = out.stdout.strip() if out.returncode == 0 else ""
        dirty = ""
        if branch:
            st = subprocess.run(["git", "status", "--porcelain"], cwd=root,
                                capture_output=True, text=True, timeout=5)
            if st.returncode == 0 and st.stdout.strip():
                dirty = " (uncommitted changes)"
        return f"git branch: {branch}{dirty}" if branch else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _environment_block(root: Path) -> str:
    lines = [
        f"time: {time.strftime('%Y-%m-%d %H:%M %Z')}",
        f"OS: {platform.system()} {platform.release()} ({platform.machine()})",
    ]
    git = _git_info(root)
    if git:
        lines.append(git)
    return "\n".join(lines)


class PromptBuilder:
    def __init__(self, root: Path, registry: TaskTypeRegistry, sections: Optional[PromptSections] = None) -> None:
        self.root = Path(root)
        self.registry = registry
        self.sections = sections or PromptSections()

    def build(self, task_type: TaskType, extra: str = "") -> str:
        s, parts = self.sections, []
        if s.base and self.registry.base_prompt:
            parts.append(self.registry.base_prompt.replace("{project_root}", str(self.root)))
        if s.task_prefix and task_type.prefix:
            parts.append("# Task type: " + task_type.name + "\n" + task_type.prefix)
        if s.instructions:
            ins = knowledge.load_general_instructions(self.root)
            if ins:
                parts.append("# Project instructions\n" + ins)
        if s.indexes:
            idx: list[str] = []
            mods = knowledge.module_index(self.root)
            if mods:
                idx.append("Module docs (read the relevant MODULE.md before working in a module):")
                idx += [f"- {e.name}: {e.description} [{e.path}]" for e in mods]
            scoped = knowledge.scoped_instruction_index(self.root)
            if scoped:
                idx.append("Extra instructions (read when relevant):")
                idx += [f"- {e.name}: {e.description} [{e.path}]" for e in scoped]
            skills = knowledge.skill_index(self.root)
            if skills:
                idx.append("Skills (read the SKILL.md when relevant):")
                idx += [f"- {e.name}: {e.description} [{e.path}]" for e in skills]
            if idx:
                parts.append("# Available knowledge\n" + "\n".join(idx))
        if s.memory:
            mem = knowledge.load_memory(self.root)
            if mem:
                parts.append("# Notes from earlier sessions\n" + mem)
        if extra:
            parts.append(extra)
        if s.environment:
            parts.append("# Environment\n" + _environment_block(self.root))
        return "\n\n".join(parts)
