from __future__ import annotations

from types import SimpleNamespace
from pathlib import Path

from lightrp.cards import load_card
from lightrp.cli import cmd_import_card, cmd_import_lore, cmd_init, cmd_prompts
from lightrp.config import AppConfig
from lightrp.world import load_world


def test_init_and_import(tmp_path: Path) -> None:
    config = AppConfig(worlds_dir=tmp_path / "worlds")
    assert cmd_init(SimpleNamespace(name="harbor"), config) == 0
    world = tmp_path / "worlds" / "harbor"
    assert (world / "WORLD.md").is_file()

    card = tmp_path / "extra.yaml"
    card.write_text("name: 老船\ndescription: 胡须\npersonality: 硬\nspeech: 粗\n", encoding="utf-8")
    args = SimpleNamespace(world=str(world), card=card, id="laochuan", present=True)
    assert cmd_import_card(args, config) == 0
    pack = load_world(world)
    assert pack.member("laochuan") is not None
    loaded = load_card(world / "characters" / "laochuan.yaml")
    assert loaded.name == "老船"

    lore = tmp_path / "more.json"
    lore.write_text('{"entries":[]}', encoding="utf-8")
    assert cmd_import_lore(SimpleNamespace(world=str(world), file=lore), config) == 0
    assert (world / "lorebooks" / "more.json").is_file()

    assert cmd_prompts(SimpleNamespace(world=str(world)), config) == 0
