import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AppEnv, Env } from '../src/server/env';
import { ApiError } from '../src/server/errors';
import {
  aggregateExtractionQuality,
  extractionQualityContext,
  qualityEvaluationRouter,
  qualityOwner,
  queryQualityVector,
  scoreExtractionQuality,
} from '../src/server/extraction-evaluation';
import { analyze, extractionSchema } from '../src/server/extraction';
import { defaults } from '../src/server/settings';
import { EvaluationStore } from '../src/server/evaluation';
import { scopeKey } from '../src/server/context';
import { extractionQualityCases, vectorQualityFacts } from './fixtures/extraction-quality';
import { aggregateVectorQuality, main } from '../scripts/quality-evaluate';
import { createTestD1 } from './d1';
afterEach(() => vi.restoreAllMocks());
const extraction = (
  facts: unknown[] = [],
  experiences: unknown[] = [],
  capabilities: unknown[] = [],
) => extractionSchema.parse({ scene: {}, facts, experiences, capabilities });
const reference = [{ source: 'assistant', quote: '测试用例' }];
it('fixes 20 Chinese extraction cases and 20 semantic queries before model output', () => {
  expect(extractionQualityCases).toHaveLength(20);
  expect(new Set(extractionQualityCases.map((f) => f.id)).size).toBe(20);
  expect(vectorQualityFacts).toHaveLength(20);
  expect(extractionQualityCases.some((f) => f.category === '谎言与误信')).toBe(true);
  expect(extractionQualityCases.some((f) => f.category === '作者纠正')).toBe(true);
  expect(vectorQualityFacts.every((f) => f.query !== f.text)).toBe(true);
});
it('scores truth, explicit contradictions, unknown predictions and recall without inflating precision', () => {
  const fixture = extractionQualityCases[1]!,
    result = scoreExtractionQuality(
      fixture,
      extraction([
        {
          kind: 'canon',
          subject: '钥匙',
          predicate: 'location',
          value: '工坊',
          text: '真实位置',
          evidence: reference,
          knownBy: [],
        },
        {
          kind: 'canon',
          subject: '钥匙',
          predicate: 'location',
          value: '仓库',
          text: '错误位置',
          evidence: reference,
          knownBy: [],
        },
        {
          kind: 'canon',
          subject: '钥匙',
          predicate: 'material',
          value: '铜',
          text: '没有gold匹配',
          evidence: reference,
          knownBy: [],
        },
      ]),
    );
  expect(result.counts).toEqual({ tp: 1, fp: 1, unjudged: 1, expected: 2, matched: 1 });
  const metrics = aggregateExtractionQuality([{ score: result }]);
  expect(metrics.facts).toMatchObject({
    judgedPrecision: 0.5,
    precision: null,
    precisionLowerBound: 1 / 3,
    precisionUpperBound: 2 / 3,
    recall: 0.5,
  });
  expect(metrics.factPrecision95Gate).toBe(false);
});
it('treats wrong explicit knowledge, imagined capabilities and unknown success as failures', () => {
  const secret = scoreExtractionQuality(
    extractionQualityCases[0]!,
    extraction([
      {
        kind: 'canon',
        subject: '钥匙',
        predicate: 'location',
        value: '仓库',
        text: '钥匙在仓库',
        knownBy: ['actor-b'],
        evidence: reference,
      },
    ]),
  );
  expect(secret.counts.fp).toBe(1);
  const plan = scoreExtractionQuality(
    extractionQualityCases[5]!,
    extraction(
      [],
      [
        {
          actorId: 'actor-a',
          capability: '开锁',
          conditions: {},
          steps: ['转动钥匙'],
          outcome: 'success',
          evidence: reference,
        },
      ],
      [{ actorId: 'actor-a', name: '开锁', level: '初级', evidence: reference }],
    ),
  );
  expect(plan.counts.fp).toBe(2);
  const missing = scoreExtractionQuality(extractionQualityCases[0]!, null);
  expect(missing.counts).toMatchObject({ tp: 0, expected: 1, matched: 0 });
  expect(
    aggregateExtractionQuality([{ score: missing, error: { code: 'EXTRACTION_INVALID' } }]),
  ).toMatchObject({ failedCases: 1, facts: { precision: null, recall: 0 } });
});
it('records real analyzer attempts, raw responses and provider usage while repairing an invalid response', async () => {
  const fixture = extractionQualityCases[0]!,
    good = extraction([
      {
        kind: 'canon',
        subject: '钥匙',
        predicate: 'location',
        value: '仓库',
        text: '钥匙在仓库',
        knownBy: [],
        evidence: [{ source: 'assistant', quote: fixture.assistant }],
      },
    ]),
    run = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: 'not json' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      });
  const env = { AI: { run }, AI_GATEWAY_ID: 'test-only' } as unknown as Env,
    events: unknown[] = [],
    usage: unknown[] = [];
  const result = await analyze(
    env,
    extractionQualityContext(fixture, defaults('gateway'), 'test-owner'),
    { mode: fixture.mode, text: fixture.user },
    fixture.assistant,
    {
      onAttempt: (event) => events.push(event),
      onUsage: (value, attempt) => usage.push({ attempt, ...value }),
    },
  );
  expect(result).toEqual(good);
  expect(run).toHaveBeenCalledTimes(2);
  expect(events).toContainEqual({ attempt: 1, phase: 'response', rawOutput: 'not json' });
  expect(events).toContainEqual({ attempt: 1, phase: 'invalid', errorCode: 'VALIDATION' });
  expect(usage).toEqual([
    { attempt: 1, prompt_tokens: 10, completion_tokens: 2 },
    { attempt: 2, prompt_tokens: 20, completion_tokens: 8 },
  ]);
});
it('quality router rejects a normal cloud user and keeps run identity isolated', async () => {
  const app = new Hono<AppEnv>();
  app.onError(
    (error) => new Response(null, { status: error instanceof ApiError ? error.status : 500 }),
  );
  app.use('*', async (c, next) => {
    c.set('ownerId', 'regular-user');
    await next();
  });
  app.route('/', qualityEvaluationRouter);
  const response = await app.request('/manifest', {}, { AUTH_MODE: 'access' } as Env);
  expect(response.status).toBe(403);
  expect(await qualityOwner('owner-a', 'same-run')).not.toBe(
    await qualityOwner('owner-b', 'same-run'),
  );
});
it('opaque Vectorize matches are mapped through full-scope manifest and D1 source permissions', async () => {
  const db = createTestD1(),
    store = new EvaluationStore(db.db, 'quality-unit-owner');
  try {
    const world = await store.createWorld(),
      story = await store.createStory({ worldId: world.id }),
      foreign = await store.createStory({ worldId: world.id }),
      session = await store.createSession({ branchId: story.branchId }),
      a = 'actor-a',
      b = 'actor-b';
    const turn = await store.appendTurn({
      branchId: story.branchId,
      sessionId: session.id,
      requestId: 'quality-unit-source',
      messages: [{ role: 'assistant', text: '只有甲知道私人暗门口令是青鸦。', knownBy: [a] }],
    });
    const event = turn.events[0]!;
    await store.grantKnowledge({
      branchId: story.branchId,
      sourceId: event.sourceId,
      characterId: a,
      start: 0,
      end: Array.from(event.text).length,
      quote: event.text,
      channel: 'witnessed',
    });
    const memory = await store.propose(story.branchId, {
      kind: 'canon',
      subject: '私人暗门',
      predicate: '口令',
      value: '青鸦',
      text: event.text,
      evidence: [
        {
          sourceId: event.sourceId,
          start: 0,
          end: Array.from(event.text).length,
          quote: event.text,
        },
      ],
      knownBy: [a],
    });
    const scope = await scopeKey(store.ownerId, story.branchId, b);
    await store.run(
      'INSERT INTO vector_manifest(vector_id,owner_id,branch_id,memory_id,viewer,scope,created_at) VALUES(?,?,?,?,?,?,?)',
      'opaque-stale-private',
      store.ownerId,
      story.branchId,
      memory.id,
      b,
      scope,
      new Date().toISOString(),
    );
    await store.run(
      'INSERT INTO vector_manifest(vector_id,owner_id,branch_id,memory_id,viewer,scope,created_at) VALUES(?,?,?,?,?,?,?)',
      'opaque-wrong-scope',
      store.ownerId,
      story.branchId,
      memory.id,
      b,
      'wrong-scope',
      new Date().toISOString(),
    );
    const env = {
      AI: { run: async () => ({ data: [Array(1024).fill(0.1)] }) },
      VECTORS: {
        query: async () => ({
          matches: [
            { id: 'opaque-stale-private', score: 1 },
            { id: 'opaque-wrong-scope', score: 0.9 },
          ],
        }),
      },
    } as unknown as Env;
    const result = await queryQualityVector(
      env,
      store,
      {
        branchId: story.branchId,
        sessionId: session.id,
        actorA: a,
        actorB: b,
        foreignBranchId: foreign.branchId,
        seeded: 20,
        secretMemoryId: memory.id,
      },
      'unit-run',
      'secret-other',
    );
    expect(result.rawVectorMatches).toMatchObject([{ memoryId: memory.id }, { memoryId: null }]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    expect(result.negativePass).toBe(true);
    expect(result.forbiddenResults).toEqual([]);
  } finally {
    db.close();
  }
});
it('default CLI performs no requests; unobserved stale vectors remain unmeasured', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch'),
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await main([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.parse(String(stdout.mock.calls[0]![0]))).toMatchObject({
    extractionCases: 20,
    positiveVectorQuestions: 20,
    worstModelCalls: 60,
    realModelRun: false,
  });
  const summary = aggregateVectorQuality([
    { id: 'erased', negativePass: null, forbiddenResults: [], staleDeletedVectorObserved: false },
  ]);
  expect(summary).toMatchObject({
    recallAt10: null,
    negativeMeasured: 0,
    negativePassed: 0,
    staleDeletedVectorObserved: false,
    vectorRecall90Gate: null,
  });
});

it.each([
  { code: 'MODEL_HTTP', status: 'transport-failed', usage: [] },
  { code: 'OUTPUT_TRUNCATED', status: 'failed', usage: [{ completion_tokens: 4096 }] },
])('stops without a verifiable response, preserving $code as $status', async (failure) => {
  const directory = await mkdtemp(join(tmpdir(), 'lightrp-quality-cli-')),
    output = join(directory, 'report.json'),
    exitCode = process.exitCode;
  vi.stubEnv('API_AUTH_HEADERS_FILE', '');
  vi.stubEnv('LRP_BASE_URL', 'https://quality.test');
  const fixture = extractionQualityCases[0]!,
    fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/manifest'))
        return Response.json({
          extractionCases: extractionQualityCases,
          vectorFacts: vectorQualityFacts,
        });
      if (url.endsWith('/settings')) return Response.json(defaults('gateway'));
      if (url.endsWith('/extraction'))
        return Response.json({
          id: fixture.id,
          error: { code: failure.code, status: 502 },
          modelCalls: 1,
          usage: failure.usage,
          rawModelAttempts: [
            { attempt: 1, phase: 'start' },
            { attempt: 1, phase: 'invalid', errorCode: failure.code },
          ],
          score: scoreExtractionQuality(fixture, null),
        });
      throw new Error('Unexpected additional request');
    });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await main(['--run', '--extraction-only', '--output', output]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const report = JSON.parse(await readFile(output, 'utf8'));
    expect(report).toMatchObject({
      status: failure.status,
      modelCalls: 1,
      returnedModelResponses: 0,
      reportedUsageEntries: failure.usage.length,
      measured: { extraction: null },
      transportAudit: {
        attemptedCases: 1,
        measuredCases: 0,
        noResponseCases: failure.usage.length ? [] : [fixture.id],
        unusableResponseCases: failure.usage.length ? [fixture.id] : [],
      },
    });
    expect(report.extractionResults).toHaveLength(1);
    expect(report.error).toContain('未返回可验证正文');
  } finally {
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it('builds a complete real-SQLite isolated vector corpus and rejects a deliberately stale indexed source', async () => {
  const db = createTestD1(),
    objects = new Map<string, string>(),
    vectors = new Map<string, any>();
  let forcedMatches: any[] = [];
  const env = {
    DB: db.db,
    AUTH_MODE: 'local',
    AI: {
      run: async (_model: unknown, input: { text: string[] }) => ({
        data: input.text.map(() => Array(1024).fill(0.1)),
      }),
    },
    BUCKET: {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
      get: async (key: string) =>
        objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
    },
    VECTORS: {
      upsert: async (rows: any[]) => {
        rows.forEach((row) => vectors.set(row.id, row));
        return { mutationId: 'unit-test' };
      },
      deleteByIds: vi.fn(),
      query: async (_vector: number[], options: { returnMetadata: unknown }) => {
        // Real Vectorize V2 rejects the legacy boolean metadata option.
        if (options.returnMetadata !== 'none') throw new TypeError('Vectorize V2 metadata enum');
        return { matches: forcedMatches };
      },
    },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.onError(
    (error) =>
      new Response(JSON.stringify({ code: error instanceof ApiError ? error.code : 'INTERNAL' }), {
        status: error instanceof ApiError ? error.status : 500,
      }),
  );
  app.use('*', async (c, next) => {
    c.set('ownerId', 'service:unit-quality');
    await next();
  });
  app.route('/', qualityEvaluationRouter);
  const runId = crypto.randomUUID(),
    call = async (path: string, data: unknown) => {
      const response = await app.request(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
        env,
      );
      expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(400);
      return response.json() as Promise<any>;
    };
  try {
    const state = await call('/vector/setup', { runId });
    for (let from = 0; from < 20; from += 4)
      await call('/vector/seed', { runId, from, to: from + 3 });
    await call('/vector/extras', { runId });
    const indexed = await call('/vector/index', { runId, maxEmbeddingCalls: 10 });
    expect(indexed.embeddingCalls).toBe(2);
    expect(indexed.vectors).toHaveLength(89);
    expect(await call('/vector/setup', { runId })).toMatchObject({
      branchId: state.branchId,
      seeded: 20,
      secretMemoryId: `${runId}:quality:secret`,
      erasedMemoryId: `${runId}:quality:erase`,
    });
    expect([...vectors.keys()].every((id) => /^[a-f0-9]{64}$/.test(id))).toBe(true);
    const owner = await qualityOwner('service:unit-quality', runId),
      store = new EvaluationStore(db.db, owner),
      foreign = new EvaluationStore(db.db, await qualityOwner('different-user', runId));
    await expect(foreign.getBranch(state.branchId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const erased = await store.one<{ vector_id: string }>(
      "SELECT vector_id FROM vector_manifest WHERE owner_id=? AND memory_id=? AND viewer='director'",
      owner,
      `${runId}:quality:erase`,
    );
    expect(erased).toBeTruthy();
    await call('/vector/invalidate', { runId });
    forcedMatches = [{ id: erased!.vector_id, score: 1 }];
    const result = await call('/vector/query', { runId, id: 'erased' });
    expect(result).toMatchObject({
      accepted: [],
      negativePass: true,
      staleDeletedVectorObserved: true,
    });
    expect(env.VECTORS.deleteByIds).not.toHaveBeenCalled();
    expect(
      (
        await store.one<{ pending: number }>(
          "SELECT count(*) AS pending FROM outbox WHERE owner_id=? AND status='pending'",
          owner,
        )
      )?.pending,
    ).toBe(0);
  } finally {
    db.close();
  }
});
