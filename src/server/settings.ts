import {
  DEFAULT_CONTEXT,
  DEFAULT_MINI,
  parseContextConfig,
  parseMiniConfig,
  type ContextConfig,
  type MiniSelectConfig,
} from "../core/budget";

/** Pre-GLM default; stale R2 settings still carrying this should not cap lore below the scaled section budget. */
export const LEGACY_LORE_TOKEN_BUDGET = 2_048;

export type AppSettings = {
  llm: {
    temperature: number;
    max_tokens: number;
    timeout: number;
    breach: boolean;
  };
  memory: { world_char_limit: number; player_char_limit: number; character_char_limit: number };
  compact_after_turns: number;
  /** Fraction of context window; post-turn background compact when pressure ≥ threshold × window. */
  compression_threshold: number;
  lore_scan_depth: number;
  lore_token_budget: number;
  max_tool_rounds: number;
  transcript_keep_after_compact: number;
  context: ContextConfig;
  mini: MiniSelectConfig;
};

/** Story completions need headroom for ~2000 汉字 plus some GLM/OpenRouter reasoning tokens. */
export const STORY_OUTPUT_TOKEN_FLOOR = 16_384;

/** commit_turn is a small JSON tool call; never inherit the 180s story timeout. */
export const TURN_COMMIT_TIMEOUT_SECONDS = 45;

export const DEFAULT_SETTINGS: AppSettings = {
  // 16384 covers long RP body plus GLM/OpenRouter reasoning without truncating at 8k.
  llm: { temperature: 1, max_tokens: 16_384, timeout: 240, breach: true },
  memory: { world_char_limit: 2500, player_char_limit: 1400, character_char_limit: 1200 },
  compact_after_turns: 40,
  compression_threshold: 0.35,
  lore_scan_depth: 4,
  lore_token_budget: 8_192,
  max_tool_rounds: 4,
  // Message ceiling only; Hermes lean token budget is the primary assemble bound.
  transcript_keep_after_compact: 8,
  context: structuredClone(DEFAULT_CONTEXT),
  mini: { ...DEFAULT_MINI },
};

export function cloneAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    llm: { ...settings.llm },
    memory: { ...settings.memory },
    context: parseContextConfig(settings.context),
    mini: parseMiniConfig(settings.mini),
  };
}

export async function loadSettings(bucket: R2Bucket): Promise<AppSettings> {
  const obj = await bucket.get("v2/config/settings.json");
  if (!obj) return cloneAppSettings(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(await obj.text()) as Partial<AppSettings> & { nmem?: unknown };
    const { nmem: _ignoredNmem, ...rest } = raw;
    return cloneAppSettings({
      ...DEFAULT_SETTINGS,
      ...rest,
      llm: { ...DEFAULT_SETTINGS.llm, ...(rest.llm || {}) },
      memory: { ...DEFAULT_SETTINGS.memory, ...(rest.memory || {}) },
      context: parseContextConfig(rest.context || DEFAULT_CONTEXT),
      mini: parseMiniConfig(rest.mini || DEFAULT_MINI),
    });
  } catch {
    return cloneAppSettings(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(bucket: R2Bucket, settings: AppSettings): Promise<void> {
  await bucket.put("v2/config/settings.json", JSON.stringify(settings, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}

export function publicSettings(env: Env, settings: AppSettings, defaultModelConfigId: string) {
  return {
    path: "r2://lightrp/v2/config/settings.json",
    llm: {
      gateway_id: env.AI_GATEWAY_ID,
      model: "runtime",
      default_model_config_id: defaultModelConfigId,
      gateway_binding: true,
      temperature: settings.llm.temperature,
      max_tokens: settings.llm.max_tokens,
      timeout: settings.llm.timeout,
      breach: settings.llm.breach,
    },
    memory: settings.memory,
    worlds_dir: "r2://lightrp/v2/workspaces",
    home: "r2://lightrp/v2",
    compact_after_turns: settings.compact_after_turns,
    compression_threshold: settings.compression_threshold,
    lore_scan_depth: settings.lore_scan_depth,
    lore_token_budget: settings.lore_token_budget,
    max_tool_rounds: settings.max_tool_rounds,
    transcript_keep_after_compact: settings.transcript_keep_after_compact,
    context: settings.context,
    mini: settings.mini,
  };
}
