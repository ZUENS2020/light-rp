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
  sections: {
    name: string;
    tokens: number;
    budget: number;
    truncated: boolean;
    items?: string[];
    protected?: boolean;
  }[];
  history: { tokens: number; messages: number; truncated: boolean };
  input: { tokens: number };
  phi_tokens?: number;
  extra_system_tokens?: number;
  stable_prefix_tokens?: number;
  volatile_tokens?: number;
  cached_input_tokens?: number;
  prefix_cache_ratio?: number;
  response_cache_status?: "HIT" | "MISS" | "BYPASS" | "unknown";
  output_contract_tokens?: number;
};

export type AppSettings = {
  path: string;
  llm: {
    gateway_id: string;
    model: string;
    default_model_config_id: string;
    gateway_binding: boolean;
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
    memory_split?: { world: number; player: number };
    budget: Record<string, number>;
    history: { use_remaining: boolean; protect_recent_turns: number };
  };
  mini: { max_tokens: number; recent_turns: number; max_characters: number };
};

export type SettingsPut = {
  llm: {
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
  character_memory?: Record<string, string[]>;
  messages: { role: string; content: string; ts: string; task_id?: string }[];
  reply?: string;
  spotlight?: string[];
  nmem_synced?: boolean;
  turn_warnings?: string[];
  remembered?: string[];
  state_updated?: boolean;
  summary?: string;
  context_report?: ContextReport | null;
  task_id?: string;
  task_status?: string;
};

export type GenerationTask = {
  id: string;
  world_id?: string;
  session_id?: string;
  status: "pending" | "running" | "completed" | "failed" | "dead";
  content?: string | null;
  error?: string | null;
  error_code?: string | null;
  response_cache_status?: "HIT" | "MISS" | "BYPASS" | "unknown";
  prompt_tokens?: number;
  nmem_sync_status?: "not_requested" | "pending" | "running" | "completed" | "failed" | "dead";
  nmem_synced_at?: string | null;
  nmem_error?: string | null;
  nmem_memory_count?: number;
  nmem_recall_count?: number;
  cached_input_tokens?: number;
  stable_prefix_tokens?: number;
  volatile_tokens?: number;
  output_contract_tokens?: number;
  prefix_cache_ratio?: number;
};

export type AiModelConfig = {
  id: string;
  label: string;
  transport: "cloudflare" | "gateway";
  provider_slug: string | null;
  model_id: string;
  context_window: number;
  max_output_tokens: number;
  supports_tools: boolean;
  supports_reasoning: boolean;
  enabled: boolean;
  sort_order: number;
  revision: number;
  source?: "application" | "workspace" | "session";
  metrics?: {
    requests: number;
    cache_hits: number;
    cold_starts: number;
    prompt_tokens: number;
    cached_input_tokens: number;
    estimated_saved_tokens: number;
    prefix_cache_ratio: number;
  };
};

export type CacheReport = {
  model: AiModelConfig;
  prompt_epoch: number;
  stable_prefix_tokens: number;
  volatile_tokens: number;
  output_contract_tokens: number;
  prompt_tokens: number;
  cached_input_tokens: number;
  prefix_cache_ratio: number;
  response_cache_status: "HIT" | "MISS" | "BYPASS" | "unknown";
};

export type MemoryStatus = {
  core: Partial<Record<"world" | "player" | "character" | "event" | "nmem", number>>;
  recall: { space_id: string; recalled_count: number; created_at: string } | null;
  sync: {
    status: "pending" | "running" | "completed" | "failed" | "dead";
    space_id: string;
    core_memory_count: number;
    error: string | null;
    updated_at: string;
  } | null;
};

export type TurnAccepted = { task_id: string; status: GenerationTask["status"]; duplicate?: boolean };

export type MiniCard = {
  id: string;
  name: string;
  summary: string;
  behavior_notes: string;
  relations: string;
};

export class TaskConflictError extends Error {
  task_id: string;
  status = 409 as const;
  constructor(taskId: string, message: string) {
    super(message);
    this.name = "TaskConflictError";
    this.task_id = taskId;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    const raw = await response.text();
    let detail = raw || response.statusText;
    try {
      const body = JSON.parse(raw) as { detail?: unknown; task_id?: unknown };
      if (Array.isArray(body.detail)) {
        detail = body.detail
          .map((item: { msg?: string; loc?: unknown[] }) => item.msg || JSON.stringify(item))
          .join("；");
      } else {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body);
      }
      if (response.status === 409 && typeof body.task_id === "string") {
        throw new TaskConflictError(body.task_id, typeof body.detail === "string" ? body.detail : "已有生成任务进行中");
      }
    } catch (err) {
      if (err instanceof TaskConflictError) throw err;
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  worlds: () => request<{ worlds: WorldSummary[] }>("/api/v2/worlds"),
  world: (id: string) => request<WorldSummary>(`/api/v2/worlds/${id}`),
  spaces: () =>
    request<{ available: boolean; error?: string; spaces: { id: string; name: string; key: string }[] }>(
      "/api/v2/nmem/spaces",
    ),
  open: (worldId: string, body: { new?: boolean; session_id?: string; space?: string | null }) =>
    request<PlayState>(`/api/v2/worlds/${worldId}/sessions`, { method: "POST", body: JSON.stringify(body) }),
  play: (worldId: string, sessionId: string) => request<PlayState>(`/api/v2/play/${worldId}/${sessionId}`),
  turn: (sessionId: string, text: string, idempotencyKey: string) =>
    request<TurnAccepted>(`/api/v2/sessions/${sessionId}/turn`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ text }),
    }),
  regenerate: (sessionId: string, idempotencyKey: string) =>
    request<TurnAccepted>(`/api/v2/sessions/${sessionId}/regenerate`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
    }),
  rewrite: (worldId: string, sessionId: string, index: number, content: string) =>
    request<PlayState>(`/api/v2/play/${worldId}/${sessionId}/rewrite`, {
      method: "POST",
      body: JSON.stringify({ index, content }),
    }),
  task: (taskId: string) => request<GenerationTask>(`/api/v2/tasks/${taskId}`),
  activeTask: (sessionId: string) =>
    request<{ task: GenerationTask | null }>(`/api/v2/sessions/${sessionId}/tasks/active`),
  models: () => request<{ models: AiModelConfig[] }>("/api/v2/models"),
  setApplicationDefaultModel: (modelConfigId: string) =>
    request<{ model: AiModelConfig }>("/api/v2/settings/default-model", {
      method: "PUT",
      body: JSON.stringify({ model_config_id: modelConfigId }),
    }),
  sessionModel: (sessionId: string) =>
    request<{ model: AiModelConfig; prompt_epoch: number; affinity_key: string }>(
      `/api/v2/sessions/${sessionId}/model`,
    ),
  setSessionModel: (sessionId: string, modelConfigId: string | null) =>
    request<{ model: AiModelConfig; prompt_epoch: number; affinity_key: string }>(
      `/api/v2/sessions/${sessionId}/model`,
      {
        method: "PUT",
        body: JSON.stringify({ model_config_id: modelConfigId }),
      },
    ),
  cache: (sessionId: string) => request<CacheReport>(`/api/v2/sessions/${sessionId}/cache`),
  memoryStatus: (sessionId: string) => request<MemoryStatus>(`/api/v2/sessions/${sessionId}/memory`),
  syncMemory: (worldId: string, spaceId = "rp-mem") =>
    request<{ ok: boolean; workspace_id: string; space_id: string; core_memory_count: number }>(
      `/api/v2/worlds/${worldId}/memory/sync`,
      { method: "POST", body: JSON.stringify({ space_id: spaceId }) },
    ),
  registerModel: (model: Omit<AiModelConfig, "enabled" | "revision" | "source" | "metrics">) =>
    request<{ model: AiModelConfig; probe_required: boolean }>("/api/v2/models", {
      method: "POST",
      body: JSON.stringify(model),
    }),
  probeModel: (id: string) =>
    request<{
      model: AiModelConfig;
      status: "passed" | "failed";
      error?: string;
      cache?: { text: "HIT" | "MISS" | "BYPASS" | "unknown"; tool: "HIT" | "MISS" | "BYPASS" | "unknown" | null };
    }>(`/api/v2/models/${id}/probe`, { method: "POST" }),
  compact: (worldId: string, sessionId: string) =>
    request<PlayState>(`/api/v2/play/${worldId}/${sessionId}/compact`, { method: "POST" }),
  setSpace: (worldId: string, sessionId: string, space: string) =>
    request<PlayState>(`/api/v2/play/${worldId}/${sessionId}/space`, {
      method: "POST",
      body: JSON.stringify({ space }),
    }),
  settings: () => request<AppSettings>("/api/v2/settings"),
  saveSettings: (body: SettingsPut) =>
    request<AppSettings>("/api/v2/settings", { method: "PUT", body: JSON.stringify(body) }),
  createWorld: (body: { id: string; name: string; player_name?: string }) =>
    request<WorldSummary>("/api/v2/worlds", { method: "POST", body: JSON.stringify(body) }),
  deleteWorld: (id: string) => request<{ ok: boolean }>(`/api/v2/worlds/${id}`, { method: "DELETE" }),
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
  ) => request<WorldSummary>(`/api/v2/worlds/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  saveMemory: (worldId: string, body: { world?: string; player?: string }) =>
    request<{ memory: string; player_memory: string }>(`/api/v2/worlds/${worldId}/memory`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sessions: (id: string) => request<{ sessions: SessionInfo[] }>(`/api/v2/worlds/${id}/sessions`),
  renameSession: (worldId: string, sessionId: string, title: string) =>
    request<SessionInfo>(`/api/v2/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  patchSession: (worldId: string, sessionId: string, body: { title?: string; primary_character?: string | null }) =>
    request<PlayState | SessionInfo>(`/api/v2/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSession: (worldId: string, sessionId: string) =>
    request<{ ok: boolean }>(`/api/v2/worlds/${worldId}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  cards: (id: string) =>
    request<{
      cards: {
        member: CastMember & { card: string };
        card: CharacterCard | null;
        mini: MiniCard | null;
      }[];
    }>(`/api/v2/worlds/${id}/cards`),
  saveCard: (worldId: string, cid: string, body: Record<string, unknown>) =>
    request<{ member: CastMember; card: CharacterCard }>(`/api/v2/worlds/${worldId}/cards/${encodeURIComponent(cid)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteCard: (worldId: string, cid: string) =>
    request<{ ok: boolean }>(`/api/v2/worlds/${worldId}/cards/${encodeURIComponent(cid)}`, { method: "DELETE" }),
  getMini: (worldId: string, cid: string) =>
    request<{ mini: MiniCard | null }>(`/api/v2/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini`),
  saveMini: (worldId: string, cid: string, body: MiniCard) =>
    request<{ mini: MiniCard }>(`/api/v2/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  generateMini: (worldId: string, cid: string) =>
    request<{ mini: MiniCard }>(`/api/v2/worlds/${worldId}/cards/${encodeURIComponent(cid)}/mini/generate`, {
      method: "POST",
    }),
  lorebooks: (id: string) => request<{ lorebooks: { name: string; text: string }[] }>(`/api/v2/worlds/${id}/lorebooks`),
  saveLorebook: (worldId: string, name: string, text: string) =>
    request<{ name: string; text: string }>(`/api/v2/worlds/${worldId}/lorebooks/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  deleteLorebook: (worldId: string, name: string) =>
    request<{ ok: boolean }>(`/api/v2/worlds/${worldId}/lorebooks/${encodeURIComponent(name)}`, { method: "DELETE" }),
  importFiles: (worldId: string, files: { name: string; text?: string; data?: string }[]) =>
    request<WorldSummary & { imported: { cards: string[]; lorebooks: string[]; warnings: string[] } }>(
      `/api/v2/worlds/${worldId}/import`,
      { method: "POST", body: JSON.stringify({ files }) },
    ),
};
