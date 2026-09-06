import {
  DEFAULT_CONTEXT,
  DEFAULT_MINI,
  parseContextConfig,
  parseMiniConfig,
  type ContextConfig,
  type MiniSelectConfig,
} from "../core/budget";
import { DEFAULT_NMEM_SPACE_ID, selectedNmemSpace } from "../core/memory";

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
  context: ContextConfig;
  mini: MiniSelectConfig;
};

/** Story completions need headroom for ≥2000 汉字 plus GLM/OpenRouter reasoning tokens. */
export const STORY_OUTPUT_TOKEN_FLOOR = 12_288;

export function resolveLlmMaxTokens(raw?: number): number {
  const parsed = Math.floor(Number(raw));
  const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.llm.max_tokens;
  return Math.max(configured, STORY_OUTPUT_TOKEN_FLOOR);
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 16384 covers ~2000 汉字 of RP body plus GLM/OpenRouter reasoning tokens.
  llm: { temperature: 1, max_tokens: 16_384, timeout: 180, breach: true },
  nmem: { enabled: true, space: DEFAULT_NMEM_SPACE_ID },
  memory: { world_char_limit: 2500, player_char_limit: 1400, character_char_limit: 1200 },
  compact_after_turns: 40,
  lore_scan_depth: 4,
  lore_token_budget: 2048,
  max_tool_rounds: 4,
  transcript_keep_after_compact: 8,
  context: structuredClone(DEFAULT_CONTEXT),
  mini: { ...DEFAULT_MINI },
};

function withStoryTokenFloor(settings: AppSettings): AppSettings {
  return {
    ...settings,
    llm: { ...settings.llm, max_tokens: resolveLlmMaxTokens(settings.llm.max_tokens) },
  };
}

export async function loadSettings(bucket: R2Bucket): Promise<AppSettings> {
  const obj = await bucket.get("v2/config/settings.json");
  if (!obj) {
    return withStoryTokenFloor({
      ...DEFAULT_SETTINGS,
      llm: { ...DEFAULT_SETTINGS.llm },
      nmem: { ...DEFAULT_SETTINGS.nmem },
      memory: { ...DEFAULT_SETTINGS.memory },
      context: parseContextConfig(DEFAULT_CONTEXT),
      mini: parseMiniConfig(DEFAULT_MINI),
    });
  }
  try {
    const raw = JSON.parse(await obj.text()) as Partial<AppSettings>;
    return withStoryTokenFloor({
      ...DEFAULT_SETTINGS,
      ...raw,
      llm: { ...DEFAULT_SETTINGS.llm, ...(raw.llm || {}) },
      nmem: {
        ...DEFAULT_SETTINGS.nmem,
        ...(raw.nmem || {}),
        space: selectedNmemSpace(raw.nmem?.space),
      },
      memory: { ...DEFAULT_SETTINGS.memory, ...(raw.memory || {}) },
      context: parseContextConfig(raw.context || DEFAULT_CONTEXT),
      mini: parseMiniConfig(raw.mini || DEFAULT_MINI),
    });
  } catch {
    return withStoryTokenFloor(DEFAULT_SETTINGS);
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
    nmem: { enabled: settings.nmem.enabled, space: settings.nmem.space, binary: "nmem" },
    memory: settings.memory,
    worlds_dir: "r2://lightrp/v2/workspaces",
    home: "r2://lightrp/v2",
    compact_after_turns: settings.compact_after_turns,
    lore_scan_depth: settings.lore_scan_depth,
    lore_token_budget: settings.lore_token_budget,
    max_tool_rounds: settings.max_tool_rounds,
    transcript_keep_after_compact: settings.transcript_keep_after_compact,
    context: settings.context,
    mini: settings.mini,
  };
}
