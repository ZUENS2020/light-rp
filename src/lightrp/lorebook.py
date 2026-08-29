from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

_CJK = re.compile(r"[\u4e00-\u9fff]")


@dataclass
class LoreEntry:
    keys: list[str]
    content: str
    enabled: bool = True
    constant: bool = False
    selective: bool = False
    secondary_keys: list[str] = field(default_factory=list)
    insertion_order: int = 0
    case_sensitive: bool = False
    comment: str = ""
    source: str = "world"
    use_regex: bool = False
    match_whole_words: bool = False
    exclude_recursion: bool = False
    prevent_recursion: bool = False
    delay_until_recursion: bool = False
    selective_logic: int = 0
    position: int = 0
    probability: int = 100
    char_name: str = ""

    @property
    def title(self) -> str:
        return self.comment or (", ".join(self.keys) if self.keys else "lore")


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value)]


def _position(value: Any) -> int:
    if value in (1, "1", "after_char", "after", "after_an"):
        return 1
    return 0


def _first_int(raw: dict[str, Any], *keys: str, default: int = 0) -> int:
    for key in keys:
        if key not in raw or raw[key] is None or raw[key] == "":
            continue
        try:
            return int(raw[key])
        except (TypeError, ValueError):
            continue
    return default


def _normalize_entry(raw: dict[str, Any], source: str) -> LoreEntry | None:
    if raw.get("disable") is True or raw.get("enabled") is False:
        enabled = False
    else:
        enabled = True
    keys = _as_list(raw.get("keys") or raw.get("key"))
    content = str(raw.get("content") or "")
    if not content:
        return None
    probability = raw.get("probability")
    try:
        chance = int(probability) if probability is not None else 100
    except (TypeError, ValueError):
        chance = 100
    if raw.get("useProbability") is False:
        chance = 100
    return LoreEntry(
        keys=keys,
        content=content,
        enabled=enabled,
        constant=bool(raw.get("constant")),
        selective=bool(raw.get("selective")),
        secondary_keys=_as_list(raw.get("secondary_keys") or raw.get("keysecondary") or raw.get("secondaryKeys")),
        insertion_order=_first_int(raw, "insertion_order", "order", "displayIndex"),
        case_sensitive=bool(raw.get("case_sensitive") or raw.get("caseSensitive")),
        comment=str(raw.get("comment") or raw.get("name") or ""),
        source=source,
        use_regex=bool(raw.get("use_regex") or raw.get("useRegex")),
        match_whole_words=bool(raw.get("match_whole_words") or raw.get("matchWholeWords")),
        exclude_recursion=bool(raw.get("excludeRecursion") or raw.get("exclude_recursion")),
        prevent_recursion=bool(raw.get("preventRecursion") or raw.get("prevent_recursion")),
        delay_until_recursion=bool(raw.get("delayUntilRecursion") or raw.get("delay_until_recursion")),
        selective_logic=_first_int(raw, "selectiveLogic", "selective_logic"),
        position=_position(raw.get("position")),
        probability=chance,
    )


def _iter_raw_entries(obj: Any) -> list[dict[str, Any]]:
    if isinstance(obj, list):
        return [item for item in obj if isinstance(item, dict)]
    if not isinstance(obj, dict):
        return []
    if "entries" in obj:
        entries = obj["entries"]
        if isinstance(entries, list):
            return [item for item in entries if isinstance(item, dict)]
        if isinstance(entries, dict):
            return [item for item in entries.values() if isinstance(item, dict)]
    if all(isinstance(v, dict) for v in obj.values()) and any(
        "content" in v for v in obj.values() if isinstance(v, dict)
    ):
        return [v for v in obj.values() if isinstance(v, dict)]
    return []


def _book_recursive(obj: Any, default: bool = True) -> bool:
    if isinstance(obj, dict) and "recursive_scanning" in obj:
        return bool(obj["recursive_scanning"])
    return default


def load_lorebook(path: Path, source: str | None = None) -> list[LoreEntry]:
    text = Path(path).read_text(encoding="utf-8")
    if Path(path).suffix.lower() in {".yaml", ".yml"}:
        obj = yaml.safe_load(text)
    else:
        obj = json.loads(text)
    label = source or Path(path).stem
    recursive = _book_recursive(obj)
    entries = [entry for raw in _iter_raw_entries(obj) if (entry := _normalize_entry(raw, label))]
    if not recursive:
        for entry in entries:
            entry.prevent_recursion = True
    return entries


def entries_from_character_book(book: dict[str, Any] | None, source: str, char_name: str = "") -> list[LoreEntry]:
    if not book:
        return []
    recursive = _book_recursive(book, default=False)
    out: list[LoreEntry] = []
    for raw in _iter_raw_entries(book):
        entry = _normalize_entry(raw, source)
        if not entry:
            continue
        entry.char_name = char_name
        if not recursive:
            entry.prevent_recursion = True
        out.append(entry)
    return out


def match_key(haystack: str, needle: str, case_sensitive: bool, whole_words: bool, use_regex: bool = False) -> bool:
    if not needle:
        return False
    if use_regex:
        try:
            flags = 0 if case_sensitive else re.IGNORECASE
            return re.search(needle, haystack, flags) is not None
        except re.error:
            pass
    text, key = (haystack, needle) if case_sensitive else (haystack.lower(), needle.lower())
    if not whole_words or _CJK.search(key):
        return key in text
    return re.search(rf"(?<![A-Za-z0-9_]){re.escape(key)}(?![A-Za-z0-9_])", text) is not None


def _any_key(blob: str, keys: list[str], entry: LoreEntry) -> bool:
    return any(match_key(blob, key, entry.case_sensitive, entry.match_whole_words, entry.use_regex) for key in keys)


def entry_matches(entry: LoreEntry, haystack: str, scene_text: str) -> bool:
    blob = f"{haystack}\n{scene_text}"
    if entry.constant:
        return True
    if not entry.keys:
        return False
    if not _any_key(blob, entry.keys, entry):
        return False
    if entry.selective and entry.secondary_keys:
        secondary = _any_key(blob, entry.secondary_keys, entry)
        if entry.selective_logic == 1:
            return not secondary
        return secondary
    return True


def trigger_lore(
    entries: list[LoreEntry],
    haystack: str,
    scene_text: str,
    token_budget: int,
) -> list[LoreEntry]:
    base = f"{haystack}\n{scene_text}"
    pool = [entry for entry in entries if entry.enabled and entry.probability != 0]
    selected: list[LoreEntry] = []
    seen: set[int] = set()

    def consider(entry: LoreEntry, blob: str, recursive: bool) -> bool:
        if id(entry) in seen:
            return False
        if entry.delay_until_recursion and not recursive:
            return False
        if entry.exclude_recursion and recursive:
            return False
        return entry_matches(entry, blob, "")

    for entry in pool:
        if consider(entry, base, False):
            selected.append(entry)
            seen.add(id(entry))

    for _ in range(8):
        extra = "\n".join(item.content for item in selected if not item.prevent_recursion)
        blob = f"{base}\n{extra}"
        added = False
        for entry in pool:
            if consider(entry, blob, True):
                selected.append(entry)
                seen.add(id(entry))
                added = True
        if not added:
            break

    selected.sort(key=lambda item: (item.position, 0 if item.source != "world" else 1, item.insertion_order))
    char_budget = max(0, token_budget) * 3
    used = 0
    out: list[LoreEntry] = []
    for entry in selected:
        size = len(entry.content)
        if out and used + size > char_budget:
            break
        out.append(entry)
        used += size
    return out
