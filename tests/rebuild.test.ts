import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { defaults } from '../src/server/settings';
import { extractionSchema, type Extraction } from '../src/server/extraction';
import { normalizeCharacter } from '../src/shared/assets';
import type { Env } from '../src/server/env';
import type { Event, TurnMessage } from '../src/shared/domain';

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
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
import { MemoryWorkflow } from '../src/server/workflows';

let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  sessionId: string,
  env: Env,
  objects: Map<string, string>,
  reads: string[];
const characterId = 'card-a';
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'rebuild-owner');
  const world = await store.createWorld('分页与分支');
  const at = new Date().toISOString(),
    raw = { name: '小明' },
    data = JSON.stringify(normalizeCharacter(raw));
  await store.run(
    'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
    characterId,
    store.ownerId,
    'character',
    '小明',
    JSON.stringify(raw),
    data,
    at,
    at,
  );
  await store.run(
    'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
    'card-revision',
    characterId,
    JSON.stringify(raw),
    data,
    at,
  );
  const story = await store.createStory({ worldId: world.id, characterIds: [characterId] });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  objects = new Map();
  reads = [];
  const bucket = {
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
    get: async (key: string) => {
      reads.push(key);
      return objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null;
    },
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    }),
  };
  env = {
    DB: database.db,
    BUCKET: bucket,
    MODEL_MODE: 'local-demo',
    VECTORS: { deleteByIds: async () => ({}) },
  } as unknown as Env;
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});
const artifactKey = (taskId: string) =>
  `tasks/${encodeURIComponent('rebuild-owner')}/${taskId}/1/extraction.json`;
function extraction(text: string, extra: Record<string, unknown> = {}): Extraction {
  return extractionSchema.parse({
    scene: {},
    facts: [
      {
        kind: 'canon',
        subject: 'world',
        predicate: 'state',
        value: text,
        text,
        evidence: [{ source: 'assistant', quote: text }],
        knownBy: [characterId],
      },
    ],
    ...extra,
  });
}
async function cachedTurn(
  taskId: string,
  text: string,
  parsed = extraction(text),
  target = branchId,
  session = sessionId,
  messages?: TurnMessage[],
) {
  const at = new Date().toISOString(),
    head = (await store.getBranch(target)).headSeq,
    input = { mode: 'roleplay', text: `继续 ${taskId}` };
  await store.run(
    "INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,?,?)",
    taskId,
    store.ownerId,
    target,
    session,
    taskId,
    head,
    JSON.stringify(input),
    JSON.stringify(defaults('local-demo')),
    at,
    at,
  );
  const result = await store.appendTurn({
    branchId: target,
    sessionId: session,
    requestId: taskId,
    expectedHead: head,
    taskFence: { taskId, attempt: 1, cancelEpoch: 0 },
    messages: messages ?? [
      { role: 'user', text: input.text },
      { role: 'assistant', text },
    ],
  });
  objects.set(artifactKey(taskId), JSON.stringify({ input, extraction: parsed }));
  const outbox = await store.one<{ id: string }>(
    "SELECT id FROM outbox WHERE branch_id=? AND json_extract(payload_json,'$.taskId')=?",
    target,
    taskId,
  );
  return { ...result, outboxId: outbox!.id };
}
function durableStep(hook?: (name: string) => Promise<void>) {
  const completed = new Map<string, unknown>(),
    names: string[] = [];
  return {
    names,
    completed,
    step: {
      do: async (name: string, options: unknown, callback?: () => Promise<unknown>) => {
        if (completed.has(name)) return completed.get(name);
        if (hook) await hook(name);
        const result = await (
          typeof options === 'function' ? (options as () => Promise<unknown>) : callback!
        )();
        completed.set(name, result);
        names.push(name);
        return result;
      },
    },
  };
}
async function runMemory(outboxId: string, target = branchId, steps = durableStep()) {
  const workflow = new MemoryWorkflow({} as ExecutionContext, env);
  await workflow.run(
    { payload: { ownerId: store.ownerId, branchId: target, outboxId } } as never,
    steps.step as never,
  );
  return steps;
}
async function rebuildJob(target: string) {
  const rows = await store.all<{ id: string; payload_json: string }>(
    "SELECT id,payload_json FROM outbox WHERE branch_id=? AND kind='memory'",
    target,
  );
  return rows.find((row) => JSON.parse(row.payload_json).rebuild)!.id;
}

describe('real D1 branch replay with durable step and R2 boundaries', () => {
  it('compression-only backfill refreshes a closed factual gap without reextracting or appending plot', async () => {
    const original = await cachedTurn('compression-only', '北门已开放。');
    await runMemory(original.outboxId);
    const before = await store.all('SELECT id FROM memory_versions WHERE kind<>?', 'observation');
    await store.run(
      'UPDATE memory_cursors SET applied_seq=0 WHERE branch_id=? AND extractor_version=?',
      branchId,
      'v3-facts',
    );
    const id = 'compression-only',
      at = new Date().toISOString();
    await store.run(
      'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
      id,
      store.ownerId,
      branchId,
      'memory',
      JSON.stringify({ compressOnly: true, throughSeq: 2, ownerEpoch: await store.ownerEpoch() }),
      at,
      at,
    );
    await runMemory(id);
    expect(
      await store.one(
        'SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version=?',
        branchId,
        'v3-facts',
      ),
    ).toEqual({ applied_seq: 2 });
    expect(await store.getEvents(branchId)).toHaveLength(2);
    expect(await store.all('SELECT id FROM memory_versions WHERE kind<>?', 'observation')).toEqual(
      before,
    );
    expect(await store.one('SELECT status FROM outbox WHERE id=?', id)).toEqual({
      status: 'completed',
    });
  });
  it('applies an oversized imported opening before requiring the semantic compression model', async () => {
    const text = '开篇。'.repeat(8000) + '信使终于抵达。';
    const imported = await store.appendTurn({
      branchId,
      sessionId,
      requestId: 'long-opening',
      messages: [{ role: 'assistant', text }],
    });
    const job = await store.one<{ id: string }>(
      "SELECT id FROM outbox WHERE branch_id=? AND kind='memory'",
      branchId,
    );
    await expect(runMemory(job!.id)).rejects.toThrow('OBSERVATION_MODEL_REQUIRED');
    expect((await store.getEvents(branchId))[0]!.text).toBe(text);
    expect(
      await store.one(
        'SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version=?',
        branchId,
        'v3-facts',
      ),
    ).toEqual({ applied_seq: 1 });
    expect(
      await store.one(
        'SELECT COUNT(*) AS n FROM memory_event_applications WHERE branch_id=? AND event_id=?',
        branchId,
        imported.events[0]!.id,
      ),
    ).toEqual({ n: 1 });
  });
  it('reuses the original validated extraction without importing a future parent fact or knowledge grant', async () => {
    const prefix = '小明知道白钥匙在北门。',
      future = '未来秘密红钥匙在南门。',
      first = await cachedTurn('prefix', prefix);
    await runMemory(first.outboxId);
    const later = await cachedTurn('future', future);
    await runMemory(later.outboxId);
    const child = await store.fork({ branchId, atSeq: 2 }),
      outboxId = await rebuildJob(child.id);
    reads.length = 0;
    const steps = await runMemory(outboxId, child.id);
    const records = await store.memories(child.id, { includeInactive: true }),
      role = await store.memories(child.id, { viewer: characterId });
    expect(JSON.stringify(records)).toContain(prefix);
    expect(JSON.stringify(records)).not.toContain(future);
    expect(JSON.stringify(role)).not.toContain(future);
    expect(reads).toContain(artifactKey('prefix'));
    expect(reads).not.toContain(artifactKey('future'));
    expect(steps.names).toContain('replay 1-2');
    expect((await store.recall(child.id, '白钥匙')).cursor).toBe(2);
    expect(await store.one('SELECT status FROM outbox WHERE id=?', outboxId)).toEqual({
      status: 'completed',
    });
    const before = await store.one<{ n: number }>(
      'SELECT count(*) AS n FROM memory_versions WHERE branch_id=?',
      child.id,
    );
    await runMemory(outboxId, child.id, steps);
    expect(
      await store.one('SELECT count(*) AS n FROM memory_versions WHERE branch_id=?', child.id),
    ).toEqual(before);
  });
  it('retains only one independent success when the fork precedes the second parent execution', async () => {
    const ability = '小明完成学习，掌握铁丝解锁能力。',
      one = '小明第一次插入铁丝并转动锁芯，开锁成功。',
      two = '小明第二次用相同条件打开另一把锁。',
      method = {
        actorId: characterId,
        capability: '解锁',
        conditions: { tool: '铁丝' },
        steps: ['插入铁丝', '转动锁芯'],
        outcome: 'success',
      };
    const acquired = await cachedTurn(
      'ability',
      ability,
      extraction(ability, {
        facts: [],
        capabilities: [
          {
            actorId: characterId,
            name: '解锁',
            level: '初级',
            evidence: [{ source: 'assistant', quote: ability }],
            knowledge: [
              { actorId: characterId, source: 'assistant', channel: 'witnessed', quote: ability },
            ],
          },
        ],
      }),
    );
    await runMemory(acquired.outboxId);
    const first = await cachedTurn(
      'success-one',
      one,
      extraction(one, {
        facts: [],
        experiences: [
          {
            ...method,
            evidence: [{ source: 'assistant', quote: one }],
            knowledge: [
              { actorId: characterId, source: 'assistant', channel: 'witnessed', quote: one },
            ],
          },
        ],
      }),
    );
    await runMemory(first.outboxId);
    const second = await cachedTurn(
      'success-two',
      two,
      extraction(two, {
        facts: [],
        experiences: [
          {
            ...method,
            evidence: [{ source: 'assistant', quote: two }],
            knowledge: [
              { actorId: characterId, source: 'assistant', channel: 'witnessed', quote: two },
            ],
          },
        ],
      }),
    );
    await runMemory(second.outboxId);
    expect((await store.memories(branchId, { kinds: ['procedure'] }))[0].status).toBe('active');
    const child = await store.fork({ branchId, atSeq: 4 });
    await runMemory(await rebuildJob(child.id), child.id);
    const skills = await store.memories(child.id, { kinds: ['procedure'], includeInactive: true });
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ status: 'draft', data: { successes: 1 } });
    expect(JSON.stringify(skills)).not.toContain(two);
    expect(await store.memories(child.id, { kinds: ['experience'] })).toHaveLength(1);
    expect((await store.listCapabilities(child.id))[0].status).toBe('available');
    expect(
      await store.memories(child.id, {
        viewer: characterId,
        kinds: ['procedure'],
        includeInactive: true,
      }),
    ).toHaveLength(1);
  });
  it('resolves an early name using its historical prefix before a later higher-priority alias exists', async () => {
    const earlier = '白钥匙此时完好。',
      later = '黑钥匙后来又名白钥匙。',
      first = await cachedTurn(
        'entity-first',
        earlier,
        extraction(earlier, {
          facts: [
            {
              kind: 'canon',
              subject: '白钥匙',
              predicate: 'state',
              value: '完好',
              text: earlier,
              evidence: [{ source: 'assistant', quote: earlier }],
              knownBy: [characterId],
            },
          ],
        }),
      );
    await runMemory(first.outboxId);
    const identity = (await store.memories(branchId, { kinds: ['canon'] })).find(
      (m) => m.text === earlier,
    )!.subject;
    const second = await cachedTurn(
      'entity-future-alias',
      later,
      extraction(later, {
        facts: [
          {
            kind: 'canon',
            subject: '黑钥匙',
            predicate: 'alias',
            value: '白钥匙',
            text: later,
            evidence: [{ source: 'assistant', quote: later }],
            knownBy: [characterId],
          },
        ],
      }),
    );
    await runMemory(second.outboxId);
    const black = (await store.memories(branchId, { kinds: ['canon'] })).find(
      (m) => m.text === later,
    )!.subject;
    expect(black).not.toBe(identity);
    const child = await store.fork({ branchId, atSeq: 4 });
    await runMemory(await rebuildJob(child.id), child.id);
    const replayed = (await store.memories(child.id, { kinds: ['canon'] })).filter(
      (m) => m.text === earlier,
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0].subject).toBe(identity);
    expect(replayed[0].sourceIds).toContain(first.events[1].sourceId);
    expect(replayed[0].subject).not.toBe(black);
  });
  it('clamps an ancestral turn at its fork point before replaying a newer child turn', async () => {
    const visible = '第一段白钥匙被拿起。',
      discarded = '截掉的未来密室信息。',
      original = await cachedTurn(
        'split-turn',
        visible,
        extraction(discarded),
        branchId,
        sessionId,
        [
          { role: 'user', text: '继续' },
          { role: 'assistant', text: visible },
          { role: 'assistant', text: discarded },
          { role: 'assistant', text: '另一个被截掉的未来结果。' },
        ],
      );
    const child = await store.fork({ branchId, atSeq: 2 }),
      childSession = await store.createSession({ branchId: child.id }),
      current = '子分支自己的选择结果。';
    await cachedTurn('child-turn', current, extraction(current), child.id, childSession.id);
    const jobId = await rebuildJob(child.id),
      payload = JSON.parse(
        (await store.one<{ payload_json: string }>(
          'SELECT payload_json FROM outbox WHERE id=?',
          jobId,
        ))!.payload_json,
      );
    await store.run(
      'UPDATE outbox SET payload_json=? WHERE id=?',
      JSON.stringify({ ...payload, throughSeq: 4 }),
      jobId,
    );
    reads.length = 0;
    const steps = await runMemory(jobId, child.id);
    expect(steps.names).toContain('replay 1-2');
    expect(steps.names).toContain('replay 3-4');
    expect(reads).not.toContain(artifactKey('split-turn'));
    expect(JSON.stringify(await store.memories(child.id, { includeInactive: true }))).not.toContain(
      discarded,
    );
    expect((await store.getBranch(child.id)).headSeq).toBe(4);
    expect((await store.getEvents(child.id)).map((e) => e.id)).not.toContain(original.events[2].id);
  });
  it('stops replay after a source deletion changes the captured epoch and never restores its fact', async () => {
    const secret = '必须彻底删除的北门秘密。',
      first = await cachedTurn('delete-one', secret),
      later = await cachedTurn('delete-two', '后续合法事件。'),
      child = await store.fork({ branchId, atSeq: 4 }),
      jobId = await rebuildJob(child.id);
    let deleted = false;
    const steps = durableStep(async (name) => {
      if (!deleted && name === 'replay 3-4') {
        deleted = true;
        await store.deleteSource(first.events[1].sourceId);
      }
    });
    await expect(runMemory(jobId, child.id, steps)).rejects.toThrow('来源已变化');
    expect(deleted).toBe(true);
    expect(await store.memories(child.id)).toHaveLength(0);
    expect(
      JSON.stringify(await store.all('SELECT text,value_json,data_json FROM memory_versions')),
    ).not.toContain(secret);
    expect(await store.one('SELECT status FROM outbox WHERE id=?', jobId)).toEqual({
      status: 'failed',
    });
    expect(steps.names).not.toContain('rebuild observations');
    expect(later.events[1].seq).toBe(4);
  });
  it(
    'replays both event pages past 1000 sources and advances only the contiguous extraction cursor',
    async () => {
      for (let round = 0; round < 501; round++)
        await store.appendTurn({
          branchId,
          sessionId,
          requestId: `page-${round}`,
          messages: [
            { role: 'user', text: `请求 ${round}` },
            { role: 'assistant', text: `第 ${round} 次独立剧情结果。` },
          ],
        });
      const child = await store.fork({ branchId, atSeq: 1002 }),
        jobId = await rebuildJob(child.id),
        spy = vi.spyOn(Store.prototype, 'getEvents'),
        steps = durableStep();
      // A demo without a language model cannot honestly compress arbitrary
      // history. Replay still commits every valid source before this boundary.
      await expect(runMemory(jobId, child.id, steps)).rejects.toThrow('OBSERVATION_MODEL_REQUIRED');
      expect(steps.names.filter((name) => name.startsWith('replay '))).toHaveLength(501);
      expect(
        spy.mock.calls.some(
          ([target, options]) =>
            target === child.id && options?.limit === 1000 && options.afterSeq === 1000,
        ),
      ).toBe(true);
      expect(
        await store.one(
          'SELECT count(*) AS n FROM memory_event_applications WHERE branch_id=? AND extractor_version=?',
          child.id,
          `v3-rebuild:${jobId}`,
        ),
      ).toEqual({ n: 1002 });
      expect(
        await store.one(
          'SELECT count(*) AS n FROM memory_versions WHERE branch_id=? AND kind=?',
          child.id,
          'episode',
        ),
      ).toEqual({ n: 501 });
      expect((await store.recall(child.id, '500 次')).cursor).toBe(1002);
      expect(await store.one('SELECT status FROM outbox WHERE id=?', jobId)).toEqual({
        status: 'failed',
      });
      expect(
        JSON.stringify(await store.memories(child.id, { kinds: ['episode'], limit: 1000 })),
      ).toContain('第 500 次独立剧情结果。');
      // Shared CI runners may need longer for 501 durable SQLite replay steps.
    },
    process.env.CI === 'true' ? 90000 : 30000,
  );
  it('rebuilds a scrubbed current fact from surviving independent evidence despite its old extraction application', async () => {
    const secret = '删除来源自己的私密背景。',
      blue = '北门钥匙确实是蓝色。';
    const original = await cachedTurn(
      'source-to-delete',
      secret,
      extraction(secret, { facts: [] }),
    );
    await runMemory(original.outboxId);
    const independent = await cachedTurn('surviving-source', blue);
    await runMemory(independent.outboxId);
    const active = (await store.memories(branchId, { kinds: ['canon'] }))[0],
      proof = (e: Event) => ({
        sourceId: e.sourceId,
        start: 0,
        end: Array.from(e.text).length,
        quote: e.text,
      });
    const combined = await store.propose(branchId, {
      kind: 'canon',
      subject: active.subject,
      predicate: active.predicate,
      value: active.value,
      text: blue,
      evidence: [proof(original.events[1]), proof(independent.events[1])],
      knownBy: [characterId],
    });
    expect(combined.sourceIds).toHaveLength(2);
    await store.deleteSource(original.events[1].sourceId);
    expect(await store.memories(branchId, { kinds: ['canon'] })).toHaveLength(0);
    const jobId = 'rebuild-independent-survivor',
      at = new Date().toISOString(),
      payload = { rebuild: true, throughSeq: 4, ownerEpoch: await store.ownerEpoch() };
    await store.run(
      'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      jobId,
      store.ownerId,
      branchId,
      'memory',
      JSON.stringify(payload),
      'dispatched',
      at,
      at,
    );
    await runMemory(jobId);
    const restored = await store.memories(branchId, { kinds: ['canon'] });
    expect(restored).toHaveLength(1);
    expect(restored[0].text).toBe(blue);
    expect(restored[0].sourceIds).toEqual([independent.events[1].sourceId]);
    expect(restored[0].id).not.toBe(active.id);
    expect(
      await store.one(
        'SELECT count(*) AS n FROM memory_event_applications WHERE branch_id=? AND event_id=? AND extractor_version=?',
        branchId,
        independent.events[1].id,
        `v3-rebuild:${jobId}`,
      ),
    ).toEqual({ n: 1 });
    const count = await store.one(
      'SELECT count(*) AS n FROM memory_versions WHERE branch_id=?',
      branchId,
    );
    await runMemory(jobId);
    expect(
      await store.one('SELECT count(*) AS n FROM memory_versions WHERE branch_id=?', branchId),
    ).toEqual(count);
    expect(
      JSON.stringify(await store.all('SELECT text,value_json,data_json FROM memory_versions')),
    ).not.toContain(secret);
  });
  it('does not resurrect explicitly forgotten evidence under a new rebuild job identity', async () => {
    const text = '作者明确遗忘这条旧口令。',
      turn = await cachedTurn('forget-before-rebuild', text);
    await runMemory(turn.outboxId);
    const fact = (await store.memories(branchId, { kinds: ['canon'] }))[0];
    await store.forget(branchId, fact.id);
    const jobId = 'rebuild-fresh-identity-after-forget',
      at = new Date().toISOString();
    await store.run(
      'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      jobId,
      store.ownerId,
      branchId,
      'memory',
      JSON.stringify({ rebuild: true, throughSeq: 2, ownerEpoch: await store.ownerEpoch() }),
      'dispatched',
      at,
      at,
    );
    await runMemory(jobId);
    expect(await store.memories(branchId, { kinds: ['canon'] })).toHaveLength(0);
    expect(await store.getRecallEvents(branchId)).not.toContainEqual(
      expect.objectContaining({ sourceId: turn.events[1].sourceId }),
    );
    expect(await store.one('SELECT status FROM outbox WHERE id=?', jobId)).toEqual({
      status: 'completed',
    });
  });
});
