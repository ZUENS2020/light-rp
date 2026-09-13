import { INVALIDATED_SUMMARY_STUB } from "./domain";
import { estimateTokens, LEAN_MIN_TAIL_MESSAGES } from "./budget";

/** Prefix for the single replaceable GM compact summary system message. */
export const COMPACT_SUMMARY_MARKER = "【压缩摘要·时间线】";

/** Hermes-style end-of-summary fence (reference only; latest user wins). */
export const COMPACT_SUMMARY_END_MARKER = "--- END OF CONTEXT SUMMARY ---";

/** Required structured sections in a valid compact summary. */
export const COMPACT_REQUIRED_SECTIONS = [
  "时间线要点",
  "在场与地点",
  "关系与身份",
  "承诺与未决",
  "ongoing",
  "禁止事项备注",
] as const;

/** Soft ceiling for summary body length in 汉字 (CJK ideographs). */
export const COMPACT_MAX_HANZI = 2000;

/** Prefer summaries in this band; longer than MAX is rejected. */
export const COMPACT_TARGET_HANZI_MIN = 800;
export const COMPACT_TARGET_HANZI_MAX = 1500;

/** Bound first-time / full summarizer cost (~80 turns). */
export const COMPACT_MAX_ROLEPLAY_FOR_FULL = 160;

const DIALOGUE_LINE_RE = /[「」『』]|^\s*["“].+["”]\s*$/;
const STAGE_DIR_RE = /[（(][^）)]{12,}[）)]/g;

export function countHanzi(text: string): number {
  return (text.match(/\p{Script=Han}/gu) || []).length;
}

export function isInvalidatedSummary(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed || trimmed === INVALIDATED_SUMMARY_STUB.trim() || trimmed.startsWith("（摘要已因编辑");
}

/** True when a system message is (or was) a compact GM summary we manage. */
export function isCompactSummaryContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(COMPACT_SUMMARY_MARKER)) return true;
  if (isInvalidatedSummary(trimmed)) return true;
  // Legacy unmarked system summaries used before hybrid compact.
  if (trimmed.startsWith("【压缩摘要")) return true;
  return false;
}

export function isBadCompactSummary(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (!trimmed.startsWith(COMPACT_SUMMARY_MARKER) && !trimmed.includes(COMPACT_SUMMARY_MARKER)) return true;
  if (countHanzi(trimmed) > COMPACT_MAX_HANZI) return true;
  if (trimmed.length > COMPACT_MAX_HANZI * 3) return true;

  for (const section of COMPACT_REQUIRED_SECTIONS) {
    if (!trimmed.includes(section)) return true;
  }

  const lines = trimmed
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dialogueLines = lines.filter((line) => DIALOGUE_LINE_RE.test(line));
  if (dialogueLines.length >= 4) return true;

  const stageHits = trimmed.match(STAGE_DIR_RE) || [];
  if (stageHits.length >= 4) return true;

  // Long continuous prose paragraphs without bullets → likely scene dump.
  const proseBlocks = trimmed.split(/\n\n+/).filter((block) => {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("-") || t.startsWith("*") || t.startsWith("【")) return false;
    return countHanzi(t) > 180 && !COMPACT_REQUIRED_SECTIONS.some((s) => t.includes(s));
  });
  if (proseBlocks.length >= 2) return true;

  return false;
}

export function stripCompactSummaryMessages<T extends { role: string; content: string }>(messages: T[]): T[] {
  return messages.filter((m) => !(m.role === "system" && isCompactSummaryContent(m.content)));
}

/**
 * Strip prior compact system summaries and prepend one marked summary.
 * All user/assistant (and other non-compact system) messages stay in order.
 */
export function upsertCompactSummaryMessage<T extends { role: string; content: string; ts?: string }>(
  messages: T[],
  summary: string,
  ts: string,
): T[] {
  const body = summary.trim().startsWith(COMPACT_SUMMARY_MARKER)
    ? summary.trim()
    : `${COMPACT_SUMMARY_MARKER}\n${summary.trim()}`;
  const rest = stripCompactSummaryMessages(messages);
  return [{ role: "system", content: body, ts } as T, ...rest];
}

export type SliceRoleplayHistoryOptions = {
  /** Optional max UA message count (ceiling). */
  keep?: number;
  /** Hermes lean token budget for the live LLM tip. */
  tokenBudget?: number;
  /** Minimum UA messages to keep when possible (default LEAN_MIN_TAIL_MESSAGES). */
  minTailMessages?: number;
};

/**
 * Walk backward by estimateTokens, keeping a lean recent tip for the LLM window.
 * Full transcript can remain on disk; this only bounds the live prompt.
 */
export function sliceRoleplayHistoryByTokenBudget<T extends { role: string; content: string }>(
  messages: T[],
  tokenBudget: number,
  minTailMessages: number = LEAN_MIN_TAIL_MESSAGES,
): T[] {
  const ua = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!ua.length) return [];
  const minTail = Math.max(1, Math.floor(minTailMessages || LEAN_MIN_TAIL_MESSAGES));
  const budget = Math.max(0, Math.floor(tokenBudget));
  if (budget <= 0) return ua.slice(-Math.min(minTail, ua.length));

  const selected: T[] = [];
  let used = 0;
  for (let i = ua.length - 1; i >= 0; i -= 1) {
    const msg = ua[i]!;
    const cost = estimateTokens(`${msg.role}: ${msg.content}`);
    if (selected.length >= minTail && used + cost > budget) break;
    selected.push(msg);
    used += cost;
    if (selected.length >= minTail && used >= budget) break;
  }
  return selected.reverse();
}

/**
 * Last roleplay UA messages for LLM history (context eviction, not disk).
 * Prefers Hermes token budget when provided; `keep` remains an optional message ceiling.
 */
export function sliceRoleplayHistoryForAssemble<T extends { role: string; content: string }>(
  messages: T[],
  keep: number,
  tokenBudget?: number,
  minTailMessages: number = LEAN_MIN_TAIL_MESSAGES,
): T[] {
  const ua = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!ua.length) return [];

  if (tokenBudget != null && tokenBudget > 0) {
    const byTokens = sliceRoleplayHistoryByTokenBudget(ua, tokenBudget, minTailMessages);
    if (keep && keep > 0) return byTokens.slice(-keep);
    return byTokens;
  }

  if (!keep || keep <= 0) return ua;
  return ua.slice(-keep);
}

export function roleplayUserAssistant<T extends { role: string; content: string }>(messages: T[]): T[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

export type IncrementalCompactInput = {
  previous_summary: string;
  transcript: string;
  incremental: boolean;
};

/**
 * Build summarizer transcript: previous structured summary + only messages since last compact.
 * Falls back to last COMPACT_MAX_ROLEPLAY_FOR_FULL UA messages when no usable previous summary.
 */
export function buildIncrementalCompactInput(
  roleplayUa: { role: string; content: string }[],
  previousSummary: string | null | undefined,
  compactRoleplayCount: number | null | undefined,
): IncrementalCompactInput {
  const prev = (previousSummary || "").trim();
  const usablePrev = prev && !isInvalidatedSummary(prev);
  const since =
    usablePrev && compactRoleplayCount != null && compactRoleplayCount >= 0
      ? roleplayUa.slice(Math.min(compactRoleplayCount, roleplayUa.length))
      : null;

  if (usablePrev && since && since.length > 0) {
    return {
      previous_summary: prev,
      transcript: since.map((m) => `${m.role}: ${m.content}`).join("\n"),
      incremental: true,
    };
  }

  if (usablePrev && since && since.length === 0) {
    // Nothing new since last compact — still allow a refresh from previous only.
    return {
      previous_summary: prev,
      transcript: "（自上次压缩以来无新的角色扮演回合。）",
      incremental: true,
    };
  }

  const bounded = roleplayUa.slice(-COMPACT_MAX_ROLEPLAY_FOR_FULL);
  return {
    previous_summary: "",
    transcript: bounded.map((m) => `${m.role}: ${m.content}`).join("\n"),
    incremental: false,
  };
}

export function formatCompactSummaryForStorage(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed.startsWith(COMPACT_SUMMARY_MARKER)) {
    trimmed = `${COMPACT_SUMMARY_MARKER}\n${trimmed}`;
  }
  if (!trimmed.includes(COMPACT_SUMMARY_END_MARKER)) {
    trimmed = `${trimmed.trimEnd()}\n\n${COMPACT_SUMMARY_END_MARKER}`;
  }
  return trimmed;
}

/**
 * Hermes-style post-generation pressure gate.
 * Compact when max(actual prompt tokens, estimated assemble total) reaches
 * threshold × context window — never every turn.
 */
export function shouldCompactAfterTurn(input: {
  promptTokens?: number | null;
  estimatedTotal?: number | null;
  contextMax: number;
  threshold: number;
}): boolean {
  const contextMax = Math.max(0, Math.floor(Number(input.contextMax) || 0));
  if (contextMax <= 0) return false;
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  const promptTokens = Math.max(0, Math.floor(Number(input.promptTokens) || 0));
  const estimatedTotal = Math.max(0, Math.floor(Number(input.estimatedTotal) || 0));
  const pressure = Math.max(promptTokens, estimatedTotal);
  return pressure >= threshold * contextMax;
}
