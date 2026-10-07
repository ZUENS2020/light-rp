import { afterEach, describe, it, expect, vi } from 'vitest';
import { readCompletion, boundedText, complete, type ChatMessage } from '../src/server/model';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
afterEach(() => vi.restoreAllMocks());
function stream(text: string, split = 3) {
  const encoded = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < encoded.length; i += split) c.enqueue(encoded.slice(i, i + split));
        c.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
describe('model responses and durable draft boundaries', () => {
  it('uses explicit extraction prompt protocol while keeping native schema for simple Qwen and other models', async () => {
    const jsonSchema = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const run = vi.fn(async (_model: unknown, _input: { response_format?: unknown }) => ({
      response: '{"value":1}',
    }));
    const env = { AI: { run }, AI_GATEWAY_ID: 'mock-only' } as unknown as Env;
    await complete(env, defaults('gateway'), [{ role: 'user', content: 'JSON' }], {
      json: true,
      jsonSchema,
      schemaProtocol: 'prompt',
    });
    expect(run.mock.calls[0]![1]).not.toHaveProperty('response_format');
    expect(JSON.parse(String(info.mock.calls[0]![0]))).toEqual({
      event: 'model_response_format',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      requested: 'json_schema',
      effective: 'prompt_only',
      reason: 'MEASURED_EXTRACTION_FORMAT_FAILURE',
      validation: 'server_schema_required',
    });
    await complete(
      env,
      { ...defaults('gateway'), model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
      [{ role: 'user', content: 'JSON' }],
      { json: true, jsonSchema },
    );
    expect(run.mock.calls[1]![1].response_format).toEqual({
      type: 'json_schema',
      json_schema: jsonSchema,
    });
    expect(info).toHaveBeenCalledTimes(1);
    await complete(env, defaults('gateway'), [{ role: 'user', content: 'JSON' }], {
      json: true,
      jsonSchema,
    });
    expect(run.mock.calls[2]![1].response_format).toEqual({
      type: 'json_schema',
      json_schema: jsonSchema,
    });
    expect(info).toHaveBeenCalledTimes(1);
  });
  it('turns binding rejection into a safe transport error without repeating or exposing private provider details', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('private-provider-key and request-body'), { status: 400 });
    });
    const env = { AI: { run }, AI_GATEWAY_ID: 'mock-only' } as unknown as Env;
    await expect(
      complete(env, defaults('gateway'), [{ role: 'user', content: 'JSON' }], { json: true }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'MODEL_HTTP',
      message: expect.stringContaining('HTTP 400'),
    });
    expect(run).toHaveBeenCalledTimes(1);
    try {
      await complete(env, defaults('gateway'), [], { json: true });
    } catch (error) {
      expect(String(error)).not.toContain('private-provider-key');
      expect(String(error)).not.toContain('request-body');
    }
  });
  it('returns only bounded visible truncated text to an explicit audit callback and still fails', async () => {
    const preview = vi.fn(),
      usage = vi.fn();
    await expect(
      readCompletion(
        Response.json({
          usage: { completion_tokens: 4096 },
          choices: [
            {
              message: {
                content: '{"facts":[' + 'x'.repeat(9000),
                reasoning_content: 'PRIVATE REASONING',
              },
              finish_reason: 'length',
            },
          ],
        }),
        { json: true, onTruncatedText: preview, onUsage: usage },
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' });
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![0]).toHaveLength(8192);
    expect(preview.mock.calls[0]![0]).not.toContain('PRIVATE REASONING');
    expect(usage).toHaveBeenCalledWith({ completion_tokens: 4096 });
    const empty = vi.fn();
    await expect(
      readCompletion(
        Response.json({
          choices: [
            {
              message: { content: '', reasoning_content: 'PRIVATE REASONING' },
              finish_reason: 'length',
            },
          ],
        }),
        { onTruncatedText: empty },
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' });
    expect(empty).toHaveBeenCalledWith('');
  });
  it('uses the documented Qwen soft switch without mutating persisted context or other model requests', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '讲述门后的故事' }],
      calls: Record<string, unknown>[] = [];
    const env = {
      AI: {
        run: async (_model: string, payload: Record<string, unknown>) => {
          calls.push(payload);
          return { choices: [{ message: { content: '门缓缓打开。' }, finish_reason: 'stop' }] };
        },
      },
      AI_GATEWAY_ID: 'test',
    } as unknown as Env;
    await complete(env, defaults('gateway'), messages);
    expect(calls[0].messages).toEqual([...messages, { role: 'system', content: '/no_think' }]);
    expect(messages).toEqual([{ role: 'user', content: '讲述门后的故事' }]);
    await complete(env, { ...defaults('gateway'), model: '@cf/other/model' }, messages);
    expect(calls[1].messages).toEqual(messages);
  });
  it('handles split UTF-8 / CRLF and never commits reasoning as story text', async () => {
    const chunks: string[] = [];
    const response = stream(
      'data: {"choices":[{"delta":{"reasoning_content":"机密思考","content":"你"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"好😀"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      1,
    );
    expect(
      await readCompletion(response, {
        onText: async (t) => {
          chunks.push(t);
        },
      }),
    ).toBe('你好😀');
    expect(chunks.join('')).toBe('你好😀');
  });
  it('preserves partial drafts but refuses a prematurely disconnected stream', async () => {
    const chunks: string[] = [];
    await expect(
      readCompletion(stream('data: {"choices":[{"delta":{"content":"半段正文"}}]}\n\n'), {
        onText: async (t) => {
          chunks.push(t);
        },
      }),
    ).rejects.toMatchObject({ code: 'MODEL_STREAM_INCOMPLETE' });
    expect(chunks.join('')).toBe('半段正文');
  });
  it('refuses a length stop even when DONE follows', async () => {
    await expect(
      readCompletion(
        stream(
          'data: {"choices":[{"delta":{"content":"片段"},"finish_reason":"length"}]}\n\ndata: [DONE]\n',
        ),
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' });
  });
  it('rejects empty body, auth error and bounded overflow without leaking provider details', async () => {
    await expect(
      readCompletion(Response.json({ choices: [{ message: { content: '' } }] })),
    ).rejects.toMatchObject({ code: 'MODEL_EMPTY' });
    await expect(
      readCompletion(new Response('private provider key', { status: 401 })),
    ).rejects.toMatchObject({ status: 422, message: '模型服务返回 401' });
    await expect(boundedText(new Response('012345'), 3)).rejects.toMatchObject({
      code: 'MODEL_TOO_LARGE',
    });
  });
});
