export type NmemSpace = { id: string; name: string; key: string };

export type NmemEnv = { NMEM_API_URL?: string; NMEM_API_KEY?: string };

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

async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  let response: Response | null = null;
  for (let i = 0; i < 3; i += 1) {
    response = await fetch(url, init);
    if (response.ok || ![429, 502, 503, 504].includes(response.status)) return response;
    await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
  }
  return response as Response;
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
  const text = (raw || "").trim();
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

export async function listNmemSpaces(env: NmemEnv): Promise<{ available: boolean; spaces: NmemSpace[]; error?: string }> {
  const auth = base(env);
  if (!auth) return { available: false, spaces: [], error: "missing nmem url or key" };
  try {
    const response = await fetchRetry(`${auth.url}/spaces`, { headers: headers(auth.key) });
    if (!response.ok) {
      return { available: false, spaces: [], error: `nmem spaces HTTP ${response.status}` };
    }
    const data = await readJson(response);
    const rec = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const rows = Array.isArray(data) ? data : ((rec?.spaces as NmemSpace[]) || []);
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
  auth: { url: string; key: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const response = await fetchRetry(`${auth.url}/memories/search`, {
    method: "POST",
    headers: headers(auth.key, true),
    body: JSON.stringify(body),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const detail = data && typeof data === "object" ? JSON.stringify(data).slice(0, 240) : String(data || "").slice(0, 240);
    throw new Error(`nmem search HTTP ${response.status}: ${detail}`);
  }
  return unwrapMemories(data);
}

export async function searchNmem(
  env: NmemEnv,
  spaceId: string,
  query: string,
  limit = 8,
): Promise<Record<string, unknown>[]> {
  const auth = base(env);
  if (!auth || !spaceId || !query.trim()) return [];
  try {
    return await postSearch(auth, { query, limit, space_id: spaceId, filter_labels: ["light-rp"] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/HTTP 422|HTTP 502/.test(message)) throw err;
    return postSearch(auth, { query, limit, space_id: spaceId });
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
): Promise<string | null> {
  const auth = base(env);
  if (!auth || !spaceId) return null;
  const response = await fetchRetry(`${auth.url}/memories`, {
    method: "POST",
    headers: headers(auth.key, true),
    body: JSON.stringify({
      title,
      content,
      labels,
      source: "lightrp",
      space_id: spaceId,
    }),
  });
  if (!response.ok) throw new Error(`nmem add HTTP ${response.status}`);
  const data = (await readJson(response)) as Record<string, unknown> | null;
  const memory = (data?.memory as Record<string, unknown> | undefined) || data;
  const id = memory?.id || memory?.memory_id;
  return id ? String(id) : null;
}

export async function updateNmemMemory(env: NmemEnv, memoryId: string, content: string): Promise<void> {
  const auth = base(env);
  if (!auth || !memoryId) return;
  const response = await fetchRetry(`${auth.url}/memories/${encodeURIComponent(memoryId)}`, {
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

export async function saveNmemIndex(put: (path: string, text: string, type?: string) => Promise<void>, index: NmemIndex): Promise<void> {
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
  for (let i = 0; i < live.length; i += 1) {
    const title = `${worldId}/${key}#${i + 1}`;
    if (next[i]) await updateNmemMemory(env, next[i], live[i]);
    else next[i] = (await addNmemMemory(env, spaceId, live[i], title, labels)) || "";
  }
  return { ...index, [key]: next };
}
