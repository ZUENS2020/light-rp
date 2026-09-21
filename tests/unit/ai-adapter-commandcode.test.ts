import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, readChatCompletionSse } from "../../src/adapters/ai-gateway";
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
  it("POSTs chat/completions with Bearer auth, disables thinking, omits reasoning effort", async () => {
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
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(JSON.stringify(body)).not.toContain("test-key");
  });

  it("maps streaming delta.reasoning into onPartial when content is empty", async () => {
    const sse =
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "训练" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "员点头" }, finish_reason: "length" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    const fetchMock = vi.fn(
      async () =>
        new Response(sse, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const env = { COMMANDCODE_API_KEY: "test-key", AI_GATEWAY_ID: "sillytavern", AI: {} } as unknown as Env;
    const partials: string[] = [];

    const result = await chat(env, [{ role: "user", content: "继续" }], null, 0.7, 1_000, 10, {
      model: commandCodeModel,
      requestKind: "story",
      onPartial: (text) => {
        partials.push(text);
      },
    });

    expect(result.text).toBe("训练员点头");
    expect(partials).toEqual(["训练", "训练员点头"]);
    expect(result.finish_reason).toBe("length");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(true);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning).toBeUndefined();
  });

  it("prefers delta.content over reasoning when both appear", async () => {
    const sse =
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "hidden", content: "可见" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "正文" }, finish_reason: "stop" }] })}`,
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
    const fetchMock = vi.fn(async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { COMMANDCODE_API_KEY: "test-key", AI_GATEWAY_ID: "sillytavern", AI: {} } as unknown as Env;

    const result = await chat(env, [{ role: "user", content: "继续" }], null, 0.7, 1_000, 10, {
      model: commandCodeModel,
      onPartial: () => undefined,
    });

    expect(result.text).toBe("可见正文");
  });
});

describe("readChatCompletionSse promoteReasoningAsContent", () => {
  it("accumulates reasoning_details[].text when content is empty", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "甲" }] } }] })}\n\n`,
          ),
        );
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { reasoning_details: [{ text: "乙" }] }, finish_reason: "stop" }] })}\n\n`,
          ),
        );
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const partials: string[] = [];
    const result = await readChatCompletionSse(
      stream,
      (text) => {
        partials.push(text);
      },
      undefined,
      30_000,
      { promoteReasoningAsContent: true },
    );
    expect(result.text).toBe("甲乙");
    expect(partials).toEqual(["甲", "甲乙"]);
    expect(result.reasoningOnly).toBe(false);
  });

  it("does not promote reasoning without the flag", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "隐" } }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const result = await readChatCompletionSse(stream);
    expect(result.text).toBe("");
    expect(result.reasoningOnly).toBe(true);
  });
});
