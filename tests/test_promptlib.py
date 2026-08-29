from __future__ import annotations

from pathlib import Path

from lightrp.paths import package_prompts_dir
from lightrp.promptlib import PromptLibrary, render_template


def test_overlay_world_wins(tmp_path: Path) -> None:
    world = tmp_path / "prompts"
    world.mkdir()
    (world / "gm.md").write_text("WORLD-GM {{world_name}}", encoding="utf-8")
    lib = PromptLibrary(package_dir=package_prompts_dir(), user_dir=tmp_path / "missing", world_dir=world)
    assert lib.text("gm.md").startswith("WORLD-GM")
    inventory = {item.name: item.layer for item in lib.inventory()}
    assert inventory["gm.md"] == "world"
    assert inventory["layers/stable.md"] == "package"
    assert inventory["layers/breach.md"] == "package"


def test_user_overrides_package(tmp_path: Path) -> None:
    user = tmp_path / "user"
    user.mkdir()
    (user / "spotlight.md").write_text("USER-SPOT", encoding="utf-8")
    lib = PromptLibrary(package_dir=package_prompts_dir(), user_dir=user, world_dir=None)
    assert lib.text("spotlight.md") == "USER-SPOT"
    assert lib.resolve("gm.md").layer == "package"


def test_render_leaves_unknown() -> None:
    assert render_template("a {{keep}} {{x}}", {"x": "1"}) == "a {{keep}} 1"


def test_missing_file_errors(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    lib = PromptLibrary(package_dir=empty, user_dir=None, world_dir=None)
    try:
        lib.text("gm.md")
    except FileNotFoundError:
        return
    raise AssertionError("expected FileNotFoundError")
