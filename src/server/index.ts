import { consumeGeneration } from "./generation-service";
import { connectNmem, connectionStatus, drainNmem, requestNmemSnapshot, wakeNmem } from "./nmem-service";
import { takeNmemOffline } from "../adapters/nmem-connection";
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
import { openingFor, runCompact } from "./engine";
import { importStFiles, type ImportFile } from "../core/sillytavern-import";
import { listNmemSpaces, resolveSpaceId } from "../adapters/nmem";
import { PromptLibrary } from "../core/prompts";
import { listWorkspaceIds, workspaceFs } from "../adapters/r2";
import { createWorkspace } from "./seed";
import { loadSettings, publicSettings, saveSettings, type AppSettings } from "./settings";
import { parseContextConfig, parseMiniConfig } from "../core/budget";
import { flushGenerationOutbox, getActiveTask } from "./tasks";
import { parseYaml, stringifyYaml, workspaceIdOk, sessionIdNow } from "../core/util";
import { projectWorkspaceAndSession, projectWorkspaceContent, registerV2Routes } from "./api-v2";
import { mirrorCoreMemorySnapshot } from "./memory";
import { getApplicationDefaultModel, resolveSessionModel } from "./models";
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
  // Pending, stopped or failed input is already durable in D1, even if the queue
  // never started. Read it here without letting a cancelled worker mutate R2.
  const uncommitted = await env.DB.prepare(
    `SELECT m.content, m.created_at AS ts, m.task_id FROM messages m
     JOIN generation_tasks g ON g.id = m.task_id
     WHERE m.session_id = ? AND m.role = 'user' AND g.status <> 'completed'
     ORDER BY m.sequence`,
  )
    .bind(sessionId)
    .all<{ content: string; ts: string; task_id: string }>();
  const visibleMessages = [...loaded.messages];
  for (const message of uncommitted.results) {
    if (!visibleMessages.some((existing) => existing.task_id === message.task_id && existing.role === "user")) {
      const index = visibleMessages.findIndex((existing) => existing.role !== "system" && existing.ts > message.ts);
      visibleMessages.splice(index < 0 ? visibleMessages.length : index, 0, { ...message, role: "user" });
    }
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
    messages: visibleMessages,
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
      enabled: true,
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

app.get("/api/v2/nmem/status", async (c) => c.json(await connectionStatus(c.env)));
app.post("/api/v2/nmem/connect", async (c) => {
  const state = await connectNmem(c.env);
  if (state.status === "online") c.executionCtx.waitUntil(wakeNmem(c.env));
  return c.json(state);
});
app.post("/api/v2/nmem/disconnect", async (c) => {
  await takeNmemOffline(c.env.DB);
  return c.json(await connectionStatus(c.env));
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

app.post("/api/v2/play/:id/:sid/compact", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  if (await getActiveTask(c.env.DB, id, sid)) throw new HTTPException(409, { message: "生成期间不能压缩" });
  const fs = workspaceFs(c.env.BUCKET, id);
  const loaded = await loadSession(fs, sid);
  const memory = await loadMemory(fs);
  const settings = await loadSettings(c.env.BUCKET);
  const library = new PromptLibrary(await overlays(fs));
  const summaryText = await runCompact(c.env, fs, memory, loaded.messages, sid, loaded, library, settings, {
    model: await resolveSessionModel(c.env.DB, sid),
    requestKind: "compact",
  });
  await mirrorCoreMemorySnapshot(c.env.DB, { workspaceId: id, sessionId: sid, snapshot: await loadMemory(fs) });
  await createPromptEpoch(c.env.DB, sid, "context_compacted");
  await requestNmemSnapshot(c.env, id, loaded.nmem_space);
  c.executionCtx.waitUntil(wakeNmem(c.env));
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
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Dispatch durable work only while explicitly online. This never probes nmem.
    ctx.waitUntil(wakeNmem(env));
    ctx.waitUntil(flushGenerationOutbox(env));
  },
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
      // A wake-up drains durable jobs; stale V2 payloads cannot create new sync work.
      await drainNmem(env);
      batch.ackAll();
      return;
    }
    for (const msg of batch.messages) await consumeGeneration(env, msg, ctx);
  },
};
