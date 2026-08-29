import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  cardFromObj,
  cardToExport,
  findMember,
  loadCard,
  loadMemory,
  loadPack,
  loadSession,
  listSessions,
  memberPresent,
  parseScene,
  saveCast,
  saveSession,
  saveWorldMeta,
  sessionInfoFrom,
  deleteSession,
  deleteWorkspace,
  type CastMember,
  type WorldPack,
} from "./domain";
import { openingFor, runCompact, runTurn } from "./engine";
import { importStFiles, type ImportFile } from "./st";
import { listNmemSpaces, resolveSpaceId } from "./nmem";
import { PromptLibrary } from "./prompts";
import { listWorkspaceIds, workspaceFs } from "./r2";
import { createWorkspace, seedLampHarbor } from "./seed";
import { loadSettings, publicSettings, saveSettings, type AppSettings } from "./settings";
import { parseYaml, stringifyYaml, workspaceIdOk, sessionIdNow } from "./util";

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

async function ensureSeed(bucket: R2Bucket) {
  const ids = await listWorkspaceIds(bucket);
  if (!ids.length) await seedLampHarbor(bucket);
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
    path: `r2://lightrp/workspaces/${pack.id}`,
    nmem_space: pack.nmem_space,
    player_name: pack.player_name,
    latest_session: latest,
    latest_nmem_space: latestNmem,
    session_count: extra.session_count ?? 0,
    cast: pack.cast.map((member) => ({
      id: member.id,
      name: member.name,
      blurb: member.blurb,
      present: member.present,
      aliases: member.aliases,
    })),
  };
}

async function playState(env: Env, fs: ReturnType<typeof workspaceFs>, pack: WorldPack, sessionId: string, extra: Record<string, unknown> = {}) {
  const loaded = await loadSession(fs, sessionId);
  const scene = parseScene(await fs.get("SCENE.md"));
  const memory = await loadMemory(fs);
  const cards = [];
  for (const member of pack.cast) {
    if (!memberPresent(member, scene.present)) continue;
    try {
      cards.push(await loadCard(fs, member));
    } catch {
      /* skip */
    }
  }
  const sessions = await listSessions(fs);
  return {
    world: { ...summary(pack, sessionId, loaded.nmem_space, { session_count: sessions.length }), sessions, world_text: pack.world_text },
    session_id: sessionId,
    session_title: sessionInfoFrom(sessionId, loaded).title,
    nmem_space: loaded.nmem_space,
    nmem_available: extra.nmem_available != null ? Boolean(extra.nmem_available) : Boolean(env.NMEM_API_KEY),
    warnings: [] as string[],
    opening: openingFor(cards, pack.player_name),
    scene,
    memory: memory.world.join("\n§\n"),
    player: memory.player.join("\n§\n"),
    messages: loaded.messages,
    ...extra,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  const status = err instanceof HTTPException ? err.status : message.includes("not found") || message.includes("不存在") ? 404 : 500;
  return c.json({ detail: message }, status as 400);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/settings", async (c) => {
  const settings = await loadSettings(c.env.BUCKET);
  const listed = await listNmemSpaces(c.env);
  settings.nmem.space = resolveSpaceId(settings.nmem.space, listed.spaces) || "";
  return c.json(publicSettings(c.env, settings));
});

app.put("/api/settings", async (c) => {
  const body = (await c.req.json()) as Partial<AppSettings> & { llm?: Partial<AppSettings["llm"]>; nmem?: Partial<AppSettings["nmem"]>; memory?: Partial<AppSettings["memory"]> };
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
  };
  await saveSettings(c.env.BUCKET, next);
  return c.json(publicSettings(c.env, next));
});

app.get("/api/nmem/spaces", async (c) => c.json(await listNmemSpaces(c.env)));

app.get("/api/worlds", async (c) => {
  await ensureSeed(c.env.BUCKET);
  const ids = await listWorkspaceIds(c.env.BUCKET);
  const worlds = [];
  for (const id of ids) {
    const fs = workspaceFs(c.env.BUCKET, id);
    const pack = await loadPack(fs, id);
    const sessions = await listSessions(fs);
    worlds.push(summary(pack, sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }));
  }
  return c.json({ worlds });
});

app.post("/api/worlds", async (c) => {
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
  return c.json(summary(await loadPack(fs, id), null, null, { session_count: 0 }));
});

app.delete("/api/worlds/:id", async (c) => {
  const id = c.req.param("id");
  if (!workspaceIdOk(id)) throw new HTTPException(400, { message: "invalid workspace id" });
  const fs = workspaceFs(c.env.BUCKET, id);
  if (!(await fs.get("world.yaml")) && !(await fs.get("WORLD.md"))) {
    throw new HTTPException(404, { message: `world '${id}' not found` });
  }
  await deleteWorkspace(fs);
  return c.json({ ok: true, id });
});

app.get("/api/worlds/:id", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  if (!pack.world_text && !(await fs.get("world.yaml"))) throw new HTTPException(404, { message: `world '${id}' not found` });
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(pack, sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }),
    sessions,
    world_text: pack.world_text,
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.put("/api/worlds/:id", async (c) => {
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
  };
  if (body.name != null) pack.name = body.name;
  if (body.player_name != null) pack.player_name = body.player_name;
  if (body.nmem_space !== undefined) pack.nmem_space = body.nmem_space;
  if (body.lore_token_budget !== undefined) pack.lore_token_budget = body.lore_token_budget;
  if (body.lore_scan_depth !== undefined) pack.lore_scan_depth = body.lore_scan_depth;
  if (body.world_text != null) await fs.put("WORLD.md", body.world_text);
  if (body.player_text != null) await fs.put("PLAYER.md", body.player_text);
  await saveWorldMeta(fs, pack);
  await saveCast(fs, pack);
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(await loadPack(fs, id), sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }),
    sessions,
    world_text: (await fs.get("WORLD.md")) || "",
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.get("/api/worlds/:id/cards", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  const cards = [];
  for (const member of pack.cast) {
    try {
      cards.push({ member, card: await loadCard(fs, member) });
    } catch {
      cards.push({ member, card: null });
    }
  }
  return c.json({ cards });
});

app.put("/api/worlds/:id/cards/:cid", async (c) => {
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
    aliases: Array.isArray(memberPatch.aliases) ? memberPatch.aliases.map(String) : existing?.aliases || card.tags.slice(0, 4),
  };
  if (asJson && member.card.endsWith(".yaml")) member.card = member.card.replace(/\.ya?ml$/i, ".json");
  const next = pack.cast.filter((item) => item.id !== cid);
  next.push(member);
  pack.cast = next;
  if (member.card.endsWith(".json")) {
    const previousText = await fs.get(member.card);
    let previous: Record<string, unknown> = {};
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
  return c.json({ member, card: { ...card, id: cid } });
});

app.delete("/api/worlds/:id/cards/:cid", async (c) => {
  const id = c.req.param("id");
  const cid = c.req.param("cid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const member = findMember(pack, cid);
  if (member) await fs.del(member.card);
  pack.cast = pack.cast.filter((item) => item.id !== cid);
  await saveCast(fs, pack);
  return c.json({ ok: true });
});

app.get("/api/worlds/:id/lorebooks", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const files = (await fs.list("lorebooks/")).filter((n) => /\.(json|ya?ml)$/i.test(n));
  const items = [];
  for (const file of files) {
    items.push({ name: file.replace(/^lorebooks\//, ""), text: (await fs.get(file)) || "" });
  }
  return c.json({ lorebooks: items });
});

app.put("/api/worlds/:id/lorebooks/:name", async (c) => {
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
  return c.json({ name: dest, text });
});

app.delete("/api/worlds/:id/lorebooks/:name", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  await fs.del(`lorebooks/${decodeURIComponent(c.req.param("name"))}`);
  return c.json({ ok: true });
});

app.post("/api/worlds/:id/import", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = (await c.req.json()) as { files?: ImportFile[] };
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new HTTPException(400, { message: "files is required" });
  const result = await importStFiles(fs, pack, files);
  await saveWorldMeta(fs, pack);
  await saveCast(fs, pack);
  const sessions = await listSessions(fs);
  return c.json({
    ...summary(await loadPack(fs, id), sessions[0]?.id || null, sessions[0]?.nmem_space || null, { session_count: sessions.length }),
    imported: result,
    world_text: (await fs.get("WORLD.md")) || "",
    player_text: (await fs.get("PLAYER.md")) || "",
  });
});

app.post("/api/worlds/:id/sessions", async (c) => {
  const id = c.req.param("id");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { new?: boolean; session_id?: string; space?: string | null };
  const listed = await listNmemSpaces(c.env);
  const settings = await loadSettings(c.env.BUCKET);
  const requested = body.space === undefined ? pack.nmem_space || settings.nmem.space : body.space;
  const space = resolveSpaceId(requested, listed.spaces);
  let sessionId = body.session_id;
  if (!sessionId || body.new) {
    sessionId = sessionIdNow();
    await saveSession(fs, sessionId, [], { nmem_space: space });
  }
  return c.json(await playState(c.env, fs, pack, sessionId, { nmem_available: listed.available }));
});

app.get("/api/worlds/:id/sessions", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  await loadPack(fs, c.req.param("id"));
  return c.json({ sessions: await listSessions(fs) });
});

app.patch("/api/worlds/:id/sessions/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const sid = c.req.param("sid");
  const body = (await c.req.json()) as { title?: string };
  const title = (body.title || "").trim();
  if (!title) throw new HTTPException(400, { message: "title is required" });
  const loaded = await loadSession(fs, sid);
  await saveSession(fs, sid, loaded.messages, {
    thread_id: loaded.thread_id,
    nmem_space: loaded.nmem_space,
    title,
  });
  return c.json(sessionInfoFrom(sid, { ...loaded, title }));
});

app.delete("/api/worlds/:id/sessions/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  await deleteSession(fs, c.req.param("sid"));
  return c.json({ ok: true, id: c.req.param("sid") });
});

app.get("/api/play/:id/:sid", async (c) => {
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const pack = await loadPack(fs, c.req.param("id"));
  return c.json(await playState(c.env, fs, pack, c.req.param("sid")));
});

app.post("/api/play/:id/:sid/turn", async (c) => {
  const body = (await c.req.json()) as { text?: string };
  const text = (body.text || "").trim();
  if (!text) throw new HTTPException(400, { message: "text is required" });
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const pack = await loadPack(fs, id);
  const settings = await loadSettings(c.env.BUCKET);
  try {
    const result = await runTurn(c.env, fs, pack, sid, text, settings, await overlays(fs));
    return c.json({
      ...(await playState(c.env, fs, pack, sid)),
      reply: result.text,
      spotlight: result.spotlight_ids,
      nmem_synced: result.nmem_synced,
      turn_warnings: result.warnings,
    });
  } catch (err) {
    throw new HTTPException(502, { message: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/play/:id/:sid/compact", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  const fs = workspaceFs(c.env.BUCKET, id);
  const loaded = await loadSession(fs, sid);
  const memory = await loadMemory(fs);
  const settings = await loadSettings(c.env.BUCKET);
  const library = new PromptLibrary(await overlays(fs));
  const summaryText = await runCompact(c.env, fs, memory, loaded.messages, sid, loaded, library, settings, id);
  const pack = await loadPack(fs, id);
  return c.json({ ...(await playState(c.env, fs, pack, sid)), summary: summaryText });
});

app.post("/api/play/:id/:sid/space", async (c) => {
  const body = (await c.req.json()) as { space?: string };
  const fs = workspaceFs(c.env.BUCKET, c.req.param("id"));
  const loaded = await loadSession(fs, c.req.param("sid"));
  const listed = await listNmemSpaces(c.env);
  const space = resolveSpaceId(body.space || null, listed.spaces);
  await saveSession(fs, c.req.param("sid"), loaded.messages, { thread_id: loaded.thread_id, nmem_space: space });
  const pack = await loadPack(fs, c.req.param("id"));
  return c.json(await playState(c.env, fs, pack, c.req.param("sid")));
});

export default app;
