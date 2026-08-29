from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

ENTRY_DELIMITER = "\n§\n"


@dataclass
class MemoryMutation:
    success: bool
    message: str
    target: str
    live: list[str] = field(default_factory=list)


class MemoryStore:
    """Hermes-style bounded file memory with a frozen system-prompt snapshot."""

    def __init__(
        self,
        root: Path,
        world_char_limit: int = 2500,
        player_char_limit: int = 1400,
        character_char_limit: int = 1200,
    ) -> None:
        self.root = Path(root)
        self.world_char_limit = world_char_limit
        self.player_char_limit = player_char_limit
        self.character_char_limit = character_char_limit
        self.world_entries: list[str] = []
        self.player_entries: list[str] = []
        self.character_entries: dict[str, list[str]] = {}
        self.user_setting = ""
        self._snapshot: dict[str, str] = {"world": "", "player": ""}
        self._character_snapshots: dict[str, str] = {}

    def world_path(self) -> Path:
        return self.root / "MEMORY.md"

    def player_path(self) -> Path:
        return self.root / "PLAYER_MEMORY.md"

    def user_setting_path(self) -> Path:
        return self.root / "PLAYER.md"

    def character_path(self, character_id: str) -> Path:
        return self.root / "memories" / f"{character_id}.md"

    def load_from_disk(self) -> None:
        self.world_entries = _read_entries(self.world_path())
        self.player_entries = _read_entries(self.player_path())
        self.user_setting = self.user_setting_path().read_text(encoding="utf-8").strip() if self.user_setting_path().is_file() else ""
        self.character_entries = {}
        memories_dir = self.root / "memories"
        if memories_dir.is_dir():
            for path in memories_dir.glob("*.md"):
                self.character_entries[path.stem] = _read_entries(path)
        self.freeze()

    def freeze(self) -> None:
        self._snapshot = {
            "world": _render(self.world_entries),
            "player": _render(self.player_entries),
        }
        self._character_snapshots = {
            cid: _render(entries) for cid, entries in self.character_entries.items()
        }

    def snapshot_text(self, target: str, character_id: str | None = None) -> str:
        if target == "character":
            if not character_id:
                return ""
            return self._character_snapshots.get(character_id, "")
        return self._snapshot.get(target, "")

    def live_entries(self, target: str, character_id: str | None = None) -> list[str]:
        if target == "world":
            return self.world_entries
        if target == "player":
            return self.player_entries
        if target == "character":
            if not character_id:
                return []
            return self.character_entries.setdefault(character_id, [])
        raise ValueError(f"unknown memory target: {target}")

    def live_text(self, target: str, character_id: str | None = None) -> str:
        return _render(self.live_entries(target, character_id))

    def char_limit(self, target: str) -> int:
        if target == "world":
            return self.world_char_limit
        if target == "player":
            return self.player_char_limit
        return self.character_char_limit

    def apply(
        self,
        action: str,
        target: str,
        content: str = "",
        old_text: str = "",
        character_id: str | None = None,
    ) -> MemoryMutation:
        if target not in {"world", "player", "character"}:
            return MemoryMutation(False, f"unknown target: {target}", target)
        if target == "character" and not character_id:
            return MemoryMutation(False, "character target requires character_id", target)
        entries = self.live_entries(target, character_id)
        action = action.strip()
        if action == "add":
            text = content.strip()
            if not text:
                return MemoryMutation(False, "content is required for add", target, list(entries))
            candidate = entries + [text]
            if _render_len(candidate) > self.char_limit(target):
                return MemoryMutation(
                    False,
                    "store is at capacity; replace or remove an entry first",
                    target,
                    list(entries),
                )
            entries.append(text)
        elif action == "replace":
            if not old_text:
                return MemoryMutation(False, "old_text is required for replace", target, list(entries))
            matches = [i for i, item in enumerate(entries) if old_text in item]
            if len(matches) != 1:
                return MemoryMutation(
                    False,
                    f"replace needs exactly one substring match, got {len(matches)}",
                    target,
                    list(entries),
                )
            text = content.strip()
            if not text:
                return MemoryMutation(False, "content is required for replace", target, list(entries))
            previous = entries[matches[0]]
            entries[matches[0]] = text
            if _render_len(entries) > self.char_limit(target):
                entries[matches[0]] = previous
                return MemoryMutation(False, "replace would exceed the character limit", target, list(entries))
        elif action == "remove":
            needle = (old_text or content).strip()
            if not needle:
                return MemoryMutation(False, "old_text or content is required for remove", target, list(entries))
            matches = [i for i, item in enumerate(entries) if needle in item]
            if len(matches) != 1:
                return MemoryMutation(
                    False,
                    f"remove needs exactly one substring match, got {len(matches)}",
                    target,
                    list(entries),
                )
            entries.pop(matches[0])
        else:
            return MemoryMutation(False, f"unknown action: {action}", target, list(entries))

        self._persist(target, character_id, entries)
        return MemoryMutation(True, "ok", target, list(entries))

    def _persist(self, target: str, character_id: str | None, entries: list[str]) -> None:
        if target == "world":
            self.world_entries = entries
            _write_entries(self.world_path(), entries)
        elif target == "player":
            self.player_entries = entries
            _write_entries(self.player_path(), entries)
        else:
            assert character_id is not None
            self.character_entries[character_id] = entries
            _write_entries(self.character_path(character_id), entries)


def _read_entries(path: Path) -> list[str]:
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []
    return [part.strip() for part in text.split(ENTRY_DELIMITER) if part.strip()]


def _write_entries(path: Path, entries: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ENTRY_DELIMITER.join(entries) + ("\n" if entries else ""), encoding="utf-8")


def _render(entries: list[str]) -> str:
    return ENTRY_DELIMITER.join(entries)


def _render_len(entries: list[str]) -> int:
    return len(_render(entries))
