import type { Env } from './env';
import type { ModelSettings } from './settings';
import { ApiError } from './errors';
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export type CompletionOptions = {
  signal?: AbortSignal;
  onText?: (text: string) => Promise<void>;
  json?: boolean;
  jsonSchema?: Record<string, unknown>;
  auxiliary?: boolean;
  onUsage?: (usage: Record<string, unknown>) => void;
};
export async function boundedText(response: Response, limit = 2_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new ApiError(502, '模型输出超过限制', 'MODEL_TOO_LARGE');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function readCompletion(
  response: Response,
  options: CompletionOptions = {},
): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ApiError(
      [401, 402, 403].includes(response.status) ? 422 : 502,
      response.status === 402
        ? '模型服务返回 402，请检查网关余额、限额或输出预算'
        : `模型服务返回 ${response.status}`,
      'MODEL_HTTP',
    );
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const obj = JSON.parse(await boundedText(response)) as {
      usage?: Record<string, unknown>;
      response?: unknown;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    if (obj.usage) options.onUsage?.(obj.usage);
    if (obj.choices?.[0]?.finish_reason === 'length')
      throw new ApiError(422, '输出达到上限，草稿已保留，请调高输出预算', 'OUTPUT_TRUNCATED');
    const text =
      obj.choices?.[0]?.message?.content ??
      (options.jsonSchema && obj.response && typeof obj.response === 'object'
        ? JSON.stringify(obj.response)
        : typeof obj.response === 'string'
          ? obj.response
          : undefined);
    if (typeof text !== 'string' || !text.trim())
      throw new ApiError(502, '模型没有返回正文', 'MODEL_EMPTY');
    await options.onText?.(text);
    return text;
  }
  if (!response.body) throw new ApiError(502, '模型没有返回流', 'MODEL_EMPTY');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    result = '',
    received = 0,
    finished = false;
  const consume = async (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    if (!data) return;
    const item = JSON.parse(data) as {
      usage?: Record<string, unknown>;
      error?: { message?: string };
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
    };
    if (item.usage) options.onUsage?.(item.usage);
    if (item.error) throw new ApiError(502, '模型流返回错误', 'MODEL_STREAM_ERROR');
    for (const choice of item.choices ?? []) {
      const part = choice.delta?.content;
      if (typeof part === 'string') {
        result += part;
        await options.onText?.(part);
      }
      if (choice.finish_reason) {
        if (choice.finish_reason === 'length')
          throw new ApiError(422, '输出达到上限，草稿已保留，请调高输出预算', 'OUTPUT_TRUNCATED');
        finished = true;
      }
    }
  };
  try {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason;
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > 2_000_000) throw new ApiError(502, '模型流超过限制', 'MODEL_TOO_LARGE');
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        await consume(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await consume(buffer.trim());
    if (!finished || !result.trim())
      throw new ApiError(502, '模型流中断，草稿尚未提交', 'MODEL_STREAM_INCOMPLETE');
    return result;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export async function complete(
  env: Env,
  settings: ModelSettings,
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<string> {
  if (settings.mode === 'local-demo')
    throw new ApiError(422, '演示模式不调用远程模型', 'DEMO_MODE');
  const model =
    options.auxiliary && settings.auxiliaryModel ? settings.auxiliaryModel : settings.model;
  // Workers AI's public Qwen schema does not expose a chat-template thinking
  // toggle. Qwen's documented soft switch avoids spending the output budget on
  // a reasoning channel that cannot become narrative or structured evidence.
  const effectiveMessages =
    settings.mode === 'gateway' &&
    settings.provider === 'workers-ai' &&
    model === '@cf/qwen/qwen3-30b-a3b-fp8'
      ? [...messages, { role: 'system' as const, content: '/no_think' }]
      : messages;
  const payload = {
    model,
    messages: effectiveMessages,
    max_tokens: options.json ? Math.min(settings.maxOutput, 8192) : settings.maxOutput,
    stream: !!options.onText,
    ...(options.json
      ? {
          response_format: options.jsonSchema
            ? {
                type: 'json_schema',
                json_schema:
                  settings.mode === 'gateway' && settings.provider === 'workers-ai'
                    ? options.jsonSchema
                    : { name: 'lightrp_extraction', schema: options.jsonSchema },
              }
            : { type: 'json_object' },
        }
      : {}),
  };
  let response: Response;
  if (settings.mode === 'gateway' && settings.provider === 'workers-ai') {
    const result = await env.AI.run(
      payload.model as keyof AiModels,
      { ...payload, enable_thinking: false } as never,
      {
        signal: options.signal,
        gateway: { id: env.AI_GATEWAY_ID, skipCache: true, collectLog: false },
      },
    );
    response =
      result instanceof Response
        ? result
        : result instanceof ReadableStream
          ? new Response(result, { headers: { 'Content-Type': 'text/event-stream' } })
          : Response.json(result);
  } else if (settings.mode === 'gateway')
    response = await env.AI.gateway(env.AI_GATEWAY_ID).run(
      {
        provider: settings.provider,
        endpoint: 'chat/completions',
        headers: { 'Content-Type': 'application/json' },
        query: payload,
      },
      {
        signal: options.signal,
        gateway: {
          id: env.AI_GATEWAY_ID,
          skipCache: true,
          collectLog: false,
          retries: { maxAttempts: 1 },
        },
      },
    );
  else {
    const url = new URL(settings.baseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.|\[)|\.local$/i.test(
        url.hostname,
      )
    )
      throw new ApiError(422, '模型地址必须是公开 HTTPS 地址', 'MODEL_URL');
    if (!env.MODEL_API_KEY)
      throw new ApiError(422, '请配置服务端 MODEL_API_KEY secret', 'MODEL_KEY_MISSING');
    response = await fetch(`${url.toString().replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MODEL_API_KEY}` },
      body: JSON.stringify(payload),
      signal: options.signal,
      redirect: 'error',
    });
  }
  return readCompletion(response, options);
}
export function parseJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*/, '')
      .replace(/\s*```$/, ''),
  );
}
