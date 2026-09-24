import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, readChatCompletionSse } from "../../src/adapters/ai-gateway";
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

function chunk(content: string, finish?: string) {
  return JSON.stringify({
    choices: [{ delta: { content }, ...(finish ? { finish_reason: finish } : {}) }],
  });
}

function sseResponse(chunks: string[]) {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cf-aig-cache-status": "MISS" },
  });
}

function fakeGatewayEnv(run: ReturnType<typeof vi.fn>) {
  return {
    AI_GATEWAY_ID: "sillytavern",
    AI: { gateway: () => ({ run }) },
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readChatCompletionSse", () => {
  it("accumulates delta content and invokes onPartial", async () => {
    const partials: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${chunk("你好")}\n\n`));
        controller.enqueue(enc.encode(`data: ${chunk("，世界", "stop")}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const result = await readChatCompletionSse(stream, (text) => {
      partials.push(text);
    });
    expect(result.text).toBe("你好，世界");
    expect(partials).toEqual(["你好", "你好，世界"]);
    expect(result.finish_reason).toBe("stop");
  });


  it("treats [DONE] without finish_reason as a clean stop", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${chunk("你好")}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const result = await readChatCompletionSse(stream);
    expect(result.text).toBe("你好");
    expect(result.stream_done).toBe(true);
    expect(result.finish_reason).toBe("stop");
  });

  it("does not await a slow onPartial while draining SSE", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let blockedCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${chunk("一")}\n\n`));
        controller.enqueue(enc.encode(`data: ${chunk("二", "stop")}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const started = Date.now();
    const resultP = readChatCompletionSse(stream, async () => {
      blockedCalls += 1;
      await gate;
    });
    // Drain must finish even while onPartial is still blocked.
    const result = await resultP;
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.text).toBe("一二");
    expect(result.finish_reason).toBe("stop");
    expect(blockedCalls).toBeGreaterThanOrEqual(1);
    release();
  });

  it("captures finish_reason and usage when the final SSE line has no trailing newline", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${chunk("你好")}\n\n`));
        // Final event + usage often arrive without a trailing newline before close.
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            })}`,
          ),
        );
        controller.close();
      },
    });
    const result = await readChatCompletionSse(stream);
    expect(result.text).toBe("你好");
    expect(result.finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(12);
    expect(result.usage.completion_tokens).toBe(3);
  });
});

describe("chat() streaming via onPartial", () => {
  it("sets stream:true and surfaces progressive text", async () => {
    const run = vi.fn(async () => sseResponse([chunk("一"), chunk("二"), chunk("三", "stop")]));
    const partials: string[] = [];
    const result = await chat(fakeGatewayEnv(run), [{ role: "user", content: "继续" }], null, 0.7, 1_000, 10, {
      model: gatewayModel,
      onPartial: (text) => {
        partials.push(text);
      },
    });

    expect(result.text).toBe("一二三");
    expect(partials.at(-1)).toBe("一二三");
    expect(partials.length).toBeGreaterThanOrEqual(1);
    const [request] = run.mock.calls[0] as unknown as [{ query: Record<string, unknown> }];
    expect(request.query.stream).toBe(true);
  });

  it("does not stream when tools are present", async () => {
    const run = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    await chat(
      fakeGatewayEnv(run),
      [{ role: "user", content: "x" }],
      [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
      0,
      100,
      10,
      {
        model: gatewayModel,
        onPartial: () => undefined,
      },
    );
    const [request] = run.mock.calls[0] as unknown as [{ query: Record<string, unknown> }];
    expect(request.query.stream).toBeUndefined();
  });

  it("falls back to JSON body when provider ignores stream", async () => {
    const run = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "整段回复" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const partials: string[] = [];
    const result = await chat(fakeGatewayEnv(run), [{ role: "user", content: "继续" }], null, 0.5, 1_000, 10, {
      model: gatewayModel,
      onPartial: (text) => {
        partials.push(text);
      },
    });
    expect(result.text).toBe("整段回复");
    expect(partials).toEqual(["整段回复"]);
    const [request] = run.mock.calls[0] as unknown as [{ query: Record<string, unknown> }];
    expect(request.query.stream).toBe(true);
  });

  it("skips gateway cache and sends low reasoning effort for streamed story", async () => {
    const run = vi.fn(async (_req: unknown, init: { gateway?: { skipCache?: boolean } }) => {
      expect(init.gateway?.skipCache).toBe(true);
      return sseResponse([chunk("完", "stop")]);
    });
    await chat(fakeGatewayEnv(run), [{ role: "user", content: "继续" }], null, 0.7, 16_384, 10, {
      model: gatewayModel,
      requestKind: "story",
      onPartial: () => undefined,
    });
    const [request] = run.mock.calls[0] as unknown as [{ query: Record<string, unknown> }];
    expect(request.query.stream).toBe(true);
    expect(request.query.reasoning).toEqual({ effort: "low" });
    expect(request.query.max_tokens).toBe(4_096);
  });

  it("does not attach reasoning for tool loops / non-story kinds", async () => {
    const run = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          headers: { "content-type": "application/json", "cf-aig-cache-status": "MISS" },
        }),
    );
    await chat(fakeGatewayEnv(run), [{ role: "user", content: "x" }], null, 0.2, 512, 10, {
      model: gatewayModel,
      requestKind: "tool",
    });
    const [request] = run.mock.calls[0] as unknown as [{ query: Record<string, unknown> }];
    expect(request.query.reasoning).toBeUndefined();
    expect(request.query.stream).toBeUndefined();
  });
});
