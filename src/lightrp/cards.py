from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from lightrp.pngcard import png_card_json


def slugify(name: str) -> str:
    text = name.strip().lower()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff\-]+", "", text)
    return text or "character"


def _strip_original(text: str) -> str:
    text = re.sub(r"\{\{original\}\}", "", text, flags=re.I)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def ensemble_acting(text: str, name: str) -> str:
    text = re.sub(r"你?只扮演[^\n。]*", f"扮演「{name}」时遵守下列口吻与人设", text)
    text = re.sub(r"继续只以[^\n。]*", f"写到「{name}」时用该角色口吻", text)
    return text


def aliases_from_card(card: CharacterCard) -> list[str]:
    skip = re.compile(r"^(sfw|nsfw|r18g?|uma\s*musume|赛马娘|pretty\s*derby|特雷森学园?|学园|宿舍|栗东寮?|美浦寮?|tomboy)$", re.I)
    seen: set[str] = set()
    out: list[str] = []

    def add(value: str) -> None:
        text = value.strip()
        if not text or skip.match(text) or text in {card.name, card.id}:
            return
        if "{{" in text or "}}" in text:
            return
        key = text.lower()
        if key in seen:
            return
        seen.add(key)
        out.append(text)

    for tag in card.tags:
        add(str(tag))
    book = card.character_book or {}
    entries = book.get("entries") if isinstance(book, dict) else None
    rows = entries if isinstance(entries, list) else []
    named = next((item for item in rows if isinstance(item, dict) and item.get("name") == "名号"), None)
    first = named or (rows[0] if rows else None)
    if isinstance(first, dict):
        raw_keys = first.get("keys") if first.get("keys") not in (None, []) else first.get("key")
        if isinstance(raw_keys, str):
            raw_keys = [raw_keys]
        for key in raw_keys or []:
            add(str(key))
    return out


def _as_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return "\n".join(str(item) for item in value)
    return str(value)


@dataclass
class CharacterCard:
    id: str
    name: str
    age: str = ""
    description: str = ""
    personality: str = ""
    behavior: str = ""
    speech: str = ""
    likes: str = ""
    dislikes: str = ""
    backstory: str = ""
    scenario: str = ""
    first_mes: str = ""
    mes_example: str = ""
    system_prompt: str = ""
    tags: list[str] = field(default_factory=list)
    character_book: dict[str, Any] | None = None
    post_history_instructions: str = ""
    source: str = ""

    def substitute(self, user_name: str, char_name: str | None = None) -> CharacterCard:
        char = char_name or self.name
        mapping = {"{{user}}": user_name, "{{char}}": char}

        def sub(text: str) -> str:
            for old, new in mapping.items():
                text = text.replace(old, new)
            return text

        return CharacterCard(
            id=self.id,
            name=self.name,
            age=self.age,
            description=sub(self.description),
            personality=sub(self.personality),
            behavior=sub(self.behavior),
            speech=sub(self.speech),
            likes=sub(self.likes),
            dislikes=sub(self.dislikes),
            backstory=sub(self.backstory),
            scenario=sub(self.scenario),
            first_mes=sub(self.first_mes),
            mes_example=sub(self.mes_example),
            system_prompt=sub(self.system_prompt),
            tags=list(self.tags),
            character_book=self.character_book,
            post_history_instructions=sub(self.post_history_instructions),
            source=self.source,
        )

    def to_export_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "name": self.name,
            "age": self.age,
            "description": self.description,
            "personality": self.personality,
            "behavior": self.behavior,
            "speech": self.speech,
            "likes": self.likes,
            "dislikes": self.dislikes,
            "backstory": self.backstory,
            "scenario": self.scenario,
            "first_mes": self.first_mes,
            "mes_example": self.mes_example,
            "system_prompt": self.system_prompt,
        }
        if self.tags:
            payload["tags"] = self.tags
        if self.character_book:
            payload["character_book"] = self.character_book
        if self.post_history_instructions:
            payload["post_history_instructions"] = self.post_history_instructions
        return {key: value for key, value in payload.items() if value not in ("", [], None)}


def _from_st_data(data: dict[str, Any], default_id: str, source: str) -> CharacterCard:
    name = _as_str(data.get("name") or default_id)
    depth = ""
    extensions = data.get("extensions")
    if isinstance(extensions, dict):
        prompt = extensions.get("depth_prompt")
        if isinstance(prompt, dict):
            depth = _as_str(prompt.get("prompt"))
    system = "\n\n".join(part for part in (_strip_original(_as_str(data.get("system_prompt"))), _strip_original(depth)) if part)
    return CharacterCard(
        id=default_id or slugify(name),
        name=name,
        age=_as_str(data.get("age")),
        description=_as_str(data.get("description")),
        personality=_as_str(data.get("personality")),
        behavior=_as_str(data.get("behavior")),
        speech=_as_str(data.get("speech")),
        likes=_as_str(data.get("likes")),
        dislikes=_as_str(data.get("dislikes")),
        backstory=_as_str(data.get("backstory") or data.get("creator_notes")),
        scenario=_as_str(data.get("scenario")),
        first_mes=_as_str(data.get("first_mes")),
        mes_example=_as_str(data.get("mes_example")),
        system_prompt=system,
        tags=[str(tag) for tag in (data.get("tags") or [])],
        character_book=data.get("character_book") if isinstance(data.get("character_book"), dict) else None,
        post_history_instructions=_strip_original(_as_str(data.get("post_history_instructions"))),
        source=source,
    )


def card_from_obj(obj: dict[str, Any], default_id: str = "", source: str = "") -> CharacterCard:
    spec = obj.get("spec")
    if spec in {"chara_card_v2", "chara_card_v3"} or "data" in obj and isinstance(obj.get("data"), dict):
        data = obj.get("data") or {}
        return _from_st_data(data, default_id, source)
    return _from_st_data(obj, default_id, source)


def load_card(path: Path, default_id: str = "") -> CharacterCard:
    path = Path(path)
    cid = default_id or path.stem
    suffix = path.suffix.lower()
    if suffix == ".png":
        return card_from_obj(png_card_json(path), cid, source=str(path))
    text = path.read_text(encoding="utf-8")
    if suffix in {".yaml", ".yml"}:
        obj = yaml.safe_load(text)
    else:
        obj = json.loads(text)
    if not isinstance(obj, dict):
        raise ValueError(f"character card must be a mapping: {path}")
    return card_from_obj(obj, cid, source=str(path))


def save_card_yaml(card: CharacterCard, path: Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(card.to_export_dict(), allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
