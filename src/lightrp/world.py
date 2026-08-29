from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from lightrp.cards import CharacterCard, load_card
from lightrp.paths import find_example_world


@dataclass
class CastMember:
    id: str
    name: str
    card: str
    blurb: str = ""
    present: bool = False
    aliases: list[str] = field(default_factory=list)


@dataclass
class WorldPack:
    root: Path
    world_id: str
    name: str
    nmem_space: str | None
    player_name: str
    cast: list[CastMember]
    lore_token_budget: int | None = None
    lore_scan_depth: int | None = None
    primary: str | None = None

    @property
    def world_md(self) -> Path:
        return self.root / "WORLD.md"

    @property
    def player_md(self) -> Path:
        return self.root / "PLAYER.md"

    @property
    def memory_md(self) -> Path:
        return self.root / "MEMORY.md"

    @property
    def scene_md(self) -> Path:
        return self.root / "SCENE.md"

    @property
    def prompts_dir(self) -> Path:
        return self.root / "prompts"

    @property
    def lorebooks_dir(self) -> Path:
        return self.root / "lorebooks"

    @property
    def characters_dir(self) -> Path:
        return self.root / "characters"

    @property
    def memories_dir(self) -> Path:
        return self.root / "memories"

    @property
    def sessions_dir(self) -> Path:
        return self.root / "sessions"

    @property
    def nmem_index_path(self) -> Path:
        return self.root / ".nmem-index.json"

    def read_world(self) -> str:
        if not self.world_md.is_file():
            raise FileNotFoundError(f"missing WORLD.md in {self.root}")
        return self.world_md.read_text(encoding="utf-8").strip()

    def member(self, ident: str) -> CastMember | None:
        needle = ident.strip().lstrip("@")
        lowered = needle.lower()
        for item in self.cast:
            names = [item.id, item.name, *item.aliases]
            if any(name.lower() == lowered for name in names if name):
                return item
        return None

    def present_members(self, present_ids: list[str] | None = None) -> list[CastMember]:
        if present_ids is None:
            return [item for item in self.cast if item.present]
        wanted = {item.lower() for item in present_ids}
        out: list[CastMember] = []
        for item in self.cast:
            names = [item.id, item.name, *item.aliases]
            if any(name.lower() in wanted for name in names if name):
                out.append(item)
        return out

    def load_member_card(self, member: CastMember) -> CharacterCard:
        return load_card(self.root / member.card, default_id=member.id)

    def lorebook_files(self) -> list[Path]:
        if not self.lorebooks_dir.is_dir():
            return []
        files = []
        for path in sorted(self.lorebooks_dir.iterdir()):
            if path.suffix.lower() in {".json", ".yaml", ".yml"}:
                files.append(path)
        return files

    def upsert_cast(self, member: CastMember) -> None:
        existing = {item.id: item for item in self.cast}
        existing[member.id] = member
        self.cast = list(existing.values())
        _write_cast(self)


def _write_cast(pack: WorldPack) -> None:
    payload: dict[str, Any] = {
        "player_name": pack.player_name,
        "characters": [
            {
                "id": item.id,
                "name": item.name,
                "card": item.card,
                "blurb": item.blurb,
                "present": item.present,
                "aliases": item.aliases,
            }
            for item in pack.cast
        ],
    }
    if pack.nmem_space:
        payload["nmem_space"] = pack.nmem_space
    (pack.root / "cast.yaml").write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def _load_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return loaded if isinstance(loaded, dict) else {}


def load_world(root: Path) -> WorldPack:
    root = Path(root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"world directory not found: {root}")
    world_meta = _load_mapping(root / "world.yaml")
    cast_meta = _load_mapping(root / "cast.yaml")
    merged = {**world_meta, **{k: v for k, v in cast_meta.items() if k != "characters"}}
    characters = cast_meta.get("characters") or world_meta.get("characters") or []
    cast: list[CastMember] = []
    for raw in characters:
        if not isinstance(raw, dict):
            continue
        cid = str(raw.get("id") or Path(str(raw.get("card", "character"))).stem)
        cast.append(
            CastMember(
                id=cid,
                name=str(raw.get("name") or cid),
                card=str(raw.get("card") or f"characters/{cid}.yaml"),
                blurb=str(raw.get("blurb") or ""),
                present=bool(raw.get("present", False)),
                aliases=[str(a) for a in (raw.get("aliases") or [])],
            )
        )
    world_id = str(merged.get("id") or root.name)
    space = merged.get("nmem_space")
    primary = merged.get("primary")
    return WorldPack(
        root=root,
        world_id=world_id,
        name=str(merged.get("name") or world_id),
        nmem_space=str(space) if space else None,
        player_name=str(merged.get("player_name") or "你"),
        cast=cast,
        lore_token_budget=merged.get("lore_token_budget"),
        lore_scan_depth=merged.get("lore_scan_depth"),
        primary=str(primary).strip() if primary else None,
    )


def resolve_world_root(name_or_path: str, worlds_dir: Path) -> Path:
    candidate = Path(name_or_path).expanduser()
    if candidate.is_dir() and (candidate / "WORLD.md").is_file():
        return candidate.resolve()
    nested = worlds_dir / name_or_path
    if nested.is_dir() and (nested / "WORLD.md").is_file():
        return nested.resolve()
    raise FileNotFoundError(
        f"world '{name_or_path}' not found (looked at {candidate} and {nested})"
    )


def discover_world_root(name_or_path: str, worlds_dir: Path) -> Path:
    try:
        return resolve_world_root(name_or_path, worlds_dir)
    except FileNotFoundError:
        if name_or_path in {"_example", "lamp-harbor", "example"}:
            return find_example_world()
        raise


def list_world_roots(worlds_dir: Path) -> list[Path]:
    seen: set[Path] = set()
    roots: list[Path] = []

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen or not (resolved / "WORLD.md").is_file():
            return
        seen.add(resolved)
        roots.append(resolved)

    try:
        add(find_example_world())
    except FileNotFoundError:
        pass
    if worlds_dir.is_dir():
        for child in sorted(worlds_dir.iterdir()):
            if child.is_dir():
                add(child)
    return roots


def ensure_world_files(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for name, content in {
        "WORLD.md": "# World\n",
        "PLAYER.md": "",
        "MEMORY.md": "",
        "SCENE.md": "location: \ntime: \npresent: []\nnotes: |\n  \n",
        "cast.yaml": "player_name: 你\ncharacters: []\n",
    }.items():
        path = root / name
        if not path.exists():
            path.write_text(content, encoding="utf-8")
    (root / "characters").mkdir(exist_ok=True)
    (root / "lorebooks").mkdir(exist_ok=True)
    (root / "memories").mkdir(exist_ok=True)
    (root / "sessions").mkdir(exist_ok=True)
    (root / "prompts").mkdir(exist_ok=True)
