import type { CastMember, CharacterCard, LoreEntry, MemoryStore, SceneState, WorldPack } from "./domain";
import { ensembleActing, sceneYaml, substituteCard } from "./domain";
import type { PromptLibrary } from "./prompts";

function clipText(text: string, limit = 450): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

export function storySummary(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === "system" && item.content.trim()) return item.content.trim();
  }
  return "";
}

export function resolvePrimaryId(pack: WorldPack, scene: SceneState): string | null {
  if (pack.primary) {
    const member = pack.cast.find((item) => item.id === pack.primary || item.name === pack.primary);
    return member?.id || pack.primary;
  }
  for (const ident of scene.present) {
    const needle = ident.toLowerCase();
    const member = pack.cast.find((item) => [item.id, item.name, ...item.aliases].some((name) => name.toLowerCase() === needle));
    if (member) return member.id;
  }
  const present = pack.cast.find((item) => item.present);
  return present?.id || pack.cast[0]?.id || null;
}

function keywordHit(member: CastMember, haystack: string): boolean {
  const hay = haystack.toLowerCase();
  return [member.id, member.name, ...member.aliases].some((name) => name && hay.includes(name.toLowerCase()));
}

export function selectMiniMembers(
  pack: WorldPack,
  scene: SceneState,
  haystack: string,
  mentionIds: string[],
  primaryId: string | null,
): CastMember[] {
  const mentioned = new Set(mentionIds.map((id) => id.toLowerCase()));
  const present = new Set(
    pack.cast.filter((member) => scene.present.some((id) => [member.id, member.name, ...member.aliases].some((name) => name.toLowerCase() === id.toLowerCase()))).map((m) => m.id),
  );
  const out: CastMember[] = [];
  const seen = new Set<string>();
  for (const member of pack.cast) {
    if (primaryId && member.id === primaryId) continue;
    const hit = keywordHit(member, haystack) || mentioned.has(member.id.toLowerCase());
    if (present.has(member.id) || hit) {
      if (!seen.has(member.id)) {
        seen.add(member.id);
        out.push(member);
      }
    }
  }
  return out;
}

function renderCastIndex(pack: WorldPack, presentIds: string[]): string {
  const present = new Set(presentIds.map((id) => id.toLowerCase()));
  return pack.cast
    .map((member) => {
      const marker = present.has(member.id.toLowerCase()) || present.has(member.name.toLowerCase()) ? "present" : "absent";
      const suffix = member.blurb.trim() ? ` — ${member.blurb.trim()}` : "";
      return `- ${member.name} (${member.id}) [${marker}]${suffix}`;
    })
    .join("\n");
}

export function renderCard(library: PromptLibrary, card: CharacterCard, userName: string): string {
  const filled = substituteCard(card, userName);
  return library
    .render("layers/card.md", {
      id: filled.id,
      name: filled.name,
      age: filled.age,
      description: filled.description,
      personality: filled.personality,
      behavior: filled.behavior,
      speech: filled.speech,
      likes: filled.likes,
      dislikes: filled.dislikes,
      backstory: filled.backstory,
      scenario: filled.scenario,
      first_mes: filled.first_mes,
      mes_example: filled.mes_example,
      system_prompt: ensembleActing(filled.system_prompt, filled.name),
    })
    .trim();
}

function renderMini(library: PromptLibrary, pack: WorldPack, card: CharacterCard, userName: string): string {
  const filled = substituteCard(card, userName);
  const member = pack.cast.find((item) => item.id === filled.id);
  return library
    .render("layers/mini.md", {
      id: filled.id,
      name: filled.name,
      summary: clipText((member?.blurb || "") || filled.personality),
      behavior_notes: clipText(filled.behavior),
      relations: clipText(filled.speech),
    })
    .trim();
}

function renderLore(library: PromptLibrary, entries: LoreEntry[], userName: string, fallbackChar: string): string {
  return entries
    .map((entry) => {
      const charName = entry.char_name || fallbackChar;
      return library
        .render("layers/lore.md", {
          title: entry.comment || entry.keys.join(", ") || "lore",
          content: entry.content.replaceAll("{{user}}", userName).replaceAll("{{char}}", charName),
          source: entry.source,
        })
        .trim();
    })
    .join("\n\n");
}

export function assembleSystem(
  library: PromptLibrary,
  pack: WorldPack,
  memory: MemoryStore,
  scene: SceneState,
  presentCards: CharacterCard[],
  loreEntries: LoreEntry[],
  nmemRecall: string,
  extraSystem = "",
  miniCards: CharacterCard[] = [],
  summary = "",
): string {
  const userName = pack.player_name;
  const values: Record<string, string> = {
    world: pack.world_text,
    cast: renderCastIndex(pack, scene.present),
    player: memory.snapPlayer,
    memory: memory.snapWorld,
    scene: sceneYaml(scene),
    cards: presentCards.map((card) => renderCard(library, card, userName)).filter(Boolean).join("\n\n"),
    minis: miniCards.map((card) => renderMini(library, pack, card, userName)).filter(Boolean).join("\n\n"),
    lore: renderLore(library, loreEntries, userName, presentCards[0]?.name || miniCards[0]?.name || ""),
    nmem: nmemRecall,
    summary,
    player_name: userName,
    world_id: pack.id,
    world_name: pack.name,
  };
  const gm = library.render("gm.md", values);
  values.gm = gm;
  const parts = [extraSystem.trim(), library.render("layers/stable.md", values).trim(), library.render("layers/context.md", values).trim(), library.render("layers/volatile.md", values).trim()];
  return parts.filter(Boolean).join("\n\n");
}

export function breachSystem(library: PromptLibrary, enabled: boolean): string {
  return enabled ? library.text("layers/breach.md").trim() : "";
}

export function breachPhi(library: PromptLibrary, enabled: boolean): string {
  return enabled ? library.text("layers/breach_user.md").trim() : "";
}

export function withPhi(messages: LlmMessage[], phi: string): LlmMessage[] {
  if (!phi) return messages;
  return [...messages, { role: "system", content: phi }];
}

export type LlmMessage = {
  role: string;
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
