/**
 * Classify how a story completion ended so silent upstream cut-offs are caught.
 *
 * GLM / Z.AI (served through Command Code) can end a stream with finish_reason values other
 * than stop/length — `sensitive` (streaming moderation), `network_error`, `abort`,
 * `model_context_window_exceeded` — while still sending usage. Before this, only `length` and
 * "no usage" were treated as incomplete, so those replies were stored mid-sentence with no note.
 *
 * Remedy is always ONE full regenerate of the whole reply — never mid-text continuation.
 */

export type StoryFinishKind = "ok" | "length" | "dirty" | "abnormal" | "unterminated";

export type StoryFinishInput = {
  /** Player-visible text (after trailer / prefill stripping). */
  visible: string;
  finish_reason?: string;
  stream_done?: boolean;
  prompt_tokens?: number;
};

export const CLEAN_FINISH_REASONS = new Set(["stop", "end_turn", "eos", "stop_sequence", "tool_calls"]);

/** Characters a finished Chinese RP beat normally ends on (closing quotes, sentence enders, ellipsis…). */
const TERMINAL_CHARS = new Set([
  ..."。！？!?…」』”\"'’）)】》〉~～♪—*♡❤.．>＞]｝}_`",
]);

export function endsMidSentence(text: string): boolean {
  const trimmed = text.replace(/\s+$/u, "");
  if (!trimmed) return false;
  const chars = [...trimmed];
  const last = chars[chars.length - 1];
  if (TERMINAL_CHARS.has(last)) return false;
  // Emoji / pictographs are a deliberate ending.
  if (/\p{Extended_Pictographic}/u.test(last)) return false;
  return true;
}

export function classifyStoryFinish(input: StoryFinishInput, options: { streamed: boolean }): StoryFinishKind {
  const finish = (input.finish_reason || "").trim().toLowerCase();
  if (finish === "length") return "length";
  if (options.streamed && !((input.prompt_tokens || 0) > 0)) return "dirty";
  if (finish && !CLEAN_FINISH_REASONS.has(finish)) return "abnormal";
  if (options.streamed && !finish && !input.stream_done) return "abnormal";
  if (endsMidSentence(input.visible)) return "unterminated";
  return "ok";
}

/** Kinds that justify one full regenerate. `length` keeps its own note (not a budget retry). */
export function shouldRegenerate(kind: StoryFinishKind): boolean {
  return kind === "dirty" || kind === "abnormal" || kind === "unterminated";
}
