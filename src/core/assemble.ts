import {
  applySectionBudgets,
  buildContextReport,
  estimateTokens,
  fitMemorySections,
  historyTokenBudget,
  leanTailTokenBudget,
  parseContextConfig,
  parseMiniConfig,
  sectionSoftCap,
  trimCardFieldMap,
  trimHistory,
  truncateToTokens,
  type ContextConfig,
  type ContextReport,
  type MiniSelectConfig,
  type SectionBlock,
} from "./budget";
import type { CastMember, CharacterCard, LoreEntry, MemoryStore, MiniCard, SceneState, WorldPack } from "./domain";
import { ensembleActing, sceneYaml, substituteCard } from "./domain";
import type { PromptLibrary } from "./prompts";

/** Prefer marked compact GM summary; else last non-empty system. Rewrite/regenerate voids it via invalidateSessionSummary. */
export function storySummary(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (item.role === "system" && item.content.trim().startsWith("【压缩摘要")) return item.content.trim();
  }
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

/**
 * Static cast roster for the stable prefix: every cast member with id, aliases and blurb so
 * the model can tell NPCs apart by name even when they have no card/mini in the window.
 * Presence lives in the per-turn scene state (`present`).
 */
export function renderCastRoster(pack: WorldPack): string {
  return pack.cast
    .map((member) => {
      const aliases = member.aliases.filter((alias) => alias && alias !== member.name && alias !== member.id);
      const alias = aliases.length ? `；别名：${aliases.join("、")}` : "";
      const blurb = member.blurb.trim() ? ` — ${member.blurb.trim()}` : "";
      return `- ${member.name}（id: ${member.id}${alias}）${blurb}`;
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

function renderMini(library: PromptLibrary, mini: MiniCard, userName = ""): string {
  // Auto-generated minis copy the card's scenario verbatim, including {{user}}/{{char}}.
  // Left raw in an ensemble prompt, {{char}} reads as "the main character" and blurs NPCs.
  const sub = (text: string) =>
    (text || "").replaceAll("{{char}}", mini.name).replaceAll("{{user}}", userName || "{{user}}");
  return library
    .render("layers/mini.md", {
      id: mini.id,
      name: mini.name,
      summary: sub(mini.summary),
      behavior_notes: sub(mini.behavior_notes),
      relations: sub(mini.relations),
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
  userName = "",
): MiniCard[] {
  const kept: MiniCard[] = [];
  let used = 0;
  for (const mini of minis) {
    const cost = estimateTokens(renderMini(library, mini, userName));
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
  /**
   * Per-epoch deduplicated hidden context (prepared/epoch path): one part per mini card and
   * per lore entry. preparePrompt appends each once per epoch (content-hash dedupe) instead of
   * re-sending the whole context layer every turn.
   */
  turn_context_parts: PromptPart[];
  /** Character memory for present/primary/mini cast, one part per character (memory events). */
  character_memory_parts: PromptPart[];
  report: ContextReport;
  history: { role: string; content: string }[];
  mini_ids: string[];
  lore_titles: string[];
};

export type PromptPart = { key: string; content: string };

/** Newest-first whole entries within a token budget (first entry truncated if it alone overflows). */
function fitEntriesNewestFirst(entries: string[], budget: number): { text: string; truncated: boolean } {
  const newest = [...entries].reverse();
  const kept: string[] = [];
  let used = 0;
  for (const entry of newest) {
    const cost = estimateTokens(entry) + 2;
    if (used + cost > budget) {
      if (!kept.length && budget > 0) kept.push(truncateToTokens(entry, budget).text);
      return { text: kept.join("\n§\n"), truncated: true };
    }
    kept.push(entry);
    used += cost;
  }
  return { text: kept.join("\n§\n"), truncated: false };
}

export type FittedMemory = {
  world: string;
  player: string;
  character_blocks: { id: string; text: string }[];
  tokens: number;
  truncated: boolean;
  items: string[];
};

/** Share of the memory budget reserved for relevant characters' own memory. */
export const CHARACTER_MEMORY_SHARE = 0.4;

/**
 * Fit world / player / per-character memory into one budget. Each relevant character gets an
 * equal slice of CHARACTER_MEMORY_SHARE (newest entries first, labelled by character) so one
 * talkative character cannot starve the others or the world facts.
 */
export function fitMemoryBudget(
  memory: MemoryStore,
  characterIds: string[],
  budget: number,
  split: ContextConfig["memory_split"],
  labels: Record<string, string> = {},
): FittedMemory {
  const total = Math.max(0, Math.floor(budget));
  const ids = characterIds.filter((id) => memory.characters[id]?.length);
  const charBudget = ids.length ? Math.floor(total * CHARACTER_MEMORY_SHARE) : 0;
  const perChar = ids.length ? Math.floor(charBudget / ids.length) : 0;
  let charUsed = 0;
  let truncated = false;
  const character_blocks: { id: string; text: string }[] = [];
  for (const id of ids) {
    const label = labels[id] && labels[id] !== id ? `${labels[id]}（${id}）` : id;
    const header = `### 角色记忆：${label}（只属于该角色，不要套到其他角色身上）`;
    const fitted = fitEntriesNewestFirst(memory.characters[id] || [], Math.max(0, perChar - estimateTokens(header)));
    truncated = truncated || fitted.truncated;
    if (!fitted.text.trim()) continue;
    const text = `${header}\n${fitted.text}`;
    charUsed += estimateTokens(text);
    character_blocks.push({ id, text });
  }
  const rest = Math.max(0, total - charUsed);
  const fitted = fitMemorySections(
    [...memory.world].reverse().join("\n§\n"),
    [...memory.player].reverse().join("\n§\n"),
    rest,
    split,
  );
  truncated = truncated || fitted.truncated_world || fitted.truncated_player;
  return {
    world: fitted.world,
    player: fitted.player,
    character_blocks,
    tokens: charUsed + fitted.world_tokens + fitted.player_tokens,
    truncated,
    items: [
      ...(fitted.world.trim() ? [`world:${fitted.world_tokens}`] : []),
      ...(fitted.player.trim() ? [`player:${fitted.player_tokens}`] : []),
      ...character_blocks.map((block) => `character:${block.id}`),
    ],
  };
}

/** Floors used when the soft cap squeezes sections (tokens). */
export const SECTION_FLOORS = { memory: 1_200, mini_cards: 800, summary: 800 } as const;

const CARD_MEMORY_NOTE = "角色卡是性格与口吻的正典；以下只记录该角色经历的事件、事实、关系与约定。";

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
  const minis = selectMinisWithinBudget(miniCards, library, miniCfg, userName);
  const cast = renderCastRoster(pack);
  const worldText = pack.world_text;
  const player = memory.userSetting || "";
  const perCardBudget = Math.floor((contextCfg.budget.primary_card * 0.85) / Math.max(1, presentCards.length || 1));
  const cardsText = presentCards
    .map((card) => renderCard(library, card, userName, perCardBudget))
    .filter(Boolean)
    .join("\n\n");
  const miniEntries = minis.map((mini) => renderMini(library, mini, userName));
  const miniLabels = minis.map((mini) => mini.id);
  const fallbackChar = presentCards[0]?.name || minis[0]?.name || "";
  const loreTexts = loreEntries.map((entry) => renderLoreEntry(library, entry, userName, fallbackChar));
  const loreLabels = loreEntries.map((entry) => entry.comment || entry.keys.join(", ") || entry.source || "lore");
  const sceneText = sceneYaml(scene);
  const characterMemory = relevantCharacterMemory(memory, scene, presentCards, miniCards);
  const joinMemory = (fit: FittedMemory) =>
    [...fit.character_blocks.map((block) => block.text), fit.world, fit.player]
      .filter((part) => part.trim())
      .join("\n\n");
  const memoryLabels = Object.fromEntries(pack.cast.map((member) => [member.id, member.name]));
  let fittedMemory = fitMemoryBudget(
    memory,
    characterMemory.ids,
    contextCfg.budget.memory,
    contextCfg.memory_split,
    memoryLabels,
  );
  const memoryBlob = joinMemory(fittedMemory);

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
    { name: "cast", text: cast, budget: Math.max(600, Math.floor(contextCfg.budget.world / 2)), protected: true },
    { name: "user_setting", text: player, budget: contextCfg.budget.user_setting, protected: true },
    { name: "primary_card", text: cardsText, budget: contextCfg.budget.primary_card, protected: true },
    {
      name: "mini_cards",
      text: miniEntries.join("\n\n"),
      budget: Math.min(contextCfg.budget.mini_cards, miniCfg.max_tokens),
      floor: Math.min(SECTION_FLOORS.mini_cards, contextCfg.budget.mini_cards),
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
      // Already fitted by fitMemoryBudget; the generic cut must not re-truncate mid-entry.
      budget: Math.max(contextCfg.budget.memory, estimateTokens(memoryBlob)),
      floor: Math.min(SECTION_FLOORS.memory, contextCfg.budget.memory),
      items: fittedMemory.items,
    },
    {
      name: "summary",
      text: summary,
      budget: contextCfg.budget.summary,
      floor: Math.min(SECTION_FLOORS.summary, contextCfg.budget.summary),
    },
  ];

  const phiTokens = estimateTokens(phiText);
  const softCap = sectionSoftCap(contextCfg, userInput, llmMaxTokens, phiTokens, 200);
  const { texts, reports } = applySectionBudgets(blocks, softCap);
  // Soft cap may have shrunk memory: refit on whole entries at the reduced size.
  const memoryReport = reports.find((item) => item.name === "memory");
  const memTokensAfterCap = estimateTokens(texts.memory || "");
  if (memTokensAfterCap < estimateTokens(memoryBlob)) {
    fittedMemory = fitMemoryBudget(
      memory,
      characterMemory.ids,
      memTokensAfterCap,
      contextCfg.memory_split,
      memoryLabels,
    );
  }
  if (memoryReport) {
    memoryReport.budget = contextCfg.budget.memory;
    memoryReport.tokens = memTokensAfterCap > 0 ? fittedMemory.tokens : 0;
    memoryReport.items = memTokensAfterCap > 0 ? fittedMemory.items : [];
    memoryReport.truncated = memoryReport.truncated || fittedMemory.truncated;
  }
  const memoryWithCharacters = [...fittedMemory.character_blocks.map((block) => block.text), fittedMemory.world]
    .filter((part) => part.trim())
    .join("\n\n");

  const values: Record<string, string> = {
    world: texts.world || "",
    cast,
    player: texts.user_setting || "",
    memory: memoryWithCharacters,
    player_memory: fittedMemory.player,
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
  // Epoch checkpoint: world/player memory + summary. Character memory rides as per-character
  // memory events (appended once per epoch when that character becomes relevant), so a
  // character entering mid-epoch still gets their memory instead of the frozen start set.
  const epochCheckpoint = library.render("layers/volatile.md", { ...values, memory: fittedMemory.world }).trim();
  // Epoch path: only the scene state is re-sent each turn; minis/lore are deduped parts.
  const turnContext = library
    .render("layers/context.md", { ...values, minis: "", lore: "" })
    .replace(/\n## Mini 卡\s*(?=\n## |$)/, "\n")
    .replace(/\n## 本轮触发的世界书\s*$/, "")
    .trim();
  const keptMinis = new Set((reports.find((item) => item.name === "mini_cards")?.items || []).map(String));
  const turnContextParts: PromptPart[] = [
    ...minis
      .map((mini, index) => ({ mini, text: miniEntries[index] }))
      .filter(({ mini }) => keptMinis.has(mini.id))
      .map(({ mini, text }) => ({ key: `mini:${mini.id}`, content: `## Mini 卡（在场/相关角色）\n${text}` })),
    ...(() => {
      const keptLore = texts.lore ? (reports.find((item) => item.name === "lore")?.items || []).length : 0;
      return loreTexts.slice(0, keptLore).map((text, index) => ({
        key: `lore:${loreLabels[index] || index}`,
        content: `## 世界书\n${keptLore === 1 ? texts.lore : text}`,
      }));
    })(),
  ];
  const characterMemoryParts: PromptPart[] = fittedMemory.character_blocks.map((block) => ({
    key: `charmem:${block.id}`,
    content: `## 角色记忆\n${CARD_MEMORY_NOTE}\n${block.text}`,
  }));
  const system = [extraSystem.trim(), stable, contextLayer, volatile].filter(Boolean).join("\n\n");

  const sectionTokens = reports.reduce((sum, item) => sum + item.tokens, 0);
  const histBudget = historyTokenBudget(
    contextCfg,
    sectionTokens + estimateTokens(extraSystem),
    userInput,
    llmMaxTokens,
    phiTokens,
  );
  const leanProtectCap = leanTailTokenBudget(contextCfg.max_tokens);
  const trimmed = trimHistory(historyMessages, histBudget, contextCfg.history.protect_recent_turns, leanProtectCap);
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
    turn_context_parts: turnContextParts,
    character_memory_parts: characterMemoryParts,
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
