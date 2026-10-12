import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/server/env';
import { runDecisionQuestions, decisionVerdict } from '../src/server/decisions';
const questions = {
  supported: { type: 'noul' as const, instructions: 'Does the exact source support the claim?' },
};
function env(run: ReturnType<typeof vi.fn>) {
  return { AI: { run }, AI_GATEWAY_ID: 'test-only' } as unknown as Env;
}
describe('Clef typed decisions cannot substitute for authorization', () => {
  it('keeps a confidence gray zone and rejects nonfinite or out-of-range responses', () => {
    expect(decisionVerdict(0.95)).toBe('supported');
    expect(decisionVerdict(0.05)).toBe('rejected');
    expect(decisionVerdict(0.65)).toBe('uncertain');
    for (const p of [NaN, Infinity, -0.1, 1.1])
      expect(() => decisionVerdict(p)).toThrow('无效概率');
  });
  it('uses the System One request and disables gateway cache/content collection', async () => {
    const run = vi.fn(async () => ({
      model: 'clef',
      answers: { supported: { type: 'noul', noul: 0.97 } },
      usage: { input_tokens: 120, output_tokens: 0 },
    }));
    const state = { source: '丙没有听见甲的话', candidate: '丙知道甲的话', sourceGeneration: 2 };
    const usage = vi.fn();
    const result = await runDecisionQuestions(env(run), '@cf/cloudflare/clef', state, questions, {
      onUsage: usage,
    });
    expect(run.mock.calls[0]).toEqual([
      '@cf/cloudflare/clef',
      { model: 'clef', state, questions },
      { signal: undefined, gateway: { id: 'test-only', skipCache: true, collectLog: false } },
    ]);
    expect(result.answers.supported).toEqual({ probability: 0.97, verdict: 'supported' });
    expect(usage).toHaveBeenCalledWith({ input_tokens: 120, output_tokens: 0 });
    expect(result).not.toHaveProperty('grant');
  });
  it.each([
    { model: 'clef-flash', answers: { supported: { type: 'noul', noul: 0.9 } } },
    { model: 'clef', answers: {} },
    {
      model: 'clef',
      answers: { supported: { type: 'noul', noul: 0.9 }, guessed: { type: 'noul', noul: 0.9 } },
    },
    { model: 'clef', answers: { supported: { type: 'noul', noul: 1.01 } } },
    { model: 'clef', answers: { supported: { type: 'choice', choice: true } } },
  ])('rejects wrong model, missing/extra fields or forged probabilities', async (raw) => {
    const run = vi.fn(async () => raw);
    await expect(
      runDecisionQuestions(env(run), '@cf/cloudflare/clef', {}, questions),
    ).rejects.toMatchObject({ code: 'DECISION_RESPONSE' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('does not send oversized evidence or too many questions and preserves cancellation', async () => {
    const run = vi.fn();
    await expect(
      runDecisionQuestions(
        env(run),
        '@cf/cloudflare/clef',
        { text: '钥匙'.repeat(50000) },
        questions,
      ),
    ).rejects.toMatchObject({ code: 'DECISION_BUDGET' });
    await expect(
      runDecisionQuestions(
        env(run),
        '@cf/cloudflare/clef',
        {},
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['q' + i, questions.supported])),
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error('cancelled by owner'));
    await expect(
      runDecisionQuestions(env(run), '@cf/cloudflare/clef', {}, questions, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by owner');
    expect(run).not.toHaveBeenCalled();
  });
  it('does not expose provider keys or retry ambiguous transport failures', async () => {
    const run = vi.fn(async () => {
      throw new Error('private-api-key request-body');
    });
    await expect(
      runDecisionQuestions(env(run), '@cf/cloudflare/clef', {}, questions),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
