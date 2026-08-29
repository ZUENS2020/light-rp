export type AppSettings = {
  llm: {
    temperature: number;
    max_tokens: number;
    timeout: number;
    breach: boolean;
  };
  nmem: { enabled: boolean; space: string };
  memory: { world_char_limit: number; player_char_limit: number; character_char_limit: number };
  compact_after_turns: number;
  lore_scan_depth: number;
  lore_token_budget: number;
  max_tool_rounds: number;
  transcript_keep_after_compact: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  llm: { temperature: 1, max_tokens: 2048, timeout: 120, breach: true },
  nmem: { enabled: true, space: "" },
  memory: { world_char_limit: 2500, player_char_limit: 1400, character_char_limit: 1200 },
  compact_after_turns: 40,
  lore_scan_depth: 4,
  lore_token_budget: 2048,
  max_tool_rounds: 4,
  transcript_keep_after_compact: 8,
};

export async function loadSettings(bucket: R2Bucket): Promise<AppSettings> {
  const obj = await bucket.get("config/settings.json");
  if (!obj) return { ...DEFAULT_SETTINGS, llm: { ...DEFAULT_SETTINGS.llm }, nmem: { ...DEFAULT_SETTINGS.nmem }, memory: { ...DEFAULT_SETTINGS.memory } };
  try {
    const raw = JSON.parse(await obj.text()) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm || {}) },
      nmem: { ...DEFAULT_SETTINGS.nmem, ...(raw.nmem || {}) },
      memory: { ...DEFAULT_SETTINGS.memory, ...(raw.memory || {}) },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(bucket: R2Bucket, settings: AppSettings): Promise<void> {
  await bucket.put("config/settings.json", JSON.stringify(settings, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export function publicSettings(env: Env, settings: AppSettings) {
  return {
    path: "r2://lightrp/config/settings.json",
    llm: {
      base_url: env.LLM_BASE_URL,
      model: env.LLM_MODEL,
      api_key_set: Boolean(env.NVIDIA_API_KEY),
      api_key_env: "NVIDIA_API_KEY",
      temperature: settings.llm.temperature,
      max_tokens: settings.llm.max_tokens,
      timeout: settings.llm.timeout,
      breach: settings.llm.breach,
    },
    nmem: { enabled: settings.nmem.enabled, space: settings.nmem.space, binary: "nmem" },
    memory: settings.memory,
    worlds_dir: "r2://lightrp/workspaces",
    home: "r2://lightrp",
    compact_after_turns: settings.compact_after_turns,
    lore_scan_depth: settings.lore_scan_depth,
    lore_token_budget: settings.lore_token_budget,
    max_tool_rounds: settings.max_tool_rounds,
    transcript_keep_after_compact: settings.transcript_keep_after_compact,
  };
}
