from __future__ import annotations

from pathlib import Path

from lightrp.memory import MemoryStore


def test_add_replace_remove_and_freeze(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path, world_char_limit=80)
    store.load_from_disk()
    assert store.apply("add", "world", content="灯塔仍亮着").success
    store.freeze()
    assert "灯塔仍亮着" in store.snapshot_text("world")
    assert store.apply("add", "world", content="茶铺记账到开船").success
    assert "茶铺记账到开船" in store.live_text("world")
    assert "茶铺记账到开船" not in store.snapshot_text("world")
    assert store.apply("replace", "world", old_text="茶铺", content="茶铺不再赊账").success
    assert store.apply("remove", "world", old_text="灯塔").success
    assert store.live_entries("world") == ["茶铺不再赊账"]
    text = (tmp_path / "MEMORY.md").read_text(encoding="utf-8")
    assert "茶铺不再赊账" in text


def test_capacity(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path, world_char_limit=10)
    store.load_from_disk()
    ok = store.apply("add", "world", content="12345")
    assert ok.success
    fail = store.apply("add", "world", content="67890 extra")
    assert not fail.success


def test_character_memory(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path)
    store.load_from_disk()
    result = store.apply("add", "character", content="不爱被追问", character_id="anlan")
    assert result.success
    path = tmp_path / "memories" / "anlan.md"
    assert path.is_file()
    assert "不爱被追问" in path.read_text(encoding="utf-8")
