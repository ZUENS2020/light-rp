from __future__ import annotations

from lightrp.budget import (
    ContextConfig,
    SectionBlock,
    SectionBudget,
    apply_section_budgets,
    estimate_tokens,
    memory_is_duplicate,
    route_memory_candidate,
    trim_history,
    truncate_to_tokens,
)
from lightrp.assemble import select_mini_members
from lightrp.paths import find_example_world
from lightrp.scene import load_scene
from lightrp.world import load_world


def test_estimate_tokens_matches_char_heuristic() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abc") == 1
    assert estimate_tokens("a" * 9) == 3


def test_section_budget_trims_lore_first_entries() -> None:
    blocks = [
        SectionBlock(name="state", text="loc", budget=100, protected=True),
        SectionBlock(
            name="lore",
            text="",
            budget=5,
            entries=["AAAAAA", "BBBBBB", "CCCCCC"],
            entry_labels=["a", "b", "c"],
        ),
    ]
    texts, reports = apply_section_budgets(blocks)
    lore = next(item for item in reports if item.name == "lore")
    assert lore.truncated is True
    assert "a" in lore.items
    assert estimate_tokens(texts["lore"]) <= 5


def test_trim_history_protects_recent() -> None:
    messages = [{"role": "user", "content": f"m{i} {'x' * 30}"} for i in range(20)]
    kept, truncated = trim_history(messages, token_budget=20, protect_recent=4)
    assert truncated is True
    assert len(kept) >= 4
    assert kept[-1]["content"].startswith("m19")


def test_truncate_to_tokens() -> None:
    text, truncated = truncate_to_tokens("abcdefghij", 2)
    assert truncated is True
    assert len(text) <= 6  # 2*3


def test_memory_route_and_dedupe() -> None:
    assert route_memory_candidate(0.9) == "long"
    assert route_memory_candidate(0.5) == "event"
    assert route_memory_candidate(0.2) == "drop"
    assert memory_is_duplicate("玩家答应周末陪铃鹿", ["玩家答应周末陪铃鹿出去"])
    assert not memory_is_duplicate("帝王去东京了", ["玩家答应周末陪铃鹿"])


def test_mini_rank_mention_over_present() -> None:
    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    scene.present = ["anlan", "xiaowu"]
    # mention xiaowu explicitly while both present — still ranked, primary excluded
    minis = select_mini_members(
        pack,
        scene,
        haystack="小雾在吗",
        mention_ids=["xiaowu"],
        primary_id="anlan",
        mini_cfg=None,
        recent_haystack="",
    )
    assert minis and minis[0].id == "xiaowu"


def test_mini_max_characters() -> None:
    from lightrp.budget import MiniSelectConfig

    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    scene.present = ["anlan", "xiaowu"]
    cfg = MiniSelectConfig(max_characters=1, max_tokens=1200, recent_turns=4)
    minis = select_mini_members(pack, scene, haystack="茶铺", mention_ids=[], primary_id="anlan", mini_cfg=cfg)
    assert len(minis) <= 1


def test_context_config_defaults() -> None:
    cfg = ContextConfig()
    assert cfg.max_tokens == 32768
    assert cfg.budget.lore == 3000
    assert isinstance(cfg.budget, SectionBudget)
