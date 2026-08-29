import { assembleBudgeted, breachPhi, breachSystem, resolvePrimaryId, selectMiniMembers, storySummary, type LlmMessage } from "./assemble";
import {
  memoryIsDuplicate,
  parseContextConfig,
  parseMiniConfig,
  routeMemoryCandidate,
  buildContextReport,
  type ContextReport,
} from "./budget";
import {
  aliasMap,
  appendEvents,
  applyMemory,
  applyScenePatch,
  ensembleActing,
  enrichRecord,
  ensureMini,
  ensureSessionState,
  formatMemoryEntry,
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
  type MiniCard,
  type SceneState,
  type WorldPack,
} from "./domain";
import { chat, toolLoop } from "./llm";
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
} from "./nmem";
import { memoryToolSpec, PromptLibrary } from "./prompts";
import type { R2Fs } from "./r2";
import type { AppSettings } from "./settings";
import { nowIso } from "./util";

export type TurnOut = {
  text: string;
  scene: SceneState;
  messages: ChatMessage[];
  spotlight_ids: string[];
  warnings: string[];
  nmem_synced: boolean;
  context_report?: ContextReport;
};

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

export function openingFor(cards: CharacterCard[], playerName: string): string {
  return cards
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

function candidateImportance(item: Record<string, unknown>): number {
  const raw = item.importance;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() && !Number.isNaN(Number(raw))) return Number(raw);
  // Plain string candidates (legacy) → EventLog, not long-term
  return 0.5;
}

async function ingestMemoryCandidate(
  fs: R2Fs,
  memory: MemoryStore,
  settings: AppSettings,
  sessionId: string,
  scene: SceneState,
  candidate: Record<string, unknown>,
  onLongTerm?: (target: string, characterId: string | null, live: string[]) => Promise<void>,
): Promise<"long" | "event" | "drop" | "dup"> {
  const enriched = enrichRecord(candidate, scene);
  const text = formatMemoryEntry(enriched);
  const importance = candidateImportance(candidate);
  const route = routeMemoryCandidate(importance);
  if (route === "drop") return "drop";
  if (route === "event") {
    await appendEvents(fs, sessionId, [{ ...enriched, kind: "memory_candidate", importance }]);
    return "event";
  }
  if (memoryIsDuplicate(text, memory.world)) return "dup";
  await runMemoryTool(fs, memory, settings, "memory", { action: "add", target: "world", content: text }, onLongTerm);
  return "long";
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
): Promise<TurnOut> {
  const warnings: string[] = [];
  const loaded = await loadSession(fs, sessionId);
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
  const listed = settings.nmem.enabled ? await listNmemSpaces(env) : { available: false, spaces: [] };
  const spaceId = settings.nmem.enabled ? resolveSpaceId(loaded.nmem_space, listed.spaces) : null;
  let recall = "";
  if (spaceId && listed.available) {
    try {
      recall = formatNmemRecall(await searchNmem(env, spaceId, userText, 8));
    } catch (err) {
      warnings.push(`nmem 召回失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const mentionIds = parseMentions(userText, aliasMap(pack.cast));
  const primaryId = resolvePrimaryId(pack, scene, primaryCharacter);
  const primaryMember = primaryId ? pack.cast.find((item) => item.id === primaryId) : undefined;
  const primaryCards = primaryMember ? await loadMemberCards(fs, [primaryMember]) : [];
  const miniCfg = parseMiniConfig(settings.mini);
  const contextCfg = parseContextConfig({
    ...settings.context,
    generation_reserve: Math.max(settings.context?.generation_reserve ?? 4096, settings.llm.max_tokens),
  });
  const recentSlice = loaded.messages.slice(-Math.max(8, miniCfg.recent_turns * 2));
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
  const lore = await triggered(fs, pack, scene, loaded.messages, userText, settings, [...primaryCards, ...loreCards]);
  const promptUser = mentionPrompt(pack, userText, mentionIds);
  const breach = settings.llm.breach;
  const loreBudget = pack.lore_token_budget || settings.lore_token_budget || contextCfg.budget.lore;
  const assembled = assembleBudgeted(
    library,
    pack,
    memory,
    scene,
    primaryCards,
    lore,
    recall,
    loaded.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
      .map((m) => ({ role: m.role, content: m.content })),
    promptUser,
    breachSystem(library, breach),
    minis,
    storySummary(loaded.messages),
    contextCfg,
    miniCfg,
    loreBudget,
    settings.llm.max_tokens,
  );
  const cardPhi = primaryCards
    .map((card) => {
      const filled = substituteCard(card, pack.player_name);
      return filled.post_history_instructions.trim() ? ensembleActing(filled.post_history_instructions, filled.name) : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const phi = [breachPhi(library, breach), cardPhi].filter(Boolean).join("\n\n");
  const contextReport = buildContextReport(
    contextCfg,
    assembled.report.sections,
    assembled.history,
    assembled.report.history.truncated,
    promptUser,
    {
      llmMaxTokens: settings.llm.max_tokens,
      phiText: phi,
      extraSystem: breachSystem(library, breach),
    },
  );
  await saveContextReport(fs, sessionId, contextReport);
  assembled.report = contextReport;
  const messages: LlmMessage[] = [
    { role: "system", content: assembled.system },
    ...assembled.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: promptUser },
  ];
  let nmemIndex = await loadNmemIndex((path) => fs.get(path));
  const syncNmem = async (target: string, characterId: string | null, live: string[]) => {
    if (!spaceId) return;
    try {
      nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, pack.id, target, characterId, live);
      await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
    } catch (err) {
      warnings.push(`nmem 记忆同步失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const gm = await toolLoop(
    env,
    messages,
    [memoryToolSpec(library)],
    (name, args) => runMemoryTool(fs, memory, settings, name, args, syncNmem),
    settings.max_tool_rounds,
    phi,
    settings.llm.temperature,
    settings.llm.max_tokens,
  );
  const { visible, trailer } = parseTrailer(gm.text);
  let nextScene = scene;
  const remembered: string[] = [];
  if (Object.keys(trailer).length) {
    nextScene = applyScenePatch(scene, trailer);
    await fs.put(`sessions/${sessionId}/state.yaml`, sceneYaml(nextScene));
    await appendEvents(
      fs,
      sessionId,
      trailerEvents(trailer).map((item) => enrichRecord(item, nextScene)),
    );
    for (const candidate of trailerMemoryCandidates(trailer)) {
      const route = await ingestMemoryCandidate(fs, memory, settings, sessionId, nextScene, candidate, syncNmem);
      if (route === "long") remembered.push(String(candidate.text || candidate.content || "").slice(0, 80));
    }
  }
  const memoryOps = Array.isArray(trailer.memory) ? trailer.memory : [];
  for (const raw of memoryOps) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    const content = String(op.content || "");
    if (String(op.action || "") === "add" && content && memoryIsDuplicate(content, memory.world.concat(memory.player))) {
      continue;
    }
    await runMemoryTool(fs, memory, settings, "memory", op, async (target, characterId, live) => {
      if (!spaceId) return;
      try {
        nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, pack.id, target, characterId, live);
        await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
      } catch (err) {
        warnings.push(`nmem 记忆同步失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  const spotlightIds = unique([...asIdList(trailer.spotlight), ...mentionIds]);
  const nextMessages = [
    ...loaded.messages,
    { role: "user", content: userText, ts: nowIso() },
    { role: "assistant", content: visible, ts: nowIso() },
  ];
  const turnNumber = nextMessages.filter((m) => m.role === "user").length;
  await appendTrace(fs, sessionId, {
    turn: turnNumber,
    primary: primaryId,
    minis: assembled.mini_ids,
    lore: assembled.lore_titles,
    memories: remembered,
    state_before: scene,
    state_after: nextScene,
    token_usage: { total: assembled.report.total, max: assembled.report.max_tokens },
    warnings,
    ts: nowIso(),
  });
  let threadId = loaded.thread_id;
  let nmemSynced = false;
  if (spaceId && listed.available) {
    threadId = threadId || sessionThreadId(pack.id, sessionId);
    try {
      await syncTurnBodyToNmem(env, spaceId, pack.id, sessionId, userText, visible);
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
        { role: "assistant", content: visible },
      ],
    ).catch((err) => {
      warnings.push(`nmem thread 同步失败: ${err instanceof Error ? err.message : String(err)}`);
    });
    const willCompact = nextMessages.length >= settings.compact_after_turns;
    if (waitUntil && !willCompact) waitUntil(threadJob);
    else await threadJob;
  }
  await saveSession(fs, sessionId, nextMessages, {
    thread_id: threadId,
    nmem_space: loaded.nmem_space,
    primary_character: primaryCharacter,
  });
  if (nextMessages.length >= settings.compact_after_turns) {
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
      );
    } catch (err) {
      warnings.push(`compact failed: ${String(err)}`);
    }
  }
  return {
    text: visible,
    scene: nextScene,
    messages: nextMessages,
    spotlight_ids: spotlightIds,
    warnings,
    nmem_synced: nmemSynced,
    context_report: assembled.report,
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
  const result = applyMemory(
    memory,
    String(args.action || ""),
    target,
    String(args.content || ""),
    String(args.old_text || ""),
    characterId,
    {
      world: settings.memory.world_char_limit,
      player: settings.memory.player_char_limit,
      character: settings.memory.character_char_limit,
    },
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
): Promise<string> {
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const values: Record<string, string> = {
    transcript,
    memory: memory.world.join("\n§\n"),
    player: memory.player.join("\n§\n"),
  };
  const extra = breachSystem(library, settings.llm.breach);
  const phi = breachPhi(library, settings.llm.breach);
  let flushSystem = library.render("memory_flush.md", values);
  if (extra) flushSystem = `${extra}\n\n${flushSystem}`;
  const listed = settings.nmem.enabled ? await listNmemSpaces(env) : { available: false, spaces: [] };
  const spaceId = settings.nmem.enabled ? resolveSpaceId(loaded.nmem_space, listed.spaces) : null;
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
    settings.llm.max_tokens,
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
    settings.llm.max_tokens,
  );
  const summary = result.text.trim();
  const keep = settings.transcript_keep_after_compact;
  const kept = keep ? messages.slice(-keep) : [];
  const next = [{ role: "system", content: summary, ts: nowIso() }, ...kept];
  await saveSession(fs, sessionId, next, loaded);
  if (summary) await fs.put(`sessions/${sessionId}/summary.md`, `${summary}\n`);
  if (spaceId && listed.available && summary) {
    const job = addSummaryToNmem(env, spaceId, worldId || "world", sessionId, summary, loaded.thread_id).catch(() => undefined);
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
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
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
