from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from lightrp.budget import (
    ContextConfig,
    ContextReport,
    MiniSelectConfig,
    SectionBlock,
    SectionReport,
    apply_section_budgets,
    build_context_report,
    default_context_config,
    default_mini_config,
    estimate_tokens,
    history_token_budget,
    section_soft_cap,
    trim_card_field_map,
    trim_history,
    truncate_to_tokens,
)
from lightrp.cards import CharacterCard, ensemble_acting
from lightrp.lorebook import LoreEntry
from lightrp.memory import MemoryStore
from lightrp.mini import MiniCard
from lightrp.promptlib import PromptLibrary
from lightrp.scene import SceneState
from lightrp.world import CastMember, WorldPack


def story_summary(messages: list[Any]) -> str:
    for item in reversed(messages):
        role = item.get("role") if isinstance(item, dict) else getattr(item, "role", "")
        content = item.get("content") if isinstance(item, dict) else getattr(item, "content", "")
        if role == "system" and str(content).strip():
            return str(content).strip()
    return ""


def resolve_primary_id(pack: WorldPack, scene: SceneState, session_primary: str | None = None) -> str | None:
    for candidate in (session_primary, pack.primary):
        if candidate:
            member = pack.member(candidate)
            return member.id if member else candidate
    for ident in scene.present:
        member = pack.member(ident)
        if member:
            return member.id
    for member in pack.cast:
        if member.present:
            return member.id
    return pack.cast[0].id if pack.cast else None


def keyword_hit(member: CastMember, haystack: str) -> bool:
    hay = haystack.lower()
    return any(name.lower() in hay for name in [member.id, member.name, *member.aliases] if name)


def _recent_mention_ids(pack: WorldPack, recent_text: str) -> set[str]:
    hay = recent_text.lower()
    hits: set[str] = set()
    for member in pack.cast:
        if any(name.lower() in hay for name in [member.id, member.name, *member.aliases] if name):
            hits.add(member.id)
    return hits


def select_mini_members(
    pack: WorldPack,
    scene: SceneState,
    haystack: str,
    mention_ids: list[str],
    primary_id: str | None,
    mini_cfg: MiniSelectConfig | None = None,
    recent_haystack: str = "",
    user_text: str = "",
) -> list[CastMember]:
    """Rank: user_text name/@ > present > recent > other keyword. Cap by max_characters."""
    cfg = mini_cfg or default_mini_config()
    mentioned = {item.lower() for item in mention_ids}
    present_ids = {member.id for member in pack.present_members(scene.present)}
    recent_ids = _recent_mention_ids(pack, recent_haystack) if recent_haystack else set()
    user_intent = _recent_mention_ids(pack, user_text) if user_text else set()

    ranked: list[tuple[int, CastMember]] = []
    for member in pack.cast:
        if primary_id and member.id == primary_id:
            continue
        explicit = member.id.lower() in mentioned or member.id in user_intent
        present = member.id in present_ids
        recent = member.id in recent_ids
        keyword = keyword_hit(member, haystack)
        if not (explicit or present or recent or keyword):
            continue
        if explicit:
            rank = 0
        elif present:
            rank = 1
        elif recent:
            rank = 2
        else:
            rank = 3
        ranked.append((rank, member))
    ranked.sort(key=lambda item: (item[0], item[1].name))
    return [member for _, member in ranked[: max(1, cfg.max_characters)]]


def select_minis_within_budget(
    minis: list[MiniCard],
    library: PromptLibrary,
    mini_cfg: MiniSelectConfig | None = None,
) -> list[MiniCard]:
    cfg = mini_cfg or default_mini_config()
    kept: list[MiniCard] = []
    used = 0
    for mini in minis:
        block = render_mini(library, mini)
        cost = estimate_tokens(block)
        if kept and used + cost > cfg.max_tokens:
            break
        if not kept and cost > cfg.max_tokens:
            kept.append(mini)
            break
        kept.append(mini)
        used += cost
    return kept


def render_cast_index(pack: WorldPack, present_ids: list[str]) -> str:
    present = {item.lower() for item in present_ids}
    lines: list[str] = []
    for member in pack.cast:
        marker = "present" if member.id.lower() in present or member.name.lower() in present else "absent"
        blurb = member.blurb.strip()
        suffix = f" — {blurb}" if blurb else ""
        lines.append(f"- {member.name} ({member.id}) [{marker}]{suffix}")
    return "\n".join(lines)


def render_card(
    library: PromptLibrary,
    card: CharacterCard,
    user_name: str,
    budget: int | None = None,
) -> str:
    filled = card.substitute(user_name)
    fields = {
        "id": filled.id,
        "name": filled.name,
        "age": filled.age,
        "description": filled.description,
        "personality": filled.personality,
        "behavior": filled.behavior,
        "speech": filled.speech,
        "likes": filled.likes,
        "dislikes": filled.dislikes,
        "backstory": filled.backstory,
        "scenario": filled.scenario,
        "first_mes": filled.first_mes,
        "mes_example": filled.mes_example,
        "system_prompt": ensemble_acting(filled.system_prompt, filled.name),
    }
    if budget is not None and budget > 0:
        fields, _ = trim_card_field_map(fields, budget)
    return library.render("layers/card.md", fields).strip()


def render_mini(library: PromptLibrary, mini: MiniCard) -> str:
    return library.render(
        "layers/mini.md",
        {
            "id": mini.id,
            "name": mini.name,
            "summary": mini.summary,
            "behavior_notes": mini.behavior_notes,
            "relations": mini.relations,
        },
    ).strip()


def render_cards(
    library: PromptLibrary,
    cards: list[CharacterCard],
    user_name: str,
    budget: int | None = None,
) -> str:
    if not cards:
        return ""
    per = max(1, (budget or 0) // max(1, len(cards))) if budget else None
    blocks = [render_card(library, card, user_name, per) for card in cards]
    return "\n\n".join(block for block in blocks if block)


def render_minis(library: PromptLibrary, minis: list[MiniCard]) -> str:
    blocks = [render_mini(library, mini) for mini in minis]
    return "\n\n".join(block for block in blocks if block)


def render_lore(library: PromptLibrary, entries: list[LoreEntry], user_name: str, char_name: str) -> str:
    blocks = []
    for entry in entries:
        name = entry.char_name or char_name
        content = entry.content.replace("{{user}}", user_name).replace("{{char}}", name)
        blocks.append(
            library.render(
                "layers/lore.md",
                {"title": entry.title, "content": content, "source": entry.source},
            ).strip()
        )
    return "\n\n".join(blocks)


def lore_entry_blocks(library: PromptLibrary, entries: list[LoreEntry], user_name: str, char_name: str) -> tuple[list[str], list[str]]:
    texts: list[str] = []
    labels: list[str] = []
    for entry in entries:
        name = entry.char_name or char_name
        content = entry.content.replace("{{user}}", user_name).replace("{{char}}", name)
        texts.append(
            library.render(
                "layers/lore.md",
                {"title": entry.title, "content": content, "source": entry.source},
            ).strip()
        )
        labels.append(entry.title or entry.comment or ",".join(entry.keys) or entry.source)
    return texts, labels


@dataclass
class AssembleResult:
    system: str
    report: ContextReport
    history: list[dict[str, Any]]
    mini_ids: list[str]
    lore_titles: list[str]


def assemble_budgeted(
    library: PromptLibrary,
    pack: WorldPack,
    memory: MemoryStore,
    scene: SceneState,
    present_cards: list[CharacterCard],
    lore_entries: list[LoreEntry],
    nmem_recall: str,
    history_messages: list[dict[str, Any]],
    user_input: str,
    extra_system: str = "",
    mini_cards: list[MiniCard] | None = None,
    summary: str = "",
    context_cfg: ContextConfig | None = None,
    mini_cfg: MiniSelectConfig | None = None,
    lore_budget_override: int | None = None,
    llm_max_tokens: int = 0,
) -> AssembleResult:
    cfg = context_cfg or default_context_config()
    mcfg = mini_cfg or default_mini_config()
    user_name = pack.player_name
    minis = select_minis_within_budget(mini_cards or [], library, mcfg)

    cast = render_cast_index(pack, scene.present)
    world_text = pack.read_world()
    player = pack.read_user_setting() or memory.user_setting
    cards_text = render_cards(library, present_cards, user_name, budget=int(cfg.budget.primary_card * 0.85))
    mini_entries = [render_mini(library, mini) for mini in minis]
    mini_labels = [mini.id for mini in minis]
    lore_texts, lore_labels = lore_entry_blocks(
        library, lore_entries, user_name, present_cards[0].name if present_cards else (minis[0].name if minis else "")
    )
    scene_text = scene.as_yaml()
    mem_world = memory.snapshot_text("world")
    mem_player = memory.snapshot_text("player")
    memory_blob = "\n\n".join(part for part in (mem_world, mem_player) if part.strip())
    memory_entries = [part for part in (mem_world, mem_player) if part.strip()]
    memory_labels = [label for label, part in (("world", mem_world), ("player", mem_player)) if part.strip()]

    values_seed = {
        "world": world_text,
        "cast": cast,
        "player": player,
        "memory": mem_world,
        "player_memory": mem_player,
        "scene": scene_text,
        "cards": cards_text,
        "minis": "\n\n".join(mini_entries),
        "lore": "\n\n".join(lore_texts),
        "nmem": nmem_recall,
        "summary": summary,
        "player_name": user_name,
        "world_id": pack.world_id,
        "world_name": pack.name,
    }
    gm = library.render("gm.md", values_seed)

    # Apply budgets to raw payloads, then re-render through layer templates.
    lore_budget = lore_budget_override if lore_budget_override is not None else cfg.budget.lore
    mini_joined = "\n\n".join(mini_entries)
    lore_joined = "\n\n".join(lore_texts)
    blocks = [
        SectionBlock(name="system", text=gm.strip(), budget=cfg.budget.system, protected=True),
        SectionBlock(name="world", text=world_text, budget=cfg.budget.world),
        SectionBlock(name="user_setting", text=player, budget=cfg.budget.user_setting, protected=True),
        SectionBlock(name="primary_card", text=cards_text, budget=cfg.budget.primary_card, protected=True),
        SectionBlock(
            name="mini_cards",
            text=mini_joined,
            budget=min(cfg.budget.mini_cards, mcfg.max_tokens),
            entries=mini_entries,
            entry_labels=mini_labels,
            items=mini_labels,
        ),
        SectionBlock(
            name="lore",
            text=lore_joined,
            budget=lore_budget,
            entries=lore_texts,
            entry_labels=lore_labels,
            items=lore_labels,
        ),
        SectionBlock(name="state", text=scene_text, budget=cfg.budget.state, protected=True),
        SectionBlock(
            name="memory",
            text=memory_blob,
            budget=cfg.budget.memory,
            entries=memory_entries or ([memory_blob] if memory_blob else []),
            entry_labels=memory_labels or (["memory"] if memory_blob else []),
            items=memory_labels,
        ),
        SectionBlock(name="nmem", text=nmem_recall, budget=cfg.budget.nmem),
        SectionBlock(name="summary", text=summary, budget=cfg.budget.summary),
    ]
    soft_cap = section_soft_cap(cfg, user_input, llm_max_tokens=llm_max_tokens, min_history_tokens=200)
    texts, section_reports = apply_section_budgets(blocks, soft_cap=soft_cap)

    # Split memory back into world / player snapshots when possible
    mem_text = texts.get("memory", "")
    if mem_world and mem_world in mem_text:
        snap_world = mem_world if estimate_tokens(mem_world) <= cfg.budget.memory else mem_text
        snap_player = mem_player if mem_player and mem_player in mem_text else ""
        if snap_world and snap_player and estimate_tokens(snap_world) + estimate_tokens(snap_player) > cfg.budget.memory:
            # prefer keeping world; trim player
            remain = max(0, cfg.budget.memory - estimate_tokens(snap_world))
            snap_player, _ = truncate_to_tokens(snap_player, remain)
    else:
        snap_world = mem_text
        snap_player = ""

    values = {
        "world": texts.get("world", ""),
        "cast": cast,
        "player": texts.get("user_setting", ""),
        "memory": snap_world,
        "player_memory": snap_player,
        "scene": texts.get("state", ""),
        "cards": texts.get("primary_card", ""),
        "minis": texts.get("mini_cards", ""),
        "lore": texts.get("lore", ""),
        "nmem": texts.get("nmem", ""),
        "summary": texts.get("summary", ""),
        "player_name": user_name,
        "world_id": pack.world_id,
        "world_name": pack.name,
        "gm": texts.get("system", gm.strip()),
    }
    stable = library.render("layers/stable.md", values).strip()
    context_layer = library.render("layers/context.md", values).strip()
    volatile = library.render("layers/volatile.md", values).strip()
    extra = extra_system.strip()
    system = "\n\n".join(part for part in (extra, stable, context_layer, volatile) if part)

    # Recompute section tokens from final system parts for report accuracy
    section_reports = [
        SectionReport(name="system", tokens=estimate_tokens(texts.get("system", "")), budget=cfg.budget.system, truncated=any(r.name == "system" and r.truncated for r in section_reports)),
        *[r for r in section_reports if r.name != "system"],
    ]

    section_tokens = sum(item.tokens for item in section_reports)
    hist_budget = history_token_budget(
        cfg,
        section_tokens + estimate_tokens(extra),
        user_input,
        llm_max_tokens=llm_max_tokens,
    )
    trimmed, hist_truncated = trim_history(history_messages, hist_budget, cfg.history.protect_recent_turns)
    report = build_context_report(
        cfg,
        section_reports,
        trimmed,
        hist_truncated,
        user_input,
        llm_max_tokens=llm_max_tokens,
        extra_system=extra,
    )
    mini_ids = list(next((r.items for r in section_reports if r.name == "mini_cards"), []) or [])
    lore_titles = list(next((r.items for r in section_reports if r.name == "lore"), []) or [])
    return AssembleResult(system=system, report=report, history=trimmed, mini_ids=mini_ids, lore_titles=lore_titles)


def assemble_system(
    library: PromptLibrary,
    pack: WorldPack,
    memory: MemoryStore,
    scene: SceneState,
    present_cards: list[CharacterCard],
    lore_entries: list[LoreEntry],
    nmem_recall: str,
    extra_system: str = "",
    mini_cards: list[MiniCard] | None = None,
    summary: str = "",
    context_cfg: ContextConfig | None = None,
    mini_cfg: MiniSelectConfig | None = None,
) -> str:
    result = assemble_budgeted(
        library,
        pack,
        memory,
        scene,
        present_cards,
        lore_entries,
        nmem_recall,
        history_messages=[],
        user_input="",
        extra_system=extra_system,
        mini_cards=mini_cards,
        summary=summary,
        context_cfg=context_cfg,
        mini_cfg=mini_cfg,
    )
    return result.system


def breach_system(library: PromptLibrary, enabled: bool) -> str:
    if not enabled:
        return ""
    return library.text("layers/breach.md").strip()


def breach_phi(library: PromptLibrary, enabled: bool) -> str:
    if not enabled:
        return ""
    return library.text("layers/breach_user.md").strip()


def with_breach_phi(
    messages: list[dict[str, Any]],
    library: PromptLibrary,
    enabled: bool,
) -> list[dict[str, Any]]:
    """ST 式历史后指令：贴在本轮最后一条，不写进 session。"""
    phi = breach_phi(library, enabled)
    if not phi:
        return messages
    return [*messages, {"role": "system", "content": phi}]


def memory_tool_spec(library: PromptLibrary) -> dict:
    from lightrp.promptlib import load_json_prompt

    schema = load_json_prompt(library, "tools/memory.schema.json")
    return {
        "type": "function",
        "function": {
            "name": "memory",
            "description": library.text("tools/memory.md").strip(),
            "parameters": schema,
        },
    }
