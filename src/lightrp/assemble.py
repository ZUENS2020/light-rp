from __future__ import annotations

from typing import Any

from lightrp.cards import CharacterCard, ensemble_acting
from lightrp.lorebook import LoreEntry
from lightrp.memory import MemoryStore
from lightrp.promptlib import PromptLibrary
from lightrp.scene import SceneState
from lightrp.world import CastMember, WorldPack


def clip_text(text: str, limit: int = 450) -> str:
    trimmed = (text or "").strip()
    if len(trimmed) <= limit:
        return trimmed
    return trimmed[: limit - 1] + "…"


def story_summary(messages: list[Any]) -> str:
    for item in reversed(messages):
        role = item.get("role") if isinstance(item, dict) else getattr(item, "role", "")
        content = item.get("content") if isinstance(item, dict) else getattr(item, "content", "")
        if role == "system" and str(content).strip():
            return str(content).strip()
    return ""


def resolve_primary_id(pack: WorldPack, scene: SceneState) -> str | None:
    if pack.primary:
        member = pack.member(pack.primary)
        return member.id if member else pack.primary
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


def select_mini_members(
    pack: WorldPack,
    scene: SceneState,
    haystack: str,
    mention_ids: list[str],
    primary_id: str | None,
) -> list[CastMember]:
    mentioned = {item.lower() for item in mention_ids}
    present_ids = {member.id for member in pack.present_members(scene.present)}
    out: list[CastMember] = []
    seen: set[str] = set()
    for member in pack.cast:
        if primary_id and member.id == primary_id:
            continue
        hit = keyword_hit(member, haystack) or member.id.lower() in mentioned
        if member.id in present_ids or hit:
            if member.id not in seen:
                seen.add(member.id)
                out.append(member)
    return out


def render_cast_index(pack: WorldPack, present_ids: list[str]) -> str:
    present = {item.lower() for item in present_ids}
    lines: list[str] = []
    for member in pack.cast:
        marker = "present" if member.id.lower() in present or member.name.lower() in present else "absent"
        blurb = member.blurb.strip()
        suffix = f" — {blurb}" if blurb else ""
        lines.append(f"- {member.name} ({member.id}) [{marker}]{suffix}")
    return "\n".join(lines)


def render_card(library: PromptLibrary, card: CharacterCard, user_name: str) -> str:
    filled = card.substitute(user_name)
    return library.render(
        "layers/card.md",
        {
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
        },
    ).strip()


def render_mini(library: PromptLibrary, pack: WorldPack, card: CharacterCard, user_name: str) -> str:
    filled = card.substitute(user_name)
    member = pack.member(filled.id)
    summary = clip_text((member.blurb if member else "") or filled.personality)
    return library.render(
        "layers/mini.md",
        {
            "id": filled.id,
            "name": filled.name,
            "summary": summary,
            "behavior_notes": clip_text(filled.behavior),
            "relations": clip_text(filled.speech),
        },
    ).strip()


def render_cards(library: PromptLibrary, cards: list[CharacterCard], user_name: str) -> str:
    blocks = [render_card(library, card, user_name) for card in cards]
    return "\n\n".join(block for block in blocks if block)


def render_minis(library: PromptLibrary, pack: WorldPack, cards: list[CharacterCard], user_name: str) -> str:
    blocks = [render_mini(library, pack, card, user_name) for card in cards]
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


def assemble_system(
    library: PromptLibrary,
    pack: WorldPack,
    memory: MemoryStore,
    scene: SceneState,
    present_cards: list[CharacterCard],
    lore_entries: list[LoreEntry],
    nmem_recall: str,
    extra_system: str = "",
    mini_cards: list[CharacterCard] | None = None,
    summary: str = "",
) -> str:
    user_name = pack.player_name
    minis = mini_cards or []
    values_common = {
        "world": pack.read_world(),
        "cast": render_cast_index(pack, scene.present),
        "player": memory.snapshot_text("player"),
        "memory": memory.snapshot_text("world"),
        "scene": scene.as_yaml(),
        "cards": render_cards(library, present_cards, user_name),
        "minis": render_minis(library, pack, minis, user_name),
        "lore": render_lore(library, lore_entries, user_name, present_cards[0].name if present_cards else (minis[0].name if minis else "")),
        "nmem": nmem_recall,
        "summary": summary,
        "player_name": user_name,
        "world_id": pack.world_id,
        "world_name": pack.name,
    }
    gm = library.render("gm.md", values_common)
    values_common["gm"] = gm
    stable = library.render("layers/stable.md", values_common).strip()
    context = library.render("layers/context.md", values_common).strip()
    volatile = library.render("layers/volatile.md", values_common).strip()
    extra = extra_system.strip()
    return "\n\n".join(part for part in (extra, stable, context, volatile) if part)


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
