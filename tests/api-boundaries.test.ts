import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store, now } from '../src/server/store';
import type { Env } from '../src/server/env';
import type { QuerySpec } from '../src/shared/domain';
import {
  apiWriteSchemas,
  correctionSchema,
  publicApiSchemas,
  settingsSchema,
} from '../src/shared/api';
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
import { app } from '../src/server/index';
let d: ReturnType<typeof createTestD1>, s: Store, branchId: string, sessionId: string;
const pending: Promise<unknown>[] = [];
beforeEach(async () => {
  d = createTestD1();
  s = new Store(d.db, 'local-owner');
  const world = await s.createWorld(),
    story = await s.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await s.createSession({ branchId })).id;
});
afterEach(async () => {
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  d.close();
});
const env = () => ({ DB: d.db, AUTH_MODE: 'local', MODEL_MODE: 'local-demo' }) as Env;
const context = () =>
  ({
    waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)),
    passThroughOnException: vi.fn(),
  }) as unknown as ExecutionContext;
const request = (path: string, method = 'GET') =>
  app.request(`http://localhost/api/v3${path}`, { method }, env(), context());
async function task(id: string, status: string) {
  const at = now();
  await s.run(
    'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?,?)',
    id,
    s.ownerId,
    branchId,
    sessionId,
    `command-${id}`,
    status,
    '{}',
    '{}',
    at,
    at,
  );
}
const row = (id: string) =>
  s.one<{ status: string; attempt: number }>('SELECT status,attempt FROM tasks WHERE id=?', id);
const generationOutbox = () => s.all("SELECT id FROM outbox WHERE kind='generation'");
describe('decision audit has the same task owner boundary', () => {
  it('reads only this owner and current attempt metadata, with private response caching', async () => {
    await task('decision-task', 'failed');
    const audit = {
      model: '@cf/cloudflare/clef',
      status: 'rejected',
      requestAttempts: 1,
      candidates: [
        {
          path: 'facts.0',
          answers: { supported: { probability: 0.04, verdict: 'rejected' } },
          usage: { input_tokens: 100, output_tokens: 0 },
          latencyMs: 200,
        },
      ],
    };
    const get = vi.fn(async () => ({ json: async () => audit }));
    const response = await app.request(
      'http://localhost/api/v3/tasks/decision-task/decision',
      {},
      { ...env(), BUCKET: { get } } as unknown as Env,
      context(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(audit);
    expect(get).toHaveBeenCalledWith('tasks/local-owner/decision-task/1/decision.json');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects another owner task before reading R2, including guessed task IDs', async () => {
    await task('private-other', 'failed');
    await s.run('UPDATE tasks SET owner_id=? WHERE id=?', 'other-owner', 'private-other');
    const get = vi.fn();
    const response = await app.request(
      'http://localhost/api/v3/tasks/private-other/decision',
      {},
      { ...env(), BUCKET: { get } } as unknown as Env,
      context(),
    );
    expect(response.status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });
});
describe('real API branch paging and generation retry fences', () => {
  it('returns the latest event beyond 2000 and pages backward to the original first event', async () => {
    for (let n = 0; n < 101; n++)
      await s.appendTurn({
        branchId,
        sessionId,
        requestId: `page-turn-${n}`,
        messages: Array.from({ length: n === 100 ? 1 : 20 }, (_, i) => ({
          role: 'assistant',
          text: `剧情 ${20 * n + i + 1}`,
        })),
      });
    const response = await request(`/branches/${branchId}`);
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      branch: { headSeq: number };
      events: { seq: number }[];
      hasEarlierEvents: boolean;
    };
    expect(page.branch.headSeq).toBe(2001);
    expect(page.events).toHaveLength(2000);
    expect(page.events[0]?.seq).toBe(2);
    expect(page.events.at(-1)?.seq).toBe(2001);
    expect(page.hasEarlierEvents).toBe(true);
    const earlierResponse = await request(`/branches/${branchId}?beforeSeq=2`);
    expect(earlierResponse.status).toBe(200);
    const earlier = (await earlierResponse.json()) as {
      events: { seq: number }[];
      hasEarlierEvents: boolean;
    };
    expect(earlier.events.map((e) => e.seq)).toEqual([1]);
    expect(earlier.hasEarlierEvents).toBe(false);
  });
  it('rejects invalid paging bounds instead of exposing a different branch scope', async () => {
    expect((await request(`/branches/${branchId}?beforeSeq=1.5`)).status).toBe(400);
    expect((await request(`/branches/${branchId}?beforeSeq=NaN`)).status).toBe(400);
    expect((await request(`/branches/${branchId}?beforeSeq=0`)).status).toBe(400);
  });
  it('rejects retry of failed A while queued B exists without changing A or adding outbox', async () => {
    await task('failed-a', 'failed');
    await task('queued-b', 'queued');
    const before = await generationOutbox();
    const response = await request('/tasks/failed-a/retry', 'POST');
    expect(response.status).toBe(409);
    expect(await row('failed-a')).toEqual({ status: 'failed', attempt: 1 });
    expect(await row('queued-b')).toEqual({ status: 'queued', attempt: 1 });
    expect(await generationOutbox()).toEqual(before);
    expect((await s.getBranch(branchId)).headSeq).toBe(0);
  });
  it('rolls back retry entirely when a plot commit lands after the API head read', async () => {
    await task('failed-a', 'failed');
    const batch = Store.prototype.batch;
    let injected = false;
    vi.spyOn(Store.prototype, 'batch').mockImplementation(async function (
      this: Store,
      specs: QuerySpec[],
    ) {
      if (!injected && specs.some((q) => q.sql.startsWith("UPDATE tasks SET status='queued'"))) {
        injected = true;
        await s.appendTurn({
          branchId,
          sessionId,
          requestId: 'concurrent-plot',
          messages: [{ role: 'assistant', text: '并发回合已提交。' }],
        });
      }
      return batch.call(this, specs);
    });
    const response = await request('/tasks/failed-a/retry', 'POST');
    expect(response.status).toBe(409);
    expect(injected).toBe(true);
    expect(await row('failed-a')).toEqual({ status: 'failed', attempt: 1 });
    expect(await generationOutbox()).toHaveLength(0);
    expect((await s.getBranch(branchId)).headSeq).toBe(1);
    expect((await s.getEvents(branchId)).map((e) => e.text)).toEqual(['并发回合已提交。']);
  });
  it('rolls back retry when another task queues between API checks and the transaction', async () => {
    await task('failed-a', 'failed');
    const batch = Store.prototype.batch;
    let injected = false;
    vi.spyOn(Store.prototype, 'batch').mockImplementation(async function (
      this: Store,
      specs: QuerySpec[],
    ) {
      if (!injected && specs.some((q) => q.sql.startsWith("UPDATE tasks SET status='queued'"))) {
        injected = true;
        await task('racing-b', 'queued');
      }
      return batch.call(this, specs);
    });
    const response = await request('/tasks/failed-a/retry', 'POST');
    expect(response.status).toBe(409);
    expect(await row('failed-a')).toEqual({ status: 'failed', attempt: 1 });
    expect(await row('racing-b')).toEqual({ status: 'queued', attempt: 1 });
    expect(await generationOutbox()).toHaveLength(0);
  });
});

describe('public v3 write contracts', () => {
  it('exports all write JSON schemas without exposing an owner override', () => {
    const schemas = publicApiSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      'correction',
      'fork',
      'playerProfile',
      'procedureStatus',
      'rebuild',
      'resources',
      'settings',
      'story',
      'turn',
    ]);
    expect(Object.keys(apiWriteSchemas).sort()).toEqual(Object.keys(schemas).sort());
    for (const schema of Object.values(schemas)) expect(schema.type).toBe('object');
    expect(schemas.turn?.required).toEqual(
      expect.arrayContaining(['commandId', 'expectedHead', 'sessionId', 'input']),
    );
    expect(
      correctionSchema.parse({ text: '作者清空属性', value: null, ownerId: 'other-owner' }),
    ).toEqual({ text: '作者清空属性', value: null });
  });
  it('keeps the model window/output relation validated by the shared settings contract', () => {
    expect(settingsSchema.safeParse({ contextWindow: 4096, maxOutput: 4096 }).success).toBe(false);
    expect(settingsSchema.parse({ contextWindow: 8192, maxOutput: 4096 }).maxOutput).toBe(4096);
  });
});

describe('branch player identity API', () => {
  const body = { commandId: 'profile-api-write', expectedHead: 0, profile: { identity: '训练员' } };
  const save = (id: string, data: unknown = body) =>
    app.request(
      `http://localhost/api/v3/branches/${id}/player-profile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      env(),
      context(),
    );
  it('validates bounds and enforces owner scope before writing any identity', async () => {
    const other = new Store(d.db, 'other-owner');
    const world = await other.createWorld();
    const story = await other.createStory({ worldId: world.id });
    await other.createSession({ branchId: story.branchId });
    expect((await save(story.branchId)).status).toBe(404);
    expect((await save(branchId, { ...body, profile: { identity: 'a'.repeat(501) } })).status).toBe(
      400,
    );
    expect(await s.getEvents(branchId)).toHaveLength(0);
    const response = await save(branchId, { ...body, ownerId: 'other-owner' });
    expect(response.status).toBe(200);
    expect((await s.getBranch(branchId)).scene.playerProfile).toMatchObject({
      identity: '训练员',
      agency: 'natural',
    });
    expect((await other.getBranch(story.branchId)).scene.playerProfile).toBeUndefined();
  });
  it('returns 409 for stale versions with no partial identity event', async () => {
    await s.appendTurn({
      branchId,
      sessionId,
      requestId: 'prior-event',
      messages: [{ role: 'assistant', text: '天色渐暗。' }],
    });
    expect((await save(branchId)).status).toBe(409);
    expect(await s.getEvents(branchId)).toHaveLength(1);
    expect((await s.getBranch(branchId)).scene.playerProfile).toBeUndefined();
  });
});
