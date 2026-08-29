from __future__ import annotations

from lightrp.budget import (
    ContextConfig,
    SectionBlock,
    SectionBudget,
    apply_section_budgets,
    estimate_tokens,
    memory_is_duplicate,
    route_memory_candidate,
    section_soft_cap,
    trim_card_field_map,
    trim_history,
    truncate_to_tokens,
)
from lightrp.assemble import select_mini_members
from lightrp.paths import find_example_world
from lightrp.scene import load_scene
from lightrp.world import load_world


def test_estimate_tokens_cjk_conservative() -> None:
    assert estimate_tokens("") == 0
    # ASCII: ceil(3/4)=1 → ×1.1 → 2
    assert estimate_tokens("abc") == 2
    # ASCII: ceil(9/4)=3 → ×1.1 → 4
    assert estimate_tokens("a" * 9) == 4
    # CJK: 2 chars ≈ 2 → ×1.1 → 3
    assert estimate_tokens("你好") == 3
    # Mixed should count CJK heavily
    assert estimate_tokens("你好世界hello") >= estimate_tokens("hello")


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


def test_soft_cap_drops_trim_order_not_protected() -> None:
    blocks = [
        SectionBlock(name="state", text="地点很长很长" * 20, budget=800, protected=True),
        SectionBlock(name="lore", text="世界设定" * 200, budget=3000),
        SectionBlock(name="memory", text="记忆条目" * 200, budget=2500),
        SectionBlock(name="primary_card", text="角色规则" * 100, budget=4000, protected=True),
    ]
    soft = 50
    texts, reports = apply_section_budgets(blocks, soft_cap=soft)
    assert texts["lore"] == ""
    assert texts["memory"] == ""
    assert texts["state"]  # protected kept
    assert texts["primary_card"]  # protected kept
    assert next(r for r in reports if r.name == "lore").truncated is True


def test_trim_history_protects_recent() -> None:
    messages = [{"role": "user", "content": f"m{i} {'x' * 30}"} for i in range(20)]
    kept, truncated = trim_history(messages, token_budget=20, protect_recent=4)
    assert truncated is True
    assert len(kept) >= 4
    assert kept[-1]["content"].startswith("m19")


def test_truncate_to_tokens() -> None:
    text, truncated = truncate_to_tokens("abcdefghij", 2)
    assert truncated is True
    assert estimate_tokens(text) <= 2


def test_memory_route_and_dedupe() -> None:
    assert route_memory_candidate(0.9) == "long"
    assert route_memory_candidate(0.5) == "event"
    assert route_memory_candidate(0.2) == "drop"
    assert memory_is_duplicate("玩家答应周末陪铃鹿", ["玩家答应周末陪铃鹿出去"])
    assert not memory_is_duplicate("帝王去东京了", ["玩家答应周末陪铃鹿"])


def test_trim_card_keeps_system_prompt_over_example() -> None:
    fields = {
        "id": "x",
        "name": "角色",
        "system_prompt": "必须遵守的角色规则" * 40,
        "personality": "温柔",
        "behavior": "礼貌",
        "speech": "轻声",
        "mes_example": "示例对话" * 80,
        "backstory": "背景故事" * 80,
        "description": "外貌" * 40,
        "scenario": "场景" * 40,
        "likes": "茶",
        "dislikes": "吵闹",
        "age": "18",
        "first_mes": "你好",
    }
    trimmed, truncated = trim_card_field_map(fields, budget=120)
    assert truncated is True
    assert trimmed["system_prompt"]
    assert not trimmed["mes_example"]
    assert not trimmed["backstory"]


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


def test_mini_rank_user_text_name_over_present() -> None:
    """Plain name in user_text should beat present-only crowd when capped."""
    from lightrp.budget import MiniSelectConfig

    pack = load_world(find_example_world())
    scene = load_scene(pack.scene_md)
    # Fill present with many cast ids if available
    scene.present = [m.id for m in pack.cast[: min(8, len(pack.cast))]]
    target = next((m for m in pack.cast if m.id not in scene.present[:6] or True), pack.cast[-1])
    # Prefer a non-primary member whose name appears in user text
    primary = pack.cast[0].id
    others = [m for m in pack.cast if m.id != primary]
    assert others
    focus = others[-1]
    cfg = MiniSelectConfig(max_characters=1, max_tokens=1200, recent_turns=4)
    # Crowd present without focus; user asks about focus by name
    scene.present = [m.id for m in others if m.id != focus.id][:6] or [others[0].id]
    minis = select_mini_members(
        pack,
        scene,
        haystack=f"{focus.name}在哪里？\n" + " ".join(scene.present),
        mention_ids=[],
        primary_id=primary,
        mini_cfg=cfg,
        recent_haystack="",
        user_text=f"对了，{focus.name}在哪里？",
    )
    assert minis and minis[0].id == focus.id


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
    assert cfg.tool_reserve == 1500
    assert isinstance(cfg.budget, SectionBudget)
    soft = section_soft_cap(cfg, "你好", llm_max_tokens=8192)
    assert soft == cfg.max_tokens - 8192 - cfg.tool_reserve - estimate_tokens("你好")
