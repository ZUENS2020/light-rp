import {
  applySectionBudgets,
  buildContextReport,
  estimateTokens,
  fitMemorySections,
  historyTokenBudget,
  parseContextConfig,
  parseMiniConfig,
  sectionSoftCap,
  trimCardFieldMap,
  trimHistory,
  type ContextConfig,
  type ContextReport,
  type MiniSelectConfig,
  type SectionBlock,
} from "./budget";
import type { CastMember, CharacterCard, LoreEntry, MemoryStore, MiniCard, SceneState, WorldPack } from "./domain";
import { ensembleActing, sceneYaml, substituteCard } from "./domain";
import type { PromptLibrary } from "./prompts";

/** Last non-empty system message (typically compact GM summary). Rewrite/regenerate void it via invalidateSessionSummary. */
export function storySummary(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === "system" && item.content.trim()) return item.content.trim();
  }
  return "";
}

export function resolvePrimaryId(
  pack: WorldPack,
  scene: SceneState,
  sessionPrimary: string | null = null,
): string | null {
  for (const candidate of [sessionPrimary, pack.primary]) {
    if (!candidate) continue;
    const member = pack.cast.find((item) => item.id === candidate || item.name === candidate);
    return member?.id || candidate;
  }
  for (const ident of scene.present) {
    const needle = ident.toLowerCase();
    const member = pack.cast.find((item) =>
      [item.id, item.name, ...item.aliases].some((name) => name.toLowerCase() === needle),
    );
    if (member) return member.id;
  }
  const present = pack.cast.find((item) => item.present);
  return present?.id || pack.cast[0]?.id || null;
}

function keywordHit(member: CastMember, haystack: string): boolean {
  const hay = haystack.toLowerCase();
  return [member.id, member.name, ...member.aliases].some((name) => name && hay.includes(name.toLowerCase()));
}

function recentMentionIds(pack: WorldPack, recentText: string): Set<string> {
  const hay = recentText.toLowerCase();
  const hits = new Set<string>();
  for (const member of pack.cast) {
    if ([member.id, member.name, ...member.aliases].some((name) => name && hay.includes(name.toLowerCase()))) {
      hits.add(member.id);
    }
  }
  return hits;
}

export function selectMiniMembers(
  pack: WorldPack,
  scene: SceneState,
  haystack: string,
  mentionIds: string[],
  primaryId: string | null,
  miniCfg: MiniSelectConfig = parseMiniConfig(null),
  recentHaystack = "",
  userText = "",
): CastMember[] {
  const mentioned = new Set(mentionIds.map((id) => id.toLowerCase()));
  const present = new Set(
    pack.cast
      .filter((member) =>
        scene.present.some((id) =>
          [member.id, member.name, ...member.aliases].some((name) => name.toLowerCase() === id.toLowerCase()),
        ),
      )
      .map((m) => m.id),
  );
  const recent = recentMentionIds(pack, recentHaystack);
  const userIntent = recentMentionIds(pack, userText);
  const ranked: { rank: number; member: CastMember }[] = [];
  for (const member of pack.cast) {
    if (primaryId && member.id === primaryId) continue;
    const explicit = mentioned.has(member.id.toLowerCase()) || userIntent.has(member.id);
    const isPresent = present.has(member.id);
    const isRecent = recent.has(member.id);
    const keyword = keywordHit(member, haystack);
    if (!(explicit || isPresent || isRecent || keyword)) continue;
    // user_text name / @mention > present > recent > other keyword
    let rank = 3;
    if (explicit) rank = 0;
    else if (isPresent) rank = 1;
    else if (isRecent) rank = 2;
    ranked.push({ rank, member });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.member.name.localeCompare(b.member.name));
  return ranked.slice(0, Math.max(1, miniCfg.max_characters)).map((item) => item.member);
}

function renderCastIndex(pack: WorldPack, presentIds: string[]): string {
  const present = new Set(presentIds.map((id) => id.toLowerCase()));
  return pack.cast
    .map((member) => {
      const marker =
        present.has(member.id.toLowerCase()) || present.has(member.name.toLowerCase()) ? "present" : "absent";
      const suffix = member.blurb.trim() ? ` — ${member.blurb.trim()}` : "";
      return `- ${member.name} (${member.id}) [${marker}]${suffix}`;
    })
    .join("\n");
}

export function renderCard(library: PromptLibrary, card: CharacterCard, userName: string, budget?: number): string {
  const filled = substituteCard(card, userName);
  let fields: Record<string, string> = {
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
  };
  if (budget != null && budget > 0) {
    fields = trimCardFieldMap(fields, budget).fields;
  }
  return library.render("layers/card.md", fields).trim();
}

function renderMini(library: PromptLibrary, mini: MiniCard): string {
  return library
    .render("layers/mini.md", {
      id: mini.id,
      name: mini.name,
      summary: mini.summary,
      behavior_notes: mini.behavior_notes,
      relations: mini.relations,
    })
    .trim();
}

function renderLoreEntry(library: PromptLibrary, entry: LoreEntry, userName: string, fallbackChar: string): string {
  const charName = entry.char_name || fallbackChar;
  return library
    .render("layers/lore.md", {
      title: entry.comment || entry.keys.join(", ") || "lore",
      content: entry.content.replaceAll("{{user}}", userName).replaceAll("{{char}}", charName),
      source: entry.source,
    })
    .trim();
}

export function selectMinisWithinBudget(
  minis: MiniCard[],
  library: PromptLibrary,
  miniCfg: MiniSelectConfig,
): MiniCard[] {
  const kept: MiniCard[] = [];
  let used = 0;
  for (const mini of minis) {
    const cost = estimateTokens(renderMini(library, mini));
    if (kept.length && used + cost > miniCfg.max_tokens) break;
    if (!kept.length && cost > miniCfg.max_tokens) {
      kept.push(mini);
      break;
    }
    kept.push(mini);
    used += cost;
  }
  return kept;
}

export type AssembleResult = {
  system: string;
  stable_system: string;
  context_layer: string;
  volatile_layer: string;
  epoch_checkpoint: string;
  turn_context: string;
  report: ContextReport;
  history: { role: string; content: string }[];
  mini_ids: string[];
  lore_titles: string[];
};

export function relevantCharacterMemory(
  memory: MemoryStore,
  scene: SceneState,
  presentCards: CharacterCard[],
  miniCards: MiniCard[],
): { text: string; ids: string[] } {
  const ids = [
    ...new Set([...scene.present, ...presentCards.map((card) => card.id), ...miniCards.map((card) => card.id)]),
  ].filter((id) => Boolean(id) && Boolean(memory.characters[id]?.length));
  return {
    ids,
    text: ids.map((id) => `### 角色记忆：${id}\n${[...memory.characters[id]].reverse().join("\n§\n")}`).join("\n\n"),
  };
}

export function assembleBudgeted(
  library: PromptLibrary,
  pack: WorldPack,
  memory: MemoryStore,
  scene: SceneState,
  presentCards: CharacterCard[],
  loreEntries: LoreEntry[],
  historyMessages: { role: string; content: string }[],
  userInput: string,
  extraSystem = "",
  miniCards: MiniCard[] = [],
  summary = "",
  contextCfg: ContextConfig = parseContextConfig(null),
  miniCfg: MiniSelectConfig = parseMiniConfig(null),
  loreBudgetOverride: number | null = null,
  llmMaxTokens = 0,
  phiText = "",
): AssembleResult {
  const userName = pack.player_name;
  const minis = selectMinisWithinBudget(miniCards, library, miniCfg);
  const cast = renderCastIndex(pack, scene.present);
  const worldText = pack.world_text;
  const player = memory.userSetting || "";
  const perCardBudget = Math.floor((contextCfg.budget.primary_card * 0.85) / Math.max(1, presentCards.length || 1));
  const cardsText = presentCards
    .map((card) => renderCard(library, card, userName, perCardBudget))
    .filter(Boolean)
    .join("\n\n");
  const miniEntries = minis.map((mini) => renderMini(library, mini));
  const miniLabels = minis.map((mini) => mini.id);
  const fallbackChar = presentCards[0]?.name || minis[0]?.name || "";
  const loreTexts = loreEntries.map((entry) => renderLoreEntry(library, entry, userName, fallbackChar));
  const loreLabels = loreEntries.map((entry) => entry.comment || entry.keys.join(", ") || entry.source || "lore");
  const sceneText = sceneYaml(scene);
  const characterMemory = relevantCharacterMemory(memory, scene, presentCards, miniCards);
  const memWorld = [characterMemory.text, [...memory.world].reverse().join("\n§\n")]
    .filter((part) => part.trim())
    .join("\n\n");
  const memPlayer = [...memory.player].reverse().join("\n§\n");
  const fittedMemory = fitMemorySections(memWorld, memPlayer, contextCfg.budget.memory, contextCfg.memory_split);
  const memoryBlob = [fittedMemory.world, fittedMemory.player].filter((part) => part.trim()).join("\n\n");
  const memoryItems = [
    ...(fittedMemory.world.trim() ? [`world:${fittedMemory.world_tokens}`] : []),
    ...(fittedMemory.player.trim() ? [`player:${fittedMemory.player_tokens}`] : []),
    ...characterMemory.ids.map((id) => `character:${id}`),
  ];

  const valuesSeed: Record<string, string> = {
    world: worldText,
    cast,
    player,
    memory: fittedMemory.world,
    player_memory: fittedMemory.player,
    scene: sceneText,
    cards: cardsText,
    minis: miniEntries.join("\n\n"),
    lore: loreTexts.join("\n\n"),
    summary,
    player_name: userName,
    world_id: pack.id,
    world_name: pack.name,
  };
  const gm = library.render("gm.md", valuesSeed);
  const loreBudget = loreBudgetOverride != null ? loreBudgetOverride : contextCfg.budget.lore;

  const blocks: SectionBlock[] = [
    { name: "system", text: gm.trim(), budget: contextCfg.budget.system, protected: true },
    { name: "world", text: worldText, budget: contextCfg.budget.world },
    { name: "user_setting", text: player, budget: contextCfg.budget.user_setting, protected: true },
    { name: "primary_card", text: cardsText, budget: contextCfg.budget.primary_card, protected: true },
    {
      name: "mini_cards",
      text: miniEntries.join("\n\n"),
      budget: Math.min(contextCfg.budget.mini_cards, miniCfg.max_tokens),
      entries: miniEntries,
      entry_labels: miniLabels,
      items: miniLabels,
    },
    {
      name: "lore",
      text: loreTexts.join("\n\n"),
      budget: loreBudget,
      entries: loreTexts,
      entry_labels: loreLabels,
      items: loreLabels,
    },
    { name: "state", text: sceneText, budget: contextCfg.budget.state, protected: true },
    {
      name: "memory",
      text: memoryBlob,
      budget: contextCfg.budget.memory,
      items: memoryItems,
    },
    { name: "summary", text: summary, budget: contextCfg.budget.summary },
  ];

  const phiTokens = estimateTokens(phiText);
  const softCap = sectionSoftCap(contextCfg, userInput, llmMaxTokens, phiTokens, 200);
  const { texts, reports } = applySectionBudgets(blocks, softCap);
  const memText = texts.memory || "";
  let snapWorld = "";
  let snapPlayer = "";
  if (memText) {
    snapWorld = fittedMemory.world;
    snapPlayer = fittedMemory.player;
  }
  // Refresh memory report items after soft-cap may have cleared the section
  const memoryReport = reports.find((item) => item.name === "memory");
  if (memoryReport) {
    if (!memText) {
      memoryReport.items = [];
      memoryReport.tokens = 0;
    } else {
      memoryReport.items = memoryItems;
      memoryReport.truncated = memoryReport.truncated || fittedMemory.truncated_world || fittedMemory.truncated_player;
    }
  }

  const values: Record<string, string> = {
    world: texts.world || "",
    cast,
    player: texts.user_setting || "",
    memory: snapWorld,
    player_memory: snapPlayer,
    scene: texts.state || "",
    cards: texts.primary_card || "",
    minis: texts.mini_cards || "",
    lore: texts.lore || "",
    summary: texts.summary || "",
    player_name: userName,
    world_id: pack.id,
    world_name: pack.name,
    gm: texts.system || gm.trim(),
  };
  const stable = library.render("layers/stable.md", values).trim();
  const contextLayer = library.render("layers/context.md", values).trim();
  const volatile = library.render("layers/volatile.md", values).trim();
  const epochCheckpoint = library.render("layers/volatile.md", values).trim();
  const turnContext = contextLayer;
  const system = [extraSystem.trim(), stable, contextLayer, volatile].filter(Boolean).join("\n\n");

  const sectionTokens = reports.reduce((sum, item) => sum + item.tokens, 0);
  const histBudget = historyTokenBudget(
    contextCfg,
    sectionTokens + estimateTokens(extraSystem),
    userInput,
    llmMaxTokens,
    phiTokens,
  );
  const trimmed = trimHistory(historyMessages, histBudget, contextCfg.history.protect_recent_turns);
  const report = buildContextReport(contextCfg, reports, trimmed.messages, trimmed.truncated, userInput, {
    llmMaxTokens,
    phiText,
    extraSystem,
  });
  const miniReport = reports.find((item) => item.name === "mini_cards");
  const loreReport = reports.find((item) => item.name === "lore");
  return {
    system,
    stable_system: [extraSystem.trim(), stable].filter(Boolean).join("\n\n"),
    context_layer: contextLayer,
    volatile_layer: volatile,
    epoch_checkpoint: epochCheckpoint,
    turn_context: turnContext,
    report,
    history: trimmed.messages,
    mini_ids: miniReport?.items || [],
    lore_titles: loreReport?.items || [],
  };
}

export function assembleSystem(
  library: PromptLibrary,
  pack: WorldPack,
  memory: MemoryStore,
  scene: SceneState,
  presentCards: CharacterCard[],
  loreEntries: LoreEntry[],
  extraSystem = "",
  miniCards: MiniCard[] = [],
  summary = "",
  contextCfg?: ContextConfig,
  miniCfg?: MiniSelectConfig,
): string {
  return assembleBudgeted(
    library,
    pack,
    memory,
    scene,
    presentCards,
    loreEntries,
    [],
    "",
    extraSystem,
    miniCards,
    summary,
    contextCfg || parseContextConfig(null),
    miniCfg || parseMiniConfig(null),
  ).system;
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
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
