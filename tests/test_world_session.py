from __future__ import annotations

from types import SimpleNamespace

from lightrp.engine import resolve_nmem_space
from lightrp.paths import find_example_world
from lightrp.scene import apply_scene_patch, load_scene
from lightrp.session import alias_map, parse_mentions, parse_trailer
from lightrp.world import CastMember, load_world


def test_parse_trailer_strips_fence() -> None:
    text = "海风很大。\n\n```lightrp\nscene:\n  location: 茶铺\nspotlight:\n  - xiaowu\n```\n"
    visible, payload = parse_trailer(text)
    assert "海风很大。" in visible
    assert "```" not in visible
    assert payload["scene"]["location"] == "茶铺"
    assert payload["spotlight"] == ["xiaowu"]


def test_parse_trailer_strips_rp_state() -> None:
    text = "茶铺里很暖。\n\n<rp_state>\nlocation: 茶铺\ntime: 黄昏\nscene: 油灯还亮着\n</rp_state>\n"
    visible, payload = parse_trailer(text)
    assert visible == "茶铺里很暖。"
    assert "<rp_state>" not in visible
    assert payload["location"] == "茶铺"
    assert payload["time"] == "黄昏"


def test_mentions() -> None:
    members = [
        CastMember(id="anlan", name="阿澜", card="x", aliases=["澜"]),
        CastMember(id="xiaowu", name="小雾", card="x", aliases=["雾"]),
    ]
    mapping = alias_map(members)
    assert parse_mentions("去找 @阿澜 和 @雾", mapping) == ["anlan", "xiaowu"]
    assert parse_mentions("没有点名", mapping) == []


def test_nmem_space_not_silent_default() -> None:
    pack = SimpleNamespace(nmem_space=None)
    config = SimpleNamespace(nmem=SimpleNamespace(space=""))
    assert resolve_nmem_space(None, pack, config) is None  # type: ignore[arg-type]
    assert resolve_nmem_space("default", pack, config) == "default"  # type: ignore[arg-type]
    assert resolve_nmem_space(None, pack, config, "kept") == "kept"  # type: ignore[arg-type]
    pack.nmem_space = "rp-mem"
    assert resolve_nmem_space(None, pack, config) == "rp-mem"  # type: ignore[arg-type]
    assert resolve_nmem_space("cli", pack, config, "kept") == "cli"  # type: ignore[arg-type]


def test_load_example_world() -> None:
    root = find_example_world()
    pack = load_world(root)
    assert pack.world_id == "lamp-harbor"
    assert pack.primary == "anlan"
    assert {m.id for m in pack.cast} == {"anlan", "xiaowu"}
    member = pack.member("anlan")
    assert member is not None
    anlan = pack.load_member_card(member)
    assert anlan.name == "阿澜"
    assert pack.lorebook_files()
    scene = load_scene(pack.scene_md)
    assert "海风很大" in scene.scene


def test_apply_old_lightrp_scene_patch() -> None:
    from lightrp.scene import SceneState

    scene = SceneState(location="石堤", time="黄昏", present=["anlan"], scene="海风")
    _, trailer = parse_trailer("ok\n\n```lightrp\nscene:\n  location: 茶铺\n  time: 夜里\n  present:\n    - xiaowu\n  notes: 油灯\n```\n")
    next_scene = apply_scene_patch(scene, trailer)
    assert next_scene.location == "茶铺"
    assert next_scene.time == "夜里"
    assert next_scene.present == ["xiaowu"]
    assert "油灯" in next_scene.scene
