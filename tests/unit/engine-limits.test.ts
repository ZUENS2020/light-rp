import { describe, expect, it } from "vitest";
import { effectiveContextConfig, effectiveOutputTokens, STORY_OUTPUT_TOKEN_FLOOR } from "../../src/server/engine";
import { cloneAppSettings, DEFAULT_SETTINGS } from "../../src/server/settings";
import { DEFAULT_MODEL, type AiModelConfig } from "../../src/core/ai";

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

    expect(context.max_tokens).toBe(131_072);
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

  it("keeps compact and OOC on the configured budget when settings are stale", () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.llm.max_tokens = 2_048;
    const glm: AiModelConfig = { ...DEFAULT_MODEL, max_output_tokens: 16_384 };
    expect(effectiveOutputTokens(settings, glm, "compact")).toBe(2_048);
    expect(effectiveOutputTokens(settings, glm, "tool")).toBe(2_048);
  });

  it("does not let callers mutate DEFAULT_SETTINGS through a clone", () => {
    const cloned = cloneAppSettings(DEFAULT_SETTINGS);
    cloned.nmem.space = "mutated";
    cloned.llm.max_tokens = 1;
    expect(DEFAULT_SETTINGS.nmem.space).not.toBe("mutated");
    expect(DEFAULT_SETTINGS.llm.max_tokens).toBe(16_384);
  });
});
