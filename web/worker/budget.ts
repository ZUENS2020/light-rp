export type SectionBudget = {
  system: number;
  world: number;
  user_setting: number;
  primary_card: number;
  mini_cards: number;
  lore: number;
  state: number;
  memory: number;
  nmem: number;
  summary: number;
};

export type HistoryBudget = {
  use_remaining: boolean;
  protect_recent_turns: number;
};

export type ContextConfig = {
  max_tokens: number;
  generation_reserve: number;
  budget: SectionBudget;
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
  items: string[];
};

export type ContextReport = {
  max_tokens: number;
  generation_reserve: number;
  total: number;
  sections: SectionReport[];
  history: { tokens: number; messages: number; truncated: boolean };
  input: { tokens: number };
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

export const DEFAULT_SECTION_BUDGET: SectionBudget = {
  system: 1500,
  world: 2500,
  user_setting: 1500,
  primary_card: 4000,
  mini_cards: 1200,
  lore: 3000,
  state: 800,
  memory: 2500,
  nmem: 2500,
  summary: 2500,
};

export const DEFAULT_CONTEXT: ContextConfig = {
  max_tokens: 32768,
  generation_reserve: 4096,
  budget: { ...DEFAULT_SECTION_BUDGET },
  history: { use_remaining: true, protect_recent_turns: 6 },
};

export const DEFAULT_MINI: MiniSelectConfig = {
  max_tokens: 1200,
  recent_turns: 4,
  max_characters: 6,
};

export const TRIM_ORDER = ["lore", "memory", "mini_cards", "summary", "nmem", "world"] as const;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

export function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens) * 3);
}

export function truncateToTokens(text: string, tokens: number): { text: string; truncated: boolean } {
  if (tokens <= 0) return { text: "", truncated: Boolean(text) };
  const limit = charsForTokens(tokens);
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

export function parseContextConfig(raw: Partial<ContextConfig> | null | undefined): ContextConfig {
  const data = raw || {};
  const budget = { ...DEFAULT_SECTION_BUDGET, ...(data.budget || {}) };
  const history = { ...DEFAULT_CONTEXT.history, ...(data.history || {}) };
  return {
    max_tokens: Number(data.max_tokens ?? DEFAULT_CONTEXT.max_tokens),
    generation_reserve: Number(data.generation_reserve ?? DEFAULT_CONTEXT.generation_reserve),
    budget,
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

function fitEntries(entries: string[], labels: string[], budget: number): { text: string; items: string[]; truncated: boolean } {
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

export function applySectionBudgets(blocks: SectionBlock[]): { texts: Record<string, string>; reports: SectionReport[] } {
  const texts: Record<string, string> = {};
  const reports: SectionReport[] = [];
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
      items,
    });
  }
  return { texts, reports };
}

function histBlob(messages: { role?: string; content?: string | null }[]): string {
  return messages.map((m) => `${m.role || ""}: ${m.content || ""}`).join("\n");
}

function recentUa<T extends { role?: string }>(messages: T[], n: number): T[] {
  if (n <= 0) return [];
  const ua = messages.filter((m) => m.role === "user" || m.role === "assistant");
  return ua.slice(-n);
}

export function trimHistory<T extends { role?: string; content?: string | null }>(
  messages: T[],
  tokenBudget: number,
  protectRecent: number,
): { messages: T[]; truncated: boolean } {
  if (tokenBudget <= 0) {
    const kept = recentUa(messages, protectRecent);
    return { messages: kept, truncated: kept.length < messages.length };
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
  const protectedMsgs = recentUa(messages, protectRecent);
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
  return { messages: selected, truncated: truncated || selected.length < messages.length };
}

export function historyTokenBudget(cfg: ContextConfig, sectionTokens: number, userInput: string): number {
  return Math.max(0, cfg.max_tokens - cfg.generation_reserve - sectionTokens - estimateTokens(userInput));
}

export function buildContextReport(
  cfg: ContextConfig,
  sectionReports: SectionReport[],
  historyMessages: { role?: string; content?: string | null }[],
  historyTruncated: boolean,
  userInput: string,
): ContextReport {
  const sectionTotal = sectionReports.reduce((sum, item) => sum + item.tokens, 0);
  const historyTokens = estimateTokens(histBlob(historyMessages));
  const inputTokens = estimateTokens(userInput);
  return {
    max_tokens: cfg.max_tokens,
    generation_reserve: cfg.generation_reserve,
    total: sectionTotal + historyTokens + inputTokens,
    sections: sectionReports,
    history: { tokens: historyTokens, messages: historyMessages.length, truncated: historyTruncated },
    input: { tokens: inputTokens },
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
