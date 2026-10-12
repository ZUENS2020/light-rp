import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  apiBase,
  evaluationResponseError,
  loadAuthHeaders,
  main,
  summarizeLiveResults,
} from '../scripts/live-evaluate';
import {
  EvaluationStore,
  compactCitations,
  evaluationOutputSchema,
  createEvaluationFixtures,
  evaluationOwner,
  evaluationCase,
  evaluationCallConfig,
  parseEvaluationSummary,
  preparedEvaluation,
  replayEvaluationChunk,
  scoreEvaluationAnswer,
  visibleRawEvents,
} from '../src/server/evaluation';
import { defaults } from '../src/server/settings';
import type { Store } from '../src/server/store';
import { evaluationStories } from './fixtures/evaluation-stories';
it('constrains schema citations to visible source labels and keeps unavailable questions in the denominator', () => {
  const schema = evaluationOutputSchema('summary', ['S1', 'S2']) as any;
  expect(schema.properties.facts.items.properties.sourceIds.items.enum).toEqual(['S1', 'S2']);
  const answer = evaluationOutputSchema('answer', []) as any;
  expect(answer.properties.citations.maxItems).toBe(0);
  const metrics = summarizeLiveResults([{ strategy: 'summary', error: 'invalid citation' }]);
  expect(metrics.summary).toMatchObject({
    attemptedQuestions: 1,
    questions: 0,
    failedRequests: 1,
    strictGoldClaimPassRate: 0,
  });
});
import { createTestD1 } from './d1';
const paths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});
it('accepts only a current-user 0600 nonsymlink authentication file without exposing values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lightrp-auth-test-'));
  paths.push(directory);
  const file = join(directory, 'headers.json');
  await writeFile(
    file,
    JSON.stringify({
      'CF-Access-Client-Id': 'fake-test-client',
      'CF-Access-Client-Secret': 'fake-test-secret',
    }),
    { mode: 0o600 },
  );
  expect(await loadAuthHeaders(file)).toEqual({
    'CF-Access-Client-Id': 'fake-test-client',
    'CF-Access-Client-Secret': 'fake-test-secret',
  });
  await chmod(file, 0o644);
  await expect(loadAuthHeaders(file)).rejects.toThrow('0600');
  await chmod(file, 0o600);
  await symlink(file, join(directory, 'linked.json'));
  await expect(loadAuthHeaders(join(directory, 'linked.json'))).rejects.toThrow('普通文件');
  await writeFile(file, JSON.stringify({ Authorization: 'fake-test-secret\nInjected: value' }));
  await expect(loadAuthHeaders(file)).rejects.toThrow('无效字段');
});
it('rejects insecure remote and embedded credential URLs', () => {
  expect(apiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/api/v3');
  expect(apiBase('https://example.test/api/v3/')).toBe('https://example.test/api/v3');
  expect(() => apiBase('http://example.test')).toThrow('HTTPS');
  expect(() => apiBase('https://client:secret@example.test')).toThrow('凭据');
});
it('defaults to a zero-network zero-model plan and shows the full cost ceiling', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await main(['--full']);
  expect(fetch).not.toHaveBeenCalled();
  const plan = JSON.parse(String(stdout.mock.calls[0]![0]));
  expect(plan).toMatchObject({
    stories: 8,
    authoredGoldQuestions: 128,
    selectedQuestions: 128,
    replayTurns: 520,
    expectedModelCallsWithSummaryReuse: 433,
    worstModelCallsWithoutReuse: 513,
    costUSD: null,
    realModelRun: false,
  });
});
it('scores actual claims, corrections and leakage strictly and leaves unmeasured metrics null', () => {
  const correct = {
    answer: '背面实际刻着四道波纹。',
    facts: ['背面实际刻着四道波纹'],
    unknown: false,
    citations: ['source'],
  };
  expect(
    scoreEvaluationAnswer(correct, ['背面实际刻着四道波纹'], ['背面刻着三道波纹'], null)
      .strictClaimPass,
  ).toBe(true);
  expect(
    scoreEvaluationAnswer(
      { ...correct, answer: '旧版是背面刻着三道波纹' },
      [],
      ['背面刻着三道波纹'],
      true,
    ),
  ).toMatchObject({
    strictClaimPass: false,
    leakedClaims: ['背面刻着三道波纹'],
    unknownPass: false,
  });
  expect(scoreEvaluationAnswer(null, [], ['私人地址'], true, '非JSON却透露私人地址')).toMatchObject(
    { strictClaimPass: false, leakedClaims: ['私人地址'] },
  );
  const noRows = summarizeLiveResults([]);
  expect(noRows.hybrid).toMatchObject({
    strictGoldClaimPassRate: null,
    recallAt5: null,
    leakageRate: null,
    extractionPrecision: null,
    semanticAnswerAccuracy: null,
    actualCostUSD: null,
  });
});
it('keeps actionable HTTP codes without copying secret-bearing error bodies', async () => {
  const failure = await evaluationResponseError(
    '/evaluate/summary',
    Response.json(
      {
        error: { code: 'OUTPUT_TRUNCATED', message: 'upstream Authorization=private-test-secret' },
        apiKey: 'private-test-secret',
      },
      { status: 422 },
    ),
  );
  expect(failure).toMatchObject({
    status: 422,
    code: 'OUTPUT_TRUNCATED',
    path: '/evaluate/summary',
  });
  expect(failure.message).toContain('OUTPUT_TRUNCATED');
  expect(JSON.stringify(failure)).not.toContain('private-test-secret');
  const arbitrary = await evaluationResponseError(
    '/evaluate/summary',
    Response.json(
      { error: { code: 'PRIVATE_TEST_SECRET', message: 'private-test-secret' } },
      { status: 500 },
    ),
  );
  expect(arbitrary.code).toBeNull();
  expect(arbitrary.message).not.toContain('PRIVATE_TEST_SECRET');
  const oversized = await evaluationResponseError(
    '/evaluate/summary',
    Response.json(
      { padding: 'x'.repeat(9000), error: { code: 'OUTPUT_TRUNCATED' } },
      { status: 422 },
    ),
  );
  expect(oversized.code).toBeNull();
});
it('gives summaries the configured output reserve and validates sourced, nonempty JSON', () => {
  const config = defaults('gateway');
  expect(evaluationCallConfig(config, 'summary').maxOutput).toBe(4096);
  expect(
    evaluationCallConfig({ ...config, auxiliaryMaxOutput: 32768 }, 'summary').auxiliaryMaxOutput,
  ).toBe(0);
  expect(evaluationCallConfig(config, 'answer').maxOutput).toBe(2048);
  expect(() => evaluationCallConfig({ ...config, maxOutput: 512 }, 'summary')).toThrow('1024');
  const text = JSON.stringify({
    summary: '作者更正钥匙为蓝色。',
    facts: [{ claim: '钥匙为蓝色', sourceIds: ['s1'] }],
  });
  expect(parseEvaluationSummary(text, 'scope', ['s1', 's2', 's1'])).toMatchObject({
    scope: 'scope',
    sourceIds: ['s1', 's2'],
  });
  expect(() => parseEvaluationSummary('{', 'scope', ['s1'])).toThrow('完整JSON');
  expect(() =>
    parseEvaluationSummary(JSON.stringify({ summary: ' ', facts: [] }), 'scope', ['s1']),
  ).toThrow('非空');
  expect(() =>
    parseEvaluationSummary(
      JSON.stringify({ summary: '内容', facts: [{ claim: '事实', sourceIds: [] }] }),
      'scope',
      ['s1'],
    ),
  ).toThrow('逐条来源');
  expect(() => parseEvaluationSummary(text, 'scope', ['invisible'])).toThrow('不可见');
});
it('rejects a deletion epoch change while assembling visible model input', async () => {
  let checks = 0;
  const store = {
    ownerEpoch: async () => ++checks,
    getRecallEvents: async () => [],
    memories: async () => [],
  } as unknown as Store;
  await expect(visibleRawEvents(store, 'branch', { viewer: 'director' })).rejects.toMatchObject({
    code: 'EVALUATION_STALE',
  });
});
it('labels source references without rewriting original evidence text and keeps canonical IDs for validation', () => {
  const context = {
    recent: [{ sourceId: 'canonical-uuid-1', text: '对白含有 S1 和 canonical-uuid-1，不能修改。' }],
    facts: [{ claim: '蓝钥匙', sourceIds: ['canonical-uuid-2', 'canonical-uuid-1'] }],
  };
  const compact = compactCitations(
    ['canonical-uuid-1', 'canonical-uuid-2', 'canonical-uuid-1'],
    context,
  );
  expect(compact.context).toEqual({
    recent: [{ sourceId: 'S1', text: context.recent[0]!.text }],
    facts: [{ claim: '蓝钥匙', sourceIds: ['S2', 'S1'] }],
  });
  expect(compact.labels.get('S2')).toBe('canonical-uuid-2');
  expect(compact.labels.has('S3')).toBe(false);
  expect(context.recent[0]!.sourceId).toBe('canonical-uuid-1');
});
describe('real synthetic fixture replay', () => {
  it('writes 65 committed turns, real scoped gold memories and skills, without paid outbox jobs', async () => {
    const db = createTestD1();
    try {
      const runId = crypto.randomUUID(),
        owner = await evaluationOwner('local-owner', runId),
        store = new EvaluationStore(db.db, owner);
      const setup = await createEvaluationFixtures(store);
      expect(setup.questions).toBe(128);
      expect(setup.extractionPrecision).toBeNull();
      const fixture = evaluationStories[0]!;
      for (let from = 1; from <= 64; from += 8)
        await replayEvaluationChunk(store, runId, fixture, from, from + 7);
      const state = await preparedEvaluation(store, runId, fixture);
      const raw = await visibleRawEvents(store, state.branchId, { viewer: 'director' });
      expect(
        raw.some(
          (event) => event.text.includes(fixture.forgotten) || event.text.includes(fixture.erased),
        ),
      ).toBe(false);
      const actorRaw = await visibleRawEvents(store, state.branchId, { viewer: fixture.actors[1] });
      expect(
        actorRaw.some(
          (event) => event.text.includes(fixture.secret) || event.text.includes(fixture.belief),
        ),
      ).toBe(false);
      const counts = await store.one<{ turns: number; pending: number }>(
        "SELECT (SELECT count(*) FROM turns WHERE owner_id=?) AS turns,(SELECT count(*) FROM outbox WHERE owner_id=? AND status='pending') AS pending",
        owner,
        owner,
      );
      expect(counts).toEqual({ turns: 65, pending: 0 });
      expect(
        (await store.memories(state.branchId, { kinds: ['procedure'] })).map(
          (memory) => memory.predicate,
        ),
      ).toContain(fixture.skill);
      expect(
        (await store.memories(state.branchId, { kinds: ['procedure'] })).map(
          (memory) => memory.predicate,
        ),
      ).not.toContain('临时修补');
      for (const caseId of [
        'early-fact',
        'span-grant',
        'secret-other',
        'fork-parent-future',
        'erased',
      ]) {
        const test = evaluationCase(state, caseId, runId),
          recalled = await store.recall(test.branchId, test.query, test.options),
          ids = recalled.items.map((item) => item.memory.id);
        expect(ids.filter((id) => test.forbidden.includes(id))).toEqual([]);
        if (test.expected.length) expect(ids.some((id) => test.expected.includes(id))).toBe(true);
      }
      const otherOwner = await evaluationOwner('other-authenticated-user', runId);
      expect(otherOwner).not.toBe(owner);
      await expect(
        new EvaluationStore(db.db, otherOwner).getBranch(state.branchId),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      db.close();
    }
  });
});
