import {
  assembleBudgeted,
  breachPhi,
  breachSystem,
  resolvePrimaryId,
  selectMiniMembers,
  storySummary,
  type LlmMessage,
} from "../core/assemble";
import {
  dropPolicyRefusalAssistants,
  isPolicyRefusal,
  reinforceBreachMessages,
  stripBreachAssistantPrefill,
  withBreachAssistantPrefill,
} from "../core/breach";
import {
  DEFAULT_CONTEXT,
  DEFAULT_MINI,
  DEFAULT_SECTION_BUDGET,
  LEGACY_DEFAULT_CONTEXT_MAX_TOKENS,
  LEGACY_MINI_MAX_TOKENS,
  WORKING_CONTEXT_CAP,
  REQUEST_CONTEXT_HARD_CAP,
  isLegacySectionBudget,
  leanTailTokenBudget,
  memoryIsDuplicate,
  parseContextConfig,
  parseMiniConfig,
  routeMemoryCandidate,
  type ContextConfig,
  type ContextReport,
  type MiniSelectConfig,
} from "../core/budget";
import {
  aliasMap,
  appendEvents,
  applyMemory,
  applyMemoryBatch,
  applyMemoryBestEffort,
  applyScenePatch,
  ensembleActing,
  enrichRecord,
  ensureMini,
  ensureSessionState,
  freezeMemory,
  loadAllLore,
  loadCard,
  loadMemory,
  loadSession,
  parseMentions,
  parseTrailer,
  persistMemory,
  appendTurnMessages,
  saveSession,
  sceneLoreHaystack,
  sceneYaml,
  substituteCard,
  trailerEvents,
  trailerMemoryCandidates,
  triggerLore,
  type CharacterCard,
  type ChatMessage,
  type MemoryStore,
  type MemoryMutation,
  type MemoryTarget,
  type MiniCard,
  type SceneState,
  type WorldPack,
} from "../core/domain";
import { chat, toolLoop, LlmEmptyError } from "../adapters/ai-gateway";
import {
  sha256,
  stableStringify,
  type AiModelConfig,
  type AiRequestOptions,
  REASONING_OUTPUT_HEADROOM,
  type AiUsage,
  type ResponseCacheStatus,
} from "../core/ai";
import { classifyStoryFinish, shouldRegenerate } from "../core/story-finish";
import { gateMemoryWrite } from "../core/memory";
import { memoryToolSpec, PromptLibrary, turnCommitToolSpec } from "../core/prompts";
import type { R2Fs } from "../adapters/r2";
import {
  LEGACY_LORE_TOKEN_BUDGET,
  STORY_OUTPUT_TOKEN_FLOOR,
  TURN_COMMIT_MAX_TOKENS,
  TURN_COMMIT_TIMEOUT_SECONDS,
  type AppSettings,
} from "./settings";
import { nowIso } from "../core/util";
import { appendHiddenPromptEvents, createPromptEpoch, preparePrompt } from "./prompt-state";
import { getCachedToolExecution, recordToolExecution, updateTaskPartialContent } from "./tasks";
import { parseSystemCommand, roleplayOnlyMessages } from "../core/commands";
import {
  buildIncrementalCompactInput,
  formatCompactSummaryForStorage,
  isBadCompactSummary,
  roleplayUserAssistant,
  sliceRoleplayHistoryForAssemble,
  shouldCompactAfterTurn,
  upsertCompactSummaryMessage,
} from "../core/compact";

export type StoryFinishDiag = {
  finish_reason: string | null;
  first_finish_reason: string | null;
  completion_tokens: number;
  /** `<kind>:<finish_reason>` when one full regenerate ran, else null. */
  retry: string | null;
};

export type TurnOut = {
  text: string;
  scene: SceneState;
  messages: ChatMessage[];
  spotlight_ids: string[];
  warnings: string[];
  truncated?: boolean;
  context_report?: ContextReport;
  ai_usage?: AiUsage;
  response_cache_status?: ResponseCacheStatus;
  request_hash?: string;
  stable_prefix_tokens?: number;
  volatile_tokens?: number;
  hidden_prompt_events?: Array<{ kind: "context" | "memory"; content: string; hashSeed?: string }>;
  /** Set when post-turn background compact should run (pressure or rare turn fallback). */
  should_compact?: boolean;
  /** Set when commit_turn should run after the reply is visible (queue: after completeTask). */
  should_commit?: boolean;
  /** Scene loaded at the start of this turn; used by deferred commit. */
  scene_before?: SceneState;
  /** How the story completion ended (persisted on generation_tasks for truncation forensics). */
  story_finish?: StoryFinishDiag;
  /** Legacy: only set if compact applied inline (no longer used on the story critical path). */
  rotate_prompt_epoch_reason?: "context_compacted";
};

export type RunTurnOptions = {
  persistUser?: boolean;
  ai?: {
    db: D1Database;
    taskId: string;
    model: AiModelConfig;
    requestKind?: "story" | "rewrite" | "regenerate";
    /** Queue lease owner — scopes partial writes and renews lease on each partial. */
    leaseOwner?: string;
    /** Extra renew hook (scheduler heartbeat touch) on each flushed partial. */
    onLeaseTouch?: () => Promise<void>;
    /** SessionRuntime DO broadcast (full content); D1 partial writes stay for poll fallback. */
    onRuntimePartial?: (content: string) => Promise<void>;
    /**
     * Called once the final reply is persisted to the R2 transcript (before trace/event-log
     * bookkeeping). The queue consumer completes the task + broadcasts here.
     */
    onReplyPersisted?: (payload: ReplyPersistedPayload) => Promise<void>;
  };
};

export type ReplyPersistedPayload = Pick<
  TurnOut,
  | "text"
  | "ai_usage"
  | "response_cache_status"
  | "request_hash"
  | "stable_prefix_tokens"
  | "volatile_tokens"
  | "hidden_prompt_events"
  | "story_finish"
>;

export type OocOut = Pick<
  TurnOut,
  | "text"
  | "messages"
  | "ai_usage"
  | "response_cache_status"
  | "request_hash"
  | "stable_prefix_tokens"
  | "volatile_tokens"
>;

const OOC_SYSTEM = `你是 Light RP 的系统助手。当前请求明确处于 OOC（Out of Character）模式。
直接、清楚地回答用户关于当前故事、角色关系、设定、玩法或应用操作的问题；可以讨论 RP，但不要扮演角色或继续叙事。
不得推进时间、地点、人物行动或状态，不得虚构已发生事件，不得生成状态块，也不得提出或执行任何记忆修改。`;

export { STORY_OUTPUT_TOKEN_FLOOR, TURN_COMMIT_TIMEOUT_SECONDS };

function isStoryOutputKind(kind?: AiRequestOptions["requestKind"]): boolean {
  return kind == null || kind === "story" || kind === "rewrite" || kind === "regenerate";
}

/** Cap commit_turn so a failed/slow tool call cannot inherit the 180s story timeout. */
export function turnCommitTimeoutSeconds(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) return TURN_COMMIT_TIMEOUT_SECONDS;
  return Math.min(TURN_COMMIT_TIMEOUT_SECONDS, Math.floor(configured));
}

export function effectiveOutputTokens(
  settings: AppSettings,
  model?: AiModelConfig,
  requestKind?: AiRequestOptions["requestKind"],
): number {
  const configured = Math.max(1, Math.floor(settings.llm.max_tokens));
  // Story kinds: never below STORY_OUTPUT_TOKEN_FLOOR; no legacy remap that would lower a 16k+ setting.
  const wanted = isStoryOutputKind(requestKind) ? Math.max(configured, STORY_OUTPUT_TOKEN_FLOOR) : configured;
  if (!model) return wanted;
  const modelCap = Math.max(1, Math.floor(model.max_output_tokens));
  // Reasoning models: assemble reserves visible content only; API adds REASONING_OUTPUT_HEADROOM.
  if (isStoryOutputKind(requestKind) && model.supports_reasoning) {
    const withHeadroom = modelCap - REASONING_OUTPUT_HEADROOM;
    // Only split when the model ceiling has room for both content floor and CoT slack.
    const contentCap = withHeadroom >= STORY_OUTPUT_TOKEN_FLOOR ? withHeadroom : modelCap;
    return Math.min(wanted, contentCap);
  }
  return Math.min(wanted, modelCap);
}

export function effectiveContextConfig(settings: AppSettings, model?: AiModelConfig) {
  const outputTokens = effectiveOutputTokens(settings, model);
  const configuredWindow = Math.max(1, Math.floor(settings.context.max_tokens));
  const modelWindow = model ? Math.max(1, Math.floor(model.context_window)) : configuredWindow;
  // Stale R2 settings still at the old 32k default should not pin GLM (~1.3M) to 32k.
  // Cap at WORKING_CONTEXT_CAP (32k), never above REQUEST_CONTEXT_HARD_CAP (128k).
  const staleSmallWindow =
    configuredWindow <= LEGACY_DEFAULT_CONTEXT_MAX_TOKENS && modelWindow > LEGACY_DEFAULT_CONTEXT_MAX_TOKENS;
  const raisedWindow = staleSmallWindow
    ? Math.min(WORKING_CONTEXT_CAP, DEFAULT_CONTEXT.max_tokens, modelWindow, REQUEST_CONTEXT_HARD_CAP)
    : configuredWindow;
  // Untouched legacy caps (memory 2500 / mini 1200 / state 800) predate the 32k working
  // window; upgrade them whenever they are still the exact legacy set.
  const budget = isLegacySectionBudget(settings.context.budget)
    ? { ...DEFAULT_SECTION_BUDGET }
    : settings.context.budget;
  const history =
    staleSmallWindow && settings.context.history.protect_recent_turns < DEFAULT_CONTEXT.history.protect_recent_turns
      ? {
          ...settings.context.history,
          protect_recent_turns: DEFAULT_CONTEXT.history.protect_recent_turns,
        }
      : settings.context.history;
  const reserved = Math.max(settings.context.generation_reserve, outputTokens);
  const modelOutputCap = model ? Math.max(1, Math.floor(model.max_output_tokens)) : reserved;
  return parseContextConfig({
    ...settings.context,
    budget,
    history,
    max_tokens: Math.min(raisedWindow, modelWindow, WORKING_CONTEXT_CAP, REQUEST_CONTEXT_HARD_CAP),
    // Completion reserve is carved from the provider window above the working window
    // (GLM: 128k request vs 32k working), not from memory/cast/lore section room.
    ...(model ? { request_window: Math.min(modelWindow, REQUEST_CONTEXT_HARD_CAP) } : {}),
    generation_reserve: Math.min(reserved, modelOutputCap),
  });
}

/** Raise mini select budget when context was auto-raised from the legacy 32k defaults. */
export function effectiveMiniConfig(
  settings: AppSettings,
  contextCfg?: ContextConfig,
  model?: AiModelConfig,
): MiniSelectConfig {
  void contextCfg;
  void model;
  const mini = parseMiniConfig(settings.mini);
  // Legacy 1.2k mini cap fits ~2 thin minis; ensemble scenes need every present NPC.
  if (mini.max_tokens <= LEGACY_MINI_MAX_TOKENS) {
    return parseMiniConfig({ ...mini, max_tokens: DEFAULT_MINI.max_tokens });
  }
  return mini;
}

/** Prefer scaled section lore when settings still carry the old 2048 default. */
export function effectiveLoreTokenBudget(
  packLore: number | null | undefined,
  settings: AppSettings,
  contextCfg: ContextConfig,
): number {
  if (packLore) return packLore;
  const configured = Number(settings.lore_token_budget) || 0;
  if (configured > 0 && configured !== LEGACY_LORE_TOKEN_BUDGET) return configured;
  return contextCfg.budget.lore;
}

/**
 * Progressive UI buffer during SSE. Nuclear isolation: onPartial MUST only mutate
 * in-memory state. Any D1 / SessionRuntime DO write concurrent with draining a
 * Command Code fetch body causes dirty TCP closes (prompt_tokens=0, mid-sentence cuts)
 * even when fire-and-forget — Workers subrequest slots still contend with the body reader.
 *
 * Flush D1 + DO exactly once after chat() returns. Lease renew during long CoT is owned
 * by startLeaseHeartbeat (waitUntil), not by this sink.
 */
export function createPartialContentSink(
  db: D1Database,
  taskId: string,
  options: {
    leaseOwner?: string;
    onLeaseTouch?: () => Promise<void>;
    onRuntimePartial?: (content: string) => Promise<void>;
  } = {},
) {
  let lastText = "";

  return {
    /** Sync + void: store only. Never schedule D1/DO/timers here. */
    onPartial: (text: string): void => {
      lastText = text;
    },
    peek: (): string => lastText,
    flush: async () => {
      if (!lastText) return;
      const ok = await updateTaskPartialContent(db, taskId, lastText, options.leaseOwner).catch(() => false);
      if (options.onRuntimePartial) await options.onRuntimePartial(lastText).catch(() => undefined);
      if (ok && options.onLeaseTouch) await options.onLeaseTouch().catch(() => undefined);
    },
  };
}

export async function runOoc(
  env: Env,
  fs: R2Fs,
  pack: WorldPack,
  sessionId: string,
  rawText: string,
  settings: AppSettings,
  options: {
    model: AiModelConfig;
    affinityKey?: string;
    taskId?: string;
    db?: D1Database;
    leaseOwner?: string;
    onLeaseTouch?: () => Promise<void>;
    onRuntimePartial?: (content: string) => Promise<void>;
  },
): Promise<OocOut> {
  const command = parseSystemCommand(rawText);
  if (command?.name !== "ooc" || !command.argument) throw new Error("/ooc 后需要填写问题");
  const loaded = await loadSession(fs, sessionId);
  const roleplayHistory = roleplayOnlyMessages(loaded.messages)
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-12)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  const context = [`工作区：${pack.name}`, roleplayHistory ? `最近的 RP 正文：\n${roleplayHistory}` : "暂无 RP 正文。"]
    .join("\n\n")
    .trim();
  const oocSink =
    options.db && options.taskId
      ? createPartialContentSink(options.db, options.taskId, {
          leaseOwner: options.leaseOwner,
          onLeaseTouch: options.onLeaseTouch,
          onRuntimePartial: options.onRuntimePartial,
        })
      : null;
  let result;
  try {
    result = await chat(
      env,
      [
        { role: "system", content: OOC_SYSTEM },
        { role: "user", content: context },
        { role: "user", content: command.argument },
      ],
      null,
      Math.min(settings.llm.temperature, 0.5),
      effectiveOutputTokens(settings, options.model, "ooc"),
      settings.llm.timeout,
      {
        model: options.model,
        affinityKey: options.affinityKey,
        requestKind: "ooc",
        ...(oocSink ? { onPartial: oocSink.onPartial } : {}),
        ...(options.onLeaseTouch ? { onHeartbeat: options.onLeaseTouch } : {}),
      },
    );
  } finally {
    if (oocSink) await oocSink.flush();
  }
  const assistant = {
    role: "assistant",
    content: result.text.trim(),
    ts: nowIso(),
    ...(options.taskId ? { task_id: options.taskId } : {}),
  };
  if (!assistant.content) throw new LlmEmptyError();
  const tip = loaded.messages[loaded.messages.length - 1];
  const messages = await appendTurnMessages(
    fs,
    sessionId,
    {
      userText: rawText,
      assistant,
      taskId: options.taskId,
      userAlreadyPersisted: tip?.role === "user" && tip.content === rawText,
    },
    {
      thread_id: loaded.thread_id,
      nmem_space: loaded.nmem_space,
      primary_character: loaded.primary_character,
      title: loaded.title,
    },
  );
  return {
    text: assistant.content,
    messages,
    ai_usage: result.usage,
    response_cache_status: result.response_cache_status,
    request_hash: await sha256(result.request_body),
    stable_prefix_tokens: 0,
    volatile_tokens: 0,
  };
}

async function loadMemberCards(fs: R2Fs, members: WorldPack["cast"]): Promise<CharacterCard[]> {
  const cards: CharacterCard[] = [];
  for (const member of members) {
    try {
      cards.push(await loadCard(fs, member));
    } catch {
      continue;
    }
  }
  return cards;
}

async function triggered(
  fs: R2Fs,
  pack: WorldPack,
  scene: SceneState,
  messages: ChatMessage[],
  extra: string,
  settings: AppSettings,
  cards: CharacterCard[],
  contextCfg: ContextConfig,
) {
  const depth = pack.lore_scan_depth || settings.lore_scan_depth;
  const budget = effectiveLoreTokenBudget(pack.lore_token_budget, settings, contextCfg);
  const recent = messages.slice(-depth);
  const haystack = `${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n${extra}`;
  return triggerLore(await loadAllLore(fs, cards), haystack, sceneLoreHaystack(pack, scene), budget);
}

export const TRUNCATION_NOTE = "（回复在 max_tokens 处被截断）";
export const TRUNCATION_NOTE_INCOMPLETE = "（回复流提前结束）";

export function openingFor(cards: CharacterCard[], playerName: string, primaryId?: string | null): string {
  const preferred = primaryId ? cards.filter((card) => card.id === primaryId || card.name === primaryId) : [];
  const chosen = (preferred.length ? preferred : cards).slice(0, 1);
  return chosen
    .map((card) => substituteCard(card, playerName).first_mes.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function loadMinisForTurn(
  fs: R2Fs,
  pack: WorldPack,
  scene: SceneState,
  haystack: string,
  mentionIds: string[],
  primaryId: string | null,
  miniCfg: MiniSelectConfig,
  recentHaystack: string,
  userText = "",
): Promise<{ minis: MiniCard[]; loreCards: CharacterCard[] }> {
  const members = selectMiniMembers(pack, scene, haystack, mentionIds, primaryId, miniCfg, recentHaystack, userText);
  const minis: MiniCard[] = [];
  const loreCards: CharacterCard[] = [];
  for (const member of members) {
    try {
      const card = await loadCard(fs, member);
      loreCards.push(card);
      minis.push(await ensureMini(fs, member, card));
    } catch {
      continue;
    }
  }
  return { minis, loreCards };
}

async function appendTrace(fs: R2Fs, sessionId: string, row: Record<string, unknown>): Promise<void> {
  const path = `sessions/${sessionId}/trace.jsonl`;
  const prev = (await fs.get(path)) || "";
  await fs.put(path, `${prev}${JSON.stringify(row)}\n`);
}

async function saveContextReport(fs: R2Fs, sessionId: string, report: ContextReport): Promise<void> {
  await fs.put(`sessions/${sessionId}/context_report.json`, JSON.stringify(report, null, 2));
}

export function candidateImportance(item: Record<string, unknown>): number {
  const raw = item.importance;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() && !Number.isNaN(Number(raw))) return Number(raw);
  const defaults: Record<string, number> = {
    promise: 0.9,
    relationship: 0.85,
    goal: 0.8,
    important_event: 0.8,
    preference: 0.75,
    fact: 0.7,
  };
  return defaults[String(item.type || "")] ?? 0.5;
}

function memoryTarget(
  candidate: Record<string, unknown>,
  pack: WorldPack,
): { target: string; characterId: string | null } {
  const requested = String(candidate.target || "world");
  if (requested !== "character") return { target: requested === "player" ? "player" : "world", characterId: null };
  const rawId = String(candidate.character_id || "").trim();
  const member = pack.cast.find(
    (item) => item.id === rawId || item.name === rawId || item.aliases.some((alias) => alias === rawId),
  );
  return member ? { target: "character", characterId: member.id } : { target: "world", characterId: null };
}

type PlannedMemoryChanges = {
  eventRecords: Record<string, unknown>[];
  mutations: MemoryMutation[];
};

export function planMemoryChanges(
  pack: WorldPack,
  scene: SceneState,
  candidates: Record<string, unknown>[],
): PlannedMemoryChanges {
  const eventRecords: Record<string, unknown>[] = [];
  const mutations: MemoryMutation[] = [];
  const durableTypes = new Set(["promise", "relationship", "fact", "preference", "goal", "important_event"]);

  for (const candidate of candidates) {
    const text = String(candidate.content || candidate.text || "").trim();
    if (!text) continue;
    const importance = candidateImportance(candidate);
    const route = routeMemoryCandidate(importance);
    if (route === "drop") continue;
    if (route === "event") {
      eventRecords.push({ ...enrichRecord(candidate, scene), kind: "memory_candidate", importance });
      continue;
    }

    const resolved = memoryTarget(candidate, pack);
    const target = resolved.target as MemoryTarget;
    const actionRaw = String(candidate.action || "add");
    const action = actionRaw === "replace" || actionRaw === "remove" ? actionRaw : "add";
    const memoryType = durableTypes.has(String(candidate.type || "")) ? String(candidate.type) : "fact";
    const storedText = /^\[(?:promise|relationship|fact|preference|goal|important_event)\]\s*/i.test(text)
      ? text
      : `[${memoryType}] ${text}`;
    const gated = gateMemoryWrite(action, action === "remove" ? text : storedText);
    if (!gated.ok) continue;
    mutations.push({
      action,
      target,
      characterId: resolved.characterId,
      ...(action === "remove" ? {} : { content: storedText }),
      ...(action === "remove" || action === "replace"
        ? { oldText: String(candidate.old_text || (action === "remove" ? text : "")).trim() }
        : {}),
    });
  }
  return { eventRecords, mutations };
}

async function persistMemoryChanges(
  fs: R2Fs,
  memory: MemoryStore,
  touched: Array<{ target: MemoryTarget; characterId: string | null }>,
): Promise<void> {
  for (const item of touched) await persistMemory(fs, memory, item.target, item.characterId);
}

function memoryPromptDelta(operations: MemoryMutation[]): string {
  return [
    "## 核心记忆变更",
    "以下变更已经持久化，从现在起有效。replace/remove 会取代 epoch 检查点中的旧事实。",
    stableStringify(
      operations.map((operation) => ({
        action: operation.action,
        target: operation.target,
        character_id: operation.characterId || null,
        content: operation.content || "",
        old_text: operation.oldText || "",
      })),
    ),
  ].join("\n");
}

type TurnCommit = {
  state: SceneState;
  events: Record<string, unknown>[];
  memoryOps: Record<string, unknown>[];
  call: { id: string; name: string; arguments: Record<string, unknown> };
  usage: AiUsage;
};

function textField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function validTurnCommitArguments(args: Record<string, unknown>): boolean {
  if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) return false;
  const state = args.state as Record<string, unknown>;
  if (!["time", "season", "weather", "location", "scene"].every((key) => typeof state[key] === "string")) {
    return false;
  }
  if (!Array.isArray(state.present) || !Array.isArray(state.ongoing)) return false;
  if (!Array.isArray(args.events) || !Array.isArray(args.memory_ops)) return false;
  return args.memory_ops.every((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const op = raw as Record<string, unknown>;
    return (
      ["add", "replace", "remove"].includes(String(op.action)) &&
      ["world", "player", "character"].includes(String(op.target)) &&
      typeof op.content === "string" &&
      typeof op.type === "string" &&
      typeof op.importance === "number" &&
      Number.isFinite(op.importance)
    );
  });
}

/** Words that name the player / nobody rather than an NPC. */
const NON_NPC_PRESENT = new Set(["训练员", "玩家", "user", "{{user}}", "你", "我", "无", "none"]);

/**
 * Map present entries to cast ids; keep off-roster NPCs (e.g. a recurring character with no
 * card) by name instead of silently dropping them, so the scene state does not lose them and
 * the model does not re-cast their lines onto roster characters. Player name is excluded.
 */
export function normalizePresentList(raw: string[], pack: WorldPack, maxOffRoster = 4): string[] {
  const out: string[] = [];
  let offRoster = 0;
  for (const entry of raw) {
    const name = entry.trim();
    if (!name) continue;
    const member = pack.cast.find(
      (item) => item.id === name || item.name === name || item.aliases.some((alias) => alias === name),
    );
    if (member) {
      out.push(member.id);
      continue;
    }
    if (name === pack.player_name || NON_NPC_PRESENT.has(name.toLowerCase()) || name.length > 24) continue;
    if (offRoster >= maxOffRoster) continue;
    offRoster += 1;
    out.push(name);
  }
  return [...new Set(out)];
}

/** Characters whose memory the commit extractor should see (present + named this turn). */
export function commitFocusCharacterIds(pack: WorldPack, scene: SceneState, text: string): string[] {
  const ids = new Set<string>();
  for (const member of pack.cast) {
    const names = [member.id, member.name, ...member.aliases].filter(Boolean);
    const present = scene.present.some((entry) => names.includes(entry));
    if (present || names.some((name) => text.includes(name))) ids.add(member.id);
  }
  return [...ids];
}

export function normalizeTurnCommit(
  args: Record<string, unknown>,
  previous: SceneState,
  pack: WorldPack,
  call: TurnCommit["call"],
  usage: AiUsage,
): TurnCommit {
  const rawState =
    args.state && typeof args.state === "object" && !Array.isArray(args.state)
      ? (args.state as Record<string, unknown>)
      : {};
  const hasPresent = Array.isArray(rawState.present);
  const present = normalizePresentList(stringList(rawState.present), pack);
  const state: SceneState = {
    time: textField(rawState.time, previous.time),
    season: textField(rawState.season, previous.season),
    weather: textField(rawState.weather, previous.weather),
    location: textField(rawState.location, previous.location),
    present: hasPresent ? [...new Set(present)] : previous.present,
    scene: textField(rawState.scene, previous.scene || previous.notes),
    ongoing: Array.isArray(rawState.ongoing) ? stringList(rawState.ongoing) : previous.ongoing,
    notes: textField(rawState.scene, previous.scene || previous.notes),
  };
  const events = stringList(args.events).map((summary) => ({ summary }));
  const memoryOps = (Array.isArray(args.memory_ops) ? args.memory_ops : []).filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  return { state, events, memoryOps, call, usage };
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    reasoning_tokens: (a.reasoning_tokens || 0) + (b.reasoning_tokens || 0),
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
  };
}

function parseCommitJson(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function unwrapCommitPayload(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.state && typeof raw.state === "object" && !Array.isArray(raw.state)) return raw;
  const nested = raw.arguments;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return unwrapCommitPayload(nested as Record<string, unknown>);
  }
  if (typeof nested === "string") {
    const parsed = parseCommitJson(nested);
    if (parsed) return unwrapCommitPayload(parsed);
  }
  const named = raw.commit_turn;
  if (named && typeof named === "object" && !Array.isArray(named)) {
    return unwrapCommitPayload(named as Record<string, unknown>);
  }
  return raw;
}

export function coerceTurnCommitArguments(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const args = unwrapCommitPayload(raw);
  const state = args.state;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const events = Array.isArray(args.events) ? args.events : args.events == null ? [] : [args.events];
  const opsRaw = Array.isArray(args.memory_ops) ? args.memory_ops : [];
  const memory_ops = opsRaw
    .filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .map((op) => ({
      ...op,
      action: ["add", "replace", "remove"].includes(String(op.action)) ? String(op.action) : "add",
      target: ["world", "player", "character"].includes(String(op.target)) ? String(op.target) : "world",
      content: String(op.content ?? op.text ?? ""),
      type: String(op.type || "fact"),
      importance: candidateImportance(op),
    }));
  return { ...args, state, events, memory_ops };
}

function commitArgsFromResult(result: {
  text: string;
  tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
}): {
  args: Record<string, unknown>;
  call: TurnCommit["call"];
} | null {
  const candidates = [...result.tool_calls.filter((item) => item.name === "commit_turn"), ...result.tool_calls];
  const parsed = result.text.trim() ? parseCommitJson(result.text) : null;
  if (parsed) candidates.push({ id: "content-commit", name: "commit_turn", arguments: parsed });
  for (const item of candidates) {
    const coerced = coerceTurnCommitArguments(item.arguments);
    if (!coerced || !validTurnCommitArguments(coerced)) continue;
    return {
      args: coerced,
      call: { id: item.id || "content-commit", name: "commit_turn", arguments: coerced },
    };
  }
  return null;
}

async function extractTurnCommit(
  env: Env,
  library: PromptLibrary,
  pack: WorldPack,
  scene: SceneState,
  memory: MemoryStore,
  userText: string,
  assistantText: string,
  settings: AppSettings,
  options: AiRequestOptions,
  memoryFeedback = "",
): Promise<TurnCommit> {
  const tool = turnCommitToolSpec(library);
  // Only present / named characters' memory: the full store (~20k chars in long sessions)
  // made the commit call slow enough to hit its timeout on about half the turns.
  const focusIds = commitFocusCharacterIds(pack, scene, `${userText}\n${assistantText}`);
  const memorySnapshot = {
    world: memory.world,
    player: memory.player,
    characters: Object.fromEntries(
      focusIds.filter((id) => memory.characters[id]).map((id) => [id, memory.characters[id]]),
    ),
  };
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        "你是回合提交器。阅读本轮已完成的正文，只调用 commit_turn 一次来提交状态和记忆；不要续写、解释或修改正文。",
    },
    {
      role: "user",
      content: [
        `可用角色 id：${pack.cast.map((member) => `${member.id}=${member.name}`).join("；") || "无"}`,
        `旧状态：\n${sceneYaml(scene)}`,
        `已有长期记忆（characters 只列出在场/本轮提到的角色；不要 replace/remove 未列出的条目）：\n${stableStringify(memorySnapshot)}`,
        `用户本轮：\n${userText}`,
        `助手正式叙事：\n${assistantText}`,
        memoryFeedback
          ? `上一次 memory_ops 没有写入，核心记忆保持原样。请根据错误和当前条目重新整理 memory_ops；可以在同一批中 remove/replace 旧条目并 add 新条目。状态必须保持本轮结束状态，events 返回空数组。\n${memoryFeedback}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  // Full state snapshot alone is ~1.5k tokens in long ensemble scenes; 1.5k cut the call
  // (finish_reason=length → no valid commit_turn → state/memory silently not saved).
  const commitMaxTokens = TURN_COMMIT_MAX_TOKENS;
  const commitTimeout = turnCommitTimeoutSeconds(settings.llm.timeout);
  const requestKind = (memoryFeedback ? "correction" : "memory") as "correction" | "memory";
  const commitOptions = {
    ...options,
    requestKind,
    skipCache: Boolean(memoryFeedback) || options.skipCache,
    skipOutputChannelRetry: true,
  };
  const requestJson = () => chat(env, messages, null, 0, commitMaxTokens, commitTimeout, commitOptions);
  const requestTool = () =>
    chat(env, messages, [tool], 0, commitMaxTokens, commitTimeout, {
      ...commitOptions,
      toolChoice: { type: "function", function: { name: "commit_turn" } },
    });
  const accept = (
    result: {
      text: string;
      tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[];
      usage: AiUsage;
      request_body: string;
    },
    extraUsage?: AiUsage,
  ): TurnCommit | null => {
    const picked = commitArgsFromResult(result);
    if (!picked) return null;
    const usage = extraUsage ? addUsage(extraUsage, result.usage) : result.usage;
    return normalizeTurnCommit(picked.args, scene, pack, picked.call, usage);
  };

  if (options.model?.supports_tools === false) {
    messages[0] = {
      role: "system",
      content: `${messages[0].content}\n模型不支持工具，因此只输出一个符合以下 JSON Schema 的 JSON 对象：\n${library.text("tools/turn-commit.schema.json")}`,
    };
    const commit = accept(await requestJson());
    if (!commit) throw new Error("文本模型没有提交合法的回合 JSON，状态与记忆未落盘");
    return commit;
  }

  const commit = accept(await requestTool());
  if (!commit) throw new Error("模型没有提交合法的 commit_turn，状态与记忆未落盘");
  return commit;
}

export async function runTurn(
  env: Env,
  fs: R2Fs,
  pack: WorldPack,
  sessionId: string,
  userText: string,
  settings: AppSettings,
  overlays: Record<string, string>,
  _waitUntil?: (job: Promise<unknown>) => void,
  opts?: RunTurnOptions,
): Promise<TurnOut> {
  const warnings: string[] = [];
  const persistUser = opts?.persistUser !== false;
  const loaded = await loadSession(fs, sessionId);
  const lastLoaded = loaded.messages[loaded.messages.length - 1];
  const userAlreadyPersisted =
    !persistUser &&
    lastLoaded?.role === "user" &&
    (lastLoaded.task_id === opts?.ai?.taskId || lastLoaded.content === userText);
  const roleplayMessages = roleplayOnlyMessages(loaded.messages);
  const historyMessages = userAlreadyPersisted ? roleplayMessages.slice(0, -1) : roleplayMessages;
  let primaryCharacter = loaded.primary_character;
  if (!primaryCharacter && pack.primary) {
    primaryCharacter = pack.primary;
    await saveSession(fs, sessionId, loaded.messages, {
      thread_id: loaded.thread_id,
      nmem_space: loaded.nmem_space,
      primary_character: primaryCharacter,
      title: loaded.title,
    });
  }
  const scene = await ensureSessionState(fs, sessionId, pack);
  const memory = await loadMemory(fs);
  const library = new PromptLibrary(overlays);
  const mentionIds = parseMentions(userText, aliasMap(pack.cast));
  const primaryId = resolvePrimaryId(pack, scene, primaryCharacter);
  const primaryMember = primaryId ? pack.cast.find((item) => item.id === primaryId) : undefined;
  const primaryCards = primaryMember ? await loadMemberCards(fs, [primaryMember]) : [];
  const contextCfg = effectiveContextConfig(settings, opts?.ai?.model);
  const miniCfg = effectiveMiniConfig(settings, contextCfg, opts?.ai?.model);
  const outputTokens = effectiveOutputTokens(settings, opts?.ai?.model, opts?.ai?.requestKind || "story");
  const leanTailBudget = leanTailTokenBudget(contextCfg.max_tokens);
  // No in-turn preflight runCompact: memory-flush + summarizer LLM would burn minutes
  // inside the story generation lease (TASK_LEASE_EXPIRED / "stuck generating").
  // Lean history slice + WORKING_CONTEXT_CAP trim keep prompts small without an extra LLM.
  const recentSlice = roleplayMessages.slice(-Math.max(8, miniCfg.recent_turns * 2));
  const recentHaystack = recentSlice.map((m) => m.content).join("\n");
  const haystack = `${userText}\n${recentHaystack}\n${scene.location} ${scene.time} ${scene.scene || scene.notes} ${scene.present.join(" ")}`;
  const { minis, loreCards } = await loadMinisForTurn(
    fs,
    pack,
    scene,
    haystack,
    mentionIds,
    primaryId,
    miniCfg,
    recentHaystack,
    userText,
  );
  const lore = await triggered(
    fs,
    pack,
    scene,
    roleplayMessages,
    userText,
    settings,
    [...primaryCards, ...loreCards],
    contextCfg,
  );
  const promptUser = mentionPrompt(pack, userText, mentionIds);
  const breach = settings.llm.breach;
  const loreBudget = effectiveLoreTokenBudget(pack.lore_token_budget, settings, contextCfg);
  const cardPhi = primaryCards
    .map((card) => {
      const filled = substituteCard(card, pack.player_name);
      return filled.post_history_instructions.trim()
        ? ensembleActing(filled.post_history_instructions, filled.name)
        : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const extraSystem = breachSystem(library, breach);
  const phi = [breachPhi(library, breach), cardPhi].filter(Boolean).join("\n\n");
  let historyForAssemble = sliceRoleplayHistoryForAssemble(
    historyMessages,
    settings.transcript_keep_after_compact,
    leanTailBudget,
  ).map((m) => ({ role: m.role, content: m.content }));
  if (breach) historyForAssemble = dropPolicyRefusalAssistants(historyForAssemble);
  const assembled = assembleBudgeted(
    library,
    pack,
    memory,
    scene,
    primaryCards,
    lore,
    historyForAssemble,
    promptUser,
    extraSystem,
    minis,
    storySummary(roleplayMessages),
    contextCfg,
    miniCfg,
    loreBudget,
    outputTokens,
    phi,
  );
  await saveContextReport(fs, sessionId, assembled.report);
  let messages: LlmMessage[] = [
    { role: "system", content: assembled.system },
    ...assembled.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: promptUser },
  ];
  let affinity: string | undefined;
  let stablePrefixTokens = 0;
  let volatileTokens = 0;
  if (opts?.ai) {
    const prepared = await preparePrompt(opts.ai.db, {
      sessionId,
      taskId: opts.ai.taskId,
      systemParts: [assembled.stable_system, phi],
      checkpoint: assembled.epoch_checkpoint,
      dynamicContext: assembled.turn_context,
      userContent: promptUser,
      tools: null,
      model: opts.ai.model,
      seedHistory: assembled.history,
      contextParts: assembled.turn_context_parts,
      memoryParts: assembled.character_memory_parts,
    });
    messages = prepared.messages;
    affinity = prepared.affinityKey;
    stablePrefixTokens = prepared.stablePrefixTokens;
    volatileTokens = prepared.volatileTokens;
  }
  // Prefill AFTER preparePrompt so the final chat() list ends with an in-character stub.
  // When breach is on, strip prior policy-refusal assistants so they cannot train the next refusal.
  if (breach) messages = dropPolicyRefusalAssistants(messages);
  messages = withBreachAssistantPrefill(messages, breach);
  const partialSink =
    opts?.ai?.db && opts.ai.taskId
      ? createPartialContentSink(opts.ai.db, opts.ai.taskId, {
          leaseOwner: opts.ai.leaseOwner,
          onLeaseTouch: opts.ai.onLeaseTouch,
          onRuntimePartial: opts.ai.onRuntimePartial,
        })
      : null;
  const storyRequestKind = opts?.ai?.requestKind || "story";
  const baseChatOpts = {
    model: opts?.ai?.model,
    affinityKey: affinity,
    requestKind: storyRequestKind,
    skipCache: storyRequestKind === "rewrite" || storyRequestKind === "regenerate",
    ...(opts?.ai?.onLeaseTouch ? { onHeartbeat: opts.ai.onLeaseTouch } : {}),
  } as const;
  const storyChatOpts = {
    ...baseChatOpts,
    ...(partialSink ? { onPartial: partialSink.onPartial } : {}),
  } as const;
  type StoryResult = Awaited<ReturnType<typeof chat>>;
  const storyVisible = (result: StoryResult) => stripBreachAssistantPrefill(parseTrailer(result.text || "").visible);
  const storyFinish = (result: StoryResult, streamed: boolean) =>
    classifyStoryFinish(
      {
        visible: storyVisible(result),
        finish_reason: result.finish_reason,
        stream_done: result.stream_done,
        prompt_tokens: result.usage?.prompt_tokens,
      },
      { streamed },
    );

  let gm: StoryResult;
  let storyRetry: string | null = null;
  let firstFinishReason: string | null;
  try {
    gm = await chat(env, messages, null, settings.llm.temperature, outputTokens, settings.llm.timeout, storyChatOpts);
    firstFinishReason = gm.finish_reason || null;
    // Incomplete story (dirty close without usage, abnormal finish_reason such as GLM
    // `sensitive` / `network_error`, or a body that stops mid-sentence): ONE full regenerate
    // WITHOUT onPartial so wantStream is false. Never mid-text 续写.
    const firstKind = storyFinish(gm, Boolean(partialSink));
    if (shouldRegenerate(firstKind)) {
      storyRetry = `${firstKind}:${gm.finish_reason || "none"}`;
      console.warn({
        event: firstKind === "dirty" ? "llm.stream_incomplete_retry" : "llm.story_incomplete_retry",
        kind: firstKind,
        finish_reason: gm.finish_reason || null,
        stream_done: Boolean(gm.stream_done),
        chars: gm.text.length,
        completion_tokens: gm.usage?.completion_tokens || 0,
      });
      const first = gm;
      try {
        const retry = await chat(
          env,
          messages,
          null,
          settings.llm.temperature,
          outputTokens,
          settings.llm.timeout,
          baseChatOpts,
        );
        const retryKind = storyFinish(retry, false);
        // Keep the retry unless it is also incomplete AND shorter than what we already have.
        gm = shouldRegenerate(retryKind) && storyVisible(retry).length < storyVisible(first).length ? first : retry;
      } catch (error) {
        // Dirty close keeps its old contract (bubble up → task retry). For a body we already
        // have, a failed regenerate (e.g. provider 1301 on non-stream) must not lose the reply.
        if (firstKind === "dirty") throw error;
        console.warn({ event: "llm.story_incomplete_retry_failed", error: String(error).slice(0, 300) });
        gm = first;
      }
      // Replace in-memory buffer with the chosen body so flush does not persist the cut.
      if (partialSink) partialSink.onPartial(gm.text || "");
    }
    // Breach on + policy refusal: one reinforced full regenerate (non-stream). Not 续写.
    const refused = breach && isPolicyRefusal(stripBreachAssistantPrefill(gm.text || ""));
    if (refused) {
      console.warn({
        event: "llm.breach_refusal_retry",
        chars: gm.text.length,
        finish_reason: gm.finish_reason || null,
      });
      const reinforced = reinforceBreachMessages(messages);
      gm = await chat(
        env,
        reinforced,
        null,
        settings.llm.temperature,
        outputTokens,
        settings.llm.timeout,
        baseChatOpts,
      );
      if (partialSink) partialSink.onPartial(gm.text || "");
    }
  } finally {
    // No partial flush for story turns: since #54 there are no mid-stream partials, so this
    // flush only pushed the not-yet-final text to Play ("reply visible, still generating")
    // several seconds before completion — and before any #57 regenerate had settled. The
    // reply now appears with the completion broadcast. Just renew the lease here.
    if (partialSink && opts?.ai?.onLeaseTouch) await opts.ai.onLeaseTouch().catch(() => undefined);
  }
  const { visible, trailer } = parseTrailer(gm.text);
  // length = provider hit max_tokens (GLM CoT shares this pool); missing finish_reason after a
  // streamed body usually means the upstream closed early (incomplete SSE).
  const hitLength = gm.finish_reason === "length";
  // Command Code is asked for stream_options.include_usage. Clean completions always carry
  // prompt_tokens>0. A stop/[DONE] with usage=0 means the socket died before the usage chunk.
  const missingStreamUsage = Boolean(partialSink) && !(gm.usage?.prompt_tokens > 0);
  const incompleteStream = Boolean(partialSink) && missingStreamUsage && gm.finish_reason !== "length";
  const finalKind = storyFinish(gm, false);
  const abnormalFinish = !hitLength && !incompleteStream && finalKind === "abnormal";
  const truncated = hitLength || incompleteStream || abnormalFinish;
  if (hitLength) warnings.push("回复在 max_tokens 处被截断");
  else if (incompleteStream) warnings.push("回复流提前结束（未收到 usage / 流未完整收尾）");
  else if (abnormalFinish) warnings.push(`上游提前终止回复（finish_reason=${gm.finish_reason}），已整段重试仍未完整`);
  else if (finalKind === "unterminated" && storyRetry) warnings.push("回复疑似在句中结束（已整段重试一次）");
  if (abnormalFinish) {
    console.warn({
      event: "llm.story_abnormal_finish",
      finish_reason: gm.finish_reason || null,
      chars: gm.text.length,
    });
  }
  if (incompleteStream) {
    console.warn({
      event: "llm.stream_incomplete",
      finish_reason: gm.finish_reason || null,
      stream_done: Boolean(gm.stream_done),
      chars: gm.text.length,
    });
  }
  // Strip echoed prefill if the model included it in the completion.
  let replyText = stripBreachAssistantPrefill(visible);
  if (truncated && replyText.trim()) {
    replyText = `${replyText.trimEnd()}\n\n${hitLength ? TRUNCATION_NOTE : TRUNCATION_NOTE_INCOMPLETE}`;
  }
  if (!replyText.trim()) throw new LlmEmptyError();
  // Story reply is user-visible immediately. commit_turn (state/memory) is deferred
  // off this critical path so a 45–180s failed tool call cannot hold the lease.
  const deferCommit = Boolean(opts?.ai);
  const nextScene = Object.keys(trailer).length ? applyScenePatch(scene, trailer) : scene;
  const remembered: string[] = [];
  const commitUsage: AiUsage = { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cached_input_tokens: 0 };
  let events = trailerEvents(trailer);
  let memoryOps = [
    ...trailerMemoryCandidates(trailer),
    ...(Array.isArray(trailer.memory)
      ? trailer.memory.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : []),
  ];
  if (deferCommit) {
    // Structured commit overwrites trailer memory/events in the background job.
    events = [];
    memoryOps = [];
  }
  await fs.put(`sessions/${sessionId}/state.yaml`, sceneYaml(nextScene));

  let appliedMemoryOps: MemoryMutation[] = [];
  const limits = {
    world: settings.memory.world_char_limit,
    player: settings.memory.player_char_limit,
    character: settings.memory.character_char_limit,
  };
  const planned = planMemoryChanges(pack, nextScene, memoryOps);
  const memoryEventRecords = planned.eventRecords;
  const batch = applyMemoryBatch(memory, planned.mutations, limits);
  if (batch.success) {
    appliedMemoryOps = batch.applied;
    await persistMemoryChanges(fs, memory, batch.touched);
    remembered.push(
      ...batch.applied
        .filter((operation) => operation.action !== "remove")
        .map((operation) =>
          String(operation.content || "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .slice(0, 80),
        ),
    );
  } else {
    warnings.push(`长期记忆写入失败：${batch.message}`);
  }

  const stateUpdated = stableStringify(scene) !== stableStringify(nextScene);
  const hiddenPromptEvents: NonNullable<TurnOut["hidden_prompt_events"]> = [];
  if (stateUpdated) {
    hiddenPromptEvents.push({
      kind: "context",
      content: `## 场景状态变化\n${sceneYaml(nextScene)}`,
      hashSeed: `state:${stableStringify(nextScene)}`,
    });
  }
  if (appliedMemoryOps.length) {
    hiddenPromptEvents.push({
      kind: "memory",
      content: memoryPromptDelta(appliedMemoryOps),
      hashSeed: `memory:${stableStringify(appliedMemoryOps)}`,
    });
  }
  const spotlightIds = unique([...asIdList(trailer.spotlight), ...mentionIds]);
  const assistant = {
    role: "assistant",
    content: replyText,
    ts: nowIso(),
    ...(opts?.ai?.taskId ? { task_id: opts.ai.taskId } : {}),
  };
  const provisionalMessages = userAlreadyPersisted
    ? [...loaded.messages, assistant]
    : [
        ...loaded.messages,
        { role: "user", content: userText, ts: nowIso(), ...(opts?.ai?.taskId ? { task_id: opts.ai.taskId } : {}) },
        assistant,
      ];
  const turnNumber = roleplayOnlyMessages(provisionalMessages).filter((m) => m.role === "user").length;
  const threadId = loaded.thread_id;
  // Reload-merge: do not write the mid-turn snapshot over a concurrent compact or newer tip.
  const nextMessages = await appendTurnMessages(
    fs,
    sessionId,
    {
      userText,
      assistant,
      taskId: opts?.ai?.taskId,
      userAlreadyPersisted,
    },
    {
      thread_id: threadId,
      nmem_space: loaded.nmem_space,
      primary_character: primaryCharacter,
    },
  );
  const aiUsage = addUsage(gm.usage, commitUsage);
  const storyFinishDiag: StoryFinishDiag = {
    finish_reason: gm.finish_reason || null,
    first_finish_reason: firstFinishReason,
    completion_tokens: gm.usage?.completion_tokens || 0,
    retry: storyRetry,
  };
  const requestHash = gm.request_body ? await sha256(gm.request_body) : undefined;
  // The reply is durable in R2 now. Flip the task to completed and broadcast BEFORE the
  // remaining bookkeeping (event log, trace, last_turn.json), so Play shows the reply and
  // "completed" at the same moment. commit_turn / compaction stay background work.
  if (opts?.ai?.onReplyPersisted) {
    await opts.ai.onReplyPersisted({
      text: replyText,
      ai_usage: aiUsage,
      response_cache_status: gm.response_cache_status,
      request_hash: requestHash,
      stable_prefix_tokens: stablePrefixTokens,
      volatile_tokens: volatileTokens,
      hidden_prompt_events: hiddenPromptEvents,
      story_finish: storyFinishDiag,
    });
  }
  await appendEvents(fs, sessionId, [...events.map((item) => enrichRecord(item, nextScene)), ...memoryEventRecords]);
  await appendTrace(fs, sessionId, {
    turn: turnNumber,
    primary: primaryId,
    minis: assembled.mini_ids,
    lore: assembled.lore_titles,
    memories: remembered,
    state_before: scene,
    state_after: nextScene,
    token_usage: {
      estimated_total: assembled.report.total,
      max: assembled.report.max_tokens,
      generation_reserve: assembled.report.generation_reserve,
      tool_reserve: assembled.report.tool_reserve,
      phi: assembled.report.phi_tokens,
    },
    warnings,
    ts: nowIso(),
  });
  const pressureCompact = shouldCompactAfterTurn({
    promptTokens: aiUsage.prompt_tokens,
    estimatedTotal: assembled.report.total,
    contextMax: assembled.report.max_tokens,
    threshold: settings.compression_threshold,
  });
  // Rare safety fallback when turn count is very high even if estimates stay under threshold.
  const turnFallback = turnNumber >= settings.compact_after_turns;
  const shouldCompact = pressureCompact || turnFallback;
  // Do NOT await runCompact here — it blocks the generation lease/UI. Callers schedule
  // background compact via waitUntil after the reply is completed/persisted.
  await fs.put(
    `sessions/${sessionId}/last_turn.json`,
    JSON.stringify(
      {
        warnings,
        remembered,
        state_updated: stateUpdated,
        hidden_prompt_events: hiddenPromptEvents,
        should_compact: shouldCompact,
        should_commit: deferCommit,
        commit_pending: deferCommit,
        commit_applied: false,
        scene_before: scene,
        compact_pressure: {
          prompt_tokens: aiUsage.prompt_tokens,
          estimated_total: assembled.report.total,
          context_max: assembled.report.max_tokens,
          threshold: settings.compression_threshold,
          pressure_hit: pressureCompact,
          turn_fallback: turnFallback,
          turn_number: turnNumber,
        },
        rotate_prompt_epoch_reason: null,
        task_id: opts?.ai?.taskId || null,
        ai_usage: aiUsage,
        response_cache_status: gm.response_cache_status,
        story_finish: storyFinishDiag,
        request_hash: requestHash ?? null,
        stable_prefix_tokens: stablePrefixTokens,
        volatile_tokens: volatileTokens,
        completed_at: nowIso(),
      },
      null,
      2,
    ),
    "application/json",
  );
  return {
    text: replyText,
    scene: nextScene,
    messages: nextMessages,
    spotlight_ids: spotlightIds,
    warnings,
    truncated,
    context_report: assembled.report,
    ai_usage: aiUsage,
    response_cache_status: gm.response_cache_status,
    story_finish: storyFinishDiag,
    request_hash: requestHash,
    stable_prefix_tokens: stablePrefixTokens,
    volatile_tokens: volatileTokens,
    hidden_prompt_events: hiddenPromptEvents,
    should_compact: shouldCompact,
    should_commit: deferCommit,
    scene_before: scene,
  };
}

function mentionPrompt(pack: WorldPack, userText: string, mentionIds: string[]): string {
  if (!mentionIds.length) return userText;
  const names = mentionIds.map((id) => pack.cast.find((member) => member.id === id || member.name === id)?.name || id);
  return `${userText}\n\n（请给${names.join("、")}更多台词。只回复一次。）`;
}

function withPhiMsgs(messages: LlmMessage[], phi: string): LlmMessage[] {
  return phi ? [...messages, { role: "system", content: phi }] : messages;
}

function resolveMemoryCharacterId(
  pack: WorldPack | null | undefined,
  raw: string | null,
): { ok: true; characterId: string | null } | { ok: false; message: string } {
  if (!raw) return { ok: false, message: "character target requires character_id" };
  if (!pack) return { ok: true, characterId: raw };
  const member = pack.cast.find(
    (item) => item.id === raw || item.name === raw || item.aliases.some((alias) => alias === raw),
  );
  if (!member) return { ok: false, message: `unknown character_id '${raw}' — use an id from the cast` };
  return { ok: true, characterId: member.id };
}

async function runMemoryTool(
  fs: R2Fs,
  memory: MemoryStore,
  settings: AppSettings,
  name: string,
  args: Record<string, unknown>,
  pack?: WorldPack | null,
): Promise<string> {
  if (name !== "memory") return JSON.stringify({ success: false, error: `unknown tool: ${name}` });
  const target = String(args.target || "");
  if (target === "user_setting" || target === "player_setting" || target === "PLAYER.md") {
    return JSON.stringify({
      success: false,
      message: "PLAYER.md is player-authored and cannot be modified by the memory tool",
      current_entries: [],
    });
  }
  if (target !== "world" && target !== "player" && target !== "character") {
    return JSON.stringify({ success: false, message: `unknown target: ${target}`, current_entries: [] });
  }
  let characterId = args.character_id ? String(args.character_id) : null;
  if (target === "character") {
    const resolved = resolveMemoryCharacterId(pack, characterId);
    if (!resolved.ok) {
      return JSON.stringify({ success: false, message: resolved.message, current_entries: [] });
    }
    characterId = resolved.characterId;
  } else {
    characterId = null;
  }
  const typedTarget = target as MemoryTarget;
  const limits = {
    world: settings.memory.world_char_limit,
    player: settings.memory.player_char_limit,
    character: settings.memory.character_char_limit,
  };
  const existing =
    target === "world"
      ? memory.world
      : target === "player"
        ? memory.player
        : characterId
          ? memory.characters[characterId] || []
          : [];
  const rawOperations = Array.isArray(args.operations) ? args.operations : [];
  if (rawOperations.length) {
    const operations: MemoryMutation[] = [];
    for (const operation of rawOperations) {
      if (!operation || typeof operation !== "object") continue;
      const action = String(operation.action || "") as MemoryMutation["action"];
      const content = String(operation.content || "");
      const gated = gateMemoryWrite(action, content);
      if (!gated.ok) {
        return JSON.stringify({
          success: false,
          done: false,
          message: gated.reason,
          target,
          current_entries: existing,
        });
      }
      operations.push({
        action,
        target: typedTarget,
        characterId,
        content,
        oldText: String(operation.old_text || ""),
      });
    }
    const batch = applyMemoryBatch(memory, operations, limits);
    if (batch.success) await persistMemoryChanges(fs, memory, batch.touched);
    return JSON.stringify({
      success: batch.success,
      done: batch.success,
      message: batch.message,
      target,
      current_entries: batch.success ? undefined : batch.currentEntries || existing,
    });
  }
  const singleAction = String(args.action || "");
  const singleContent = String(args.content || "");
  const singleGate = gateMemoryWrite(singleAction, singleContent);
  if (!singleGate.ok) {
    return JSON.stringify({ success: false, message: singleGate.reason, target, live: existing });
  }
  if (singleAction === "add" && memoryIsDuplicate(singleContent, existing)) {
    return JSON.stringify({ success: true, message: "duplicate memory skipped", target, live: existing });
  }
  const result = applyMemory(
    memory,
    singleAction,
    target,
    singleContent,
    String(args.old_text || ""),
    characterId,
    limits,
  );
  if (result.success) await persistMemory(fs, memory, target, characterId);
  return JSON.stringify({ success: result.success, message: result.message, target, live: result.live });
}

export type CompactResult = { summary: string; warnings: string[]; applied: boolean };

export async function runCompact(
  env: Env,
  fs: R2Fs,
  memory: MemoryStore,
  messages: ChatMessage[],
  sessionId: string,
  loaded: {
    thread_id: string | null;
    nmem_space: string | null;
    primary_character?: string | null;
    compact_roleplay_count?: number | null;
  },
  library: PromptLibrary,
  settings: AppSettings,
  pack: WorldPack,
  _waitUntil?: (job: Promise<unknown>) => void,
  aiOptions?: AiRequestOptions,
): Promise<CompactResult> {
  const warnings: string[] = [];
  const outputTokens = effectiveOutputTokens(settings, aiOptions?.model, "compact");
  const roleplayMessages = roleplayOnlyMessages(messages);
  const roleplayUa = roleplayUserAssistant(roleplayMessages);

  const summaryFile = ((await fs.get(`sessions/${sessionId}/summary.md`)) || "").trim();
  const previousFromMessages = storySummary(roleplayMessages);
  const previousSummary =
    summaryFile && !summaryFile.startsWith("（摘要已因编辑")
      ? summaryFile
      : previousFromMessages && !previousFromMessages.startsWith("（摘要已因编辑")
        ? previousFromMessages
        : "";

  const sessionMeta = await loadSession(fs, sessionId).catch(() => null);
  const compactRoleplayCount = loaded.compact_roleplay_count ?? sessionMeta?.compact_roleplay_count ?? null;

  const incremental = buildIncrementalCompactInput(roleplayUa, previousSummary, compactRoleplayCount);
  const values: Record<string, string> = {
    transcript: incremental.transcript,
    previous_summary: incremental.previous_summary || "（无）",
    memory: memory.world.join("\n§\n"),
    player: memory.player.join("\n§\n"),
  };
  const extra = breachSystem(library, settings.llm.breach);
  const phi = breachPhi(library, settings.llm.breach);
  let flushSystem = library.render("memory_flush.md", values);
  if (extra) flushSystem = `${extra}\n\n${flushSystem}`;
  // Before compact: flush durable facts into bounded MemoryStore (Hermes).
  await toolLoop(
    env,
    [
      { role: "system", content: flushSystem },
      { role: "user", content: library.render("memory_flush_user.md", values) },
    ],
    [memoryToolSpec(library)],
    (name, args) => runMemoryTool(fs, memory, settings, name, args, pack),
    settings.max_tool_rounds,
    phi,
    settings.llm.temperature,
    outputTokens,
    settings.llm.timeout,
    aiOptions,
  );
  freezeMemory(memory);
  values.memory = memory.snapWorld;
  values.player = memory.snapPlayer;
  let compactSystem = library.render("compact.md", values);
  if (extra) compactSystem = `${extra}\n\n${compactSystem}`;

  const askSummary = async (userPrompt: string) => {
    const result = await chat(
      env,
      withPhiMsgs(
        [
          { role: "system", content: compactSystem },
          { role: "user", content: userPrompt },
        ],
        phi,
      ),
      null,
      0.3,
      outputTokens,
      settings.llm.timeout,
      aiOptions,
    );
    return result.text.trim();
  };

  let summary = await askSummary(library.render("compact_user.md", values));
  if (!summary || isBadCompactSummary(formatCompactSummaryForStorage(summary))) {
    warnings.push("compact summary failed validation; retrying with stricter schema prompt");
    const strictUser =
      library.render("compact_user.md", values) +
      "\n\n【校验失败·重试】必须保留标记【压缩摘要·时间线】与全部必填小节标题；只许短子弹；禁止对白与场景散文；不超过2000汉字。";
    summary = await askSummary(strictUser);
  }

  if (!summary || isBadCompactSummary(formatCompactSummaryForStorage(summary))) {
    warnings.push("compact summary still invalid after retry; kept previous summary.md and full transcript");
    // Do not wipe transcript; do not overwrite a good previous summary with garbage.
    return { summary: previousSummary || summary || "", warnings, applied: false };
  }

  const formatted = formatCompactSummaryForStorage(summary);
  // Keep ALL user/assistant history; only replace the compact system summary message.
  // CRITICAL: reload before write. Deferred compact runs while the next turn may already
  // have appended user/assistant messages — saving the stale `messages` snapshot would
  // wipe those newer turns (history "rolls back" to an older segment).
  const fresh = await loadSession(fs, sessionId);
  const next = upsertCompactSummaryMessage(fresh.messages, formatted, nowIso());
  // Cursor counts only what this compact summarized, not messages that arrived mid-flight.
  await saveSession(fs, sessionId, next, {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    primary_character: loaded.primary_character ?? null,
    compact_roleplay_count: roleplayUa.length,
    compact_at_message_count: next.length,
    last_compact_summary_chars: formatted.length,
  });
  await fs.put(`sessions/${sessionId}/summary.md`, `${formatted}\n`);
  return { summary: formatted, warnings, applied: true };
}

export type DeferredPostTurnCompactInput = {
  env: Env;
  fs: R2Fs;
  pack: WorldPack;
  sessionId: string;
  settings: AppSettings;
  overlays: Record<string, string>;
  waitUntil?: (job: Promise<unknown>) => void;
  db?: D1Database;
  ai?: AiRequestOptions;
};

/**
 * Background post-turn compact for the *next* turn's lean window.
 * Failures are logged into last_turn warnings and must not fail the completed story turn.
 */
export async function runDeferredPostTurnCompact(input: DeferredPostTurnCompactInput): Promise<CompactResult> {
  const loaded = await loadSession(input.fs, input.sessionId);
  const memory = await loadMemory(input.fs);
  const library = new PromptLibrary(input.overlays);
  let compactResult: CompactResult;
  try {
    compactResult = await runCompact(
      input.env,
      input.fs,
      memory,
      loaded.messages,
      input.sessionId,
      loaded,
      library,
      input.settings,
      input.pack,
      input.waitUntil,
      input.ai,
    );
  } catch (err) {
    compactResult = { summary: "", warnings: [`background compact failed: ${String(err)}`], applied: false };
  }
  if (compactResult.applied && input.db) {
    try {
      await createPromptEpoch(input.db, input.sessionId, "context_compacted");
    } catch (err) {
      compactResult.warnings.push(`prompt epoch rotate after compact failed: ${String(err)}`);
    }
  }
  try {
    const raw = await input.fs.get(`sessions/${input.sessionId}/last_turn.json`);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const prevWarnings = Array.isArray(prev.warnings) ? (prev.warnings as string[]) : [];
    await input.fs.put(
      `sessions/${input.sessionId}/last_turn.json`,
      JSON.stringify(
        {
          ...prev,
          warnings: [...prevWarnings, ...compactResult.warnings],
          should_compact: false,
          rotate_prompt_epoch_reason: compactResult.applied ? "context_compacted" : null,
          compact_applied: compactResult.applied,
          background_compact_completed_at: nowIso(),
        },
        null,
        2,
      ),
      "application/json",
    );
  } catch {
    // Diagnostics-only; story turn already completed.
  }
  return compactResult;
}

function memoryFailureFeedback(
  memory: MemoryStore,
  failed: Array<{ operation: MemoryMutation; message: string }>,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { operation, message } of failed) {
    lines.push(
      `- 失败：${stableStringify({ action: operation.action, target: operation.target, character_id: operation.characterId || null, content: operation.content || "", old_text: operation.oldText || "" })} → ${message}`,
    );
    const key = `${operation.target}:${operation.characterId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entries =
      operation.target === "world"
        ? memory.world
        : operation.target === "player"
          ? memory.player
          : memory.characters[operation.characterId || ""] || [];
    lines.push(`  当前 ${key} 条目（${entries.join("\n§\n").length} 字）：${stableStringify(entries)}`);
  }
  return lines.join("\n");
}

export type DeferredTurnCommitInput = {
  env: Env;
  fs: R2Fs;
  pack: WorldPack;
  sessionId: string;
  userText: string;
  assistantText: string;
  settings: AppSettings;
  overlays: Record<string, string>;
  sceneBefore: SceneState;
  db?: D1Database;
  ai?: {
    taskId: string;
    model: AiModelConfig;
    affinityKey?: string;
  };
};

export type DeferredTurnCommitResult = {
  warnings: string[];
  applied: boolean;
  skippedState: boolean;
};

/** Skip state.yaml if this commit already landed or a newer turn owns last_turn. */
export function deferredSceneWriteDecision(input: {
  thisTaskId?: string | null;
  lastTurnTaskId?: string | null;
  alreadyApplied?: boolean;
}): { apply: boolean; warning?: string } {
  if (input.alreadyApplied) {
    return { apply: false, warning: "deferred commit already applied" };
  }
  if (input.thisTaskId && input.lastTurnTaskId && input.lastTurnTaskId !== input.thisTaskId) {
    return {
      apply: false,
      warning: "deferred commit skipped state.yaml (newer turn landed; last-write-wins avoided)",
    };
  }
  return { apply: true };
}

export function sessionMovedPastTurn(
  messages: Array<{ role: string; task_id?: string; content?: string }>,
  input: { taskId?: string | null; assistantText: string },
): boolean {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if ((input.taskId && message.task_id === input.taskId) || message.content === input.assistantText) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return false;
  return messages.slice(idx + 1).some((message) => message.role === "user");
}

async function mergeLastTurnDiagnostics(
  fs: R2Fs,
  sessionId: string,
  patch: Record<string, unknown>,
  extraWarnings: string[] = [],
): Promise<void> {
  try {
    const raw = await fs.get(`sessions/${sessionId}/last_turn.json`);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const prevWarnings = Array.isArray(prev.warnings) ? (prev.warnings as string[]) : [];
    await fs.put(
      `sessions/${sessionId}/last_turn.json`,
      JSON.stringify({ ...prev, ...patch, warnings: [...prevWarnings, ...extraWarnings] }, null, 2),
      "application/json",
    );
  } catch {
    // Diagnostics-only; story turn already completed.
  }
}

/**
 * Background commit_turn after the story reply is visible / the generation task completed.
 * Failures become last_turn warnings and must not fail the completed story turn.
 */
export async function runDeferredTurnCommit(input: DeferredTurnCommitInput): Promise<DeferredTurnCommitResult> {
  const warnings: string[] = [];
  const taskId = input.ai?.taskId || null;
  let alreadyApplied = false;
  try {
    const raw = await input.fs.get(`sessions/${input.sessionId}/last_turn.json`);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const lastTurnTaskId = typeof prev.task_id === "string" ? prev.task_id : null;
    alreadyApplied = prev.commit_applied === true && (!taskId || lastTurnTaskId === taskId);
  } catch {
    // ignore missing diagnostics
  }
  if (alreadyApplied) {
    return { warnings: ["deferred commit already applied"], applied: false, skippedState: true };
  }

  const library = new PromptLibrary(input.overlays);
  const memory = await loadMemory(input.fs);
  let commit: TurnCommit;
  try {
    commit = await extractTurnCommit(
      input.env,
      library,
      input.pack,
      input.sceneBefore,
      memory,
      input.userText,
      input.assistantText,
      input.settings,
      { model: input.ai?.model, affinityKey: input.ai?.affinityKey },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    await mergeLastTurnDiagnostics(
      input.fs,
      input.sessionId,
      { commit_pending: false, commit_applied: false, background_commit_completed_at: nowIso() },
      warnings,
    );
    return { warnings, applied: false, skippedState: false };
  }

  let lastTurnAfter: Record<string, unknown>;
  try {
    const raw = await input.fs.get(`sessions/${input.sessionId}/last_turn.json`);
    lastTurnAfter = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    lastTurnAfter = {};
  }
  const latestTaskId = typeof lastTurnAfter.task_id === "string" ? lastTurnAfter.task_id : null;
  const loaded = await loadSession(input.fs, input.sessionId);
  const movedOn = sessionMovedPastTurn(loaded.messages, { taskId, assistantText: input.assistantText });
  const decision = deferredSceneWriteDecision({
    thisTaskId: taskId,
    lastTurnTaskId: latestTaskId,
    alreadyApplied: lastTurnAfter.commit_applied === true && (!taskId || latestTaskId === taskId),
  });
  const skipState = !decision.apply || movedOn;
  if (decision.warning) warnings.push(decision.warning);
  if (movedOn && decision.apply) {
    warnings.push("deferred commit skipped state.yaml (newer user turn already queued)");
  }

  let commitWasReplayed = false;
  if (input.db && taskId) {
    const argsHash = await sha256(stableStringify(commit.call.arguments));
    const replay = await getCachedToolExecution(input.db, taskId, commit.call.id, argsHash);
    commitWasReplayed = replay != null;
  }

  const nextScene = commit.state;
  const events = commitWasReplayed ? [] : commit.events;
  const memoryOps = commitWasReplayed ? [] : commit.memoryOps;
  if (!skipState) {
    await input.fs.put(`sessions/${input.sessionId}/state.yaml`, sceneYaml(nextScene));
  }

  const limits = {
    world: input.settings.memory.world_char_limit,
    player: input.settings.memory.player_char_limit,
    character: input.settings.memory.character_char_limit,
  };
  const planned = planMemoryChanges(input.pack, nextScene, memoryOps);
  const batch = applyMemoryBestEffort(memory, planned.mutations, limits);
  let appliedMemoryOps: MemoryMutation[] = [...batch.applied];
  const touched = new Map(batch.touched.map((item) => [`${item.target}:${item.characterId || ""}`, item]));
  let failedOps = batch.failed;
  let memoryRetryUsage: AiUsage | null = null;
  if (failedOps.length) {
    warnings.push(`长期记忆部分写入失败：${batch.message}`);
    // One correction round with the concrete errors + live entries (Hermes-style consolidate).
    try {
      const feedback = memoryFailureFeedback(memory, failedOps);
      const retry = await extractTurnCommit(
        input.env,
        library,
        input.pack,
        input.sceneBefore,
        memory,
        input.userText,
        input.assistantText,
        input.settings,
        { model: input.ai?.model, affinityKey: input.ai?.affinityKey },
        feedback,
      );
      memoryRetryUsage = retry.usage;
      const retryPlanned = planMemoryChanges(input.pack, nextScene, retry.memoryOps);
      const retryBatch = applyMemoryBestEffort(memory, retryPlanned.mutations, limits);
      appliedMemoryOps = [...appliedMemoryOps, ...retryBatch.applied];
      for (const item of retryBatch.touched) touched.set(`${item.target}:${item.characterId || ""}`, item);
      failedOps = retryBatch.failed;
      if (failedOps.length) warnings.push(`长期记忆纠正后仍有失败：${retryBatch.message}`);
    } catch (error) {
      warnings.push(`长期记忆纠正重试失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const remembered: string[] = [];
  if (appliedMemoryOps.length) {
    await persistMemoryChanges(input.fs, memory, [...touched.values()]);
    remembered.push(
      ...appliedMemoryOps
        .filter((operation) => operation.action !== "remove")
        .map((operation) =>
          String(operation.content || "")
            .replace(/^\[[^\]]+\]\s*/, "")
            .slice(0, 80),
        ),
    );
  }

  await appendEvents(input.fs, input.sessionId, [
    ...events.map((item) => enrichRecord(item, nextScene)),
    ...planned.eventRecords,
  ]);

  if (input.db && taskId && !commitWasReplayed) {
    await recordToolExecution(input.db, {
      taskId,
      toolCallId: commit.call.id,
      toolName: commit.call.name,
      arguments: commit.call.arguments,
      result: stableStringify({ state: nextScene, events, memory_ops: appliedMemoryOps }),
    });
  }

  const hiddenPromptEvents: NonNullable<TurnOut["hidden_prompt_events"]> = [];
  if (!skipState) {
    hiddenPromptEvents.push({
      kind: "context",
      content: `## 场景状态变化\n${sceneYaml(nextScene)}`,
      hashSeed: `state:${stableStringify(nextScene)}`,
    });
  }
  if (appliedMemoryOps.length) {
    hiddenPromptEvents.push({
      kind: "memory",
      content: memoryPromptDelta(appliedMemoryOps),
      hashSeed: `memory:${stableStringify(appliedMemoryOps)}`,
    });
  }

  let promptEventsWritten = 0;
  if (input.db && hiddenPromptEvents.length) {
    try {
      promptEventsWritten = await appendHiddenPromptEvents(input.db, input.sessionId, hiddenPromptEvents, taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`prompt event append failed: ${message}`);
    }
  }

  await mergeLastTurnDiagnostics(
    input.fs,
    input.sessionId,
    {
      commit_pending: false,
      commit_applied: true,
      state_updated: !skipState,
      remembered,
      hidden_prompt_events: hiddenPromptEvents,
      prompt_events_written: promptEventsWritten,
      background_commit_completed_at: nowIso(),
      background_commit_usage: memoryRetryUsage ? addUsage(commit.usage, memoryRetryUsage) : commit.usage,
      memory_ops_requested: planned.mutations.length,
      memory_ops_applied: appliedMemoryOps.length,
      memory_ops_failed: failedOps.length,
    },
    warnings,
  );
  return { warnings, applied: true, skippedState: skipState };
}

/** Run commit (if any) then compact after the reply is done; never blocks the caller. */
export function schedulePostTurnFollowup(
  waitUntil: ((job: Promise<unknown>) => void) | undefined,
  jobs: { commit?: () => Promise<unknown>; compact?: () => Promise<unknown> },
): void {
  if (!jobs.commit && !jobs.compact) return;
  if (!waitUntil) {
    console.warn("post-turn followup needed but waitUntil unavailable; skipping");
    return;
  }
  waitUntil(
    Promise.resolve().then(async () => {
      if (jobs.commit) {
        try {
          await jobs.commit();
        } catch (err) {
          console.warn("background turn-commit failed:", err);
        }
      }
      if (jobs.compact) {
        try {
          await jobs.compact();
        } catch (err) {
          console.warn("background post-turn compact failed:", err);
        }
      }
    }),
  );
}

/** Schedule deferred compact after the reply is done; never blocks the caller. */
export function schedulePostTurnCompact(
  waitUntil: ((job: Promise<unknown>) => void) | undefined,
  shouldCompact: boolean,
  job: () => Promise<unknown>,
): void {
  if (!shouldCompact) return;
  schedulePostTurnFollowup(waitUntil, { compact: job });
}

function asIdList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return [];
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
