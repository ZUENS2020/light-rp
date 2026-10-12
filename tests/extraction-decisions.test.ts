import { describe, it, expect, vi } from 'vitest';
import { validateExtractionDecisions } from '../src/server/extraction-decisions';
import { extractionSchema } from '../src/server/extraction';
import { defaults } from '../src/server/settings';
import type { ContextSnapshot } from '../src/server/context';
import type { Env } from '../src/server/env';
const narration = '钥匙实际在工坊。甲撒谎说在仓库。乙听清并相信；丙没有听见。';
const input = { mode: 'roleplay' as const, text: '继续' };
const candidate = {
  kind: 'belief',
  subject: '乙',
  observerId: 'b',
  predicate: 'location',
  value: '仓库',
  text: '乙相信钥匙在仓库',
  knownBy: ['b'],
  evidence: [{ source: 'assistant', quote: '乙听清并相信' }],
  knowledge: [{ actorId: 'b', source: 'assistant', channel: 'told', quote: narration }],
};
function setup(probability = 0.97) {
  const run = vi.fn(async (_model: unknown, request: any, _options?: any) => ({
    model: 'clef',
    answers: Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: probability }]),
    ),
    usage: { input_tokens: 400, output_tokens: 0 },
  }));
  const context = {
    settings: { ...defaults('gateway'), decisionModel: '@cf/cloudflare/clef' },
    characters: [],
    hardRules: [{ origin: 'global', id: 'world:rule', text: '作者规则保持有效' }],
  } as unknown as ContextSnapshot;
  const env = { AI: { run }, AI_GATEWAY_ID: 'test' } as unknown as Env;
  return { run, context, env };
}
describe('semantic decisions supplement controlled extraction', () => {
  it('does not call a judge when disabled or in local demo', async () => {
    const { env, context, run } = setup();
    context.settings.decisionModel = '';
    await validateExtractionDecisions(
      env,
      context,
      input,
      narration,
      extractionSchema.parse({ scene: {}, facts: [candidate] }),
    );
    context.settings.decisionModel = '@cf/cloudflare/clef';
    context.settings.mode = 'local-demo';
    await validateExtractionDecisions(
      env,
      context,
      input,
      narration,
      extractionSchema.parse({ scene: {}, facts: [candidate] }),
    );
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps a belief separate from canon and never mutates the candidate or creates a grant', async () => {
    const { env, context, run } = setup(),
      extraction = extractionSchema.parse({ scene: {}, facts: [candidate] }),
      before = JSON.stringify(extraction);
    const audit = await validateExtractionDecisions(env, context, input, narration, extraction);
    expect(audit?.status).toBe('supported');
    expect(JSON.stringify(extraction)).toBe(before);
    expect(run.mock.calls[0]![1].state).toMatchObject({
      source: { narration, userText: '继续' },
      candidateType: 'fact',
      candidate: { kind: 'belief' },
    });
    expect(audit).not.toHaveProperty('knowledgeGrant');
  });
  it.each([
    [0.02, 'rejected', 'EXTRACTION_DECISION_REJECTED'],
    [0.6, 'uncertain', 'EXTRACTION_DECISION_UNCERTAIN'],
  ] as const)(
    'holds unsupported or uncertain candidates, records an audit, and preserves source content',
    async (probability, status, code) => {
      const { env, context } = setup(probability),
        onDecision = vi.fn();
      await expect(
        validateExtractionDecisions(
          env,
          context,
          input,
          narration,
          extractionSchema.parse({ scene: {}, facts: [candidate] }),
          { onDecision },
        ),
      ).rejects.toMatchObject({ code });
      expect(onDecision).toHaveBeenCalledTimes(1);
      expect(onDecision.mock.calls[0]![0]).toMatchObject({
        status,
        candidates: [{ path: 'facts.0' }],
      });
      expect(JSON.stringify(onDecision.mock.calls[0]![0])).not.toContain(narration);
    },
  );
  it('keeps independent candidates in separate model states and rejects excessive candidate cost before network', async () => {
    const { env, context, run } = setup();
    await validateExtractionDecisions(
      env,
      context,
      input,
      narration,
      extractionSchema.parse({ scene: {}, facts: [candidate, { ...candidate, text: '乙误信' }] }),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]![1].state).not.toHaveProperty('candidates');
    await expect(
      validateExtractionDecisions(
        env,
        context,
        input,
        narration,
        extractionSchema.parse({ scene: {}, facts: Array.from({ length: 65 }, () => candidate) }),
      ),
    ).rejects.toMatchObject({ code: 'DECISION_BUDGET' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('records a transport failure without treating it as supported evidence', async () => {
    const { env, context, run } = setup();
    run.mockRejectedValueOnce(new Error('private provider secret'));
    const onDecision = vi.fn();
    await expect(
      validateExtractionDecisions(
        env,
        context,
        input,
        narration,
        extractionSchema.parse({ scene: {}, facts: [candidate] }),
        { onDecision },
      ),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' });
    expect(onDecision.mock.calls[0]![0]).toMatchObject({
      status: 'failed',
      errorCode: 'DECISION_UNAVAILABLE',
    });
    expect(JSON.stringify(onDecision.mock.calls)).not.toContain('private provider');
  });
  it('combines per-request timeout with an external cancellation signal without starting repair calls', async () => {
    const { env, context, run } = setup(),
      external = new AbortController(),
      timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    run.mockImplementationOnce(
      async (_model, _request, options?: any) =>
        new Promise<never>((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        ),
    );
    try {
      const pending = validateExtractionDecisions(
        env,
        context,
        input,
        narration,
        extractionSchema.parse({ scene: {}, facts: [candidate] }),
        { signal: external.signal },
      );
      timeout.abort(new DOMException('request timeout', 'TimeoutError'));
      await expect(pending).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE' });
      expect(external.signal.aborted).toBe(false);
      expect(timeoutSpy).toHaveBeenCalledWith(30000);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
