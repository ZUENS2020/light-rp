from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def field_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("description", "name", "text"):
            if value.get(key):
                return str(value[key]).strip()
    if isinstance(value, list):
        return "\n".join(part for part in (field_text(item) for item in value) if part)
    return str(value).strip()


def field_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            text = field_text(item)
            if text:
                out.append(text)
        return out
    text = field_text(value)
    return [text] if text else []


@dataclass
class SceneState:
    location: str = ""
    time: str = ""
    season: str = ""
    weather: str = ""
    present: list[str] = field(default_factory=list)
    scene: str = ""
    ongoing: list[str] = field(default_factory=list)
    notes: str = ""  # alias of scene for older callers

    def as_yaml(self) -> str:
        payload = {
            "time": self.time,
            "season": self.season,
            "weather": self.weather,
            "location": self.location,
            "present": list(self.present),
            "scene": self.scene or self.notes,
            "ongoing": list(self.ongoing),
        }
        return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)

    def haystack(self) -> str:
        parts = [self.location, self.time, self.season, self.weather, " ".join(self.present), self.scene or self.notes, *self.ongoing]
        return "\n".join(part for part in parts if part)


def scene_lore_haystack(scene: SceneState, cast: list[Any]) -> str:
    present = {item.lower() for item in scene.present}
    parts = [scene.location, scene.time, scene.season, scene.weather, scene.scene or scene.notes, *scene.present, *scene.ongoing]
    for member in cast:
        names = [str(getattr(member, "id", "")), str(getattr(member, "name", "")), *list(getattr(member, "aliases", []) or [])]
        if not any(name.lower() in present for name in names if name):
            continue
        parts.extend(names)
    return "\n".join(str(part) for part in parts if part)


def load_scene(path: Path) -> SceneState:
    if not path.is_file():
        return SceneState()
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        text = path.read_text(encoding="utf-8")
        return SceneState(scene=text, notes=text)
    scene_text = field_text(raw.get("scene")) or str(raw.get("notes") or "")
    return SceneState(
        location=field_text(raw.get("location")),
        time=field_text(raw.get("time")),
        season=field_text(raw.get("season")),
        weather=field_text(raw.get("weather")),
        present=field_list(raw.get("present") or raw.get("characters_present")),
        scene=scene_text,
        ongoing=field_list(raw.get("ongoing")),
        notes=scene_text,
    )


def save_scene(path: Path, scene: SceneState) -> None:
    path.write_text(scene.as_yaml(), encoding="utf-8")


def apply_scene_patch(scene: SceneState, patch: dict[str, Any]) -> SceneState:
    if not patch:
        return scene
    fields = extract_state_fields(patch)
    scene_text = fields["scene"] if fields["scene"] else (scene.scene or scene.notes)
    return SceneState(
        location=fields["location"] or scene.location,
        time=fields["time"] or scene.time,
        season=fields["season"] or scene.season,
        weather=fields["weather"] or scene.weather,
        present=fields["present"] if patch_has_present(patch) else scene.present,
        scene=scene_text,
        ongoing=fields["ongoing"] if "ongoing" in patch else scene.ongoing,
        notes=scene_text,
    )


def patch_has_present(patch: dict[str, Any]) -> bool:
    if "present" in patch or "characters_present" in patch:
        return True
    nested = patch.get("scene")
    return isinstance(nested, dict) and "present" in nested


def extract_state_fields(patch: dict[str, Any]) -> dict[str, Any]:
    nested = patch.get("scene") if isinstance(patch.get("scene"), dict) else {}
    old_shape = isinstance(nested, dict) and any(key in nested for key in ("location", "time", "present", "notes"))
    src = nested if old_shape else patch
    location = field_text(src.get("location"))
    time = field_text(src.get("time"))
    season = field_text(src.get("season"))
    weather = field_text(src.get("weather"))
    present = field_list(src.get("present") or src.get("characters_present") or patch.get("characters_present"))
    scene_text = field_text(src.get("scene")) if not old_shape else field_text(nested.get("notes") or nested.get("scene"))
    if old_shape and not scene_text:
        scene_text = field_text(nested.get("notes"))
    if not old_shape and not scene_text:
        scene_text = field_text(patch.get("notes"))
    ongoing = field_list(src.get("ongoing") or patch.get("ongoing"))
    return {
        "location": location,
        "time": time,
        "season": season,
        "weather": weather,
        "present": present,
        "scene": scene_text,
        "ongoing": ongoing,
    }


def trailer_events(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw = payload.get("events") or []
    if not isinstance(raw, list):
        raw = [raw]
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            out.append(item)
        elif str(item).strip():
            out.append({"summary": str(item).strip()})
    return out


def trailer_memory_candidates(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("memory_candidates") or []
    if not isinstance(raw, list):
        raw = [raw]
    texts: list[str] = []
    for item in raw:
        if isinstance(item, dict):
            text = field_text(item.get("text") or item.get("content"))
        else:
            text = str(item).strip()
        if text:
            texts.append(text)
    return texts
