import { DEFAULT_NMEM_SPACE_ID, type MemorySnapshot } from "../core/memory";
import { sha256 } from "../core/ai";

export type NmemSpace = { id: string; name: string; key: string };

import { nmemConnection, nmemRequest, type NmemEnv } from "./nmem-connection";
export type { NmemEnv } from "./nmem-connection";

const UA = "LightRP/0.1 (CloudflareWorker)";

function base(env: NmemEnv): { url: string; key: string } | null {
  const url = (env.NMEM_API_URL || "").replace(/\/$/, "");
  const key = env.NMEM_API_KEY || "";
  if (!url || !key) return null;
  return { url, key };
}

function headers(key: string, json = false): Record<string, string> {
  const out: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
    "User-Agent": UA,
  };
  if (json) out["Content-Type"] = "application/json";
  return out;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function unwrapMemories(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.map((row) => {
      if (row && typeof row === "object" && "memory" in row) {
        const wrapped = row as { memory?: Record<string, unknown>; similarity_score?: number };
        if (wrapped.memory && typeof wrapped.memory === "object") {
          return { ...wrapped.memory, similarity_score: wrapped.similarity_score };
        }
      }
      return row as Record<string, unknown>;
    });
  }
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    const rows = rec.memories || rec.results || rec.items;
    if (Array.isArray(rows)) return unwrapMemories(rows);
  }
  return [];
}

export function resolveSpaceId(raw: string | null | undefined, spaces: NmemSpace[]): string | null {
  const text = (raw || DEFAULT_NMEM_SPACE_ID).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const hit = spaces.find(
    (space) =>
      space.id === text ||
      space.key === text ||
      space.name === text ||
      space.id.toLowerCase() === lower ||
      space.key.toLowerCase() === lower ||
      space.name.toLowerCase() === lower,
  );
  return hit?.id || text;
}

export async function listNmemSpaces(
  env: NmemEnv,
): Promise<{ available: boolean; spaces: NmemSpace[]; error?: string }> {
  const auth = base(env);
  if (!auth) return { available: false, spaces: [], error: "missing nmem url or key" };
  if (env.DB && env.nmemProbeRevision === undefined) {
    const state = await nmemConnection(env.DB);
    return {
      available: state.status === "online",
      spaces: state.status === "online" ? JSON.parse(state.spaces_json) : [],
    };
  }
  try {
    const response = await nmemRequest(env, `${auth.url}/spaces`, { headers: headers(auth.key) });
    if (!response.ok) {
      return { available: false, spaces: [], error: `nmem spaces HTTP ${response.status}` };
    }
    const data = await readJson(response);
    const rec = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const rows = Array.isArray(data) ? data : (rec?.spaces as NmemSpace[]) || [];
    return {
      available: true,
      spaces: rows
        .filter((row) => row && typeof row === "object")
        .map((row) => {
          const item = row as NmemSpace & { space_id?: string };
          const id = item.id || item.key || item.space_id || "";
          return { id, name: item.name || id, key: item.key || id };
        })
        .filter((row) => row.id),
    };
  } catch (err) {
    return { available: false, spaces: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function postSearch(
  env: NmemEnv,
  auth: { url: string; key: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await nmemRequest(env, `${auth.url}/memories/search`, {
    method: "POST",
    headers: headers(auth.key, true),
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const detail =
      data && typeof data === "object" ? JSON.stringify(data).slice(0, 240) : String(data || "").slice(0, 240);
    throw new Error(`nmem search HTTP ${response.status}: ${detail}`);
  }
  return unwrapMemories(data);
}

export async function searchNmem(
  env: NmemEnv,
  spaceId: string,
  query: string,
  limit = 8,
  filterLabels: string[] = ["light-rp"],
): Promise<Record<string, unknown>[]> {
  const auth = base(env);
  if (!auth || !spaceId || !query.trim()) return [];
  const recallEnv = { ...env, nmemDeadline: Math.min(env.nmemDeadline ?? Infinity, Date.now() + 1500) };
  try {
    return await postSearch(recallEnv, auth, { query, limit, space_id: spaceId, filter_labels: filterLabels });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/HTTP 422/.test(message)) throw err;
    return postSearch(recallEnv, auth, { query, limit, space_id: spaceId });
  }
}

export function formatNmemRecall(rows: Record<string, unknown>[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const title = String(row.title || "").trim();
    const content = String(row.content || row.content_preview || "").trim();
    if (title && content) lines.push(`- ${title}: ${content}`);
    else if (content) lines.push(`- ${content}`);
    else if (title) lines.push(`- ${title}`);
  }
  return lines.join("\n");
}

export async function addNmemMemory(
  env: NmemEnv,
  spaceId: string,
  content: string,
  title: string,
  labels: string[],
  options: { id?: string; importance?: number; unitType?: string; metadata?: Record<string, unknown> } = {},
): Promise<string | null> {
  const auth = base(env);
  if (!auth || !spaceId) return null;
  const response = await nmemRequest(env, `${auth.url}/memories`, {
    method: "POST",
    headers: headers(auth.key, true),
    body: JSON.stringify({
      ...(options.id ? { id: options.id } : {}),
      title,
      content,
      labels,
      source: "lightrp",
      space_id: spaceId,
      importance: options.importance ?? 0.6,
      unit_type: options.unitType || "context",
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }),
  });
  if (response.status === 409 && options.id) return options.id;
  if (!response.ok) throw new Error(`nmem add HTTP ${response.status}`);
  const data = (await readJson(response)) as Record<string, unknown> | null;
  const memory = (data?.memory as Record<string, unknown> | undefined) || data;
  const id = memory?.id || memory?.memory_id;
  if (!id) throw new Error("nmem add returned no memory id");
  return String(id);
}

export async function forgetNmemMemory(env: NmemEnv, spaceId: string, memoryId: string): Promise<void> {
  const auth = base(env);
  if (!auth || !spaceId || !memoryId) return;
  const response = await nmemRequest(env, `${auth.url}/memories/${encodeURIComponent(memoryId)}/forget`, {
    method: "POST",
    headers: headers(auth.key, true),
    body: JSON.stringify({ space_id: spaceId }),
  });
  if (!response.ok && response.status !== 404) throw new Error(`nmem forget HTTP ${response.status}`);
}

export async function updateNmemMemory(env: NmemEnv, memoryId: string, content: string): Promise<void> {
  const auth = base(env);
  if (!auth || !memoryId) return;
  const response = await nmemRequest(env, `${auth.url}/memories/${encodeURIComponent(memoryId)}`, {
    method: "PATCH",
    headers: headers(auth.key, true),
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`nmem update HTTP ${response.status}`);
}

export type NmemIndex = Record<string, string[]>;

export async function loadNmemIndex(get: (path: string) => Promise<string | null>): Promise<NmemIndex> {
  const text = await get(".nmem-index.json");
  if (!text) return {};
  try {
    const raw = JSON.parse(text) as NmemIndex;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function saveNmemIndex(
  put: (path: string, text: string, type?: string) => Promise<void>,
  index: NmemIndex,
): Promise<void> {
  await put(".nmem-index.json", JSON.stringify(index, null, 2), "application/json");
}

export async function syncFactToNmem(
  env: NmemEnv,
  spaceId: string,
  index: NmemIndex,
  worldId: string,
  target: string,
  characterId: string | null,
  live: string[],
): Promise<NmemIndex> {
  const key = target === "character" ? `character:${characterId || "?"}` : target;
  const ids = [...(index[key] || [])];
  const labels = ["light-rp", `world:${worldId}`, `target:${target}`];
  if (characterId) labels.push(`character:${characterId}`);
  while (ids.length < live.length) ids.push("");
  const next = ids.slice(0, live.length);
  for (const removedId of ids.slice(live.length)) {
    if (removedId) await forgetNmemMemory(env, spaceId, removedId);
  }
  for (let i = 0; i < live.length; i += 1) {
    const title = `${worldId}/${key}#${i + 1}`;
    if (next[i]) await updateNmemMemory(env, next[i], live[i]);
    else {
      const digest = await sha256(`${worldId}:${key}:${i}`);
      next[i] =
        (await addNmemMemory(env, spaceId, live[i], title, labels, {
          id: `lightrp-fact-${digest.slice(0, 40)}`,
          importance: 0.8,
          unitType: target === "player" ? "preference" : "fact",
          metadata: { world_id: worldId, target, character_id: characterId, position: i },
        })) || "";
    }
  }
  return { ...index, [key]: next };
}

export async function syncMemorySnapshotToNmem(
  env: NmemEnv,
  spaceId: string,
  index: NmemIndex,
  worldId: string,
  memory: MemorySnapshot,
): Promise<{ index: NmemIndex; count: number }> {
  let next = await syncFactToNmem(env, spaceId, index, worldId, "world", null, memory.world);
  next = await syncFactToNmem(env, spaceId, next, worldId, "player", null, memory.player);
  for (const characterId of Object.keys(memory.characters).sort()) {
    next = await syncFactToNmem(
      env,
      spaceId,
      next,
      worldId,
      "character",
      characterId,
      memory.characters[characterId] || [],
    );
  }
  return {
    index: next,
    count:
      memory.world.length +
      memory.player.length +
      Object.values(memory.characters).reduce((sum, entries) => sum + entries.length, 0),
  };
}

export function sessionThreadId(worldId: string, sessionId: string): string {
  return `lightrp_${worldId}_${sessionId}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
}

export function formatTurnMemory(userText: string, assistantText: string): string {
  return `你: ${userText}\n\n世界: ${assistantText}`;
}

type ThreadMessage = { role: string; content: string };

async function postJson(
  env: NmemEnv,
  auth: { url: string; key: string },
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await nmemRequest(
    env,
    `${auth.url}${path}`,
    { method: "POST", headers: headers(auth.key, true), body: JSON.stringify(body) },
    timeoutMs,
  );
  return { ok: response.ok, status: response.status, data: await readJson(response) };
}

export async function syncThreadTurn(
  env: NmemEnv,
  spaceId: string,
  existingThreadId: string | null,
  threadId: string,
  title: string,
  messages: ThreadMessage[],
  idempotencyKey?: string,
): Promise<void> {
  const auth = base(env);
  if (!auth || !spaceId || !messages.length) return;
  const payload = messages.map((item) => ({ role: item.role, content: item.content }));
  if (!existingThreadId) {
    const created = await postJson(
      env,
      auth,
      "/threads",
      {
        thread_id: threadId,
        title,
        messages: payload,
        source: "lightrp",
        space_id: spaceId,
        labels: ["light-rp"],
      },
      3000,
    );
    if (created.ok) return;
    if (created.status !== 409) {
      throw new Error(`nmem thread create HTTP ${created.status}`);
    }
  }
  const appended = await postJson(
    env,
    auth,
    `/threads/${encodeURIComponent(threadId)}/append`,
    { messages: payload, deduplicate: true, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) },
    3000,
  );
  if (!appended.ok) throw new Error(`nmem thread append HTTP ${appended.status}`);
}

export async function syncTurnBodyToNmem(
  env: NmemEnv,
  spaceId: string,
  worldId: string,
  sessionId: string,
  userText: string,
  assistantText: string,
  taskId?: string,
): Promise<string | null> {
  const content = formatTurnMemory(userText, assistantText);
  const stableId = taskId ? `lightrp-turn-${taskId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96)}` : undefined;
  return addNmemMemory(
    env,
    spaceId,
    content,
    `${worldId}/${sessionId}`,
    ["light-rp", `world:${worldId}`, `session:${sessionId}`, "lightrp-turn"],
    {
      id: stableId,
      importance: 0.45,
      unitType: "event",
      metadata: { world_id: worldId, session_id: sessionId, task_id: taskId || null },
    },
  );
}
