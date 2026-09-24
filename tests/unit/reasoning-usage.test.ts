import { describe, expect, it, vi, afterEach } from "vitest";
import { type AiModelConfig } from "../../src/core/ai";
import { chat } from "../../src/adapters/ai-gateway";

const model: AiModelConfig = {
  id: "cc",
  label: "cc",
  transport: "openai_compatible",
  provider_slug: "commandcode",
  model_id: "z-ai/glm-5.3-flash",
  context_window: 128_000,
  max_output_tokens: 32_768,
  supports_tools: true,
  supports_reasoning: true,
  enabled: true,
  sort_order: 1,
  revision: 1,
};

describe("reasoning vs content token split", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses completion_tokens_details.reasoning_tokens into usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "正文" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 100,
              completion_tokens_details: { reasoning_tokens: 40 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const result = await chat(
      { COMMANDCODE_API_KEY: "test-key" } as never,
      [{ role: "user", content: "hi" }],
      null,
      1,
      16_384,
      30,
      { model, requestKind: "story", skipCache: true },
    );
    expect(result.usage.completion_tokens).toBe(100);
    expect(result.usage.reasoning_tokens).toBe(40);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(32_768);
  });
});
