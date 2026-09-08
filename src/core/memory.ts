/**
 * Hermes-style core memory snapshot + write policy.
 *
 * Character cards (primary/mini) own personality and voice. Core memory stores
 * plot-durable events, facts, relationships, and concrete commitments only.
 * Model-proposed writes that invent lasting personality/rules are rejected so
 * they cannot fight the card in the prompt.
 */

export type MemorySnapshot = {
  world: string[];
  player: string[];
  characters: Record<string, string[]>;
};

export type DurableMemoryType = "promise" | "relationship" | "fact" | "preference" | "goal" | "important_event";

/** Shown above the core-memory section; also mirrored in GM priority text. */
export const CARD_OVER_MEMORY_CANON =
  "角色卡是性格与口吻的正典；记忆只记录事件、事实、关系与具体约定。若冲突，以角色卡为准。";

const TYPE_TAG_RE = /^\[(?:promise|relationship|fact|preference|goal|important_event)\]\s*/i;

/** Patterns that try to persist personality, voice, or invented lasting character law. */
const PERSONALITY_OVERRIDE_RE = new RegExp(
  [
    String.raw`(?:性格|人格|人设|temperament|personality)\s*(?:变成|改成|变为|转为|定为|设置为|：|:)`,
    String.raw`(?:永久|固定)(?:性格|人格|人设|temperament)`,
    String.raw`(?:说话方式|说话风格|言语风格|speaking\s*style|speech\s*style)`,
    String.raw`(?:口吻|语气)\s*(?:变成|改成|变为|定为|设置为)`,
    String.raw`扣分规矩`,
    String.raw`(?:必须|永远|永久)?服从观察员`,
    String.raw`(?:新的?)?(?:角色规则|character\s*rules?)`,
    String.raw`(?:改写|覆盖|取代).{0,12}(?:性格|口吻|人设|人格|personality|voice)`,
    String.raw`(?:性格|口吻|人设|人格|personality|voice).{0,12}(?:改写|覆盖|取代)`,
  ].join("|"),
  "i",
);

export function stripMemoryTypeTag(text: string): string {
  return text.replace(TYPE_TAG_RE, "").trim();
}

/** True when content tries to invent lasting personality/voice/rules that belong on the card. */
export function isPersonalityOverrideMemory(text: string): boolean {
  const body = stripMemoryTypeTag(text);
  if (!body) return false;
  return PERSONALITY_OVERRIDE_RE.test(body);
}

/**
 * Gate model-proposed memory writes. Removals always pass (cleanup of dirty
 * entries). Adds/replaces that assert personality overrides are rejected.
 */
export function gateMemoryWrite(
  action: "add" | "replace" | "remove" | string,
  content: string,
): { ok: true } | { ok: false; reason: string } {
  if (action === "remove") return { ok: true };
  if (!String(content || "").trim()) return { ok: true };
  if (isPersonalityOverrideMemory(content)) {
    return {
      ok: false,
      reason:
        "Rejected: memory cannot store personality, speaking style, or permanent character rules; keep those on the character card. Memory is for events, facts, relationships, and concrete plot commitments only.",
    };
  }
  return { ok: true };
}
