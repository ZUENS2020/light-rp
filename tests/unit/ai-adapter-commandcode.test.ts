import { afterEach, describe, expect, it, vi } from "vitest";
import { chat } from "../../src/adapters/ai-gateway";
import type { AiModelConfig } from "../../src/core/ai";

const commandCodeModel: AiModelConfig = {
  id: "glm53-flash-cheap-openrouter",
  label: "GLM 5.3 Flash · Command Code GOAT",
  transport: "gateway",
  provider_slug: "commandcode",
  model_id: "z-ai/glm-5.3-flash",
  context_window: 1_000_000,
  max_output_tokens: 16_384,
  supports_tools: true,
  supports_reasoning: true,
  enabled: true,
  sort_order: 12,
  revision: 2,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Command Code openai_compatible transport", () => {
  it("POSTs chat/completions with Bearer auth and User-Agent", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "正式输出" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = { COMMANDCODE_API_KEY: "test-key", AI_GATEWAY_ID: "sillytavern", AI: {} } as unknown as Env;

    const result = await chat(env, [{ role: "user", content: "继续" }], null, 0.7, 1_000, 10, {
      model: commandCodeModel,
      requestKind: "story",
    });

    expect(result.text).toBe("正式输出");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["User-Agent"]).toBe("light-rp/1.0");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("z-ai/glm-5.3-flash");
    expect(body.reasoning).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("test-key");
  });
});
