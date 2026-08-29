from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class SceneState:
    location: str = ""
    time: str = ""
    present: list[str] = field(default_factory=list)
    notes: str = ""

    def as_yaml(self) -> str:
        payload = {
            "location": self.location,
            "time": self.time,
            "present": list(self.present),
            "notes": self.notes,
        }
        return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)

    def haystack(self) -> str:
        parts = [self.location, self.time, " ".join(self.present), self.notes]
        return "\n".join(part for part in parts if part)


def scene_lore_haystack(scene: SceneState, cast: list[Any]) -> str:
    present = {item.lower() for item in scene.present}
    parts = [scene.location, scene.time, scene.notes, *scene.present]
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
        return SceneState(notes=path.read_text(encoding="utf-8"))
    present = raw.get("present") or []
    if isinstance(present, str):
        present_list = [part.strip() for part in present.split(",") if part.strip()]
    else:
        present_list = [str(item) for item in present]
    return SceneState(
        location=str(raw.get("location") or ""),
        time=str(raw.get("time") or ""),
        present=present_list,
        notes=str(raw.get("notes") or ""),
    )


def save_scene(path: Path, scene: SceneState) -> None:
    path.write_text(scene.as_yaml(), encoding="utf-8")


def apply_scene_patch(scene: SceneState, patch: dict[str, Any]) -> SceneState:
    if not patch:
        return scene
    location = patch.get("location", scene.location)
    time = patch.get("time", scene.time)
    notes = patch.get("notes", scene.notes)
    present = patch.get("present", scene.present)
    if isinstance(present, str):
        present_list = [part.strip() for part in present.split(",") if part.strip()]
    else:
        present_list = [str(item) for item in present]
    return SceneState(
        location=str(location or ""),
        time=str(time or ""),
        present=present_list,
        notes=str(notes or ""),
    )
