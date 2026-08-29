from __future__ import annotations

import json
from pathlib import Path

from lightrp.lorebook import LoreEntry, entries_from_character_book, load_lorebook, trigger_lore
from lightrp.scene import SceneState, scene_lore_haystack
from lightrp.world import CastMember


def test_keyword_and_constant(tmp_path: Path) -> None:
    path = tmp_path / "book.json"
    path.write_text(
        json.dumps(
            {
                "entries": [
                    {
                        "keys": ["灯塔"],
                        "content": "灯塔每晚必亮。",
                        "enabled": True,
                        "constant": False,
                        "insertion_order": 10,
                    },
                    {
                        "keys": [],
                        "content": "通用设定。",
                        "enabled": True,
                        "constant": True,
                        "insertion_order": 1,
                    },
                    {
                        "keys": ["酒铺"],
                        "content": "不该出现。",
                        "enabled": True,
                        "constant": False,
                        "insertion_order": 5,
                    },
                ]
            }
        ),
        encoding="utf-8",
    )
    entries = load_lorebook(path)
    hit = trigger_lore(entries, haystack="我们去看灯塔", scene_text="", token_budget=200)
    texts = [item.content for item in hit]
    assert "通用设定。" in texts
    assert "灯塔每晚必亮。" in texts
    assert "不该出现。" not in texts


def test_scene_entity_trigger() -> None:
    entries = [
        LoreEntry(keys=["石堤"], content="堤上有盐。", enabled=True, insertion_order=1),
    ]
    hit = trigger_lore(entries, haystack="你好", scene_text="location: 灯塔下的石堤", token_budget=200)
    assert hit and hit[0].content == "堤上有盐。"


def test_selective_secondary() -> None:
    entries = [
        LoreEntry(
            keys=["雾"],
            secondary_keys=["灯塔"],
            selective=True,
            content="双影。",
            insertion_order=1,
        )
    ]
    assert trigger_lore(entries, "有雾", "", 200) == []
    hit = trigger_lore(entries, "雾里的灯塔", "", 200)
    assert hit and hit[0].content == "双影。"


def test_st_worldinfo_dict_keys(tmp_path: Path) -> None:
    path = tmp_path / "uma.json"
    path.write_text(
        json.dumps(
            {
                "name": "赛马娘世界书",
                "entries": {
                    "0": {
                        "uid": 0,
                        "key": [],
                        "content": "赛马娘是学园里的运动员。",
                        "constant": True,
                        "disable": False,
                        "order": 1,
                        "comment": "世界观核心",
                    },
                    "9": {
                        "uid": 9,
                        "key": ["无声铃鹿", "铃鹿"],
                        "content": "逃马天才。",
                        "constant": False,
                        "disable": False,
                        "order": 100,
                        "comment": "无声铃鹿",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    entries = load_lorebook(path)
    assert len(entries) == 2
    hit = trigger_lore(entries, "铃鹿在跑道上", "", 200)
    texts = [item.content for item in hit]
    assert "赛马娘是学园里的运动员。" in texts
    assert "逃马天才。" in texts


def test_token_budget() -> None:
    entries = [
        LoreEntry(keys=["a"], content="x" * 50, constant=True, insertion_order=1),
        LoreEntry(keys=["a"], content="y" * 50, constant=True, insertion_order=2),
    ]
    hit = trigger_lore(entries, "a", "", token_budget=20)
    assert len(hit) == 1


def test_recursive_scan_from_constant() -> None:
    entries = [
        LoreEntry(keys=[], content="无声铃鹿今天也在跑。", constant=True, insertion_order=1, source="world"),
        LoreEntry(keys=["无声铃鹿", "铃鹿"], content="逃马天才。", insertion_order=100, source="world"),
    ]
    hit = trigger_lore(entries, haystack="早上好", scene_text="", token_budget=200)
    texts = [item.content for item in hit]
    assert "无声铃鹿今天也在跑。" in texts
    assert "逃马天才。" in texts


def test_prevent_recursion_does_not_scan_content() -> None:
    entries = [
        LoreEntry(keys=[], content="无声铃鹿在场。秘传口令。", constant=True, insertion_order=1, prevent_recursion=True),
        LoreEntry(keys=["无声铃鹿"], content="铃鹿资料。", insertion_order=2),
        LoreEntry(keys=["秘传口令"], content="不该被递归打出。", insertion_order=3),
    ]
    texts = [item.content for item in trigger_lore(entries, "", "", 200)]
    assert "铃鹿资料。" not in texts
    assert "不该被递归打出。" not in texts


def test_character_book_still_triggered_by_world_constant() -> None:
    world = [
        LoreEntry(keys=[], content="无声铃鹿在跑道上。", constant=True, source="world", insertion_order=1),
    ]
    book = entries_from_character_book(
        {
            "recursive_scanning": False,
            "entries": [
                {"keys": ["无声铃鹿"], "content": "{{char}} 的名号条目。", "enabled": True},
                {"keys": ["名号条目"], "content": "不该再引爆。", "enabled": True},
            ],
        },
        source="suzuka",
        char_name="无声铃鹿",
    )
    assert all(item.prevent_recursion for item in book)
    hit = trigger_lore([*world, *book], "", "", 200)
    texts = [item.content for item in hit]
    assert "{{char}} 的名号条目。" in texts
    assert "不该再引爆。" not in texts
    assert book[0].char_name == "无声铃鹿"


def test_match_whole_words() -> None:
    entries = [LoreEntry(keys=["cat"], content="meow", match_whole_words=True, insertion_order=1)]
    assert trigger_lore(entries, "the category", "", 200) == []
    hit = trigger_lore(entries, "the cat sat", "", 200)
    assert hit and hit[0].content == "meow"


def test_selective_not_logic() -> None:
    entries = [
        LoreEntry(
            keys=["雾"],
            secondary_keys=["晴"],
            selective=True,
            selective_logic=1,
            content="雾且非晴",
            insertion_order=1,
        )
    ]
    assert trigger_lore(entries, "雾但晴了", "", 200) == []
    hit = trigger_lore(entries, "有雾", "", 200)
    assert hit and hit[0].content == "雾且非晴"


def test_probability_zero_skipped() -> None:
    entries = [LoreEntry(keys=["a"], content="no", probability=0, insertion_order=1)]
    assert trigger_lore(entries, "a", "", 200) == []


def test_scene_lore_haystack_includes_present_aliases() -> None:
    scene = SceneState(location="操场", present=["铃鹿"])
    cast = [CastMember(id="suzuka", name="无声铃鹿", card="x", aliases=["铃鹿", "Silence Suzuka"])]
    blob = scene_lore_haystack(scene, cast)
    assert "无声铃鹿" in blob
    assert "铃鹿" in blob
    entries = [LoreEntry(keys=["无声铃鹿"], content="在场即注入。", insertion_order=1)]
    hit = trigger_lore(entries, haystack="", scene_text=blob, token_budget=200)
    assert hit and hit[0].content == "在场即注入。"
