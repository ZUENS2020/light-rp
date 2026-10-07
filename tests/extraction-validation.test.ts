import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyze,
  extractionMessages,
  extractionSchema,
  parseExtractionOutput,
  validateExtraction,
} from '../src/server/extraction';
import { normalizeCharacter } from '../src/shared/assets';
import { defaults } from '../src/server/settings';
import type { ContextSnapshot } from '../src/server/context';
import type { Env } from '../src/server/env';
import { complete, readCompletion, type ChatMessage } from '../src/server/model';

afterEach(() => vi.restoreAllMocks());
function context(): ContextSnapshot {
  return {
    branch: {
      id: 'branch',
      ownerId: 'mock-owner',
      storyId: 'story',
      name: '验证',
      parentBranchId: null,
      forkSeq: 0,
      headSeq: 0,
      revision: 0,
      projectionRevision: 0,
      scene: {},
      createdAt: '2026-10-07T00:00:00Z',
    },
    settings: defaults('gateway'),
    characters: [
      {
        id: 'actor-a',
        revision: 7,
        data: normalizeCharacter({ name: '甲', description: '甲不能飞翔。' }),
      },
    ],
    recall: { items: [], tokens: 0, cursor: 0, visited: 0, truncated: false, degraded: [] },
    worldbookTriggers: { activated: [], skipped: [], tokens: 0, seed: 'same-attempt' },
    hardRules: [
      { origin: 'global', id: 'global:story', text: '世界中不存在复活。' },
      { origin: 'character', id: 'actor-a', revision: 7, text: '甲不能飞翔。' },
      { origin: 'worldbook', id: 'book:dragon', revision: 3, text: '龙永远不能飞翔。' },
    ],
    messages: [{ role: 'user', content: '我说大家都能飞翔。' }],
    resources: [],
    ownerEpoch: 0,
    sourceFence: [],
    tokens: 0,
    budget: 32768,
    headSeq: 0,
    warnings: [],
    entities: [],
  } as ContextSnapshot;
}
const input = { mode: 'roleplay' as const, text: '继续。' };
const narration = '钥匙在仓库。';
const fact = (quote = narration) => ({
  kind: 'canon',
  subject: '钥匙',
  predicate: 'location',
  value: '仓库',
  text: narration,
  evidence: [{ source: 'assistant', quote }],
  knownBy: [],
});
const result = (facts: unknown[] = [fact()]) => ({
  scene: {},
  facts,
  violations: [],
  experiences: [],
  capabilities: [],
  procedureUses: [],
});
function binding(...outputs: unknown[]) {
  const run = vi.fn();
  outputs.forEach((value) =>
    run.mockResolvedValueOnce({
      choices: [
        {
          message: { content: typeof value === 'string' ? value : JSON.stringify(value) },
          finish_reason: 'stop',
        },
      ],
    }),
  );
  return { run, env: { AI: { run }, AI_GATEWAY_ID: 'mock-only' } as unknown as Env };
}
describe('bound-rule extraction and source semantics', () => {
  it('sends frozen global, character and activated lore rules without promoting historical dialogue', async () => {
    const c = context(),
      { run, env } = binding(result());
    await analyze(env, c, input, narration);
    const messages = run.mock.calls[0]![1].messages as ChatMessage[];
    const payload = JSON.parse(messages.find((message) => message.role === 'user')!.content);
    expect(payload.boundHardRules).toEqual(c.hardRules);
    expect(
      payload.boundHardRules.some((rule: { text: string }) => rule.text.includes('大家都能飞翔')),
    ).toBe(false);
    expect(messages[0]!.content).toContain('角色自称成功不足');
    expect(messages[0]!.content).not.toContain('validFrom":"明确的剧情');
    expect(run.mock.calls[0]![1]).not.toHaveProperty('response_format');
  });
  it('rejects an explicit fixed-rule conflict on the first response instead of repairing it away', async () => {
    const { run, env } = binding(
      { ...result([]), violations: ['龙不能飞翔，但正文写了龙飞翔。'] },
      result(),
    );
    await expect(analyze(env, context(), input, '龙飞翔。')).rejects.toMatchObject({
      code: 'CANON_CONFLICT',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('does not spend three analyzer calls on a rejected binding protocol', async () => {
    const run = vi.fn(async () => {
      throw new Error('private provider schema error');
    });
    await expect(
      analyze(
        { AI: { run }, AI_GATEWAY_ID: 'mock-only' } as unknown as Env,
        context(),
        input,
        narration,
      ),
    ).rejects.toMatchObject({ code: 'MODEL_HTTP' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('records a synthetic visible truncation preview without retrying or returning it as extraction', async () => {
    const events: unknown[] = [],
      run = vi.fn(async () => ({
        choices: [
          {
            message: { content: '{"facts":[', reasoning_content: 'PRIVATE REASONING' },
            finish_reason: 'length',
          },
        ],
        usage: { completion_tokens: 4096 },
      }));
    await expect(
      analyze(
        { AI: { run }, AI_GATEWAY_ID: 'mock-only' } as unknown as Env,
        context(),
        input,
        narration,
        { onAttempt: (event) => events.push(event) },
      ),
    ).rejects.toMatchObject({ code: 'OUTPUT_TRUNCATED' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      attempt: 1,
      phase: 'truncated',
      rawOutput: '{"facts":[',
      errorCode: 'OUTPUT_TRUNCATED',
    });
    expect(JSON.stringify(events)).not.toContain('PRIVATE REASONING');
  });
  it('keeps provider schema enforcement for a different auxiliary model', async () => {
    const c = context(),
      { run, env } = binding(result());
    c.settings.auxiliaryModel = '@cf/meta/llama-3.1-8b-instruct';
    await analyze(env, c, input, narration);
    expect(run.mock.calls[0]![0]).toBe(c.settings.auxiliaryModel);
    expect(run.mock.calls[0]![1].response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { type: 'object' },
    });
  });
  it('uses the measured prompt-only extraction protocol for Llama70b, retaining strict parsing', async () => {
    const c = context(),
      { run, env } = binding(result());
    c.settings.auxiliaryModel = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    await analyze(env, c, input, narration);
    expect(run.mock.calls[0]![0]).toBe(c.settings.auxiliaryModel);
    expect(run.mock.calls[0]![1]).not.toHaveProperty('response_format');
  });
  it('keeps a clipped quoted lie or imagined/conditional statement out of canon', () => {
    for (const source of [
      '甲撒谎说：“钥匙在仓库。”客观上钥匙实际在工坊。',
      '甲想象钥匙在仓库。钥匙实际在工坊。',
      '如果钥匙在仓库，甲就会回来。',
      '甲计划告诉乙钥匙在仓库。',
    ])
      expect(() =>
        validateExtraction(
          extractionSchema.parse(result([fact('钥匙在仓库')])),
          input,
          source,
          context(),
        ),
      ).toThrow('世界事实');
    const source = '甲撒谎说：“钥匙在仓库。”客观上钥匙实际在工坊。',
      objective = { ...fact('钥匙实际在工坊'), value: '工坊', text: '钥匙实际在工坊' };
    expect(() =>
      validateExtraction(extractionSchema.parse(result([objective])), input, source, context()),
    ).not.toThrow();
    const paddedSource = '甲撒谎说：“钥匙在仓库。”窗外正在下雨。';
    for (const evidence of [
      [
        { source: 'assistant', quote: '钥匙在仓库' },
        { source: 'assistant', quote: '窗外正在下雨' },
      ],
      [{ source: 'assistant', quote: '钥匙在仓库。”窗外正在下雨' }],
    ])
      expect(() =>
        validateExtraction(
          extractionSchema.parse(result([{ ...fact(), evidence }])),
          input,
          paddedSource,
          context(),
        ),
      ).toThrow('世界事实');
  });
  it('grounds numeric, boolean and null canon values instead of laundering them with unrelated evidence', () => {
    const source = '甲撒谎说：“门禁密码是7391。”客观上密码是8520。窗外正在下雨。';
    const numeric = {
      ...fact(),
      subject: '门禁',
      predicate: '密码',
      value: 7391,
      evidence: [
        { source: 'assistant', quote: '门禁密码是7391' },
        { source: 'assistant', quote: '窗外正在下雨' },
      ],
    };
    expect(() =>
      validateExtraction(extractionSchema.parse(result([numeric])), input, source, context()),
    ).toThrow('世界事实');
    for (const [value, quote] of [
      [8520, '客观上密码是8520'],
      [7391, '密码是73912'],
      [7391, '密码是７３９１'],
    ] as const) {
      const extraction = extractionSchema.parse(
        result([{ ...numeric, value, evidence: [{ source: 'assistant', quote }] }]),
      );
      const validate = () => validateExtraction(extraction, input, quote + '。', context());
      if (quote.endsWith('73912')) expect(validate).toThrow('世界事实');
      else expect(validate).not.toThrow();
    }
    for (const quote of [
      '密码是-7391',
      '密码是+7391',
      '密码是負7391',
      '密码是负7391',
      '密码是7391e2',
    ])
      expect(() =>
        validateExtraction(
          extractionSchema.parse(
            result([{ ...numeric, evidence: [{ source: 'assistant', quote }] }]),
          ),
          input,
          quote + '。',
          context(),
        ),
      ).toThrow('世界事实');
    for (const value of [true, false, null]) {
      const quote = `作者确认：甲.alive=${String(value)}`,
        candidate = {
          ...numeric,
          subject: 'actor-a',
          predicate: 'alive',
          value,
          evidence: [{ source: 'user', quote }],
        };
      expect(() =>
        validateExtraction(
          extractionSchema.parse(result([candidate])),
          { mode: 'author', text: quote },
          '',
          context(),
        ),
      ).not.toThrow();
      const misleading = {
        ...candidate,
        evidence: [
          { source: 'assistant', quote: '甲说：“alive=' + String(value) + '。”' },
          { source: 'assistant', quote: '窗外下雨' },
        ],
      };
      expect(() =>
        validateExtraction(
          extractionSchema.parse(result([misleading])),
          input,
          `甲说：“alive=${String(value)}。”窗外下雨。`,
          context(),
        ),
      ).toThrow('世界事实');
    }
  });
  it('rejects quoted claims as canon but accepts independent objective narration and directional belief', () => {
    const said = '甲说：“钥匙在仓库。”';
    expect(() =>
      validateExtraction(extractionSchema.parse(result([fact(said)])), input, said, context()),
    ).toThrow('对白');
    const objective = '甲说：“钥匙在码头。”钥匙实际在仓库。';
    expect(() =>
      validateExtraction(
        extractionSchema.parse(result([fact(objective)])),
        input,
        objective,
        context(),
      ),
    ).not.toThrow();
    const believed = { ...fact(said), kind: 'belief', observerId: 'actor-a', knownBy: ['actor-a'] };
    expect(() =>
      validateExtraction(extractionSchema.parse(result([believed])), input, said, context()),
    ).not.toThrow();
    expect(() =>
      validateExtraction(
        extractionSchema.parse(result([{ ...fact(), observerId: 'actor-a' }])),
        input,
        narration,
        context(),
      ),
    ).toThrow('observerId');
  });
  it('rejects self-claimed success and accepts separately narrated successful state change', () => {
    const claimed = '甲声称自己成功打开北门。';
    const experience = (quote: string) => ({
      actorId: 'actor-a',
      capability: '开锁',
      conditions: {},
      steps: ['转动钥匙'],
      outcome: 'success',
      evidence: [{ source: 'assistant', quote }],
    });
    expect(() =>
      validateExtraction(
        extractionSchema.parse({ ...result([]), experiences: [experience(claimed)] }),
        input,
        claimed,
        context(),
      ),
    ).toThrow('自称成功');
    for (const [source, quote] of [
      ['甲声称：“甲成功打开北门。”窗外下雨。', '甲成功打开北门'],
      ['甲没有成功打开北门。', '成功打开北门'],
    ])
      expect(() =>
        validateExtraction(
          extractionSchema.parse({ ...result([]), experiences: [experience(quote)] }),
          input,
          source,
          context(),
        ),
      ).toThrow('自称');
    const claimedCapability = extractionSchema.parse({
      ...result([]),
      capabilities: [
        {
          actorId: 'actor-a',
          name: '开锁',
          level: '初级',
          evidence: [{ source: 'assistant', quote: '甲学会开锁' }],
        },
      ],
    });
    expect(() =>
      validateExtraction(claimedCapability, input, '甲说：“甲学会开锁。”', context()),
    ).toThrow('实际学习');
    const actual = '甲声称自己成功打开北门。北门实际打开，甲走了进去。';
    expect(() =>
      validateExtraction(
        extractionSchema.parse({ ...result([]), experiences: [experience(actual)] }),
        input,
        actual,
        context(),
      ),
    ).not.toThrow();
  });
});
describe('strict unknown normalization and useful bounded repair', () => {
  it('records omitted unknown times and categories while rejecting numeric and date strings', () => {
    const parsed = parseExtractionOutput({
      ...result([{ ...fact(), validFrom: null, validTo: 'unknown' }]),
      experiences: [
        {
          actorId: 'actor-a',
          capability: '开锁',
          conditions: {},
          steps: ['尝试'],
          outcome: 'unknown',
          evidence: [{ source: 'assistant', quote: narration }],
          failureCategory: '',
        },
      ],
    });
    expect(parsed.facts[0]!.validFrom).toBeUndefined();
    expect(parsed.facts[0]!.validTo).toBeUndefined();
    expect(parsed.normalizations).toEqual([
      { path: 'facts.0.validFrom', code: 'UNKNOWN_TIME_OMITTED', original: null },
      { path: 'facts.0.validTo', code: 'UNKNOWN_TIME_OMITTED', original: 'unknown' },
      {
        path: 'experiences.0.failureCategory',
        code: 'UNKNOWN_FAILURE_CATEGORY_OMITTED',
        original: '',
      },
    ]);
    for (const value of ['10', '2026-10-07', '明确的数值时间'])
      expect(() => parseExtractionOutput(result([{ ...fact(), validFrom: value }]))).toThrow();
    expect(
      parseExtractionOutput(result([{ ...fact(), validFrom: 10, validTo: 15 }])).facts[0],
    ).toMatchObject({ validFrom: 10, validTo: 15 });
  });
  it('repairs numeric strings using the previous exact assistant response and concrete Zod path', async () => {
    const bad = result([{ ...fact(), validFrom: '10' }]),
      good = result([{ ...fact(), validFrom: 10 }]);
    const { run, env } = binding(bad, good);
    const value = await analyze(env, context(), input, narration);
    expect(value.facts[0]!.validFrom).toBe(10);
    expect(run).toHaveBeenCalledTimes(2);
    const messages = run.mock.calls[1]![1].messages as ChatMessage[];
    expect(messages.find((message) => message.role === 'assistant')!.content).toBe(
      JSON.stringify(bad),
    );
    expect(messages.filter((message) => message.role === 'user').at(-1)!.content).toContain(
      'facts.0.validFrom',
    );
    expect(messages.filter((message) => message.role === 'user').at(-1)!.content).toContain(
      'invalid_type',
    );
  });
  it('normalizes explicit unknown fields on one model call and rejects mandatory budget overflow before any call', async () => {
    const { run, env } = binding(result([{ ...fact(), validFrom: '', validTo: null }]));
    const parsed = await analyze(env, context(), input, narration);
    expect(run).toHaveBeenCalledTimes(1);
    expect(parsed.normalizations).toHaveLength(2);
    const large = context();
    large.hardRules![0]!.text = '不可删除的世界规则。'.repeat(10000);
    await expect(analyze(env, large, input, narration)).rejects.toMatchObject({
      code: 'EXTRACTION_BUDGET',
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => extractionMessages(context(), input, '不可删除的原文。'.repeat(12000))).toThrow(
      '辅助上下文预算',
    );
  });
});
it('adapts JSON Schema for OpenAI transport and accepts Cloudflare structured response objects', async () => {
  const jsonSchema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  };
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ choices: [{ message: { content: '{"text":"ok"}' } }] }));
  const env = { MODEL_API_KEY: 'mock-test-key' } as unknown as Env;
  await complete(env, defaults('openai'), [{ role: 'user', content: 'JSON' }], {
    json: true,
    jsonSchema,
  });
  const payload = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
  expect(payload.response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'lightrp_extraction', schema: jsonSchema },
  });
  expect(
    await readCompletion(Response.json({ response: { text: 'ok' } }), { json: true, jsonSchema }),
  ).toBe('{"text":"ok"}');
  expect(await readCompletion(Response.json({ response: '叙事正文。' }))).toBe('叙事正文。');
  await expect(
    readCompletion(Response.json({ response: { text: '不能用对象当正文' } })),
  ).rejects.toMatchObject({ code: 'MODEL_EMPTY' });
});
