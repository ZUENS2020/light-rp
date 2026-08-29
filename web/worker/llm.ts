import type { LlmMessage, ToolCall } from "./assemble";

export type ChatResult = { text: string; tool_calls: ToolCall[]; reasoning?: string; finish_reason?: string };

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

export function turnErrorStatus(err: unknown): number {
  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403 || err.status === 429) return err.status;
    if (err.status >= 500 && err.status <= 599) return err.status;
    return 502;
  }
  if (err instanceof LlmTimeoutError) return 504;
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

export async function chat(
  env: { LLM_BASE_URL: string; LLM_MODEL: string; NVIDIA_API_KEY: string },
  messages: LlmMessage[],
  tools: unknown[] | null,
  temperature: number,
  maxTokens: number,
  timeoutSec = 120,
): Promise<ChatResult> {
  if (!env.LLM_BASE_URL) throw new Error("missing API base URL");
  if (!env.LLM_MODEL) throw new Error("missing API model");
  if (!env.NVIDIA_API_KEY) throw new Error("missing API key");
  const payload: Record<string, unknown> = {
    model: env.LLM_MODEL,
    messages: messages.map(toApiMessage),
    temperature,
    max_tokens: maxTokens,
  };
  if (tools?.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
  const seconds = Math.max(1, timeoutSec || 120);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), seconds * 1000);
  let response: Response;
  try {
    response = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
    if (aborted) throw new LlmTimeoutError(seconds);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const rawText = await response.text();
  if (!response.ok) throw new LlmHttpError(response.status, rawText.slice(0, 800));
  const data = JSON.parse(rawText) as {
    choices?: { message?: Record<string, unknown>; finish_reason?: string }[];
  };
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const toolCalls: ToolCall[] = [];
  for (const raw of (message.tool_calls as Record<string, unknown>[] | undefined) || []) {
    const fn = (raw.function as Record<string, unknown>) || {};
    let args: Record<string, unknown> = {};
    try {
      args = typeof fn.arguments === "string" ? JSON.parse(fn.arguments || "{}") : ((fn.arguments as Record<string, unknown>) || {});
    } catch {
      args = {};
    }
    toolCalls.push({ id: String(raw.id || ""), name: String(fn.name || ""), arguments: args });
  }
  return {
    text: String(message.content || ""),
    tool_calls: toolCalls,
    reasoning: message.reasoning_content ? String(message.reasoning_content) : undefined,
    finish_reason: choice.finish_reason ? String(choice.finish_reason) : undefined,
  };
}

function toApiMessage(msg: LlmMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role, content: msg.content };
  if (msg.reasoning_content) out.reasoning_content = msg.reasoning_content;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return out;
}

export async function toolLoop(
  env: { LLM_BASE_URL: string; LLM_MODEL: string; NVIDIA_API_KEY: string },
  messages: LlmMessage[],
  tools: unknown[] | null,
  runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxRounds: number,
  phi: string,
  temperature: number,
  maxTokens: number,
  timeoutSec = 120,
): Promise<ChatResult> {
  let last: ChatResult = { text: "", tool_calls: [] };
  const outgoingPhi = (list: LlmMessage[]) => (phi ? [...list, { role: "system", content: phi }] : list);
  for (let i = 0; i < Math.max(1, maxRounds); i += 1) {
    last = await chat(env, outgoingPhi(messages), tools, temperature, maxTokens, timeoutSec);
    if (!last.tool_calls.length) return last;
    messages.push({
      role: "assistant",
      content: last.text || null,
      reasoning_content: last.reasoning,
      tool_calls: last.tool_calls,
    });
    for (const call of last.tool_calls) {
      const output = await runTool(call.name, call.arguments);
      messages.push({ role: "tool", content: output, tool_call_id: call.id });
    }
  }
  return chat(env, outgoingPhi(messages), null, temperature, maxTokens, timeoutSec);
}
