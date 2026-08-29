from __future__ import annotations

from lightrp.assemble import breach_system, render_card, render_lore, with_breach_phi
from lightrp.cards import CharacterCard
from lightrp.llm import ChatResult, LLMClient
from lightrp.lorebook import LoreEntry, trigger_lore
from lightrp.memory import MemoryStore
from lightrp.promptlib import PromptLibrary
from lightrp.scene import SceneState
from lightrp.session import Session, ChatMessage
from lightrp.world import WorldPack


def run_spotlight(
    llm: LLMClient,
    library: PromptLibrary,
    pack: WorldPack,
    memory: MemoryStore,
    scene: SceneState,
    card: CharacterCard,
    lore: list[LoreEntry],
    session: Session,
    player_line: str,
    breach: bool = True,
) -> str:
    user_name = pack.player_name
    filled = card.substitute(user_name)
    values = {
        "character_id": filled.id,
        "character_name": filled.name,
        "player_name": user_name,
        "card": render_card(library, filled, user_name),
        "character_memory": memory.snapshot_text("character", filled.id) or memory.live_text("character", filled.id),
        "scene": scene.as_yaml(),
        "lore": render_lore(library, lore, user_name, filled.name),
        "transcript": session.haystack(8),
        "player_line": player_line,
        "world": pack.read_world(),
    }
    system = library.render("spotlight.md", values)
    extra = breach_system(library, breach)
    if extra:
        system = f"{extra}\n\n{system}"
    user = library.render("spotlight_user.md", values)
    result = llm.chat(
        with_breach_phi(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            library,
            breach,
        ),
        tools=None,
    )
    return result.text.strip()
