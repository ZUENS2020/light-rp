from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

PROMPT_FILES = (
    "gm.md",
    "spotlight.md",
    "spotlight_user.md",
    "memory_flush.md",
    "memory_flush_user.md",
    "compact.md",
    "compact_user.md",
    "tools/memory.md",
    "tools/memory.schema.json",
    "layers/stable.md",
    "layers/context.md",
    "layers/volatile.md",
    "layers/card.md",
    "layers/lore.md",
    "layers/breach.md",
    "layers/breach_user.md",
)

PLACEHOLDER = re.compile(r"\{\{([a-zA-Z0-9_]+)\}\}")


@dataclass(frozen=True)
class ResolvedPrompt:
    name: str
    path: Path
    layer: str  # world | user | package


class PromptLibrary:
    def __init__(self, package_dir: Path, user_dir: Path | None = None, world_dir: Path | None = None) -> None:
        self.package_dir = package_dir
        self.user_dir = user_dir
        self.world_dir = world_dir
        self._cache: dict[str, str] = {}

    def resolve(self, name: str) -> ResolvedPrompt:
        search = [
            ("world", self.world_dir),
            ("user", self.user_dir),
            ("package", self.package_dir),
        ]
        for layer, directory in search:
            if directory is None:
                continue
            path = Path(directory) / name
            if path.is_file():
                return ResolvedPrompt(name=name, path=path, layer=layer)
        raise FileNotFoundError(f"prompt file missing: {name}")

    def text(self, name: str) -> str:
        if name not in self._cache:
            resolved = self.resolve(name)
            self._cache[name] = resolved.path.read_text(encoding="utf-8")
        return self._cache[name]

    def render(self, name: str, values: dict[str, str]) -> str:
        return render_template(self.text(name), values)

    def inventory(self) -> list[ResolvedPrompt]:
        return [self.resolve(name) for name in PROMPT_FILES]


def render_template(template: str, values: dict[str, str]) -> str:
    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key in values:
            return values[key]
        return match.group(0)

    return PLACEHOLDER.sub(repl, template)


def load_json_prompt(library: PromptLibrary, name: str) -> dict:
    payload = json.loads(library.text(name))
    if not isinstance(payload, dict):
        raise ValueError(f"{name} must contain a JSON object")
    return payload
