import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../../src/adapters/ai-gateway";
import type { AiModelConfig } from "../../src/core/ai";

const gatewayModel: AiModelConfig = {
  id: "test-gateway",
  label: "Test Gateway",
  transport: "gateway",
  provider_slug: "openrouter",
  model_id: "example/model",
  context_window: 32_768,
  max_output_tokens: 4_096,
  supports_tools: true,
  supports_reasoning: true,
  enabled: true,
  sort_order: 1,
  revision: 7,
};

function jsonResponse(message: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("skip output channel retry", () => {
  it("does not fire a second request when skipOutputChannelRetry is set", async () => {
    const run = vi.fn(async () => jsonResponse({ content: "", reasoning_content: "private chain" }));
    const env = {
      AI_GATEWAY_ID: "sillytavern",
      AI: { gateway: () => ({ run }) },
    } as unknown as Env;

    const result = await chat(env, [{ role: "user", content: "commit" }], null, 0, 1_000, 10, {
      model: gatewayModel,
      skipOutputChannelRetry: true,
    });

    expect(result.text).toBe("");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
