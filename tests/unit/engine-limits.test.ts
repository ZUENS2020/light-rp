import { describe, expect, it } from "vitest";
import {
  effectiveContextConfig,
  effectiveLoreTokenBudget,
  effectiveMiniConfig,
  effectiveOutputTokens,
  STORY_OUTPUT_TOKEN_FLOOR,
} from "../../src/server/engine";
import { cloneAppSettings, DEFAULT_SETTINGS, LEGACY_LORE_TOKEN_BUDGET } from "../../src/server/settings";
import { DEFAULT_MODEL, REASONING_OUTPUT_HEADROOM, type AiModelConfig } from "../../src/core/ai";
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

    expect(effectiveContextConfig(settings, model).max_tokens).toBe(WORKING_CONTEXT_CAP);
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

  it("keeps story assemble reserve on content while model ceiling holds CoT headroom", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 24_576;
    const glm: AiModelConfig = {
      ...DEFAULT_MODEL,
      supports_reasoning: true,
      max_output_tokens: STORY_OUTPUT_TOKEN_FLOOR + REASONING_OUTPUT_HEADROOM, // 16k content + 16k CoT
    };
    expect(effectiveOutputTokens(settings, glm, "story")).toBe(STORY_OUTPUT_TOKEN_FLOOR);
    expect(effectiveContextConfig(settings, glm).generation_reserve).toBe(STORY_OUTPUT_TOKEN_FLOOR);
  });

  it("caps story assemble reserve below model ceiling so CoT headroom fits", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 32_768;
    // Reasoning models: visible content budget stays at floor; API uses full model.max_output_tokens.
    expect(effectiveOutputTokens(settings, DEFAULT_MODEL, "story")).toBe(STORY_OUTPUT_TOKEN_FLOOR);
    expect(DEFAULT_MODEL.max_output_tokens).toBeGreaterThan(STORY_OUTPUT_TOKEN_FLOOR);
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
      model_id: "~z-ai/glm-flash-latest",
      context_window: 1_310_720,
      max_output_tokens: 32_768,
    };

    const context = effectiveContextConfig(settings, glm);
    expect(context.max_tokens).toBe(WORKING_CONTEXT_CAP);
    expect(context.budget.lore).toBe(DEFAULT_SECTION_BUDGET.lore);
    expect(context.budget.memory).toBe(DEFAULT_SECTION_BUDGET.memory);
    expect(context.history.protect_recent_turns).toBe(DEFAULT_CONTEXT.history.protect_recent_turns);
    expect(effectiveMiniConfig(settings, context, glm).max_tokens).toBeGreaterThanOrEqual(1_200);
    expect(effectiveLoreTokenBudget(null, settings, context)).toBe(DEFAULT_SECTION_BUDGET.lore);
  });

  it("does not auto-raise past the working cap even for ~1.3M models", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = LEGACY_DEFAULT_CONTEXT_MAX_TOKENS;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, context_window: 1_310_720 };
    expect(effectiveContextConfig(settings, glm).max_tokens).toBe(WORKING_CONTEXT_CAP);
    expect(effectiveContextConfig(settings, glm).max_tokens).toBeLessThan(glm.context_window);
  });

  it("caps an explicit mid-size window at WORKING_CONTEXT_CAP", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.context.max_tokens = 48_000;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, context_window: 1_310_720 };
    expect(effectiveContextConfig(settings, glm).max_tokens).toBe(WORKING_CONTEXT_CAP);
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
    expect(DEFAULT_SETTINGS.llm.max_tokens).toBe(32_768);
  });

  it("keeps configured 16k story max_tokens (no legacy downgrade to 8k)", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 16_384;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, max_output_tokens: 32_768 };
    expect(effectiveOutputTokens(settings, glm, "story")).toBe(16_384);
    expect(effectiveOutputTokens(settings, glm, "ooc")).toBe(16_384);
  });

  it("floors story below the 16k floor upward without affecting OOC", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 8_192;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, max_output_tokens: 32_768 };
    expect(effectiveOutputTokens(settings, glm, "story")).toBe(STORY_OUTPUT_TOKEN_FLOOR);
    expect(effectiveOutputTokens(settings, glm, "ooc")).toBe(8_192);
  });
});
