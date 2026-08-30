import { describe, expect, it } from "vitest";
import { effectiveContextConfig } from "../../src/server/engine";
import { DEFAULT_SETTINGS } from "../../src/server/settings";
import type { AiModelConfig } from "../../src/core/ai";

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
});
