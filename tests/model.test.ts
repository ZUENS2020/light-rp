import { describe, it, expect } from 'vitest';
import { readCompletion, boundedText, complete, type ChatMessage } from '../src/server/model';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
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
