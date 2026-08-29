export type CharacterCard = {
  id: string;
  name: string;
  age: string;
  description: string;
  personality: string;
  behavior: string;
  speech: string;
  likes: string;
  dislikes: string;
  backstory: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  tags: string[];
  character_book?: Record<string, unknown> | null;
  post_history_instructions?: string;
  alternate_greetings?: string[];
};

export type CastMember = {
  id: string;
  name: string;
  blurb: string;
  present: boolean;
  aliases: string[];
};

export type SessionInfo = {
  id: string;
  title: string;
  messages: number;
  nmem_space: string | null;
  updated: string;
  preview: string;
};

export type WorldSummary = {
  id: string;
  name: string;
  path: string;
  nmem_space: string | null;
  player_name: string;
  primary?: string | null;
  latest_session: string | null;
  latest_nmem_space?: string | null;
  session_count?: number;
  cast: CastMember[];
  sessions?: SessionInfo[];
  world_text?: string;
  player_text?: string;
};

export type ContextReport = {
  max_tokens: number;
  generation_reserve: number;
  tool_reserve?: number;
  total: number;
  estimated?: boolean;
  sections: { name: string; tokens: number; budget: number; truncated: boolean; items?: string[]; protected?: boolean }[];
  history: { tokens: number; messages: number; truncated: boolean };
  input: { tokens: number };
  phi_tokens?: number;
  extra_system_tokens?: number;
};

export type AppSettings = {
  path: string;
  llm: {
    base_url: string;
    model: string;
    api_key_set: boolean;
    api_key_env: string;
    temperature: number;
    max_tokens: number;
    timeout: number;
    breach: boolean;
  };
  nmem: { enabled: boolean; space: string; binary: string };
  memory: { world_char_limit: number; player_char_limit: number; character_char_limit: number };
  worlds_dir: string;
  home: string;
  compact_after_turns: number;
  lore_scan_depth: number;
  lore_token_budget: number;
  max_tool_rounds: number;
  transcript_keep_after_compact: number;
  context: {
    max_tokens: number;
    generation_reserve: number;
    tool_reserve?: number;
    budget: Record<string, number>;
    history: { use_remaining: boolean; protect_recent_turns: number };
  };
  mini: { max_tokens: number; recent_turns: number; max_characters: number };
};

export type SettingsPut = {
  llm: {
    base_url: string;
    model: string;
    api_key?: string | null;
    clear_api_key?: boolean;
    api_key_env: string;
    temperature: number;
    max_tokens: number;
    timeout: number;
    breach: boolean;
  };
  nmem: { enabled: boolean; space: string; binary: string };
  memory: { world_char_limit: number; player_char_limit: number; character_char_limit: number };
  worlds_dir: string;
  home: string;
  compact_after_turns: number;
  lore_scan_depth: number;
  lore_token_budget: number;
  max_tool_rounds: number;
  transcript_keep_after_compact: number;
  context: AppSettings["context"];
  mini: AppSettings["mini"];
};

export type PlayState = {
  world: WorldSummary;
  session_id: string;
  session_title?: string;
  primary_character?: string | null;
  nmem_space: string | null;
  nmem_available: boolean;
  warnings: string[];
  opening: string;
  scene: {
    location: string;
    time: string;
    season?: string;
    weather?: string;
    present: string[];
    scene?: string;
    ongoing?: string[];
    notes: string;
  };
  memory: string;
  player: string;
  player_memory?: string;
  messages: { role: string; content: string; ts: string }[];
  reply?: string;
  spotlight?: string[];
  nmem_synced?: boolean;
  turn_warnings?: string[];
  summary?: string;
  context_report?: ContextReport | null;
};

export type MiniCard = {
  id: string;
  name: string;
  summary: string;
  behavior_notes: string;
  relations: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (Array.isArray(body.detail)) {
        detail = body.detail
          .map((item: { msg?: string; loc?: unknown[] }) => item.msg || JSON.stringify(item))
          .join("；");
      } else {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body);
      }
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  worlds: () => request<{ worlds: WorldSummary[] }>("/api/worlds"),
  world: (id: string) => request<WorldSummary>(`/api/worlds/${id}`),
  spaces: () => request<{ available: boolean; error?: string; spaces: { id: string; name: string; key: string }[] }>("/api/nmem/spaces"),
  open: (worldId: string, body: { new?: boolean; session_id?: string; space?: string | null }) =>
    request<PlayState>(`/api/worlds/${worldId}/sessions`, { method: "POST", body: JSON.stringify(body) }),
  play: (worldId: string, sessionId: string) => request<PlayState>(`/api/play/${worldId}/${sessionId}`),
  turn: (worldId: string, sessionId: string, text: string) =>
    request<PlayState>(`/api/play/${worldId}/${sessionId}/turn`, { method: "POST", body: JSON.stringify({ text }) }),
  compact: (worldId: string, sessionId: string) =>
    request<PlayState>(`/api/play/${worldId}/${sessionId}/compact`, { method: "POST" }),
  setSpace: (worldId: string, sessionId: string, space: string) =>
    request<PlayState>(`/api/play/${worldId}/${sessionId}/space`, {
      method: "POST",
      body: JSON.stringify({ space }),
    }),
  settings: () => request<AppSettings>("/api/settings"),
  saveSettings: (body: SettingsPut) => request<AppSettings>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  createWorld: (body: { id: string; name: string; player_name?: string }) =>
    request<WorldSummary>("/api/worlds", { method: "POST", body: JSON.stringify(body) }),
  deleteWorld: (id: string) => request<{ ok: boolean }>(`/api/worlds/${id}`, { method: "DELETE" }),
  saveWorld: (
    id: string,
    body: {
      name?: string;
      player_name?: string;
      nmem_space?: string | null;
      world_text?: string;
      player_text?: string;
      primary?: string | null;
    },
  ) => request<WorldSummary>(`/api/worlds/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  sessions: (id: string) => request<{ sessions: SessionInfo[] }>(`/api/worlds/${id}/sessions`),
  renameSession: (worldId: string, sessionId: string, title: string) =>
    request<SessionInfo>(`/api/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  patchSession: (worldId: string, sessionId: string, body: { title?: string; primary_character?: string | null }) =>
    request<PlayState | SessionInfo>(`/api/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSession: (worldId: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  cards: (id: string) =>
    request<{
      cards: {
        member: CastMember & { card: string };
        card: CharacterCard | null;
        mini: MiniCard | null;
      }[];
    }>(`/api/worlds/${id}/cards`),
  saveCard: (worldId: string, cid: string, body: Record<string, unknown>) =>
    request<{ member: CastMember; card: CharacterCard }>(`/api/worlds/${worldId}/cards/${encodeURIComponent(cid)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteCard: (worldId: string, cid: string) =>
    request<{ ok: boolean }>(`/api/worlds/${worldId}/cards/${encodeURIComponent(cid)}`, { method: "DELETE" }),
  getMini: (worldId: string, cid: string) =>
    request<{ mini: MiniCard | null }>(`/api/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini`),
  saveMini: (worldId: string, cid: string, body: MiniCard) =>
    request<{ mini: MiniCard }>(`/api/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  generateMini: (worldId: string, cid: string) =>
    request<{ mini: MiniCard }>(`/api/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini/generate`, { method: "POST" }),
  lorebooks: (id: string) => request<{ lorebooks: { name: string; text: string }[] }>(`/api/worlds/${id}/lorebooks`),
  saveLorebook: (worldId: string, name: string, text: string) =>
    request<{ name: string; text: string }>(`/api/worlds/${worldId}/lorebooks/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteLorebook: (worldId: string, name: string) =>
    request<{ ok: boolean }>(`/api/worlds/${worldId}/lorebooks/${encodeURIComponent(name)}`, { method: "DELETE" }),
  importFiles: (worldId: string, files: { name: string; text?: string; data?: string }[]) =>
    request<WorldSummary & { imported: { cards: string[]; lorebooks: string[]; warnings: string[] } }>(
      `/api/worlds/${worldId}/import`,
      { method: "POST", body: JSON.stringify({ files }) },
    ),
};
