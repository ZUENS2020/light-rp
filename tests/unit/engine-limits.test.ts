import { describe, expect, it } from "vitest";
import {
  effectiveContextConfig,
  effectiveLoreTokenBudget,
  effectiveMiniConfig,
  effectiveOutputTokens,
  STORY_OUTPUT_TOKEN_FLOOR,
} from "../../src/server/engine";
import { cloneAppSettings, DEFAULT_SETTINGS, LEGACY_LORE_TOKEN_BUDGET } from "../../src/server/settings";
import { DEFAULT_MODEL, type AiModelConfig } from "../../src/core/ai";
import {
  DEFAULT_CONTEXT,
  DEFAULT_MINI,
  DEFAULT_SECTION_BUDGET,
  LEGACY_DEFAULT_CONTEXT_MAX_TOKENS,
  LEGACY_SECTION_BUDGET,
  WORKING_CONTEXT_CAP,
} from "../../src/core/budget";

const model: AiModelConfig = {
  id: "small-window",
  label: "Small window",
  transport: "gateway",
  provider_slug: "openrouter",
  model_id: "example/model",
  context_window: 131_072,
  max_output_tokens: 8_192,
  supports_tools: true,
  supports_reasoning: false,
  enabled: true,
  sort_order: 1,
  revision: 1,
};

describe("runtime model limits", () => {
  it("never allocates more context than the selected model supports", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = 1_000_000;
    settings.llm.max_tokens = 20_480;

    const context = effectiveContextConfig(settings, model);

    expect(context.max_tokens).toBe(WORKING_CONTEXT_CAP);
    expect(context.generation_reserve).toBe(8_192);
  });

  it("keeps a smaller user-configured context window", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = 64_000;

    expect(effectiveContextConfig(settings, model).max_tokens).toBe(64_000);
  });

  it("floors story completions above 4k even when saved settings are 2048", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 2_048;
    settings.context.generation_reserve = 4_096;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, max_output_tokens: 16_384 };

    expect(effectiveOutputTokens(settings, glm, "story")).toBe(STORY_OUTPUT_TOKEN_FLOOR);
    expect(effectiveOutputTokens(settings, glm, "ooc")).toBe(2_048);
    expect(STORY_OUTPUT_TOKEN_FLOOR).toBeGreaterThan(4_096);
    expect(effectiveContextConfig(settings, glm).generation_reserve).toBe(STORY_OUTPUT_TOKEN_FLOOR);
  });

  it("does not exceed the OpenRouter GLM output cap", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 32_768;
    expect(effectiveOutputTokens(settings, DEFAULT_MODEL, "story")).toBe(DEFAULT_MODEL.max_output_tokens);
    expect(DEFAULT_MODEL.max_output_tokens).toBeGreaterThanOrEqual(STORY_OUTPUT_TOKEN_FLOOR);
  });

  it("auto-raises stale 32k settings toward WORKING_CONTEXT_CAP when the model window is larger", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = LEGACY_DEFAULT_CONTEXT_MAX_TOKENS;
    settings.context.budget = { ...LEGACY_SECTION_BUDGET };
    settings.context.history.protect_recent_turns = 2;
    settings.mini.max_tokens = 1_200;
    settings.lore_token_budget = LEGACY_LORE_TOKEN_BUDGET;
    const glm: AiModelConfig = {
      ...DEFAULT_MODEL,
      id: "glm53-flash-cheap-openrouter",
      model_id: "@preset/glm53-flash-cheap",
      context_window: 1_310_720,
      max_output_tokens: 32_768,
    };

    const context = effectiveContextConfig(settings, glm);
    expect(context.max_tokens).toBe(WORKING_CONTEXT_CAP);
    expect(context.budget.lore).toBe(DEFAULT_SECTION_BUDGET.lore);
    expect(context.budget.memory).toBe(DEFAULT_SECTION_BUDGET.memory);
    expect(context.history.protect_recent_turns).toBe(DEFAULT_CONTEXT.history.protect_recent_turns);
    expect(effectiveMiniConfig(settings, context, glm).max_tokens).toBe(DEFAULT_MINI.max_tokens);
    expect(effectiveLoreTokenBudget(null, settings, context)).toBe(DEFAULT_SECTION_BUDGET.lore);
  });

  it("does not auto-raise past the working cap even for ~1.3M models", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = LEGACY_DEFAULT_CONTEXT_MAX_TOKENS;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, context_window: 1_310_720 };
    expect(effectiveContextConfig(settings, glm).max_tokens).toBe(WORKING_CONTEXT_CAP);
    expect(effectiveContextConfig(settings, glm).max_tokens).toBeLessThan(glm.context_window);
  });

  it("still honors an explicit mid-size window above the legacy default", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = 48_000;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, context_window: 1_310_720 };
    expect(effectiveContextConfig(settings, glm).max_tokens).toBe(48_000);
  });

  it("hard-caps configured windows above WORKING_CONTEXT_CAP", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = 131_072;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, context_window: 1_310_720 };
    expect(effectiveContextConfig(settings, glm).max_tokens).toBe(WORKING_CONTEXT_CAP);
  });

  it("keeps custom lore budgets when they are not the legacy 2048 default", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lore_token_budget = 4_096;
    const context = effectiveContextConfig(settings, { ...DEFAULT_MODEL, context_window: 1_310_720 });
    expect(effectiveLoreTokenBudget(null, settings, context)).toBe(4_096);
  });

  it("keeps compact and OOC on the configured budget when settings are stale", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 2_048;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, max_output_tokens: 16_384 };
    expect(effectiveOutputTokens(settings, glm, "compact")).toBe(2_048);
    expect(effectiveOutputTokens(settings, glm, "tool")).toBe(2_048);
  });

  it("does not let callers mutate DEFAULT_SETTINGS through a clone", () => {
    const cloned = cloneAppSettings(DEFAULT_SETTINGS);
    cloned.llm.max_tokens = 1;
    expect(DEFAULT_SETTINGS.llm.max_tokens).toBe(16_384);
  });
});
