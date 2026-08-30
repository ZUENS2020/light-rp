import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  cardFromObj,
  cardToExport,
  ensureSessionState,
  findMember,
  generateMini,
  loadCard,
  loadMemory,
  loadMini,
  loadPack,
  loadSession,
  listSessions,
  memberPresent,
  persistMemory,
  readEntries,
  saveCast,
  saveMini,
  saveSession,
  saveWorldMeta,
  sessionInfoFrom,
  deleteSession,
  deleteWorkspace,
  type CastMember,
  type MiniCard,
  type WorldPack,
} from "../core/domain";
import { openingFor, runCompact, runOoc, runTurn, type TurnOut } from "./engine";
import { turnErrorStatus } from "../adapters/ai-gateway";
import { importStFiles, type ImportFile } from "../core/sillytavern-import";
import {
  listNmemSpaces,
  loadNmemIndex,
  resolveSpaceId,
  saveNmemIndex,
  sessionThreadId,
  syncMemorySnapshotToNmem,
  syncThreadTurn,
  syncTurnBodyToNmem,
} from "../adapters/nmem";
import { PromptLibrary } from "../core/prompts";
import { listWorkspaceIds, workspaceFs } from "../adapters/r2";
import { createWorkspace } from "./seed";
import { loadSettings, publicSettings, saveSettings, type AppSettings } from "./settings";
import { parseContextConfig, parseMiniConfig } from "../core/budget";
import { completeTask, getActiveTask, getTask, insertPending, leaseTask, markFailed } from "./tasks";
import { nowIso, parseYaml, stringifyYaml, workspaceIdOk, sessionIdNow } from "../core/util";
import { projectWorkspaceAndSession, projectWorkspaceContent, registerV2Routes } from "./api-v2";
import type { AiModelConfig, AiUsage, ResponseCacheStatus } from "../core/ai";
import { sha256 } from "../core/ai";
import { selectedNmemSpace } from "../core/memory";
import { beginNmemSync, completeNmemSync, failNmemSync, mirrorCoreMemorySnapshot } from "./memory";
import { getApplicationDefaultModel, sessionRuntime } from "./models";
import { isOocMessage } from "../core/commands";
import { createPromptEpoch } from "./prompt-state";

async function overlays(fs: ReturnType<typeof workspaceFs>) {
  const files = await fs.list("prompts/");
  const out: Record<string, string> = {};
  for (const file of files) {
    if (!file.startsWith("prompts/") || file.endsWith("/")) continue;
    const text = await fs.get(file);
    if (text != null) out[file.replace(/^prompts\//, "")] = text;
  }
  return out;
}

type PersistedTurnDiagnostics = {
  task_id?: string | null;
  ai_usage?: AiUsage;
  response_cache_status?: ResponseCacheStatus;
  request_hash?: string | null;
  stable_prefix_tokens?: number;
  volatile_tokens?: number;
  hidden_prompt_events?: Array<{ kind: "context" | "memory"; content: string; hashSeed?: string }>;
  rotate_prompt_epoch_reason?: "context_compacted" | null;
};

async function loadTurnDiagnostics(
  fs: ReturnType<typeof workspaceFs>,
  sessionId: string,
): Promise<PersistedTurnDiagnostics | null> {
  try {
    const raw = await fs.get(`sessions/${sessionId}/last_turn.json`);
    return raw ? (JSON.parse(raw) as PersistedTurnDiagnostics) : null;
  } catch {
    return null;
  }
}

function summary(
  pack: WorldPack,
  latest: string | null,
  latestNmem: string | null,
  extra: { session_count?: number } = {},
) {
  return {
    id: pack.id,
    name: pack.name,
    path: `r2://lightrp/v2/workspaces/${pack.id}`,
    nmem_space: pack.nmem_space,
    player_name: pack.player_name,
    latest_session: latest,
    latest_nmem_space: latestNmem,
    session_count: extra.session_count ?? 0,
    primary: pack.primary,
    cast: pack.cast.map((member) => ({
      id: member.id,
      name: member.name,
      blurb: member.blurb,
      present: member.present,
      aliases: member.aliases,
    })),
  };
}

async function playState(
  env: Env,
  fs: ReturnType<typeof workspaceFs>,
  pack: WorldPack,
  sessionId: string,
  extra: Record<string, unknown> = {},
) {
  const loaded = await loadSession(fs, sessionId);
  await projectWorkspaceAndSession(env, {
    workspace: {
      id: pack.id,
      name: pack.name,
      playerName: pack.player_name,
      nmemSpace: pack.nmem_space,
      primaryCharacterId: pack.primary,
    },
    session: {
      id: sessionId,
      title: sessionInfoFrom(sessionId, loaded).title,
      nmemSpace: loaded.nmem_space,
      primaryCharacterId: loaded.primary_character,
    },
  });
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
  const cards = [];
  for (const member of pack.cast) {
    const isPrimary = Boolean(primaryCharacter && (member.id === primaryCharacter || member.name === primaryCharacter));
    if (!isPrimary && !memberPresent(member, scene.present)) continue;
    try {
      cards.push(await loadCard(fs, member));
    } catch {
      /* skip */
    }
  }
  const sessions = await listSessions(fs);
  let contextReport = null;
  type LastTurnDiagnostics = { warnings?: unknown; remembered?: unknown; state_updated?: unknown };
  let lastTurn: LastTurnDiagnostics | null = null;
  try {
    const raw = await fs.get(`sessions/${sessionId}/context_report.json`);
    if (raw) contextReport = JSON.parse(raw);
  } catch {
    contextReport = null;
  }
  try {
    const raw = await fs.get(`sessions/${sessionId}/last_turn.json`);
    if (raw) lastTurn = JSON.parse(raw) as LastTurnDiagnostics;
  } catch {
    lastTurn = null;
  }
  return {
    world: {
      ...summary(pack, sessionId, loaded.nmem_space, { session_count: sessions.length }),
      sessions,
      world_text: pack.world_text,
    },
    session_id: sessionId,
    session_title: sessionInfoFrom(sessionId, loaded).title,
    primary_character: primaryCharacter,
    nmem_space: loaded.nmem_space,
    nmem_available: extra.nmem_available != null ? Boolean(extra.nmem_available) : false,
    warnings: Array.isArray(lastTurn?.warnings) ? lastTurn.warnings.map(String) : [],
    opening: openingFor(cards, pack.player_name, primaryCharacter),
    scene,
    memory: memory.world.join("\n§\n"),
    player: memory.userSetting,
    player_memory: memory.player.join("\n§\n"),
    character_memory: memory.characters,
    messages: loaded.messages,
    context_report: contextReport,
    turn_warnings: Array.isArray(lastTurn?.warnings) ? lastTurn.warnings.map(String) : [],
    remembered: Array.isArray(lastTurn?.remembered) ? lastTurn.remembered.map(String) : [],
    state_updated: Boolean(lastTurn?.state_updated),
    ...extra,
  };
}

const app = new Hono<{ Bindings: Env }>();

registerV2Routes(app);

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  const status =
    err instanceof HTTPException ? err.status : message.includes("not found") || message.includes("不存在") ? 404 : 500;
  return c.json({ detail: message }, status as 400);
});

app.get("/api/v2/health", (c) => c.json({ status: "ok" }));

app.get("/api/v2/settings", async (c) => {
  const settings = await loadSettings(c.env.BUCKET);
  const listed = await listNmemSpaces(c.env);
  const defaultModel = await getApplicationDefaultModel(c.env.DB);
  settings.nmem.space = resolveSpaceId(settings.nmem.space, listed.spaces) || "";
  return c.json(publicSettings(c.env, settings, defaultModel.id));
});

app.put("/api/v2/settings", async (c) => {
  const body = (await c.req.json()) as Partial<AppSettings> & {
    llm?: Partial<AppSettings["llm"]>;
    nmem?: Partial<AppSettings["nmem"]>;
    memory?: Partial<AppSettings["memory"]>;
  };
  const previous = await loadSettings(c.env.BUCKET);
  const listed = await listNmemSpaces(c.env);
  const requestedSpace = body.nmem?.space ?? previous.nmem.space;
  const next: AppSettings = {
    llm: {
      temperature: Number(body.llm?.temperature ?? previous.llm.temperature),
      max_tokens: Number(body.llm?.max_tokens ?? previous.llm.max_tokens),
      timeout: Number(body.llm?.timeout ?? previous.llm.timeout),
      breach: body.llm?.breach != null ? Boolean(body.llm.breach) : previous.llm.breach,
    },
    nmem: {
      enabled: body.nmem?.enabled != null ? Boolean(body.nmem.enabled) : previous.nmem.enabled,
      space: resolveSpaceId(requestedSpace, listed.spaces) || "",
    },
    memory: {
      world_char_limit: Number(body.memory?.world_char_limit ?? previous.memory.world_char_limit),
      player_char_limit: Number(body.memory?.player_char_limit ?? previous.memory.player_char_limit),
      character_char_limit: Number(body.memory?.character_char_limit ?? previous.memory.character_char_limit),
    },
    compact_after_turns: Number(body.compact_after_turns ?? previous.compact_after_turns),
    lore_scan_depth: Number(body.lore_scan_depth ?? previous.lore_scan_depth),
    lore_token_budget: Number(body.lore_token_budget ?? previous.lore_token_budget),
    max_tool_rounds: Number(body.max_tool_rounds ?? previous.max_tool_rounds),
    transcript_keep_after_compact: Number(body.transcript_keep_after_compact ?? previous.transcript_keep_after_compact),
    context: parseContextConfig(((body as { context?: unknown }).context as never) || previous.context),
    mini: parseMiniConfig(((body as { mini?: unknown }).mini as never) || previous.mini),
  };
  await saveSettings(c.env.BUCKET, next);
  const defaultModel = await getApplicationDefaultModel(c.env.DB);
  return c.json(publicSettings(c.env, next, defaultModel.id));
});

app.get("/api/v2/nmem/spaces", async (c) => c.json(await listNmemSpaces(c.env)));

app.get("/api/v2/worlds", async (c) => {
  const ids = await listWorkspaceIds(c.env.BUCKET);
  const worlds = [];
  for (const id of ids) {
    const fs = workspaceFs(c.env.BUCKET, id);
    const pack = await loadPack(fs, id);
    const sessions = await listSessions(fs);
    worlds.push(
      summary(pack, sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }),
    );
  }
  return c.json({ worlds });
});

app.post("/api/v2/worlds", async (c) => {
  const body = (await c.req.json()) as { id?: string; name?: string; player_name?: string };
  const id = (body.id || "").trim();
  const name = (body.name || id).trim();
  if (!workspaceIdOk(id)) throw new HTTPException(400, { message: "工作区 id 只能用小写字母、数字和连字符" });
  try {
    await createWorkspace(c.env.BUCKET, id, name, body.player_name || "你");
  } catch (err) {
    throw new HTTPException(409, { message: err instanceof Error ? err.message : "无法创建" });
  }
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  await projectWorkspaceContent(c.env, pack);
  return c.json(summary(pack, null, null, { session_count: 0 }));
});

app.delete("/api/v2/worlds/:id", async (c) => {
  const id = c.req.param("id");
  if (!workspaceIdOk(id)) throw new HTTPException(400, { message: "invalid workspace id" });
  const fs = workspaceFs(c.env.BUCKET, id);
  if (!(await fs.get("world.yaml")) && !(await fs.get("WORLD.md"))) {
    throw new HTTPException(404, { message: `world '${id}' not found` });
  }
  await deleteWorkspace(fs);
  await c.env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(id).run();
  return c.json({ ok: true, id });
});

app.get("/api/v2/worlds/:id", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  if (!pack.world_text && !(await fs.get("world.yaml")))
    throw new HTTPException(404, { message: `world '${id}' not found` });
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(pack, sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }),
    sessions,
    world_text: pack.world_text,
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.put("/api/v2/worlds/:id", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = (await c.req.json()) as {
    name?: string;
    player_name?: string;
    nmem_space?: string | null;
    world_text?: string;
    player_text?: string;
    lore_token_budget?: number | null;
    lore_scan_depth?: number | null;
    primary?: string | null;
  };
  if (body.name != null) pack.name = body.name;
  if (body.player_name != null) pack.player_name = body.player_name;
  if (body.nmem_space !== undefined) pack.nmem_space = body.nmem_space;
  if (body.lore_token_budget !== undefined) pack.lore_token_budget = body.lore_token_budget;
  if (body.lore_scan_depth !== undefined) pack.lore_scan_depth = body.lore_scan_depth;
  if (body.primary !== undefined) pack.primary = body.primary;
  if (body.world_text != null) await fs.put("WORLD.md", body.world_text);
  if (body.player_text != null) await fs.put("PLAYER.md", body.player_text);
  await saveWorldMeta(fs, pack);
  await saveCast(fs, pack);
  await projectWorkspaceContent(c.env, pack);
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(await loadPack(fs, id), sessions[0]?.id || null, sessions[0]?.nmem_space || null, {
      session_count: sessions.length,
    }),
    sessions,
    world_text: (await fs.get("WORLD.md")) || "",
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.put("/api/v2/worlds/:id/memory", async (c) => {
  const workspaceId = c.req.param("id");
  const active = await c.env.DB.prepare(
    `SELECT COUNT(*) AS value FROM generation_tasks
     WHERE workspace_id = ? AND status IN ('pending', 'running')`,
  )
    .bind(workspaceId)
    .first<{ value: number }>();
  if (Number(active?.value || 0) > 0) throw new HTTPException(409, { message: "生成期间不能修改核心记忆" });
  const fs = workspaceFs(c.env.BUCKET, workspaceId);
  const body = (await c.req.json()) as { world?: string; player?: string };
  const store = await loadMemory(fs);
  if (body.world != null) {
    store.world = readEntries(body.world);
    await persistMemory(fs, store, "world", null);
  }
  if (body.player != null) {
    store.player = readEntries(body.player);
    await persistMemory(fs, store, "player", null);
  }
  await mirrorCoreMemorySnapshot(c.env.DB, { workspaceId, snapshot: store });
  const sessions = await c.env.DB.prepare(`SELECT id FROM sessions WHERE workspace_id = ?`).bind(workspaceId).all<{
    id: string;
  }>();
  for (const session of sessions.results || []) {
    await createPromptEpoch(c.env.DB, session.id, "core_memory_edited");
  }
  return c.json({
    memory: store.world.join("\n§\n"),
    player_memory: store.player.join("\n§\n"),
  });
});

app.get("/api/v2/worlds/:id/cards", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  const cards = [];
  for (const member of pack.cast) {
    try {
      cards.push({ member, card: await loadCard(fs, member), mini: await loadMini(fs, member.id) });
    } catch {
      cards.push({ member, card: null, mini: await loadMini(fs, member.id) });
    }
  }
  return c.json({ cards });
});

app.get("/api/v2/worlds/:id/cards/:cid/mini", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const mini = await loadMini(fs, c.req.param("cid"));
  return c.json({ mini });
});

app.put("/api/v2/worlds/:id/cards/:cid/mini", async (c) => {
  const cid = c.req.param("cid");
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  const member = findMember(pack, cid);
  const body = (await c.req.json()) as Partial<MiniCard>;
  const mini: MiniCard = {
    id: cid,
    name: String(body.name || member?.name || cid),
    summary: String(body.summary || ""),
    behavior_notes: String(body.behavior_notes || ""),
    relations: String(body.relations || ""),
  };
  await saveMini(fs, mini);
  return c.json({ mini });
});

app.post("/api/v2/worlds/:id/cards/:cid/mini/generate", async (c) => {
  const cid = c.req.param("cid");
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  const member = findMember(pack, cid);
  if (!member) throw new HTTPException(404, { message: `character '${cid}' not found` });
  const card = await loadCard(fs, member);
  const mini = generateMini(card, member.blurb);
  mini.id = cid;
  await saveMini(fs, mini);
  return c.json({ mini });
});

app.put("/api/v2/worlds/:id/cards/:cid", async (c) => {
  const id = c.req.param("id");
  const cid = c.req.param("cid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = (await c.req.json()) as Record<string, unknown> & { member?: Partial<CastMember> };
  const card = cardFromObj(body, cid);
  card.id = cid;
  const memberPatch = body.member || {};
  const existing = findMember(pack, cid);
  const asJson = Boolean(body.spec || body.data || existing?.card.endsWith(".json"));
  const member: CastMember = {
    id: cid,
    name: String(memberPatch.name || card.name || existing?.name || cid),
    card: existing?.card || `characters/${cid}.${asJson ? "json" : "yaml"}`,
    blurb: String(memberPatch.blurb ?? existing?.blurb ?? ""),
    present: memberPatch.present != null ? Boolean(memberPatch.present) : (existing?.present ?? true),
    aliases: Array.isArray(memberPatch.aliases)
      ? memberPatch.aliases.map(String)
      : existing?.aliases || card.tags.slice(0, 4),
  };
  if (asJson && member.card.endsWith(".yaml")) member.card = member.card.replace(/\.ya?ml$/i, ".json");
  const next = pack.cast.filter((item) => item.id !== cid);
  next.push(member);
  pack.cast = next;
  if (member.card.endsWith(".json")) {
    const previousText = await fs.get(member.card);
    let previous: Record<string, unknown>;
    try {
      previous = previousText ? (JSON.parse(previousText) as Record<string, unknown>) : {};
    } catch {
      previous = {};
    }
    const previousData =
      previous.data && typeof previous.data === "object" && !Array.isArray(previous.data)
        ? (previous.data as Record<string, unknown>)
        : {};
    const exported = cardToExport(card);
    await fs.put(
      member.card,
      JSON.stringify(
        {
          ...previous,
          spec: previous.spec || "chara_card_v2",
          spec_version: previous.spec_version || "2.0",
          data: {
            ...previousData,
            ...exported,
            character_book: exported.character_book || previousData.character_book || null,
          },
        },
        null,
        2,
      ),
      "application/json",
    );
  } else {
    await fs.put(member.card, stringifyYaml(cardToExport(card)));
  }
  await saveCast(fs, pack);
  try {
    if (!(await loadMini(fs, cid))) {
      const mini = generateMini(card, member.blurb);
      mini.id = cid;
      await saveMini(fs, mini);
    }
  } catch {
    /* card load already succeeded above */
  }
  await projectWorkspaceContent(c.env, pack);
  return c.json({ member, card: { ...card, id: cid } });
});

app.delete("/api/v2/worlds/:id/cards/:cid", async (c) => {
  const id = c.req.param("id");
  const cid = c.req.param("cid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const member = findMember(pack, cid);
  if (member) {
    await fs.del(member.card);
    await fs.del(`characters/${cid}.mini.yaml`);
  }
  pack.cast = pack.cast.filter((item) => item.id !== cid);
  await saveCast(fs, pack);
  await projectWorkspaceContent(c.env, pack);
  return c.json({ ok: true });
});

app.get("/api/v2/worlds/:id/lorebooks", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const files = (await fs.list("lorebooks/")).filter((n) => /\.(json|ya?ml)$/i.test(n));
  const items = [];
  for (const file of files) {
    items.push({ name: file.replace(/^lorebooks\//, ""), text: (await fs.get(file)) || "" });
  }
  return c.json({ lorebooks: items });
});

app.put("/api/v2/worlds/:id/lorebooks/:name", async (c) => {
  const name = decodeURIComponent(c.req.param("name")).replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, "");
  if (!name) throw new HTTPException(400, { message: "invalid lorebook name" });
  const body = (await c.req.json()) as { text?: string };
  const text = body.text || "{}";
  const trimmed = text.trim();
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) JSON.parse(trimmed);
    else parseYaml(text);
  } catch {
    throw new HTTPException(400, { message: "世界书必须是 JSON 或 YAML" });
  }
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const dest = name.includes("/") ? name.replace(/^.*\//, "") : name;
  await fs.put(`lorebooks/${dest}`, text, "application/json");
  await projectWorkspaceContent(c.env, await loadPack(fs, c.req.param("id")));
  return c.json({ name: dest, text });
});

app.delete("/api/v2/worlds/:id/lorebooks/:name", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  await fs.del(`lorebooks/${decodeURIComponent(c.req.param("name"))}`);
  await projectWorkspaceContent(c.env, await loadPack(fs, c.req.param("id")));
  return c.json({ ok: true });
});

app.post("/api/v2/worlds/:id/import", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = (await c.req.json()) as { files?: ImportFile[] };
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new HTTPException(400, { message: "files is required" });
  const result = await importStFiles(fs, pack, files);
  await saveWorldMeta(fs, pack);
  await saveCast(fs, pack);
  await projectWorkspaceContent(c.env, pack);
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(await loadPack(fs, id), sessions[0]?.id || null, sessions[0]?.nmem_space || null, {
      session_count: sessions.length,
    }),
    imported: result,
    world_text: (await fs.get("WORLD.md")) || "",
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.post("/api/v2/worlds/:id/sessions", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    new?: boolean;
    session_id?: string;
    space?: string | null;
  };
  const listed = await listNmemSpaces(c.env);
  const settings = await loadSettings(c.env.BUCKET);
  const requested = body.space === undefined ? pack.nmem_space || settings.nmem.space : body.space;
  const space = resolveSpaceId(requested, listed.spaces);
  let sessionId = body.session_id;
  if (!sessionId || body.new) {
    sessionId = sessionIdNow();
    await saveSession(fs, sessionId, [], { nmem_space: space, primary_character: pack.primary });
    await ensureSessionState(fs, sessionId, pack);
  }
  return c.json(await playState(c.env, fs, pack, sessionId, { nmem_available: listed.available }));
});

app.get("/api/v2/worlds/:id/sessions", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  await loadPack(fs, c.req.param("id"));
  return c.json({ sessions: await listSessions(fs) });
});

app.patch("/api/v2/worlds/:id/sessions/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const sid = c.req.param("sid");
  const pack = await loadPack(fs, c.req.param("id"));
  const body = (await c.req.json()) as { title?: string; primary_character?: string | null };
  const loaded = await loadSession(fs, sid);
  const title = body.title != null ? body.title.trim() : undefined;
  if (body.title != null && !title) throw new HTTPException(400, { message: "title is required" });
  let primary = body.primary_character;
  if (primary !== undefined && primary) {
    const member = findMember(pack, primary);
    if (!member) throw new HTTPException(400, { message: `character '${primary}' not found` });
    primary = member.id;
  }
  await saveSession(fs, sid, loaded.messages, {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    title: title ?? loaded.title,
    primary_character: primary !== undefined ? primary : loaded.primary_character,
  });
  if (title != null) return c.json(sessionInfoFrom(sid, { ...loaded, title }));
  return c.json(await playState(c.env, fs, pack, sid));
});

app.delete("/api/v2/worlds/:id/sessions/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const sessionId = c.req.param("sid");
  await deleteSession(fs, sessionId);
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ? AND workspace_id = ?")
    .bind(sessionId, c.req.param("id"))
    .run();
  return c.json({ ok: true, id: sessionId });
});

app.get("/api/v2/play/:id/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  return c.json(await playState(c.env, fs, pack, c.req.param("sid")));
});

app.post("/api/v2/play/:id/:sid/turn", async (c) => {
  const body = (await c.req.json()) as { text?: string };
  const text = (body.text || "").trim();
  if (!text) throw new HTTPException(400, { message: "text is required" });
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  if (!c.env.DB || !c.env.GENERATE_QUEUE) {
    try {
      const settings = await loadSettings(c.env.BUCKET);
      const result = await runTurn(c.env, fs, pack, sid, text, settings, await overlays(fs), (job) =>
        c.executionCtx.waitUntil(job),
      );
      return c.json({
        ...(await playState(c.env, fs, pack, sid, {
          context_report: result.context_report,
          nmem_available: result.nmem_available,
        })),
        reply: result.text,
        spotlight: result.spotlight_ids,
        nmem_synced: result.nmem_synced,
        turn_warnings: result.warnings,
        context_report: result.context_report,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(turnErrorStatus(err) as 502, { message });
    }
  }
  const active = await getActiveTask(c.env.DB, id, sid);
  if (active) {
    return c.json({ detail: "已有生成任务进行中", task_id: active.id, task_status: active.status }, 409);
  }
  const loaded = await loadSession(fs, sid);
  await saveSession(fs, sid, [...loaded.messages, { role: "user", content: text, ts: nowIso() }], {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    primary_character: loaded.primary_character,
    title: loaded.title,
  });
  const taskId = crypto.randomUUID();
  await insertPending(c.env.DB, { id: taskId, worldId: id, sessionId: sid, userText: text });
  await c.env.GENERATE_QUEUE.send({ taskId, worldId: id, sessionId: sid });
  return c.json({
    ...(await playState(c.env, fs, pack, sid)),
    task_id: taskId,
    task_status: "pending",
  });
});

app.post("/api/v2/play/:id/:sid/rewrite", async (c) => {
  const body = (await c.req.json()) as { index?: number; content?: string };
  const content = (body.content || "").trim();
  const index = Number(body.index);
  if (!content || !Number.isInteger(index) || index < 0) {
    throw new HTTPException(400, { message: !content ? "content is required" : "index out of range" });
  }
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  if (c.env.DB && c.env.GENERATE_QUEUE) {
    const active = await getActiveTask(c.env.DB, id, sid);
    if (active) {
      return c.json({ detail: "已有生成任务进行中", task_id: active.id, task_status: active.status }, 409);
    }
  }
  const loaded = await loadSession(fs, sid);
  if (index >= loaded.messages.length) {
    throw new HTTPException(400, { message: "index out of range" });
  }
  const kept = { ...loaded.messages[index], content };
  const messages = [...loaded.messages.slice(0, index), kept];
  await saveSession(fs, sid, messages, {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    primary_character: loaded.primary_character,
    title: loaded.title,
  });
  if (kept.role === "user") {
    if (c.env.DB && c.env.GENERATE_QUEUE) {
      const taskId = crypto.randomUUID();
      await insertPending(c.env.DB, { id: taskId, worldId: id, sessionId: sid, userText: content });
      await c.env.GENERATE_QUEUE.send({ taskId, worldId: id, sessionId: sid });
      return c.json({
        ...(await playState(c.env, fs, pack, sid)),
        task_id: taskId,
        task_status: "pending",
      });
    }
    try {
      const settings = await loadSettings(c.env.BUCKET);
      const result = await runTurn(
        c.env,
        fs,
        pack,
        sid,
        content,
        settings,
        await overlays(fs),
        (job) => c.executionCtx.waitUntil(job),
        { persistUser: false },
      );
      return c.json({
        ...(await playState(c.env, fs, pack, sid, {
          context_report: result.context_report,
          nmem_available: result.nmem_available,
        })),
        reply: result.text,
        spotlight: result.spotlight_ids,
        nmem_synced: result.nmem_synced,
        turn_warnings: result.warnings,
        context_report: result.context_report,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HTTPException(turnErrorStatus(err) as 502, { message });
    }
  }
  return c.json(await playState(c.env, fs, pack, sid));
});

app.get("/api/v2/play/:id/:sid/tasks/active", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  if (!c.env.DB) return c.json({ task: null });
  const task = await getActiveTask(c.env.DB, id, sid);
  if (!task) return c.json({ task: null });
  return c.json({
    task: {
      id: task.id,
      world_id: task.world_id,
      session_id: task.session_id,
      status: task.status,
      content: task.content,
      error: task.error,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
  });
});

app.get("/api/v2/play/:id/:sid/tasks/:taskId", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const taskId = c.req.param("taskId");
  if (!c.env.DB) throw new HTTPException(404, { message: "task not found" });
  const task = await getTask(c.env.DB, taskId);
  if (!task || task.world_id !== id || task.session_id !== sid) {
    throw new HTTPException(404, { message: "task not found" });
  }
  return c.json({
    id: task.id,
    world_id: task.world_id,
    session_id: task.session_id,
    status: task.status,
    content: task.content,
    error: task.error,
    created_at: task.created_at,
    updated_at: task.updated_at,
  });
});

app.post("/api/v2/play/:id/:sid/compact", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const loaded = await loadSession(fs, sid);
  const memory = await loadMemory(fs);
  const settings = await loadSettings(c.env.BUCKET);
  const library = new PromptLibrary(await overlays(fs));
  const summaryText = await runCompact(c.env, fs, memory, loaded.messages, sid, loaded, library, settings, id, (job) =>
    c.executionCtx.waitUntil(job),
  );
  const pack = await loadPack(fs, id);
  return c.json({ ...(await playState(c.env, fs, pack, sid)), summary: summaryText });
});

app.post("/api/v2/play/:id/:sid/space", async (c) => {
  const body = (await c.req.json()) as { space?: string };
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const loaded = await loadSession(fs, c.req.param("sid"));
  const listed = await listNmemSpaces(c.env);
  const space = resolveSpaceId(body.space || null, listed.spaces);
  await saveSession(fs, c.req.param("sid"), loaded.messages, { thread_id: loaded.thread_id, nmem_space: space });
  const pack = await loadPack(fs, c.req.param("id"));
  return c.json(await playState(c.env, fs, pack, c.req.param("sid")));
});

export default {
  fetch: app.fetch,
  async queue(
    batch: MessageBatch<{
      kind?: "generation" | "nmem";
      taskId: string;
      workspaceId?: string;
      worldId?: string;
      sessionId: string;
      userText?: string;
      assistantText?: string;
    }>,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (batch.queue === "lightrp-v2-nmem") {
      for (const msg of batch.messages) {
        try {
          const payload = msg.body;
          const workspaceId = payload.workspaceId || payload.worldId || "";
          if (!workspaceId || !payload.userText || !payload.assistantText) {
            msg.ack();
            continue;
          }
          const fs = workspaceFs(env.BUCKET, workspaceId);
          const loaded = await loadSession(fs, payload.sessionId);
          const settings = await loadSettings(env.BUCKET);
          if (!settings.nmem.enabled) {
            msg.ack();
            continue;
          }
          const listed = await listNmemSpaces(env);
          if (!listed.available) throw new Error(listed.error || "nmem unavailable");
          const spaceId = resolveSpaceId(selectedNmemSpace(loaded.nmem_space, settings.nmem.space), listed.spaces);
          if (!spaceId || !listed.spaces.some((space) => space.id === spaceId)) {
            throw new Error(`nmem space '${spaceId || ""}' is unavailable`);
          }
          await beginNmemSync(env.DB, {
            taskId: payload.taskId,
            workspaceId,
            sessionId: payload.sessionId,
            spaceId,
            attempt: msg.attempts,
          });
          const threadId = loaded.thread_id || sessionThreadId(workspaceId, payload.sessionId);
          const externalMemoryId = await syncTurnBodyToNmem(
            env,
            spaceId,
            workspaceId,
            payload.sessionId,
            payload.userText,
            payload.assistantText,
            payload.taskId,
          );
          await syncThreadTurn(
            env,
            spaceId,
            loaded.thread_id,
            threadId,
            `Light RP / ${workspaceId} / ${payload.sessionId}`,
            [
              { role: "user", content: payload.userText },
              { role: "assistant", content: payload.assistantText },
            ],
            payload.taskId,
          );
          const memory = await loadMemory(fs);
          const synced = await syncMemorySnapshotToNmem(
            env,
            spaceId,
            await loadNmemIndex((path) => fs.get(path)),
            workspaceId,
            memory,
          );
          await saveNmemIndex((path, text, type) => fs.put(path, text, type), synced.index);
          const mirroredCount = await mirrorCoreMemorySnapshot(env.DB, {
            workspaceId,
            sessionId: payload.sessionId,
            taskId: payload.taskId,
            snapshot: memory,
          });
          await saveSession(fs, payload.sessionId, loaded.messages, {
            thread_id: threadId,
            nmem_space: spaceId,
            primary_character: loaded.primary_character,
            title: loaded.title,
          });
          const ts = nowIso();
          const content = `${payload.userText}\n\n${payload.assistantText}`;
          await env.DB.batch([
            env.DB.prepare(`UPDATE workspaces SET nmem_space = ?, updated_at = ? WHERE id = ?`).bind(
              spaceId,
              ts,
              workspaceId,
            ),
            env.DB.prepare(`UPDATE sessions SET nmem_space = ?, updated_at = ? WHERE id = ?`).bind(
              spaceId,
              ts,
              payload.sessionId,
            ),
            env.DB.prepare(
              `INSERT INTO memories (
                 id, workspace_id, session_id, character_id, scope, content, content_hash,
                 importance, source, created_at, updated_at, memory_type, status, external_id,
                 source_task_id, provenance_json
               ) VALUES (?, ?, ?, NULL, 'nmem', ?, ?, 0.45, ?, ?, ?, 'event', 'active', ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 content = excluded.content, content_hash = excluded.content_hash,
                 source = excluded.source, updated_at = excluded.updated_at, status = 'active',
                 external_id = excluded.external_id, source_task_id = excluded.source_task_id,
                 provenance_json = excluded.provenance_json`,
            ).bind(
              `nmem:${payload.taskId}`,
              workspaceId,
              payload.sessionId,
              content,
              await sha256(content),
              externalMemoryId ? `nmem:${externalMemoryId}` : "nmem",
              ts,
              ts,
              externalMemoryId,
              payload.taskId,
              JSON.stringify({ origin: "sync_turn", space_id: spaceId, thread_id: threadId }),
            ),
          ]);
          await completeNmemSync(env.DB, {
            taskId: payload.taskId,
            coreMemoryCount: mirroredCount,
            turnExternalId: externalMemoryId,
            threadId,
          });
          msg.ack();
        } catch (error) {
          await failNmemSync(env.DB, msg.body.taskId, error, msg.attempts >= 4).catch(() => undefined);
          console.error("nmem queue sync failed", {
            taskId: msg.body.taskId,
            sessionId: msg.body.sessionId,
            attempt: msg.attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          msg.retry();
        }
      }
      return;
    }
    for (const msg of batch.messages) {
      let taskId = "";
      try {
        const body = typeof msg.body === "string" ? JSON.parse(msg.body) : msg.body;
        const { taskId: id, sessionId } = body;
        taskId = id;
        const existing = await getTask(env.DB, taskId);
        if (
          !existing ||
          existing.status === "completed" ||
          existing.status === "failed" ||
          existing.status === "dead"
        ) {
          msg.ack();
          continue;
        }
        const owner = `queue-${msg.id}-${crypto.randomUUID()}`;
        const leased = await leaseTask(env.DB, taskId, owner);
        if (!leased) {
          msg.retry({ delaySeconds: 5 });
          continue;
        }
        const workspaceId = leased.workspace_id;
        const fs = workspaceFs(env.BUCKET, workspaceId);
        const pack = await loadPack(fs, workspaceId);
        const settings = await loadSettings(env.BUCKET);
        const loaded = await loadSession(fs, sessionId);
        const ooc = isOocMessage(leased.user_text);
        const persistedAssistant = [...loaded.messages]
          .reverse()
          .find((message) => message.role === "assistant" && message.task_id === taskId);
        if (persistedAssistant) {
          const diagnostics = await loadTurnDiagnostics(fs, sessionId);
          await mirrorCoreMemorySnapshot(env.DB, {
            workspaceId,
            sessionId,
            taskId,
            snapshot: await loadMemory(fs),
          });
          if (!ooc) {
            await env.NMEM_QUEUE.send({
              kind: "nmem",
              taskId,
              workspaceId,
              sessionId,
              userText: leased.user_text,
              assistantText: persistedAssistant.content,
            });
          }
          await completeTask(env.DB, taskId, {
            content: persistedAssistant.content,
            includeInPrompt: !ooc,
            requestHash: diagnostics?.task_id === taskId ? diagnostics.request_hash || undefined : undefined,
            cacheStatus: diagnostics?.task_id === taskId ? diagnostics.response_cache_status : undefined,
            usage: diagnostics?.task_id === taskId ? diagnostics.ai_usage : undefined,
            stablePrefixTokens: diagnostics?.task_id === taskId ? diagnostics.stable_prefix_tokens || 0 : undefined,
            volatileTokens: diagnostics?.task_id === taskId ? diagnostics.volatile_tokens || 0 : undefined,
            hiddenEvents: diagnostics?.task_id === taskId ? diagnostics.hidden_prompt_events || [] : undefined,
            rotatePromptEpochReason:
              diagnostics?.task_id === taskId ? diagnostics.rotate_prompt_epoch_reason || undefined : undefined,
          });
          msg.ack();
          continue;
        }
        const last = loaded.messages[loaded.messages.length - 1];
        if (last?.role !== "user" || (last.task_id !== taskId && last.content !== leased.user_text)) {
          await saveSession(
            fs,
            sessionId,
            [...loaded.messages, { role: "user", content: leased.user_text, ts: leased.created_at, task_id: taskId }],
            {
              thread_id: loaded.thread_id,
              nmem_space: loaded.nmem_space,
              primary_character: loaded.primary_character,
              title: loaded.title,
            },
          );
        }
        const model = JSON.parse(leased.model_snapshot_json) as AiModelConfig;
        const result = ooc
          ? await runOoc(env, fs, pack, sessionId, leased.user_text, settings, {
              model,
              affinityKey: (await sessionRuntime(env.DB, sessionId)).affinity_key,
              taskId,
            })
          : await runTurn(
              env,
              fs,
              pack,
              sessionId,
              leased.user_text,
              settings,
              await overlays(fs),
              (job) => ctx.waitUntil(job),
              {
                persistUser: false,
                deferNmemWrites: true,
                ai: {
                  db: env.DB,
                  taskId,
                  model,
                  requestKind:
                    leased.kind === "rewrite" ? "rewrite" : leased.kind === "regenerate" ? "regenerate" : "story",
                },
              },
            );
        if (!ooc) {
          await mirrorCoreMemorySnapshot(env.DB, {
            workspaceId,
            sessionId,
            taskId,
            snapshot: await loadMemory(fs),
          });
          await env.NMEM_QUEUE.send({
            kind: "nmem",
            taskId,
            workspaceId,
            sessionId,
            userText: leased.user_text,
            assistantText: result.text,
          });
        }
        await completeTask(env.DB, taskId, {
          content: result.text,
          includeInPrompt: !ooc,
          requestHash: result.request_hash,
          cacheStatus: result.response_cache_status,
          usage: result.ai_usage,
          stablePrefixTokens: result.stable_prefix_tokens,
          volatileTokens: result.volatile_tokens,
          hiddenEvents: (result as Partial<TurnOut>).hidden_prompt_events,
          rotatePromptEpochReason: (result as Partial<TurnOut>).rotate_prompt_epoch_reason,
        });
        msg.ack();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code =
          err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code || "") : undefined;
        await markFailed(env.DB, taskId, message, { code, dead: msg.attempts >= 4 }).catch(() => undefined);
        msg.retry();
      }
    }
  },
};
