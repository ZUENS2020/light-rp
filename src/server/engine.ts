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
  memoryIsDuplicate,
  parseContextConfig,
  parseMiniConfig,
  routeMemoryCandidate,
  type ContextReport,
} from "../core/budget";
import {
  aliasMap,
  appendEvents,
  applyMemory,
  applyMemoryBatch,
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
  type AiUsage,
  type ResponseCacheStatus,
} from "../core/ai";
import {
  formatNmemRecall,
  listNmemSpaces,
  loadNmemIndex,
  resolveSpaceId,
  saveNmemIndex,
  searchNmem,
  sessionThreadId,
  syncFactToNmem,
  syncThreadTurn,
  syncTurnBodyToNmem,
} from "../adapters/nmem";
import { memoryToolSpec, PromptLibrary, turnCommitToolSpec } from "../core/prompts";
import type { R2Fs } from "../adapters/r2";
import { STORY_OUTPUT_TOKEN_FLOOR, type AppSettings } from "./settings";
import { nowIso } from "../core/util";
import { preparePrompt } from "./prompt-state";
import { getCachedToolExecution, recordToolExecution } from "./tasks";
import { selectedNmemSpace, shouldRecallMemory } from "../core/memory";
import { recordMemoryRecall } from "./memory";
import { parseSystemCommand, roleplayOnlyMessages } from "../core/commands";

export type TurnOut = {
  text: string;
  scene: SceneState;
  messages: ChatMessage[];
  spotlight_ids: string[];
  warnings: string[];
  nmem_synced: boolean;
  nmem_available: boolean;
  truncated?: boolean;
  context_report?: ContextReport;
  ai_usage?: AiUsage;
  response_cache_status?: ResponseCacheStatus;
  request_hash?: string;
  stable_prefix_tokens?: number;
  volatile_tokens?: number;
  hidden_prompt_events?: Array<{ kind: "context" | "memory"; content: string; hashSeed?: string }>;
  rotate_prompt_epoch_reason?: "context_compacted";
};

export type RunTurnOptions = {
  persistUser?: boolean;
  deferNmemWrites?: boolean;
  ai?: {
    db: D1Database;
    taskId: string;
    model: AiModelConfig;
    requestKind?: "story" | "rewrite" | "regenerate";
  };
};

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

const NMEM_RECALL_DEADLINE_MS = 8_000;

async function withinDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时（${Math.round(milliseconds / 1_000)}s）`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { STORY_OUTPUT_TOKEN_FLOOR };

function isStoryOutputKind(kind?: AiRequestOptions["requestKind"]): boolean {
  return kind == null || kind === "story" || kind === "rewrite" || kind === "regenerate";
}

export function effectiveOutputTokens(
  settings: AppSettings,
  model?: AiModelConfig,
  requestKind?: AiRequestOptions["requestKind"],
): number {
  const configured = Math.max(1, Math.floor(settings.llm.max_tokens));
  const wanted = isStoryOutputKind(requestKind) ? Math.max(configured, STORY_OUTPUT_TOKEN_FLOOR) : configured;
  return model ? Math.min(wanted, Math.max(1, Math.floor(model.max_output_tokens))) : wanted;
}

export function effectiveContextConfig(settings: AppSettings, model?: AiModelConfig) {
  const outputTokens = effectiveOutputTokens(settings, model);
  const configuredWindow = Math.max(1, Math.floor(settings.context.max_tokens));
  const modelWindow = model ? Math.max(1, Math.floor(model.context_window)) : configuredWindow;
  const reserved = Math.max(settings.context.generation_reserve, outputTokens);
  const modelOutputCap = model ? Math.max(1, Math.floor(model.max_output_tokens)) : reserved;
  return parseContextConfig({
    ...settings.context,
    max_tokens: Math.min(configuredWindow, modelWindow),
    generation_reserve: Math.min(reserved, modelOutputCap),
  });
}

export async function runOoc(
  env: Env,
  fs: R2Fs,
  pack: WorldPack,
  sessionId: string,
  rawText: string,
  settings: AppSettings,
  options: { model: AiModelConfig; affinityKey?: string; taskId?: string },
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
  const result = await chat(
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
    { model: options.model, affinityKey: options.affinityKey, requestKind: "ooc" },
  );
  const assistant = {
    role: "assistant",
    content: result.text.trim(),
    ts: nowIso(),
    ...(options.taskId ? { task_id: options.taskId } : {}),
  };
  if (!assistant.content) throw new LlmEmptyError();
  const last = loaded.messages[loaded.messages.length - 1];
  const messages =
    last?.role === "user" && last.content === rawText
      ? [...loaded.messages, assistant]
      : [
          ...loaded.messages,
          { role: "user", content: rawText, ts: nowIso(), ...(options.taskId ? { task_id: options.taskId } : {}) },
          assistant,
        ];
  await saveSession(fs, sessionId, messages, {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    primary_character: loaded.primary_character,
    title: loaded.title,
  });
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
) {
  const depth = pack.lore_scan_depth || settings.lore_scan_depth;
  const context = parseContextConfig(settings.context);
  const budget = pack.lore_token_budget || settings.lore_token_budget || context.budget.lore;
  const recent = messages.slice(-depth);
  const haystack = `${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n${extra}`;
  return triggerLore(await loadAllLore(fs, cards), haystack, sceneLoreHaystack(pack, scene), budget);
}

export const TRUNCATION_NOTE = "（回复在 max_tokens 处被截断）";

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
  settings: AppSettings,
  recentHaystack: string,
  userText = "",
): Promise<{ minis: MiniCard[]; loreCards: CharacterCard[] }> {
  const miniCfg = parseMiniConfig(settings.mini);
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

function planMemoryChanges(
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
  const present = stringList(rawState.present)
    .map(
      (rawId) =>
        pack.cast.find(
          (member) => member.id === rawId || member.name === rawId || member.aliases.some((alias) => alias === rawId),
        )?.id,
    )
    .filter((id): id is string => Boolean(id));
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
  const memorySnapshot = {
    world: memory.world,
    player: memory.player,
    characters: memory.characters,
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
        `已有长期记忆：\n${stableStringify(memorySnapshot)}`,
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
  const commitMaxTokens = Math.min(1_536, effectiveOutputTokens(settings, options.model, "tool"));
  const requestKind = memoryFeedback ? "correction" : "memory";
  const commitOptions = {
    ...options,
    requestKind,
    skipCache: Boolean(memoryFeedback) || options.skipCache,
    skipOutputChannelRetry: true,
  };
  const requestJson = () => chat(env, messages, null, 0, commitMaxTokens, settings.llm.timeout, commitOptions);
  const requestTool = () =>
    chat(env, messages, [tool], 0, commitMaxTokens, settings.llm.timeout, {
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
  waitUntil?: (job: Promise<unknown>) => void,
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
  let listed: Awaited<ReturnType<typeof listNmemSpaces>> = { available: false, spaces: [] };
  let spaceId: string | null = null;
  let recall = "";
  if (settings.nmem.enabled) {
    try {
      const outcome = await withinDeadline(
        (async () => {
          const registry = await listNmemSpaces(env);
          const resolvedSpaceId = resolveSpaceId(
            selectedNmemSpace(loaded.nmem_space, pack.nmem_space, settings.nmem.space),
            registry.spaces,
          );
          const rows =
            resolvedSpaceId && registry.available && shouldRecallMemory(userText)
              ? await searchNmem(env, resolvedSpaceId, userText, 8, ["light-rp", `world:${pack.id}`])
              : [];
          return { registry, resolvedSpaceId, rows };
        })(),
        NMEM_RECALL_DEADLINE_MS,
        "nmem 召回",
      );
      listed = outcome.registry;
      spaceId = outcome.resolvedSpaceId;
      recall = formatNmemRecall(outcome.rows);
      if (opts?.ai && spaceId && outcome.rows.length) {
        await recordMemoryRecall(opts.ai.db, {
          workspaceId: pack.id,
          sessionId,
          taskId: opts.ai.taskId,
          spaceId,
          query: userText,
          rows: outcome.rows,
        });
      }
    } catch (err) {
      listed = { available: false, spaces: [], error: err instanceof Error ? err.message : String(err) };
      warnings.push(`nmem 召回失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (settings.nmem.enabled && !listed.available && !warnings.some((warning) => warning.startsWith("nmem 召回失败"))) {
    warnings.push(`nmem 不可用: ${listed.error || "连接失败"}`);
  }
  const mentionIds = parseMentions(userText, aliasMap(pack.cast));
  const primaryId = resolvePrimaryId(pack, scene, primaryCharacter);
  const primaryMember = primaryId ? pack.cast.find((item) => item.id === primaryId) : undefined;
  const primaryCards = primaryMember ? await loadMemberCards(fs, [primaryMember]) : [];
  const miniCfg = parseMiniConfig(settings.mini);
  const contextCfg = effectiveContextConfig(settings, opts?.ai?.model);
  const outputTokens = effectiveOutputTokens(settings, opts?.ai?.model, opts?.ai?.requestKind || "story");
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
    settings,
    recentHaystack,
    userText,
  );
  const lore = await triggered(fs, pack, scene, roleplayMessages, userText, settings, [...primaryCards, ...loreCards]);
  const promptUser = mentionPrompt(pack, userText, mentionIds);
  const breach = settings.llm.breach;
  const loreBudget = pack.lore_token_budget || settings.lore_token_budget || contextCfg.budget.lore;
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
  const assembled = assembleBudgeted(
    library,
    pack,
    memory,
    scene,
    primaryCards,
    lore,
    recall,
    historyMessages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m) => ({ role: m.role, content: m.content })),
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
    });
    messages = prepared.messages;
    affinity = prepared.affinityKey;
    stablePrefixTokens = prepared.stablePrefixTokens;
    volatileTokens = prepared.volatileTokens;
  }
  let nmemIndex = await loadNmemIndex((path) => fs.get(path));
  const syncNmem = async (target: string, characterId: string | null, live: string[]) => {
    if (opts?.deferNmemWrites) return;
    if (!spaceId) return;
    try {
      nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, pack.id, target, characterId, live);
      await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
    } catch (err) {
      warnings.push(`nmem 记忆同步失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const gm = await chat(env, messages, null, settings.llm.temperature, outputTokens, settings.llm.timeout, {
    model: opts?.ai?.model,
    affinityKey: affinity,
    requestKind: opts?.ai?.requestKind || "story",
    skipCache: opts?.ai?.requestKind === "rewrite" || opts?.ai?.requestKind === "regenerate",
  });
  const { visible, trailer } = parseTrailer(gm.text);
  const truncated = gm.finish_reason === "length";
  if (truncated) warnings.push("回复在 max_tokens 处被截断");
  let replyText = visible;
  if (truncated && replyText.trim()) replyText = `${replyText.trimEnd()}\n\n${TRUNCATION_NOTE}`;
  if (!replyText.trim()) throw new LlmEmptyError();
  let nextScene = scene;
  const remembered: string[] = [];
  let commitUsage: AiUsage = { prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0 };
  let commitRecord: { call: TurnCommit["call"]; result: string } | undefined;
  let activeCommit: TurnCommit | undefined;
  let commitWasReplayed = false;
  let events = trailerEvents(trailer);
  let memoryOps = [
    ...trailerMemoryCandidates(trailer),
    ...(Array.isArray(trailer.memory)
      ? trailer.memory.filter(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : []),
  ];
  if (opts?.ai) {
    try {
      const commit = await extractTurnCommit(env, library, pack, scene, memory, userText, replyText, settings, {
        model: opts.ai.model,
        affinityKey: affinity,
      });
      activeCommit = commit;
      const argsHash = await sha256(stableStringify(commit.call.arguments));
      const replay = await getCachedToolExecution(opts.ai.db, opts.ai.taskId, commit.call.id, argsHash);
      commitWasReplayed = replay != null;
      nextScene = commit.state;
      events = replay == null ? commit.events : [];
      memoryOps = replay == null ? commit.memoryOps : [];
      commitUsage = commit.usage;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(message);
    }
  } else if (Object.keys(trailer).length) {
    nextScene = applyScenePatch(scene, trailer);
  }
  await fs.put(`sessions/${sessionId}/state.yaml`, sceneYaml(nextScene));

  let appliedMemoryOps: MemoryMutation[] = [];
  let memoryEventRecords: Record<string, unknown>[];
  const limits = {
    world: settings.memory.world_char_limit,
    player: settings.memory.player_char_limit,
    character: settings.memory.character_char_limit,
  };
  let consolidationFailures = 0;
  while (true) {
    const planned = planMemoryChanges(pack, nextScene, memoryOps);
    memoryEventRecords = planned.eventRecords;
    const batch = applyMemoryBatch(memory, planned.mutations, limits);
    if (batch.success) {
      appliedMemoryOps = batch.applied;
      await persistMemoryChanges(fs, memory, batch.touched);
      for (const touched of batch.touched) {
        const live =
          touched.target === "world"
            ? memory.world
            : touched.target === "player"
              ? memory.player
              : memory.characters[touched.characterId || ""] || [];
        await syncNmem(touched.target, touched.characterId, live);
      }
      remembered.push(
        ...batch.applied
          .filter((operation) => operation.action !== "remove")
          .map((operation) =>
            String(operation.content || "")
              .replace(/^\[[^\]]+\]\s*/, "")
              .slice(0, 80),
          ),
      );
      break;
    }

    consolidationFailures += 1;
    if (!opts?.ai || !activeCommit || commitWasReplayed || consolidationFailures >= 3) {
      warnings.push(`长期记忆写入失败：${batch.message}`);
      break;
    }
    const feedback = stableStringify({
      error: batch.message,
      current_entries: batch.currentEntries || [],
      rejected_memory_ops: memoryOps,
      attempt: consolidationFailures,
      maximum_attempts: 3,
    });
    let repaired: TurnCommit;
    try {
      repaired = await extractTurnCommit(
        env,
        library,
        pack,
        scene,
        memory,
        userText,
        replyText,
        settings,
        { model: opts.ai.model, affinityKey: affinity, requestKind: "correction", skipCache: true },
        feedback,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`记忆整理失败：${message}`);
      break;
    }
    activeCommit = repaired;
    memoryOps = repaired.memoryOps;
    commitUsage = addUsage(commitUsage, repaired.usage);
  }

  await appendEvents(fs, sessionId, [...events.map((item) => enrichRecord(item, nextScene)), ...memoryEventRecords]);
  if (opts?.ai && activeCommit && !commitWasReplayed) {
    commitRecord = {
      call: activeCommit.call,
      result: stableStringify({ state: nextScene, events, memory_ops: appliedMemoryOps }),
    };
    await recordToolExecution(opts.ai.db, {
      taskId: opts.ai.taskId,
      toolCallId: commitRecord.call.id,
      toolName: commitRecord.call.name,
      arguments: commitRecord.call.arguments,
      result: commitRecord.result,
    });
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
  const nextMessages = userAlreadyPersisted
    ? [...loaded.messages, assistant]
    : [
        ...loaded.messages,
        { role: "user", content: userText, ts: nowIso(), ...(opts?.ai?.taskId ? { task_id: opts.ai.taskId } : {}) },
        assistant,
      ];
  const turnNumber = roleplayOnlyMessages(nextMessages).filter((m) => m.role === "user").length;
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
  let threadId = loaded.thread_id;
  let nmemSynced = false;
  if (spaceId && listed.available && !opts?.deferNmemWrites) {
    threadId = threadId || sessionThreadId(pack.id, sessionId);
    try {
      await syncTurnBodyToNmem(env, spaceId, pack.id, sessionId, userText, replyText);
      nmemSynced = true;
    } catch (err) {
      warnings.push(`nmem 正文写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    const threadJob = syncThreadTurn(
      env,
      spaceId,
      loaded.thread_id,
      threadId,
      `Light RP / ${pack.name} / ${sessionId}`,
      [
        { role: "user", content: userText },
        { role: "assistant", content: replyText },
      ],
      `${sessionId}:${turnNumber}`,
    ).catch((err) => {
      warnings.push(`nmem thread 同步失败: ${err instanceof Error ? err.message : String(err)}`);
    });
    const willCompact = turnNumber >= settings.compact_after_turns;
    if (waitUntil && !willCompact) waitUntil(threadJob);
    else await threadJob;
  }
  await saveSession(fs, sessionId, nextMessages, {
    thread_id: threadId,
    nmem_space: loaded.nmem_space,
    primary_character: primaryCharacter,
  });
  let rotatePromptEpochReason: TurnOut["rotate_prompt_epoch_reason"];
  if (turnNumber >= settings.compact_after_turns) {
    try {
      await runCompact(
        env,
        fs,
        memory,
        nextMessages,
        sessionId,
        { ...loaded, thread_id: threadId, primary_character: primaryCharacter },
        library,
        settings,
        pack.id,
        waitUntil,
        opts?.ai ? { model: opts.ai.model, affinityKey: affinity, requestKind: "compact" } : undefined,
        opts?.deferNmemWrites === true,
      );
      if (opts?.ai) rotatePromptEpochReason = "context_compacted";
    } catch (err) {
      warnings.push(`compact failed: ${String(err)}`);
    }
  }
  await fs.put(
    `sessions/${sessionId}/last_turn.json`,
    JSON.stringify(
      {
        warnings,
        remembered,
        state_updated: stateUpdated,
        hidden_prompt_events: hiddenPromptEvents,
        rotate_prompt_epoch_reason: rotatePromptEpochReason || null,
        task_id: opts?.ai?.taskId || null,
        ai_usage: addUsage(gm.usage, commitUsage),
        response_cache_status: gm.response_cache_status,
        request_hash: gm.request_body ? await sha256(gm.request_body) : null,
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
    nmem_synced: nmemSynced,
    nmem_available: listed.available,
    truncated,
    context_report: assembled.report,
    ai_usage: addUsage(gm.usage, commitUsage),
    response_cache_status: gm.response_cache_status,
    request_hash: gm.request_body ? await sha256(gm.request_body) : undefined,
    stable_prefix_tokens: stablePrefixTokens,
    volatile_tokens: volatileTokens,
    hidden_prompt_events: hiddenPromptEvents,
    rotate_prompt_epoch_reason: rotatePromptEpochReason,
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

async function runMemoryTool(
  fs: R2Fs,
  memory: MemoryStore,
  settings: AppSettings,
  name: string,
  args: Record<string, unknown>,
  onChange?: (target: string, characterId: string | null, live: string[]) => Promise<void>,
): Promise<string> {
  if (name !== "memory") return JSON.stringify({ success: false, error: `unknown tool: ${name}` });
  const target = String(args.target || "");
  const characterId = args.character_id ? String(args.character_id) : null;
  if (target !== "world" && target !== "player" && target !== "character") {
    return JSON.stringify({ success: false, message: `unknown target: ${target}`, current_entries: [] });
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
    const operations = rawOperations
      .filter((operation): operation is Record<string, unknown> => Boolean(operation) && typeof operation === "object")
      .map((operation) => ({
        action: String(operation.action || "") as MemoryMutation["action"],
        target: typedTarget,
        characterId,
        content: String(operation.content || ""),
        oldText: String(operation.old_text || ""),
      }));
    const batch = applyMemoryBatch(memory, operations, limits);
    if (batch.success) {
      await persistMemoryChanges(fs, memory, batch.touched);
      if (onChange) {
        for (const touched of batch.touched) {
          const live =
            touched.target === "world"
              ? memory.world
              : touched.target === "player"
                ? memory.player
                : memory.characters[touched.characterId || ""] || [];
          await onChange(touched.target, touched.characterId, live);
        }
      }
    }
    return JSON.stringify({
      success: batch.success,
      done: batch.success,
      message: batch.message,
      target,
      current_entries: batch.success ? undefined : batch.currentEntries || existing,
    });
  }
  if (String(args.action || "") === "add" && memoryIsDuplicate(String(args.content || ""), existing)) {
    return JSON.stringify({ success: true, message: "duplicate memory skipped", target, live: existing });
  }
  const result = applyMemory(
    memory,
    String(args.action || ""),
    target,
    String(args.content || ""),
    String(args.old_text || ""),
    characterId,
    limits,
  );
  if (result.success) {
    await persistMemory(fs, memory, target, characterId);
    if (onChange) await onChange(target, characterId, result.live);
  }
  return JSON.stringify({ success: result.success, message: result.message, target, live: result.live });
}

export async function runCompact(
  env: Env,
  fs: R2Fs,
  memory: MemoryStore,
  messages: ChatMessage[],
  sessionId: string,
  loaded: { thread_id: string | null; nmem_space: string | null; primary_character?: string | null },
  library: PromptLibrary,
  settings: AppSettings,
  worldId = "",
  waitUntil?: (job: Promise<unknown>) => void,
  aiOptions?: AiRequestOptions,
  deferNmemWrites = false,
): Promise<string> {
  const outputTokens = effectiveOutputTokens(settings, aiOptions?.model, "compact");
  const roleplayMessages = roleplayOnlyMessages(messages);
  const transcript = roleplayMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const values: Record<string, string> = {
    transcript,
    memory: memory.world.join("\n§\n"),
    player: memory.player.join("\n§\n"),
  };
  const extra = breachSystem(library, settings.llm.breach);
  const phi = breachPhi(library, settings.llm.breach);
  let flushSystem = library.render("memory_flush.md", values);
  if (extra) flushSystem = `${extra}\n\n${flushSystem}`;
  const listed =
    settings.nmem.enabled && !deferNmemWrites ? await listNmemSpaces(env) : { available: false, spaces: [] };
  const spaceId =
    settings.nmem.enabled && !deferNmemWrites
      ? resolveSpaceId(selectedNmemSpace(loaded.nmem_space, settings.nmem.space), listed.spaces)
      : null;
  let nmemIndex = await loadNmemIndex((path) => fs.get(path));
  await toolLoop(
    env,
    [
      { role: "system", content: flushSystem },
      { role: "user", content: library.render("memory_flush_user.md", values) },
    ],
    [memoryToolSpec(library)],
    (name, args) =>
      runMemoryTool(fs, memory, settings, name, args, async (target, characterId, live) => {
        if (!spaceId) return;
        nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, worldId || "world", target, characterId, live);
        await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
      }),
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
  const result = await chat(
    env,
    withPhiMsgs(
      [
        { role: "system", content: compactSystem },
        { role: "user", content: library.render("compact_user.md", values) },
      ],
      phi,
    ),
    null,
    0.3,
    outputTokens,
    settings.llm.timeout,
    aiOptions,
  );
  const summary = result.text.trim();
  const keep = settings.transcript_keep_after_compact;
  const kept = keep ? roleplayMessages.slice(-keep) : [];
  const next = [{ role: "system", content: summary, ts: nowIso() }, ...kept];
  await saveSession(fs, sessionId, next, loaded);
  if (summary) await fs.put(`sessions/${sessionId}/summary.md`, `${summary}\n`);
  if (spaceId && listed.available && summary) {
    const job = addSummaryToNmem(env, spaceId, worldId || "world", sessionId, summary, loaded.thread_id).catch(
      () => undefined,
    );
    if (waitUntil) waitUntil(job);
    else await job;
  }
  return summary;
}

async function addSummaryToNmem(
  env: Env,
  spaceId: string,
  worldId: string,
  sessionId: string,
  summary: string,
  threadId: string | null,
): Promise<void> {
  await syncTurnBodyToNmem(env, spaceId, worldId, sessionId, "（压缩摘要）", summary);
  if (!threadId) return;
  await syncThreadTurn(env, spaceId, threadId, threadId, `Light RP / ${worldId} / ${sessionId}`, [
    { role: "system", content: summary },
  ]);
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
