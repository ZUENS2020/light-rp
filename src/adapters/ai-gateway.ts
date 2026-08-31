import {
  DEFAULT_MODEL,
  canonicalMessages,
  canonicalTools,
  stableStringify,
  type AiModelConfig,
  type AiRequestOptions,
  type AiUsage,
  type ResponseCacheStatus,
} from "../core/ai";
import type { LlmMessage, ToolCall } from "../core/assemble";

export type ChatResult = {
  text: string;
  tool_calls: ToolCall[];
  finish_reason?: string;
  usage: AiUsage;
  response_cache_status: ResponseCacheStatus;
  request_body: string;
};

type ParsedResponse = ChatResult & { reasoningOnly: boolean };

export class LlmHttpError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`LLM HTTP ${status}: ${body}`);
    this.name = "LlmHttpError";
    this.status = status;
  }
}

export class LlmTimeoutError extends Error {
  constructor(seconds: number) {
    super(`LLM 超时（${seconds}s）`);
    this.name = "LlmTimeoutError";
  }
}

export class LlmEmptyError extends Error {
  constructor() {
    super("LLM 返回空回复");
    this.name = "LlmEmptyError";
  }
}

export class LlmOutputChannelViolation extends Error {
  readonly code = "LLM_OUTPUT_CHANNEL_VIOLATION";
  constructor() {
    super("模型连续两次只返回思考通道，正式输出为空");
    this.name = "LlmOutputChannelViolation";
  }
}

export function turnErrorStatus(err: unknown): number {
  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403 || err.status === 429) return err.status;
    if (err.status >= 500 && err.status <= 599) return err.status;
    return 502;
  }
  if (err instanceof LlmTimeoutError) return 504;
  if (err instanceof LlmOutputChannelViolation) return 502;
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/LLM HTTP (\d+)/);
  if (match) {
    const status = Number(match[1]);
    if (status === 401 || status === 403 || status === 429) return status;
    if (status >= 500 && status <= 599) return status;
  }
  if (message.includes("超时")) return 504;
  return 502;
}

function shouldSkipCache(options: AiRequestOptions): boolean {
  return (
    options.skipCache === true ||
    options.requestKind === "rewrite" ||
    options.requestKind === "regenerate" ||
    options.requestKind === "correction"
  );
}

function effectiveCache(options: AiRequestOptions): { skipCache: boolean; cacheTtl: number; cacheKey?: string } {
  const probe = options.requestKind === "probe";
  return {
    skipCache: shouldSkipCache(options),
    cacheTtl: probe ? 86_400 : Math.max(60, options.cacheTtl ?? 3_600),
    ...(probe && options.cacheKey ? { cacheKey: options.cacheKey } : {}),
  };
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.tool_call_id) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls?.length) {
    out.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: stableStringify(call.arguments) },
    }));
  }
  return out;
}

function responseCacheStatus(response: Response, skipped: boolean): ResponseCacheStatus {
  if (skipped) return "BYPASS";
  const raw = response.headers.get("cf-aig-cache-status")?.toUpperCase();
  if (raw === "HIT" || raw === "MISS" || raw === "BYPASS") return raw;
  return "unknown";
}

function parseUsage(raw: Record<string, unknown>): AiUsage {
  const usage = (raw.usage as Record<string, unknown> | undefined) || {};
  const details = (usage.prompt_tokens_details as Record<string, unknown> | undefined) || {};
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cached = Number(usage.cached_input_tokens ?? usage.cached_tokens ?? details.cached_tokens ?? 0);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    cached_input_tokens: Number.isFinite(cached) ? cached : 0,
  };
}

function recoverJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseToolCallArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    const recovered = recoverJsonObject(value);
    if (recovered) return recovered;
  }
  return recoverJsonObject(value) || {};
}

function parseToolCalls(message: Record<string, unknown>): ToolCall[] {
  const calls: ToolCall[] = [];
  const rawCalls = [...((message.tool_calls as Record<string, unknown>[] | undefined) || [])];
  if (message.function_call && typeof message.function_call === "object") {
    rawCalls.push(message.function_call as Record<string, unknown>);
  }
  for (const raw of rawCalls) {
    const fn = (raw.function as Record<string, unknown> | undefined) || raw;
    const args = parseToolCallArgs(fn.arguments ?? raw.arguments);
    calls.push({ id: String(raw.id || ""), name: String(fn.name || raw.name || ""), arguments: args });
  }
  return calls;
}

function publicResult(parsed: ParsedResponse): ChatResult {
  return {
    text: parsed.text,
    tool_calls: parsed.tool_calls,
    ...(parsed.finish_reason ? { finish_reason: parsed.finish_reason } : {}),
    usage: parsed.usage,
    response_cache_status: parsed.response_cache_status,
    request_body: parsed.request_body,
  };
}

function parseResponse(response: Response, rawText: string, requestBody: string, skipped: boolean): ParsedResponse {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    throw new LlmHttpError(502, "Gateway returned non-JSON output");
  }
  const choices = (data.choices as Record<string, unknown>[] | undefined) || [];
  const choice = choices[0] || {};
  const message = (choice.message as Record<string, unknown> | undefined) || {};
  const toolCalls = parseToolCalls(message);
  const text =
    typeof message.content === "string" ? message.content : typeof data.response === "string" ? data.response : "";
  const reasoningPresent = Boolean(message.reasoning_content || message.reasoning || data.reasoning);
  return {
    text,
    tool_calls: toolCalls,
    finish_reason: choice.finish_reason ? String(choice.finish_reason) : undefined,
    usage: parseUsage(data),
    response_cache_status: responseCacheStatus(response, skipped),
    request_body: requestBody,
    reasoningOnly: reasoningPresent && !text.trim() && toolCalls.length === 0,
  };
}

async function rawChat(
  env: Env,
  messages: LlmMessage[],
  tools: unknown[] | null,
  temperature: number,
  maxTokens: number,
  timeoutSec: number,
  options: AiRequestOptions,
): Promise<ParsedResponse> {
  const model: AiModelConfig = options.model || DEFAULT_MODEL;
  if (!model.enabled && options.requestKind !== "probe") throw new Error(`model '${model.label}' is disabled`);
  const canonical = canonicalMessages(messages);
  const normalizedTools = canonicalTools(tools);
  const payload: Record<string, unknown> = {
    model: model.model_id,
    messages: canonical.map(toApiMessage),
    temperature,
    max_tokens: Math.min(maxTokens, model.max_output_tokens),
  };
  if (normalizedTools?.length) {
    payload.tools = normalizedTools;
    payload.tool_choice = options.toolChoice || "auto";
  }
  const requestBody = stableStringify(payload);
  const normalizedPayload = JSON.parse(requestBody) as Record<string, unknown>;
  const cache = effectiveCache(options);
  const seconds = Math.max(1, timeoutSec || 120);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  let response: Response;
  try {
    if (model.transport === "cloudflare") {
      response = await env.AI.run(model.model_id as keyof AiModels, normalizedPayload as never, {
        returnRawResponse: true,
        signal: controller.signal,
        gateway: {
          id: env.AI_GATEWAY_ID,
          cacheTtl: cache.cacheTtl,
          skipCache: cache.skipCache,
          collectLog: false,
          ...(cache.cacheKey ? { cacheKey: cache.cacheKey } : {}),
        },
        extraHeaders: options.affinityKey ? { "x-session-affinity": options.affinityKey } : undefined,
      });
    } else {
      if (!model.provider_slug) throw new Error(`gateway model '${model.label}' is missing provider_slug`);
      response = await env.AI.gateway(env.AI_GATEWAY_ID).run(
        {
          provider: model.provider_slug,
          endpoint: "chat/completions",
          headers: { "Content-Type": "application/json" },
          query: normalizedPayload,
        },
        {
          signal: controller.signal,
          gateway: {
            id: env.AI_GATEWAY_ID,
            cacheTtl: cache.cacheTtl,
            skipCache: cache.skipCache,
            collectLog: false,
            ...(cache.cacheKey ? { cacheKey: cache.cacheKey } : {}),
          },
          extraHeaders: options.affinityKey ? { "x-session-affinity": options.affinityKey } : undefined,
        },
      );
    }
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message));
    if (aborted) throw new LlmTimeoutError(seconds);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const rawText = await response.text();
  if (!response.ok) throw new LlmHttpError(response.status, rawText.slice(0, 800));
  return parseResponse(response, rawText, requestBody, cache.skipCache);
}

export async function chat(
  env: Env,
  messages: LlmMessage[],
  tools: unknown[] | null,
  temperature: number,
  maxTokens: number,
  timeoutSec = 120,
  options: AiRequestOptions = {},
): Promise<ChatResult> {
  const first = await rawChat(env, messages, tools, temperature, maxTokens, timeoutSec, options);
  if (!first.reasoningOnly) return publicResult(first);
  if (options.skipOutputChannelRetry) return publicResult(first);
  const correction: LlmMessage[] = [
    ...messages,
    {
      role: "user",
      content: "上一响应没有正式输出。请立即把完整结果放入 assistant.content，或返回合法 tool_calls；不要复述约束。",
    },
  ];
  const second = await rawChat(env, correction, tools, temperature, maxTokens, timeoutSec, {
    ...options,
    requestKind: "correction",
    skipCache: true,
    cacheKey: undefined,
  });
  if (second.reasoningOnly) throw new LlmOutputChannelViolation();
  return publicResult(second);
}

export async function toolLoop(
  env: Env,
  messages: LlmMessage[],
  tools: unknown[] | null,
  runTool: (name: string, args: Record<string, unknown>, call: ToolCall) => Promise<string>,
  maxRounds: number,
  phi: string,
  temperature: number,
  maxTokens: number,
  timeoutSec = 120,
  options: AiRequestOptions = {},
): Promise<ChatResult> {
  const loopMessages = canonicalMessages(phi ? [...messages, { role: "system", content: phi }] : messages);
  for (let round = 0; round < Math.max(1, maxRounds); round += 1) {
    const result = await chat(env, loopMessages, tools, temperature, maxTokens, timeoutSec, {
      ...options,
      requestKind: round === 0 ? options.requestKind || "story" : "tool",
    });
    if (!result.tool_calls.length) return result;
    loopMessages.push({ role: "assistant", content: result.text || null, tool_calls: result.tool_calls });
    for (const call of result.tool_calls) {
      const output = await runTool(call.name, call.arguments, call);
      loopMessages.push({ role: "tool", content: output, tool_call_id: call.id });
    }
  }
  return chat(env, loopMessages, null, temperature, maxTokens, timeoutSec, { ...options, requestKind: "tool" });
}
