import type { LlmMessage, ToolCall } from "./assemble";

export const OUTPUT_CHANNEL_CONTRACT =
  "不要把叙事正文、对白、状态块、摘要、工具所需结果或任何应用需要读取的输出写入 reasoning_content、analysis 或思考通道。思考可以省略；完整结果必须写入 assistant.content 或正式 tool_calls。不要在正文中解释这条约束。";

export type AiTransport = "cloudflare" | "gateway";

export type AiModelConfig = {
  id: string;
  label: string;
  transport: AiTransport;
  provider_slug: string | null;
  model_id: string;
  context_window: number;
  max_output_tokens: number;
  supports_tools: boolean;
  supports_reasoning: boolean;
  enabled: boolean;
  sort_order: number;
  revision: number;
  source?: "application" | "workspace" | "session";
};

export type AiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  cached_input_tokens: number;
};

export type ResponseCacheStatus = "HIT" | "MISS" | "BYPASS" | "unknown";

export type ToolChoice = "auto" | "required" | "none" | { type: "function"; function: { name: string } };

export type AiRequestOptions = {
  model?: AiModelConfig;
  skipCache?: boolean;
  cacheTtl?: number;
  cacheKey?: string;
  affinityKey?: string;
  toolChoice?: ToolChoice;
  skipOutputChannelRetry?: boolean;
  /** Progressive assistant text callback (enables OpenAI-compatible SSE stream:true). */
  onPartial?: (text: string) => void | Promise<void>;
  /**
   * Fired periodically during long LLM awaits (TTFT + stream gaps) so Workers can
   * renew leases without relying on setInterval while blocked on fetch.
   */
  onHeartbeat?: () => void | Promise<void>;
  /** Interval for onHeartbeat; defaults to 30s when onHeartbeat is set. */
  heartbeatIntervalMs?: number;
  requestKind?:
    "story" | "ooc" | "tool" | "summary" | "compact" | "memory" | "rewrite" | "regenerate" | "correction" | "probe";
};

export const DEFAULT_MODEL: AiModelConfig = {
  id: "dsf0731-cheap-openrouter",
  label: "DSF0731 Cheap · OpenRouter",
  transport: "gateway",
  provider_slug: "openrouter",
  model_id: "@preset/dsf0731-cheap",
  context_window: 131_072,
  max_output_tokens: 16_384,
  supports_tools: true,
  supports_reasoning: true,
  enabled: true,
  sort_order: 10,
  revision: 1,
  source: "application",
};

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalTools(tools: unknown[] | null): unknown[] | null {
  if (!tools?.length) return null;
  return tools
    .map((tool) => sortJson(tool) as Record<string, unknown>)
    .sort((a, b) => {
      const aName = String((a.function as Record<string, unknown> | undefined)?.name || "");
      const bName = String((b.function as Record<string, unknown> | undefined)?.name || "");
      return aName.localeCompare(bName);
    });
}

export function canonicalMessages(messages: LlmMessage[]): LlmMessage[] {
  const systems: LlmMessage[] = [];
  const events: LlmMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content?.trim() && message.content.trim() !== OUTPUT_CHANNEL_CONTRACT) {
        systems.push({ role: "system", content: message.content.trim() });
      }
      continue;
    }
    events.push({
      role: message.role,
      content: message.content,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length ? { tool_calls: canonicalToolCalls(message.tool_calls) } : {}),
    });
  }
  return [...systems, { role: "system", content: OUTPUT_CHANNEL_CONTRACT }, ...events];
}

export function canonicalToolCalls(calls: ToolCall[]): ToolCall[] {
  return calls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: sortJson(call.arguments) as Record<string, unknown>,
  }));
}

export function isMessagePrefix(previous: LlmMessage[], next: LlmMessage[]): boolean {
  if (previous.length > next.length) return false;
  return stableStringify(next.slice(0, previous.length)) === stableStringify(previous);
}

export function affinityKey(sessionId: string, model: AiModelConfig, epoch: number): Promise<string> {
  return sha256(`${sessionId}:${model.id}:${model.revision}:${epoch}`).then((hash) => `lrp-${hash.slice(0, 32)}`);
}

export function cacheRatio(usage: AiUsage): number {
  return usage.prompt_tokens > 0 ? usage.cached_input_tokens / usage.prompt_tokens : 0;
}
