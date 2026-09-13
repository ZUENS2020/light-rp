export type SectionBudget = {
  system: number;
  world: number;
  user_setting: number;
  primary_card: number;
  mini_cards: number;
  lore: number;
  state: number;
  memory: number;
  summary: number;
};

export type HistoryBudget = {
  use_remaining: boolean;
  protect_recent_turns: number;
};

export type MemorySplitConfig = {
  world: number;
  player: number;
};

export type ContextConfig = {
  max_tokens: number;
  generation_reserve: number;
  tool_reserve: number;
  budget: SectionBudget;
  memory_split: MemorySplitConfig;
  history: HistoryBudget;
};

export type MiniSelectConfig = {
  max_tokens: number;
  recent_turns: number;
  max_characters: number;
};

export type SectionReport = {
  name: string;
  tokens: number;
  budget: number;
  truncated: boolean;
  protected?: boolean;
  items: string[];
};

export type ContextReport = {
  max_tokens: number;
  generation_reserve: number;
  tool_reserve: number;
  total: number;
  estimated: boolean;
  sections: SectionReport[];
  history: { tokens: number; messages: number; truncated: boolean };
  input: { tokens: number };
  phi_tokens: number;
  extra_system_tokens: number;
};

export type SectionBlock = {
  name: string;
  text: string;
  budget: number;
  protected?: boolean;
  items?: string[];
  entries?: string[];
  entry_labels?: string[];
};

/** Pre-GLM 32k-era section caps; used to detect stale R2 settings.json. */
export const LEGACY_SECTION_BUDGET: SectionBudget = {
  system: 1500,
  world: 2500,
  user_setting: 1500,
  primary_card: 4000,
  mini_cards: 1200,
  lore: 3000,
  state: 800,
  memory: 2500,
  summary: 2500,
};

/**
 * Working prompt window for GLM-class models.
 * Prefer 64k over the full ~1.3M provider window: larger prompts are
 * slow/expensive for RP turns, while 64k (2× the old 32k default) still gives lore,
 * memory, mini cards, summary, and history meaningful headroom — and forces
 * section+history trim hard enough that live story prompts stay lean.
 */
export const WORKING_CONTEXT_CAP = 65_536;
export const LEGACY_DEFAULT_CONTEXT_MAX_TOKENS = 32_768;
export const LEGACY_MINI_MAX_TOKENS = 1_200;

/** Hermes-style lean tail: keep a small recent transcript tip for the live LLM window. */
export const LEAN_TAIL_FLOOR_TOKENS = 10_000;
export const LEAN_TAIL_CAP_TOKENS = 25_000;
export const LEAN_TAIL_FRACTION = 0.025;
export const LEAN_MIN_TAIL_MESSAGES = 2;

/** clamp(floor, cap, floor(contextWindow * 0.025)) — Hermes lean tail token budget. */
export function leanTailTokenBudget(contextWindow: number): number {
  const window = Math.max(0, Math.floor(Number(contextWindow) || 0));
  const raw = Math.floor(window * LEAN_TAIL_FRACTION);
  return Math.min(LEAN_TAIL_CAP_TOKENS, Math.max(LEAN_TAIL_FLOOR_TOKENS, raw));
}

/** Scaled ~2× from the 32k-era caps so section room tracks WORKING_CONTEXT_CAP (64k). */
export const DEFAULT_SECTION_BUDGET: SectionBudget = {
  system: 3_000,
  world: 5_000,
  user_setting: 3_000,
  primary_card: 8_000,
  mini_cards: 2_400,
  lore: 6_000,
  state: 1_600,
  memory: 5_000,
  summary: 5_000,
};

export const DEFAULT_MEMORY_SPLIT: MemorySplitConfig = {
  world: 0.6,
  player: 0.4,
};

export const DEFAULT_CONTEXT: ContextConfig = {
  max_tokens: WORKING_CONTEXT_CAP,
  // Runtime raises this to max(reserve, story output floor / llm max_tokens).
  generation_reserve: 4096,
  tool_reserve: 1500,
  budget: { ...DEFAULT_SECTION_BUDGET },
  memory_split: { ...DEFAULT_MEMORY_SPLIT },
  history: { use_remaining: true, protect_recent_turns: 6 },
};

export const DEFAULT_MINI: MiniSelectConfig = {
  max_tokens: 2_400,
  recent_turns: 4,
  max_characters: 6,
};

export function isLegacySectionBudget(budget: SectionBudget): boolean {
  return (Object.keys(LEGACY_SECTION_BUDGET) as (keyof SectionBudget)[]).every(
    (key) => Number(budget[key]) === LEGACY_SECTION_BUDGET[key],
  );
}

export const TRIM_ORDER = ["lore", "memory", "mini_cards", "summary", "world"] as const;
export const CARD_DROP_FIRST = ["mes_example", "first_mes", "backstory", "likes", "dislikes", "age"] as const;
export const CARD_SECONDARY = ["description", "scenario"] as const;

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let asciiRun = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1;
    else if (/[A-Za-z0-9\s]/.test(ch)) asciiRun += 1;
    else other += 1;
  }
  const raw = cjk + Math.ceil(asciiRun / 4) + other;
  return Math.max(1, Math.ceil(raw * 1.1));
}

export function truncateToTokens(text: string, tokens: number): { text: string; truncated: boolean } {
  if (tokens <= 0) return { text: "", truncated: Boolean(text) };
  if (estimateTokens(text) <= tokens) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  let best = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = text.slice(0, mid) + (mid < text.length ? "…" : "");
    if (estimateTokens(candidate) <= tokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { text: best || "…", truncated: true };
}

export function effectiveGenerationReserve(cfg: ContextConfig, llmMaxTokens = 0): number {
  return Math.max(cfg.generation_reserve, llmMaxTokens || 0);
}

export function parseMemorySplit(raw: Partial<MemorySplitConfig> | null | undefined): MemorySplitConfig {
  const data = raw || {};
  const world = Number(data.world);
  const player = Number(data.player);
  if (!Number.isFinite(world) || !Number.isFinite(player) || world <= 0 || player <= 0) {
    return { ...DEFAULT_MEMORY_SPLIT };
  }
  const sum = world + player;
  return { world: world / sum, player: player / sum };
}

export function splitMemoryBudget(total: number, split: MemorySplitConfig): { world: number; player: number } {
  const normalized = parseMemorySplit(split);
  const world = Math.max(0, Math.floor(Math.max(0, total) * normalized.world));
  return { world, player: Math.max(0, Math.max(0, total) - world) };
}

export function fitMemorySections(
  worldText: string,
  playerText: string,
  totalBudget: number,
  split: MemorySplitConfig = DEFAULT_MEMORY_SPLIT,
): {
  world: string;
  player: string;
  world_tokens: number;
  player_tokens: number;
  truncated_world: boolean;
  truncated_player: boolean;
} {
  const caps = splitMemoryBudget(totalBudget, split);
  let worldCut = truncateToTokens(worldText || "", caps.world);
  let playerCut = truncateToTokens(playerText || "", caps.player);
  let worldTokens = estimateTokens(worldCut.text);
  let playerTokens = estimateTokens(playerCut.text);

  const worldUnused = Math.max(0, caps.world - worldTokens);
  const playerUnused = Math.max(0, caps.player - playerTokens);

  if (worldUnused > 0 && estimateTokens(playerText || "") > playerTokens) {
    playerCut = truncateToTokens(playerText || "", caps.player + worldUnused);
    playerTokens = estimateTokens(playerCut.text);
  } else if (playerUnused > 0 && estimateTokens(worldText || "") > worldTokens) {
    worldCut = truncateToTokens(worldText || "", caps.world + playerUnused);
    worldTokens = estimateTokens(worldCut.text);
  }

  // Safety: never exceed total memory budget
  if (worldTokens + playerTokens > totalBudget) {
    const remainForPlayer = Math.max(0, totalBudget - worldTokens);
    if (playerTokens > remainForPlayer) {
      playerCut = truncateToTokens(playerCut.text, remainForPlayer);
      playerTokens = estimateTokens(playerCut.text);
    }
    if (worldTokens + playerTokens > totalBudget) {
      const remainForWorld = Math.max(0, totalBudget - playerTokens);
      worldCut = truncateToTokens(worldCut.text, remainForWorld);
      worldTokens = estimateTokens(worldCut.text);
    }
  }

  return {
    world: worldCut.text,
    player: playerCut.text,
    world_tokens: worldTokens,
    player_tokens: playerTokens,
    truncated_world: worldCut.truncated || estimateTokens(worldText || "") > worldTokens,
    truncated_player: playerCut.truncated || estimateTokens(playerText || "") > playerTokens,
  };
}

export function parseContextConfig(raw: Partial<ContextConfig> | null | undefined): ContextConfig {
  const data = raw || {};
  const mergedBudget = { ...DEFAULT_SECTION_BUDGET, ...(data.budget || {}) } as SectionBudget & { nmem?: number };
  const { nmem: _legacyNmem, ...budgetRest } = mergedBudget;
  const budget: SectionBudget = { ...DEFAULT_SECTION_BUDGET, ...budgetRest };
  const history = { ...DEFAULT_CONTEXT.history, ...(data.history || {}) };
  return {
    max_tokens: Number(data.max_tokens ?? DEFAULT_CONTEXT.max_tokens),
    generation_reserve: Number(data.generation_reserve ?? DEFAULT_CONTEXT.generation_reserve),
    tool_reserve: Number(data.tool_reserve ?? DEFAULT_CONTEXT.tool_reserve),
    budget,
    memory_split: parseMemorySplit(data.memory_split),
    history,
  };
}

export function parseMiniConfig(raw: Partial<MiniSelectConfig> | null | undefined): MiniSelectConfig {
  const data = raw || {};
  return {
    max_tokens: Number(data.max_tokens ?? DEFAULT_MINI.max_tokens),
    recent_turns: Number(data.recent_turns ?? DEFAULT_MINI.recent_turns),
    max_characters: Number(data.max_characters ?? DEFAULT_MINI.max_characters),
  };
}

function fitEntries(
  entries: string[],
  labels: string[],
  budget: number,
): { text: string; items: string[]; truncated: boolean } {
  if (!entries.length) return { text: "", items: [], truncated: false };
  const kept: string[] = [];
  const keptLabels: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const cost = estimateTokens(entry);
    if (kept.length && used + cost > budget) {
      truncated = true;
      break;
    }
    if (!kept.length && cost > budget) {
      const cut = truncateToTokens(entry, budget);
      return { text: cut.text, items: [labels[i] || `item-${i}`], truncated: true };
    }
    kept.push(entry);
    keptLabels.push(labels[i] || `item-${i}`);
    used += cost;
  }
  return { text: kept.join("\n\n"), items: keptLabels, truncated };
}

export function applySectionBudgets(
  blocks: SectionBlock[],
  softCap: number | null = null,
): { texts: Record<string, string>; reports: SectionReport[] } {
  const texts: Record<string, string> = {};
  const reports: SectionReport[] = [];
  const blockMap = new Map(blocks.map((b) => [b.name, b]));

  for (const block of blocks) {
    let text = block.text;
    let items = [...(block.items || [])];
    let truncated = false;
    if (block.entries?.length) {
      const fitted = fitEntries(block.entries, block.entry_labels || block.items || [], block.budget);
      text = fitted.text;
      items = fitted.items;
      truncated = fitted.truncated;
    } else if (estimateTokens(text) > block.budget) {
      const cut = truncateToTokens(text, block.budget);
      text = cut.text;
      truncated = cut.truncated;
    }
    texts[block.name] = text;
    reports.push({
      name: block.name,
      tokens: estimateTokens(text),
      budget: block.budget,
      truncated,
      protected: Boolean(block.protected),
      items,
    });
  }

  if (softCap != null) {
    const reportMap = new Map(reports.map((r) => [r.name, r]));
    let total = Object.values(texts).reduce((sum, t) => sum + estimateTokens(t), 0);
    for (const name of TRIM_ORDER) {
      if (total <= softCap) break;
      const block = blockMap.get(name);
      if (block?.protected) continue;
      if (!texts[name]) continue;
      const cost = estimateTokens(texts[name]);
      texts[name] = "";
      total -= cost;
      const report = reportMap.get(name);
      if (report) {
        report.tokens = 0;
        report.truncated = true;
        report.items = [];
      }
    }
  }

  return { texts, reports };
}

function histBlob(messages: { role?: string; content?: string | null }[]): string {
  return messages.map((m) => `${m.role || ""}: ${m.content || ""}`).join("\n");
}

function recentUa<T extends { role?: string }>(messages: T[], n: number): T[] {
  if (n <= 0) return [];
  return messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-n);
}

/**
 * Recent UA messages protected from drop, but never more tokens than protectTokenCap
 * (Hermes lean: protect_recent_turns cannot force a 40k+ tip).
 */
export function protectedRecentMessages<T extends { role?: string; content?: string | null }>(
  messages: T[],
  protectRecent: number,
  protectTokenCap: number,
): T[] {
  const candidates = recentUa(messages, Math.max(0, protectRecent));
  if (!candidates.length) return [];
  const cap = Math.max(0, Math.floor(protectTokenCap));
  if (cap <= 0) return candidates.slice(-LEAN_MIN_TAIL_MESSAGES);
  const selected: T[] = [];
  let used = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const msg = candidates[i]!;
    const cost = estimateTokens(`${msg.role || ""}: ${msg.content || ""}`);
    if (selected.length >= LEAN_MIN_TAIL_MESSAGES && used + cost > cap) break;
    selected.push(msg);
    used += cost;
    // Always attempt at least LEAN_MIN_TAIL_MESSAGES even if slightly over cap.
    if (selected.length >= LEAN_MIN_TAIL_MESSAGES && used >= cap) break;
  }
  return selected.reverse();
}

export function trimHistory<T extends { role?: string; content?: string | null }>(
  messages: T[],
  tokenBudget: number,
  protectRecent: number,
  protectTokenCap: number = LEAN_TAIL_CAP_TOKENS,
): { messages: T[]; truncated: boolean } {
  const protectedMsgs = protectedRecentMessages(messages, protectRecent, protectTokenCap);
  if (tokenBudget <= 0) {
    return { messages: protectedMsgs, truncated: protectedMsgs.length < messages.length };
  }
  const selected: T[] = [];
  let used = 0;
  let truncated = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const cost = estimateTokens(`${msg.role || ""}: ${msg.content || ""}`);
    if (selected.length && used + cost > tokenBudget) {
      truncated = true;
      break;
    }
    selected.push(msg);
    used += cost;
  }
  selected.reverse();
  const ids = new Set(selected.map((m) => m));
  for (const msg of protectedMsgs) {
    if (!ids.has(msg)) {
      selected.push(msg);
      truncated = true;
    }
  }
  const order = new Map(messages.map((m, i) => [m, i]));
  selected.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const prot = new Set(protectedMsgs);
  while (selected.length && estimateTokens(histBlob(selected)) > tokenBudget) {
    const dropIdx = selected.findIndex((m) => !prot.has(m));
    if (dropIdx < 0) break;
    selected.splice(dropIdx, 1);
    truncated = true;
  }
  // Final safety: if protected alone still exceeds hist budget, keep lean tip only.
  if (selected.length && estimateTokens(histBlob(selected)) > tokenBudget) {
    const leanOnly = protectedRecentMessages(messages, protectRecent, Math.min(protectTokenCap, tokenBudget));
    return { messages: leanOnly, truncated: true };
  }
  return { messages: selected, truncated: truncated || selected.length < messages.length };
}

export function historyTokenBudget(
  cfg: ContextConfig,
  sectionTokens: number,
  userInput: string,
  llmMaxTokens = 0,
  phiTokens = 0,
): number {
  const gen = effectiveGenerationReserve(cfg, llmMaxTokens);
  const tool = Math.max(cfg.tool_reserve, phiTokens);
  return Math.max(0, cfg.max_tokens - gen - tool - sectionTokens - estimateTokens(userInput));
}

export function sectionSoftCap(
  cfg: ContextConfig,
  userInput: string,
  llmMaxTokens = 0,
  phiTokens = 0,
  minHistoryTokens = 0,
): number {
  const gen = effectiveGenerationReserve(cfg, llmMaxTokens);
  const tool = Math.max(cfg.tool_reserve, phiTokens);
  return Math.max(0, cfg.max_tokens - gen - tool - estimateTokens(userInput) - Math.max(0, minHistoryTokens));
}

export function buildContextReport(
  cfg: ContextConfig,
  sectionReports: SectionReport[],
  historyMessages: { role?: string; content?: string | null }[],
  historyTruncated: boolean,
  userInput: string,
  opts: { llmMaxTokens?: number; phiText?: string; extraSystem?: string } = {},
): ContextReport {
  const gen = effectiveGenerationReserve(cfg, opts.llmMaxTokens || 0);
  const phiTokens = estimateTokens(opts.phiText || "");
  const extraTokens = estimateTokens(opts.extraSystem || "");
  const tool = Math.max(cfg.tool_reserve, phiTokens);
  const sectionTotal = sectionReports.reduce((sum, item) => sum + item.tokens, 0);
  const historyTokens = estimateTokens(histBlob(historyMessages));
  const inputTokens = estimateTokens(userInput);
  return {
    max_tokens: cfg.max_tokens,
    generation_reserve: gen,
    tool_reserve: tool,
    total: sectionTotal + historyTokens + inputTokens + phiTokens + extraTokens,
    estimated: true,
    sections: sectionReports,
    history: { tokens: historyTokens, messages: historyMessages.length, truncated: historyTruncated },
    input: { tokens: inputTokens },
    phi_tokens: phiTokens,
    extra_system_tokens: extraTokens,
  };
}

export function normalizeMemoryText(text: string): string {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()[\]{}]/g, "");
}

export function memoryIsDuplicate(newText: string, existing: string[], threshold = 0.85): boolean {
  const needle = normalizeMemoryText(newText);
  if (!needle) return true;
  for (const item of existing) {
    const hay = normalizeMemoryText(item);
    if (!hay) continue;
    if (needle.includes(hay) || hay.includes(needle)) return true;
    const shared = [...new Set(needle)].filter((ch) => hay.includes(ch)).length;
    const ratio = shared / Math.max(new Set(needle).size, 1);
    if (ratio >= threshold && Math.abs(needle.length - hay.length) <= Math.max(8, Math.floor(needle.length / 3))) {
      return true;
    }
  }
  return false;
}

export function routeMemoryCandidate(importance: number): "long" | "event" | "drop" {
  if (importance >= 0.7) return "long";
  if (importance >= 0.4) return "event";
  return "drop";
}

export function trimCardFieldMap(
  fields: Record<string, string>,
  budget: number,
): { fields: Record<string, string>; truncated: boolean } {
  const current = { ...fields };
  let truncated = false;
  const cost = (data: Record<string, string>) =>
    estimateTokens(
      Object.entries(data)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}:${v}`)
        .join("\n"),
    );
  for (const key of CARD_DROP_FIRST) {
    if (cost(current) <= budget) break;
    if (current[key]) {
      current[key] = "";
      truncated = true;
    }
  }
  for (const key of CARD_SECONDARY) {
    if (cost(current) <= budget) break;
    if (current[key]) {
      const cut = truncateToTokens(current[key], Math.max(40, Math.floor(budget / 8)));
      if (cut.text !== current[key]) truncated = true;
      current[key] = cut.text;
    }
  }
  if (cost(current) > budget) {
    for (const key of ["system_prompt", "personality", "behavior", "speech"]) {
      if (cost(current) <= budget) break;
      if (current[key]) {
        const cut = truncateToTokens(current[key], Math.max(80, Math.floor(budget / 4)));
        current[key] = cut.text;
        truncated = truncated || cut.truncated;
      }
    }
  }
  return { fields: current, truncated };
}
