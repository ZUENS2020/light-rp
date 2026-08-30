import { afterEach, describe, expect, it, vi } from "vitest";
import { chat, LlmOutputChannelViolation, toolLoop } from "../../src/adapters/ai-gateway";
import { OUTPUT_CHANNEL_CONTRACT, type AiModelConfig } from "../../src/core/ai";

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

const cloudflareModel: AiModelConfig = {
  ...gatewayModel,
  id: "test-cloudflare",
  label: "Test Cloudflare",
  transport: "cloudflare",
  provider_slug: null,
  model_id: "@cf/example/model",
};

function jsonResponse(message: Record<string, unknown>, headers: HeadersInit = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 650 } },
    }),
    { headers: { "content-type": "application/json", ...headers } },
  );
}

function fakeGatewayEnv(run: ReturnType<typeof vi.fn>) {
  return {
    AI_GATEWAY_ID: "sillytavern",
    AI: { gateway: () => ({ run }) },
  } as unknown as Env;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AI Gateway adapter contract", () => {
  it("uses the Workers AI binding with Gateway cache and affinity options", async () => {
    const run = vi.fn(async (_modelId: string, _payload: Record<string, unknown>, _options: Record<string, unknown>) =>
      jsonResponse({ content: "正式输出" }),
    );
    const env = {
      AI_GATEWAY_ID: "sillytavern",
      AI: { run, gateway: vi.fn() },
    } as unknown as Env;

    const result = await chat(env, [{ role: "user", content: "继续" }], null, 0.7, 8_000, 10, {
      model: cloudflareModel,
      affinityKey: "lrp-affinity",
    });

    expect(result.text).toBe("正式输出");
    expect(result.response_cache_status).toBe("unknown");
    expect(result.usage.cached_input_tokens).toBe(650);
    const [modelId, payload, options] = run.mock.calls[0];
    expect(modelId).toBe("@cf/example/model");
    expect((payload.messages as Array<Record<string, unknown>>).at(-2)).toMatchObject({
      role: "system",
      content: OUTPUT_CHANNEL_CONTRACT,
    });
    expect(options).toMatchObject({
      gateway: { id: "sillytavern", cacheTtl: 3_600, skipCache: false, collectLog: false },
      extraHeaders: { "x-session-affinity": "lrp-affinity" },
      returnRawResponse: true,
    });
  });

  it("uses the pre-authenticated Gateway binding with provider BYOK and records Gateway HIT", async () => {
    const run = vi.fn(async (_request: unknown, _options?: unknown) =>
      jsonResponse({ content: "cached" }, { "cf-aig-cache-status": "HIT" }),
    );

    const result = await chat(fakeGatewayEnv(run), [{ role: "user", content: "same" }], null, 0.4, 1_000, 10, {
      model: gatewayModel,
      affinityKey: "lrp-session",
    });

    expect(result.response_cache_status).toBe("HIT");
    const [request, options] = run.mock.calls[0];
    expect(request).toMatchObject({
      provider: "openrouter",
      endpoint: "chat/completions",
      headers: { "Content-Type": "application/json" },
    });
    expect(options).toMatchObject({
      gateway: { cacheTtl: 3_600, skipCache: false, collectLog: false },
      extraHeaders: { "x-session-affinity": "lrp-session" },
    });
    expect(JSON.stringify(request)).not.toContain("authorization");
  });

  it("forwards a required named tool choice for structured turn commits", async () => {
    const run = vi.fn(async (_request: { query: Record<string, unknown> }) =>
      jsonResponse({
        content: null,
        tool_calls: [
          {
            id: "commit-1",
            type: "function",
            function: { name: "commit_turn", arguments: '{"state":{},"events":[],"memory_ops":[]}' },
          },
        ],
      }),
    );

    await chat(
      fakeGatewayEnv(run),
      [{ role: "user", content: "commit" }],
      [{ type: "function", function: { name: "commit_turn", parameters: { type: "object" } } }],
      0,
      1_000,
      10,
      {
        model: gatewayModel,
        toolChoice: { type: "function", function: { name: "commit_turn" } },
      },
    );

    expect(run.mock.calls[0][0].query.tool_choice).toEqual({
      type: "function",
      function: { name: "commit_turn" },
    });
  });

  it.each(["rewrite", "regenerate", "correction"] as const)(
    "bypasses exact response cache for %s",
    async (requestKind) => {
      const run = vi.fn(async (_request: unknown, _options?: { gateway?: Record<string, unknown> }) =>
        jsonResponse({ content: "fresh" }),
      );

      const result = await chat(fakeGatewayEnv(run), [{ role: "user", content: "again" }], null, 0.8, 1_000, 10, {
        model: gatewayModel,
        requestKind,
      });

      expect(run.mock.calls[0][1]).toMatchObject({ gateway: { skipCache: true, cacheTtl: 3_600 } });
      expect(run.mock.calls[0][1]?.gateway).not.toHaveProperty("cacheKey");
      expect(result.response_cache_status).toBe("BYPASS");
    },
  );

  it("uses a revision-scoped 24 hour cache key only for model probes", async () => {
    const run = vi.fn(async (_request: unknown, _options?: { gateway?: Record<string, unknown> }) =>
      jsonResponse({ content: "ok" }),
    );

    await chat(fakeGatewayEnv(run), [{ role: "user", content: "probe" }], null, 0, 64, 10, {
      model: gatewayModel,
      requestKind: "probe",
      cacheKey: `model-probe:${gatewayModel.revision}`,
    });

    expect(run.mock.calls[0][1]).toMatchObject({
      gateway: { cacheTtl: 86_400, cacheKey: "model-probe:7" },
    });
  });

  it("allows probes for disabled registrations but rejects disabled generation", async () => {
    const run = vi.fn(async (_request: unknown, _options?: unknown) => jsonResponse({ content: "OK" }));
    const disabledModel = { ...gatewayModel, enabled: false };

    await expect(
      chat(fakeGatewayEnv(run), [{ role: "user", content: "probe" }], null, 0, 32, 10, {
        model: disabledModel,
        requestKind: "probe",
        cacheKey: "model-probe:disabled:1",
      }),
    ).resolves.toMatchObject({ text: "OK" });

    await expect(
      chat(fakeGatewayEnv(run), [{ role: "user", content: "story" }], null, 0.5, 1_000, 10, {
        model: disabledModel,
        requestKind: "story",
      }),
    ).rejects.toThrow("is disabled");
  });

  it("corrects a reasoning-only response once without persisting or forwarding reasoning", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: "", reasoning_content: "private chain" }))
      .mockResolvedValueOnce(jsonResponse({ content: "formal answer" }));

    const result = await chat(fakeGatewayEnv(run), [{ role: "user", content: "answer" }], null, 0.5, 1_000, 10, {
      model: gatewayModel,
    });

    expect(result.text).toBe("formal answer");
    expect(JSON.stringify(result)).not.toContain("private chain");
    expect(run).toHaveBeenCalledTimes(2);
    const correctionBody = JSON.stringify(run.mock.calls[1][0]?.query);
    expect(correctionBody).not.toContain("private chain");
    expect(run.mock.calls[1][1]).toMatchObject({ gateway: { skipCache: true } });
  });

  it("raises a typed violation after two reasoning-only responses", async () => {
    const run = vi.fn(async () => jsonResponse({ content: "", reasoning_content: "discard me" }));

    await expect(
      chat(fakeGatewayEnv(run), [{ role: "user", content: "answer" }], null, 0.5, 1_000, 10, {
        model: gatewayModel,
      }),
    ).rejects.toBeInstanceOf(LlmOutputChannelViolation);
  });

  it("keeps tool-loop requests append-only and carries only formal tool events", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const run = vi
      .fn()
      .mockImplementationOnce(async (request: { query: Record<string, unknown> }) => {
        bodies.push(request.query);
        return jsonResponse({
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "memory", arguments: '{"content":"x"}' } }],
        });
      })
      .mockImplementationOnce(async (request: { query: Record<string, unknown> }) => {
        bodies.push(request.query);
        return jsonResponse({ content: "done" });
      });

    const result = await toolLoop(
      fakeGatewayEnv(run),
      [
        { role: "system", content: "GM" },
        { role: "user", content: "remember" },
      ],
      [{ type: "function", function: { name: "memory", parameters: { type: "object" } } }],
      async () => '{"success":true}',
      2,
      "stable override",
      0.5,
      1_000,
      10,
      { model: gatewayModel },
    );

    expect(result.text).toBe("done");
    const first = bodies[0].messages as unknown[];
    const second = bodies[1].messages as unknown[];
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.slice(first.length)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "memory", arguments: '{"content":"x"}' } }],
      },
      { role: "tool", content: '{"success":true}', tool_call_id: "call-1" },
    ]);
  });
});
