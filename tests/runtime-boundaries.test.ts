import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { buildContext } from '../src/server/context';
import { defaults } from '../src/server/settings';
import { extractionSchema, validateExtraction, evidenceFor } from '../src/server/extraction';
import type { ContextSnapshot } from '../src/server/context';
import type { Env } from '../src/server/env';
import type { Evidence } from '../src/shared/domain';
import { normalizeCharacter } from '../src/shared/assets';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  WorkflowEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
import { BranchRuntime } from '../src/server/runtime';
import { dispatchOutbox, GenerationWorkflow, MemoryWorkflow } from '../src/server/workflows';

const close: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of close.splice(0)) dispose();
});
async function storyFixture() {
  const database = createTestD1();
  close.push(database.close);
  const store = new Store(database.db, 'boundary-owner'),
    world = await store.createWorld({ name: '边界故事' });
  const story = await store.createStory({ worldId: world.id, name: '边界剧情' }),
    session = await store.createSession({ branchId: story.branchId });
  const turn = await store.appendTurn({
    branchId: story.branchId,
    sessionId: session.id,
    requestId: 'initial-turn',
    messages: [{ role: 'assistant', text: '导演秘密：隐藏航线在北礁。' }],
  });
  const event = turn.events[0]!,
    evidence: Evidence = {
      sourceId: event.sourceId,
      start: 0,
      end: Array.from(event.text).length,
      quote: event.text,
    };
  const memory = await store.propose(story.branchId, {
    kind: 'canon',
    subject: '隐藏航线',
    predicate: '位置',
    value: '北礁',
    text: event.text,
    evidence: [evidence],
  });
  await store.extract(story.branchId, {
    eventIds: [event.id],
    proposals: [],
    cursor: event.seq,
    extractorVersion: 'facts',
  });
  await store.run("UPDATE outbox SET status='completed'");
  return { ...database, store, story, session, event, evidence, memory };
}
function fakeBindings(fixture: Awaited<ReturnType<typeof storyFixture>>) {
  const doDatabase = createTestD1({ schema: false });
  close.push(doDatabase.close);
  const kv = new Map<string, unknown>(),
    objects = new Map<string, string>(),
    workflows = new Map<string, unknown>();
  const sql = {
    exec: (query: string, ...params: unknown[]) => {
      const statement = doDatabase.sqlite.prepare(query),
        rows = statement.reader ? statement.all(...params) : (statement.run(...params), []);
      return {
        toArray: () => rows,
        one: () => rows[0],
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
  const ctx = {
    storage: {
      sql,
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      get: async (key: string) => kv.get(key),
    },
  } as unknown as DurableObjectState;
  let onPut: ((key: string) => Promise<void>) | null = null;
  const bucket = {
    put: async (key: string, value: string) => {
      objects.set(key, value);
      if (onPut) await onPut(key);
    },
    get: async (key: string) =>
      objects.has(key)
        ? {
            json: async () => JSON.parse(objects.get(key)!),
            text: async () => objects.get(key)!,
            arrayBuffer: async () => new TextEncoder().encode(objects.get(key)!).buffer,
          }
        : null,
    delete: async (key: string | string[]) => {
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: Array.from(objects.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    }),
  };
  const workflow = {
    createBatch: async (batch: Array<{ id: string; params: unknown }>) => {
      for (const item of batch) {
        if (workflows.has(item.id)) throw new Error('duplicate workflow');
        workflows.set(item.id, item.params);
      }
      return [];
    },
    get: async (id: string) => {
      if (!workflows.has(id)) throw new Error('not found');
      return { status: async () => ({ status: 'running' }) };
    },
  };
  const env = {
    DB: fixture.db,
    BUCKET: bucket,
    GENERATION: workflow,
    MEMORY: workflow,
    MODEL_MODE: 'local-demo',
    VECTORS: { deleteByIds: async () => ({}) },
  } as unknown as Env;
  const runtime = new BranchRuntime(ctx, env),
    stub = {
      fetch: async (input: Request | string | URL, init?: RequestInit) =>
        runtime.fetch(input instanceof Request ? input : new Request(input, init)),
    };
  env.BRANCH_RUNTIME = {
    idFromName: (name: string) => name,
    get: () => stub,
    getByName: () => stub,
  } as unknown as Env['BRANCH_RUNTIME'];
  return {
    env,
    runtime,
    doSqlite: doDatabase.sqlite,
    objects,
    workflows,
    stub,
    setPutHook: (hook: typeof onPut) => {
      onPut = hook;
    },
  };
}
async function taskFixture(fixture: Awaited<ReturnType<typeof storyFixture>>, status = 'queued') {
  const at = new Date().toISOString(),
    taskId = 'boundary-task';
  await fixture.store.run(
    'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,attempt,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)',
    taskId,
    fixture.store.ownerId,
    fixture.story.branchId,
    fixture.session.id,
    'generation-command',
    1,
    status,
    JSON.stringify({ mode: 'roleplay', text: '继续寻找航线' }),
    JSON.stringify(defaults('local-demo')),
    at,
    at,
  );
  await fixture.store.run(
    'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    'generation-outbox',
    fixture.store.ownerId,
    fixture.story.branchId,
    'generation',
    JSON.stringify({ taskId, attempt: 1 }),
    'pending',
    at,
    at,
  );
  return {
    ownerId: fixture.store.ownerId,
    taskId,
    attempt: 1,
    branchId: fixture.story.branchId,
    outboxId: 'generation-outbox',
  };
}
function fakeStep(hook?: (name: string) => Promise<void>) {
  return {
    do: async (name: string, options: unknown, callback?: () => Promise<unknown>) => {
      if (hook) await hook(name);
      const fn = typeof options === 'function' ? (options as () => Promise<unknown>) : callback!;
      return fn();
    },
  };
}

describe('context and evidence fences', () => {
  it('keeps another character example and post-history instructions out of an actor snapshot', async () => {
    const database = createTestD1();
    close.push(database.close);
    const store = new Store(database.db, 'actor-context-owner'),
      world = await store.createWorld('定向认知'),
      at = new Date().toISOString();
    for (const [id, name, example, post] of [
      ['actor-a', '晴岚', '晴岚的说话示例', '晴岚的局部补充'],
      ['actor-b', '阿澈', 'B_SECRET_EXAMPLE', 'B_SECRET_POST'],
    ]) {
      const raw = { name, mes_example: example, post_history_instructions: post },
        data = JSON.stringify(normalizeCharacter(raw));
      await store.run(
        'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
        id,
        store.ownerId,
        'character',
        name,
        JSON.stringify(raw),
        data,
        at,
        at,
      );
      await store.run(
        'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
        `revision-${id}`,
        id,
        JSON.stringify(raw),
        data,
        at,
      );
    }
    const story = await store.createStory({
      worldId: world.id,
      characterIds: ['actor-a', 'actor-b'],
    });
    const context = await buildContext(
      {} as Env,
      store,
      story.branchId,
      { mode: 'roleplay', actorId: 'actor-a', text: '阿澈在做什么？' },
      defaults('local-demo'),
      'actor-context',
      'actor-a',
    );
    expect(JSON.stringify(context.messages)).not.toMatch(/B_SECRET_(EXAMPLE|POST)/);
    expect(context.characters.map((character) => character.id)).toEqual(['actor-a']);
  });
  it('rejects a snapshot when a source is deleted between recall and final fence capture', async () => {
    const fixture = await storyFixture(),
      original = fixture.store.recall.bind(fixture.store);
    let removed = false;
    vi.spyOn(fixture.store, 'recall').mockImplementation(async (...args) => {
      const recalled = await original(...args);
      if (!removed) {
        removed = true;
        await fixture.store.deleteSource(fixture.event.sourceId);
      }
      return recalled;
    });
    await expect(
      buildContext(
        {} as Env,
        fixture.store,
        fixture.story.branchId,
        { mode: 'roleplay', text: '隐藏航线在哪里' },
        defaults('local-demo'),
        'snapshot-race',
      ),
    ).rejects.toThrow();
  });
  it('does not atomically activate observations whose expected fact is corrected during evidence preparation', async () => {
    const fixture = await storyFixture();
    const correction = await fixture.store.appendTurn({
      branchId: fixture.story.branchId,
      sessionId: fixture.session.id,
      requestId: 'author-change',
      messages: [{ role: 'correction', text: '隐藏航线实际在南礁。' }],
    });
    const correctedEvent = correction.events[0]!,
      replacement = {
        sourceId: correctedEvent.sourceId,
        start: 0,
        end: Array.from(correctedEvent.text).length,
        quote: correctedEvent.text,
      };
    const source = fixture.store.source.bind(fixture.store);
    let changed = false;
    vi.spyOn(fixture.store, 'source').mockImplementation(async (id) => {
      if (!changed && id === fixture.event.sourceId) {
        changed = true;
        await fixture.store.correct(fixture.story.branchId, fixture.memory.id, {
          text: correctedEvent.text,
          value: '南礁',
          evidence: [replacement],
        });
      }
      return source(id);
    });
    await expect(
      fixture.store.activateObservation({
        branchId: fixture.story.branchId,
        cursor: 2,
        expectedMemoryIds: [fixture.memory.id],
        proposals: [
          {
            kind: 'observation',
            subject: 'director',
            predicate: 'summary',
            value: '北礁',
            text: '旧结论仍是北礁',
            evidence: [fixture.evidence],
          },
        ],
      }),
    ).rejects.toThrow();
    expect(
      fixture.sqlite
        .prepare("SELECT count(*) AS n FROM memory_versions WHERE kind='observation'")
        .get(),
    ).toEqual({ n: 0 });
  });
  it('uses Unicode offsets, rejects repeated quotes and prevents roleplay-only assertions becoming canon', () => {
    const event = {
      id: 'e',
      sourceId: 's',
      role: 'assistant',
      text: '🌙前缀。晴岚收到密信。',
      seq: 1,
    } as Parameters<typeof evidenceFor>[1][number];
    expect(evidenceFor({ source: 'assistant', quote: '晴岚收到密信。' }, [event]).start).toBe(4);
    expect(() =>
      evidenceFor({ source: 'assistant', quote: '重复' }, [{ ...event, text: '重复重复' }]),
    ).toThrow();
    const extraction = extractionSchema.parse({
      scene: {},
      facts: [
        {
          kind: 'canon',
          subject: '王位',
          predicate: '拥有者',
          value: '玩家',
          text: '我是国王',
          evidence: [{ source: 'user', quote: '我是国王' }],
        },
      ],
    });
    expect(() =>
      validateExtraction(extraction, { mode: 'roleplay', text: '我是国王' }, '', {
        characters: [],
        recall: { items: [] },
      } as unknown as ContextSnapshot),
    ).toThrow('世界事实');
  });
});

describe('late runtime publishing and durable dispatch', () => {
  it('cannot restore stream events after cancellation and clear', async () => {
    const fixture = await storyFixture(),
      { runtime, doSqlite } = fakeBindings(fixture);
    await taskFixture(fixture, 'running');
    await runtime.publish('boundary-task', 1, 'reset', { text: '' });
    await runtime.publish('boundary-task', 1, 'delta', { text: '旧机密' });
    await fixture.store.run(
      "UPDATE tasks SET status='cancelled',cancel_epoch=cancel_epoch+1,draft_text='' WHERE id='boundary-task'",
    );
    await runtime.fetch(
      new Request('https://runtime/clear', {
        method: 'POST',
        body: JSON.stringify({ taskIds: ['boundary-task'] }),
      }),
    );
    await runtime.publish('boundary-task', 1, 'delta', { text: '迟到机密' });
    expect(
      doSqlite.prepare("SELECT count(*) AS n FROM stream_events WHERE data LIKE '%机密%'").get(),
    ).toEqual({ n: 0 });
  });
  it('does not publish stale terminal text once completed task artifacts are scrubbed', async () => {
    const fixture = await storyFixture(),
      { runtime, doSqlite } = fakeBindings(fixture);
    await taskFixture(fixture, 'completed');
    await fixture.store.run(
      "UPDATE tasks SET draft_text='',context_json='{}',input_json='{}' WHERE id='boundary-task'",
    );
    await runtime.fetch(
      new Request('https://runtime/clear', {
        method: 'POST',
        body: JSON.stringify({ taskIds: ['boundary-task'] }),
      }),
    );
    await runtime.publish('boundary-task', 1, 'terminal', {
      status: 'completed',
      text: '迟到导演秘密',
    });
    expect(
      doSqlite.prepare("SELECT count(*) AS n FROM stream_events WHERE data LIKE '%秘密%'").get(),
    ).toEqual({ n: 0 });
  });
  it('does not replay a D1 draft read before source cleanup when the stream is already revoked', async () => {
    const fixture = await storyFixture(),
      { runtime } = fakeBindings(fixture);
    await taskFixture(fixture, 'completed');
    await fixture.store.run(
      "UPDATE tasks SET draft_text='删除前的秘密航线' WHERE id='boundary-task'",
    );
    const prepare = fixture.db.prepare.bind(fixture.db);
    let delayed = false;
    vi.spyOn(fixture.db, 'prepare').mockImplementation((sql) => {
      const prepared = prepare(sql),
        bind = prepared.bind.bind(prepared);
      prepared.bind = (...params) => {
        const statement = bind(...params);
        if (sql === 'SELECT attempt,status,draft_text FROM tasks WHERE id=?') {
          const first = statement.first.bind(statement);
          statement.first = async <T>() => {
            const old = await first<T>();
            if (!delayed) {
              delayed = true;
              await fixture.store.run("UPDATE tasks SET draft_text='' WHERE id='boundary-task'");
              await runtime.fetch(
                new Request('https://runtime/clear', {
                  method: 'POST',
                  body: JSON.stringify({ taskIds: ['boundary-task'] }),
                }),
              );
            }
            return old;
          };
        }
        return statement;
      };
      return prepared;
    });
    const response = await runtime.fetch(new Request('https://runtime/events?task=boundary-task'));
    expect(await response.text()).not.toContain('删除前的秘密航线');
  });
  it('uses the same workflow identity for concurrent duplicate dispatch and increments the outbox once', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture);
    await taskFixture(fixture);
    await Promise.all([dispatchOutbox(bindings.env), dispatchOutbox(bindings.env)]);
    expect(bindings.workflows.size).toBe(1);
    expect(
      await fixture.store.one('SELECT status,attempts FROM outbox WHERE id=?', 'generation-outbox'),
    ).toEqual({ status: 'dispatched', attempts: 1 });
  });
  it('does not fail a newer attempt when repair observes an errored older workflow', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture);
    await taskFixture(fixture, 'running');
    await fixture.store.run("UPDATE tasks SET attempt=2 WHERE id='boundary-task'");
    await fixture.store.run(
      "UPDATE outbox SET status='dispatched',updated_at=? WHERE id='generation-outbox'",
      new Date(Date.now() - 30 * 60_000).toISOString(),
    );
    bindings.env.GENERATION.get = async () =>
      ({ status: async () => ({ status: 'errored' }) }) as unknown as WorkflowInstance;
    await dispatchOutbox(bindings.env);
    expect(
      await fixture.store.one('SELECT status,attempt FROM tasks WHERE id=?', 'boundary-task'),
    ).toEqual({ status: 'running', attempt: 2 });
    expect(
      await fixture.store.one('SELECT status FROM outbox WHERE id=?', 'generation-outbox'),
    ).toEqual({ status: 'failed' });
  });
  it('does not commit a narrative after cancellation immediately before its commit step', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture),
      params = await taskFixture(fixture);
    const workflow = new GenerationWorkflow({} as ExecutionContext, bindings.env);
    await expect(
      workflow.run(
        { payload: params } as never,
        fakeStep(async (name) => {
          if (name === 'commit narrative')
            await fixture.store.run(
              "UPDATE tasks SET status='cancelled',cancel_epoch=cancel_epoch+1 WHERE id='boundary-task'",
            );
        }) as never,
      ),
    ).rejects.toThrow();
    expect((await fixture.store.getBranch(fixture.story.branchId)).headSeq).toBe(1);
    expect(await fixture.store.one('SELECT status FROM tasks WHERE id=?', params.taskId)).toEqual({
      status: 'cancelled',
    });
  });
  it('removes a late R2 context put when deletion changed its source epoch while writing', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture),
      params = await taskFixture(fixture);
    let erased = false;
    bindings.setPutHook(async (path) => {
      if (!erased && path.endsWith('/context.json')) {
        erased = true;
        await fixture.store.deleteSource(fixture.event.sourceId);
      }
    });
    const workflow = new GenerationWorkflow({} as ExecutionContext, bindings.env);
    await expect(workflow.run({ payload: params } as never, fakeStep() as never)).rejects.toThrow();
    expect(Array.from(bindings.objects.keys()).some((key) => key.includes('/context.json'))).toBe(
      false,
    );
  });
  it('removes a late narrative extraction artifact when its context source is deleted while writing', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture),
      params = await taskFixture(fixture);
    let erased = false;
    bindings.setPutHook(async (path) => {
      if (!erased && path.endsWith('/extraction.json')) {
        erased = true;
        await fixture.store.deleteSource(fixture.event.sourceId);
      }
    });
    const workflow = new GenerationWorkflow({} as ExecutionContext, bindings.env);
    await expect(workflow.run({ payload: params } as never, fakeStep() as never)).rejects.toThrow();
    expect(
      Array.from(bindings.objects.keys()).some((key) => key.endsWith('/extraction.json')),
    ).toBe(false);
    expect((await fixture.store.getBranch(fixture.story.branchId)).headSeq).toBe(1);
  });
  it('removes a late prepared memory artifact after source deletion during R2 put', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture),
      epoch = await fixture.store.ownerEpoch(),
      at = new Date().toISOString();
    await fixture.store.run(
      'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      'memory-race',
      fixture.store.ownerId,
      fixture.story.branchId,
      'memory',
      JSON.stringify({ eventIds: [fixture.event.id], throughSeq: 1, ownerEpoch: epoch }),
      'pending',
      at,
      at,
    );
    let erased = false;
    bindings.setPutHook(async (path) => {
      if (!erased && path === 'jobs/memory-race/prepared.json') {
        erased = true;
        await fixture.store.deleteSource(fixture.event.sourceId);
      }
    });
    const workflow = new MemoryWorkflow({} as ExecutionContext, bindings.env);
    await expect(
      workflow.run(
        {
          payload: {
            ownerId: fixture.store.ownerId,
            branchId: fixture.story.branchId,
            outboxId: 'memory-race',
          },
        } as never,
        fakeStep() as never,
      ),
    ).rejects.toThrow();
    expect(bindings.objects.has('jobs/memory-race/prepared.json')).toBe(false);
  });
  it('does not erase a valid prepared memory job created after an older source deletion', async () => {
    const fixture = await storyFixture(),
      bindings = fakeBindings(fixture);
    await fixture.store.deleteSource(fixture.event.sourceId);
    const cleanup = await fixture.store.one<{ id: string }>(
      "SELECT id FROM outbox WHERE kind='cleanup' AND owner_id=?",
      fixture.store.ownerId,
    );
    const newTurn = await fixture.store.appendTurn({
      branchId: fixture.story.branchId,
      sessionId: fixture.session.id,
      requestId: 'new-valid-turn',
      messages: [{ role: 'assistant', text: '新的地标是南礁。' }],
    });
    const at = new Date(Date.now() + 1000).toISOString(),
      epoch = await fixture.store.ownerEpoch();
    await fixture.store.run(
      'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      'current-memory-job',
      fixture.store.ownerId,
      fixture.story.branchId,
      'memory',
      JSON.stringify({
        ownerEpoch: epoch,
        eventIds: newTurn.events.map((event) => event.id),
        throughSeq: 2,
      }),
      'dispatched',
      at,
      at,
    );
    bindings.objects.set(
      'jobs/current-memory-job/prepared.json',
      JSON.stringify({ text: '删除之后的新合法片段', ownerEpoch: epoch }),
    );
    const workflow = new MemoryWorkflow({} as ExecutionContext, bindings.env);
    await workflow.run(
      {
        payload: {
          ownerId: fixture.store.ownerId,
          branchId: fixture.story.branchId,
          outboxId: cleanup!.id,
        },
      } as never,
      fakeStep() as never,
    );
    expect(bindings.objects.has('jobs/current-memory-job/prepared.json')).toBe(true);
  });
});
