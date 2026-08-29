from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from lightrp.cards import CharacterCard


@dataclass
class MiniCard:
    id: str
    name: str
    summary: str = ""
    behavior_notes: str = ""
    relations: str = ""


def clip_text(text: str, limit: int = 450) -> str:
    trimmed = (text or "").strip()
    if len(trimmed) <= limit:
        return trimmed
    return trimmed[: limit - 1] + "…"


def mini_rel(character_id: str) -> str:
    return f"characters/{character_id}.mini.yaml"


def generate_mini(card: CharacterCard, blurb: str = "") -> MiniCard:
    first = next((part.strip() for part in (card.personality or "").splitlines() if part.strip()), "")
    return MiniCard(
        id=card.id,
        name=card.name,
        summary=clip_text(blurb or first or card.personality),
        behavior_notes=clip_text(card.behavior or card.scenario or card.post_history_instructions),
        relations="",
    )


def load_mini(path: Path, default_id: str = "") -> MiniCard | None:
    if not path.is_file():
        return None
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        return None
    cid = str(raw.get("id") or default_id or path.stem.replace(".mini", ""))
    return MiniCard(
        id=cid,
        name=str(raw.get("name") or cid),
        summary=str(raw.get("summary") or ""),
        behavior_notes=str(raw.get("behavior_notes") or ""),
        relations=str(raw.get("relations") or ""),
    )


def save_mini(path: Path, mini: MiniCard) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(
            {
                "id": mini.id,
                "name": mini.name,
                "summary": mini.summary,
                "behavior_notes": mini.behavior_notes,
                "relations": mini.relations,
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        encoding="utf-8",
    )


def ensure_mini(root: Path, character_id: str, card: CharacterCard, blurb: str = "") -> MiniCard:
    path = root / mini_rel(character_id)
    existing = load_mini(path, character_id)
    if existing:
        return existing
    mini = generate_mini(card, blurb)
    mini.id = character_id
    save_mini(path, mini)
    return mini
