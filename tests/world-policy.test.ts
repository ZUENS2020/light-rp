import { beforeEach, afterEach, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { setWorldPolicy } from '../src/server/world-policy';
import { buildContext, validationRules } from '../src/server/context';
import { extractionMessages, extractionSchema, validateExtraction } from '../src/server/extraction';
import { FREEFORM_NARRATION } from '../src/shared/world-policy';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';

let db: ReturnType<typeof createTestD1>,
  store: Store,
  worldId: string,
  branchId: string,
  sessionId: string;
beforeEach(async () => {
  db = createTestD1();
  store = new Store(db.db, 'freeform-owner');
  worldId = (await store.createWorld('赛马娘')).id;
  branchId = (await store.createStory({ worldId })).branchId!;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => db.close());
const context = (id = branchId) =>
  buildContext(
    {} as Env,
    store,
    id,
    { mode: 'roleplay', text: '继续' },
    defaults('local-demo'),
    'policy-test',
  );

it('scopes free narration to the workspace including its future stories and branches', async () => {
  const before = await context();
  expect(validationRules(before).length).toBeGreaterThan(0);
  const unrelated = await store.createWorld('别的世界');
  const otherStory = await store.createStory({ worldId: unrelated.id });
  await setWorldPolicy(store, worldId, {
    mode: 'freeform',
    expectedRevision: 0,
    commandId: 'free-mode',
  });
  const free = await context();
  expect(validationRules(free)).toEqual([]);
  expect(free.narrativePolicy).toMatchObject({ mode: 'freeform', revision: 1 });
  expect(free.messages.at(-1)?.content).toBe(FREEFORM_NARRATION);
  expect(
    extractionMessages(free, { mode: 'roleplay', text: '继续' }, '你主动迈步。')[0]?.content,
  ).toContain('不检查内容题材、角色行为、玩家代写');
  expect(validationRules(await context(otherStory.branchId!)).length).toBeGreaterThan(0);
  const child = await store.fork({ branchId, atSeq: 0 });
  expect(validationRules(await context(child.id))).toEqual([]);
  const future = await store.createStory({ worldId });
  expect(validationRules(await context(future.branchId!))).toEqual([]);
  expect((await store.getBranch(branchId)).headSeq).toBe(0);
});

it('waives narrative vetoes while continuing to reject fabricated memory evidence', async () => {
  const parsed = extractionSchema.parse({
    scene: {},
    violations: ['不得替玩家决定动作'],
    facts: [],
  });
  const input = { mode: 'roleplay' as const, text: '继续' };
  const guided = await context();
  expect(() => validateExtraction(parsed, input, '你决定向前走。', guided)).toThrow(
    '剧情与固定规则冲突',
  );
  await setWorldPolicy(store, worldId, {
    mode: 'freeform',
    expectedRevision: 0,
    commandId: 'waive',
  });
  const free = await context();
  expect(() => validateExtraction(parsed, input, '你决定向前走。', free)).not.toThrow();
  const fake = extractionSchema.parse({
    scene: {},
    facts: [
      {
        kind: 'episode',
        subject: 'narrator',
        predicate: 'event',
        value: '秘密',
        text: '假记忆',
        evidence: [{ source: 'assistant', quote: '正文没有的原句' }],
      },
    ],
  });
  expect(() => validateExtraction(fake, input, '你决定向前走。', free)).toThrow();
});

it('preserves frozen policy snapshots and atomically refuses stale in-flight commits', async () => {
  const frozen = await context();
  await setWorldPolicy(store, worldId, {
    mode: 'freeform',
    expectedRevision: 0,
    commandId: 'toggle',
  });
  expect(validationRules(frozen).length).toBeGreaterThan(0);
  await expect(
    store.appendTurn({
      branchId,
      sessionId,
      requestId: 'stale-turn',
      expectedHead: 0,
      worldPolicyFence: { worldId, revision: 0 },
      messages: [{ role: 'assistant', text: '旧规则结果' }],
    }),
  ).rejects.toMatchObject({ code: 'STALE_WRITE' });
  expect(await store.getEvents(branchId)).toHaveLength(0);
  expect(await store.all('SELECT id FROM turns')).toHaveLength(0);
  expect(await store.all('SELECT id FROM sources')).toHaveLength(0);
  await store.appendTurn({
    branchId,
    sessionId,
    requestId: 'current-turn',
    expectedHead: 0,
    worldPolicyFence: { worldId, revision: 1 },
    messages: [{ role: 'assistant', text: '新规则结果' }],
  });
  expect(await store.getEvents(branchId)).toHaveLength(1);
});

it('supports idempotent reversal and rejects other owners or competing versions', async () => {
  const input = { mode: 'freeform' as const, expectedRevision: 0, commandId: 'one-change' };
  await setWorldPolicy(store, worldId, input);
  await setWorldPolicy(store, worldId, input);
  expect(await store.all('SELECT * FROM world_policy_changes')).toHaveLength(1);
  await expect(setWorldPolicy(store, worldId, { ...input, mode: 'guided' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_REUSE',
  });
  await expect(
    setWorldPolicy(store, worldId, { ...input, commandId: 'stale-change' }),
  ).rejects.toMatchObject({ code: 'STALE_WRITE' });
  await expect(
    setWorldPolicy(new Store(db.db, 'other-owner'), worldId, { ...input, commandId: 'foreign' }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await setWorldPolicy(store, worldId, {
    mode: 'guided',
    expectedRevision: 1,
    commandId: 'restore',
  });
  expect(validationRules(await context()).length).toBeGreaterThan(0);
  expect((await store.getWorld(worldId)).policyRevision).toBe(2);
});
