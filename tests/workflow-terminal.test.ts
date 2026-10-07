import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store, StoreError } from '../src/server/store';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
import type { WorkflowStep } from 'cloudflare:workers';

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
vi.mock('../src/server/persona', () => ({
  syncPersonaCapabilities: vi.fn(async () => ({ sources: [], capabilities: [], skipped: [] })),
}));
vi.mock('../src/server/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/server/model')>()),
  complete: vi.fn(async () => {
    throw new Error('Unexpected model call in workflow test');
  }),
}));
import { syncPersonaCapabilities } from '../src/server/persona';
import { complete } from '../src/server/model';
import { dispatchOutbox, GenerationWorkflow, MemoryWorkflow } from '../src/server/workflows';

let db: ReturnType<typeof createTestD1>, store: Store, branchId: string, sessionId: string;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  db = createTestD1();
  store = new Store(db.db, 'workflow-terminal-owner');
  const world = await store.createWorld('持久任务终态'),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  await store.appendTurn({
    branchId,
    sessionId,
    requestId: 'initial',
    messages: [{ role: 'assistant', text: '白钥匙在桌面。' }],
  });
  await store.extract(branchId, {
    eventIds: [],
    proposals: [],
    cursor: 1,
    extractorVersion: 'v3-facts',
  });
  await store.run("UPDATE outbox SET status='completed'");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  db.close();
});

/** The runtime forbids any binding I/O outside an awaited durable callback.
 * This catches the original load/catch problem instead of mocking persistence. */
function strictBindings() {
  let active = 0;
  const requireStep = () => {
    if (!active) throw new Error('Binding I/O escaped a durable step');
  };
  function statement(native: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(native, {
      get(target, property) {
        if (property === 'bind') return (...args: unknown[]) => statement(target.bind(...args));
        const value = Reflect.get(target, property);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              requireStep();
              return value.apply(target, args);
            }
          : value;
      },
    });
  }
  const guardedDB = new Proxy(db.db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => statement(target.prepare(sql));
      const value = Reflect.get(target, property);
      return typeof value === 'function'
        ? (...args: unknown[]) => {
            requireStep();
            return value.apply(target, args);
          }
        : value;
    },
  });
  const objects = new Map<string, string>(),
    published: unknown[] = [];
  let onStep: ((name: string) => Promise<void>) | undefined;
  const completed = new Map<string, unknown>(),
    names: string[] = [];
  const step = {
    do: async (name: string, options: unknown, callback?: () => Promise<unknown>) => {
      if (completed.has(name)) return completed.get(name);
      const fn = typeof options === 'function' ? (options as () => Promise<unknown>) : callback!;
      const limit =
        typeof options === 'object' && options
          ? ((options as { retries?: { limit?: number } }).retries?.limit ?? 0)
          : 0;
      for (let attempt = 0; ; attempt++) {
        active++;
        names.push(name);
        try {
          if (onStep) await onStep(name);
          const value = await fn();
          completed.set(name, value);
          return value;
        } catch (error) {
          if ((error as Error)?.constructor.name === 'NonRetryableError' || attempt >= limit)
            throw error;
        } finally {
          active--;
        }
      }
    },
    sleep: async () => undefined,
  } as unknown as WorkflowStep;
  const bucket = {
    put: async (key: string, value: string) => {
      requireStep();
      objects.set(key, value);
    },
    get: async (key: string) => {
      requireStep();
      return objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null;
    },
    delete: async (key: string | string[]) => {
      requireStep();
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
    },
    list: async ({ prefix }: { prefix: string }) => {
      requireStep();
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  const stub = {
    fetch: async (_url: string, init: RequestInit) => {
      requireStep();
      published.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    },
  };
  const binding = {
    createBatch: async () => {
      requireStep();
      return [];
    },
    get: async () => {
      requireStep();
      return { status: async () => ({ status: 'errored' }) };
    },
  };
  const env = {
    DB: guardedDB,
    BUCKET: bucket,
    MODEL_MODE: 'local-demo',
    GENERATION: binding,
    MEMORY: binding,
    BRANCH_RUNTIME: { idFromName: (id: string) => id, get: () => stub, getByName: () => stub },
    VECTORS: { deleteByIds: async () => ({}) },
  } as unknown as Env;
  return {
    env,
    step,
    names,
    objects,
    published,
    onStep: (hook: typeof onStep) => {
      onStep = hook;
    },
  };
}
async function generation(status = 'queued') {
  const at = new Date().toISOString();
  await store.run(
    'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,attempt,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?,?,?)',
    'task',
    store.ownerId,
    branchId,
    sessionId,
    'gen-command',
    1,
    status,
    JSON.stringify({ mode: 'roleplay', text: '继续。' }),
    JSON.stringify(defaults('local-demo')),
    at,
    at,
  );
  await store.run(
    'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    'generation-job',
    store.ownerId,
    branchId,
    'generation',
    JSON.stringify({ taskId: 'task', attempt: 1 }),
    'dispatched',
    at,
    at,
  );
  return {
    ownerId: store.ownerId,
    taskId: 'task',
    attempt: 1,
    branchId,
    outboxId: 'generation-job',
  };
}
async function memory(retryId?: string) {
  const at = new Date().toISOString(),
    payload = {
      throughSeq: 1,
      ownerEpoch: await store.ownerEpoch(),
      ...(retryId ? { retryId } : {}),
    };
  await store.run(
    'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    'memory-job',
    store.ownerId,
    branchId,
    'memory',
    JSON.stringify(payload),
    'dispatched',
    at,
    at,
  );
  return {
    ownerId: store.ownerId,
    branchId,
    outboxId: 'memory-job',
    ...(retryId ? { retryId } : {}),
  };
}

describe('durable task terminal states', () => {
  it('claims an outbox once before concurrent dispatchers can create a Workflow', async () => {
    const params = await generation(),
      entered = deferred<void>(),
      release = deferred<void>();
    await store.run("UPDATE outbox SET status='pending' WHERE id=?", params.outboxId);
    const createBatch = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const get = vi.fn(async () => {
      throw new Error('Unexpected duplicate creation');
    });
    const env = { DB: db.db, GENERATION: { createBatch, get } } as unknown as Env;
    const first = dispatchOutbox(env);
    await entered.promise;
    await dispatchOutbox(env);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatching', attempts: 1 });
    release.resolve();
    await first;
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatched', attempts: 1 });
  });
  it('recovers a successful creation whose D1 acknowledgement was lost using its stable ID', async () => {
    const params = await generation();
    await store.run("UPDATE outbox SET status='pending' WHERE id=?", params.outboxId);
    const instances = new Set<string>();
    const createBatch = vi.fn(async (items: { id: string }[]) => {
      if (instances.has(items[0]!.id)) throw new Error('Already exists');
      instances.add(items[0]!.id);
      return [];
    });
    const get = vi.fn(async (id: string) => {
      if (!instances.has(id)) throw new Error('Not found');
      return { status: async () => ({ status: 'running' }) };
    });
    let loseAcknowledgement = true;
    function statement(native: D1PreparedStatement, sql: string): D1PreparedStatement {
      return new Proxy(native, {
        get(target, property) {
          if (property === 'bind')
            return (...args: unknown[]) => statement(target.bind(...args), sql);
          if (property === 'run' && sql.startsWith("UPDATE outbox SET status='dispatched'"))
            return async () => {
              if (loseAcknowledgement) {
                loseAcknowledgement = false;
                throw new Error('D1 acknowledgement lost');
              }
              return target.run();
            };
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    const guardedDB = new Proxy(db.db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => statement(target.prepare(sql), sql);
        return Reflect.get(target, property);
      },
    });
    const env = { DB: guardedDB, GENERATION: { createBatch, get } } as unknown as Env;
    await expect(dispatchOutbox(env)).rejects.toThrow('D1 acknowledgement lost');
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatching', attempts: 1 });
    await store.run(
      'UPDATE outbox SET updated_at=? WHERE id=?',
      new Date(Date.now() - 30 * 60_000).toISOString(),
      params.outboxId,
    );
    await dispatchOutbox(env);
    expect(instances.size).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(createBatch.mock.calls[0]![0][0]!.id).toBe(createBatch.mock.calls[1]![0][0]!.id);
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatched', attempts: 1 });
  });
  it.each(['success', 'failure'] as const)(
    'does not let a late %s overwrite a replacement dispatch lease',
    async (outcome) => {
      const params = await generation(),
        entered = deferred<void>(),
        release = deferred<void>();
      await store.run("UPDATE outbox SET status='pending' WHERE id=?", params.outboxId);
      const createBatch = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        if (outcome === 'failure') throw new Error('Old creation failed');
        return [];
      });
      const get = vi.fn(async () => {
        throw new Error('Old instance absent');
      });
      const original = dispatchOutbox({
        DB: db.db,
        GENERATION: { createBatch, get },
      } as unknown as Env);
      await entered.promise;
      const replacementLease = new Date(Date.now() + 1000).toISOString();
      await store.run(
        "UPDATE outbox SET status='dispatching',attempts=2,last_error=NULL,updated_at=? WHERE id=?",
        replacementLease,
        params.outboxId,
      );
      release.resolve();
      await original;
      expect(
        await store.one(
          'SELECT status,attempts,last_error,updated_at FROM outbox WHERE id=?',
          params.outboxId,
        ),
      ).toEqual({
        status: 'dispatching',
        attempts: 2,
        last_error: null,
        updated_at: replacementLease,
      });
    },
  );
  it('recovers an expired third lease before creation without counting its crash as a failure', async () => {
    const params = await generation();
    await store.run(
      "UPDATE outbox SET status='dispatching',attempts=3,updated_at=? WHERE id=?",
      new Date(Date.now() - 30 * 60_000).toISOString(),
      params.outboxId,
    );
    const createBatch = vi.fn(async () => []);
    await dispatchOutbox({ DB: db.db, GENERATION: { createBatch } } as unknown as Env);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatched', attempts: 3 });
    expect(await store.one('SELECT status FROM tasks WHERE id=?', params.taskId)).toEqual({
      status: 'queued',
    });
  });
  it('persists a terminal generation failure after three confirmed dispatch failures', async () => {
    const params = await generation();
    await store.run("UPDATE outbox SET status='pending' WHERE id=?", params.outboxId);
    const unavailable = vi.fn(async () => {
      throw new Error('Workflow binding unavailable');
    });
    const env = {
      DB: db.db,
      GENERATION: { createBatch: unavailable, get: unavailable },
    } as unknown as Env;
    for (let attempt = 0; attempt < 3; attempt++) await dispatchOutbox(env);
    expect(
      await store.one('SELECT status,attempts FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'failed', attempts: 3 });
    expect(
      await store.one('SELECT status,error_json FROM tasks WHERE id=?', params.taskId),
    ).toMatchObject({
      status: 'failed',
      error_json: expect.stringContaining('WORKFLOW_DISPATCH_FAILED'),
    });
  });
  it('settles a previously cancelled generation without narration or escaped I/O', async () => {
    const params = await generation('cancelled'),
      guarded = strictBindings();
    await new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
      { payload: params } as never,
      guarded.step,
    );
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'completed',
    });
    expect(guarded.objects.size).toBe(0);
    expect(guarded.published).toHaveLength(0);
    expect(guarded.names).toEqual(['load generation task', 'settle inactive generation']);
  });
  it('persists cancellation before commit and never converts it to failed or leaves dispatched intent', async () => {
    const params = await generation(),
      guarded = strictBindings();
    guarded.onStep(async (name) => {
      if (name === 'commit narrative')
        await store.run(
          "UPDATE tasks SET status='cancelled',cancel_epoch=cancel_epoch+1 WHERE id='task'",
        );
    });
    await expect(
      new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('取消');
    expect(await store.one('SELECT status FROM tasks WHERE id=?', 'task')).toEqual({
      status: 'cancelled',
    });
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'completed',
    });
    expect((await store.getBranch(branchId)).headSeq).toBe(1);
    expect(guarded.names).toContain('persist generation failure');
    expect(guarded.names).not.toContain('publish generation failure');
  });
  it('does not poison a replacement attempt when an older generation fails', async () => {
    const params = await generation(),
      guarded = strictBindings();
    guarded.onStep(async (name) => {
      if (name === 'context snapshot') throw new StoreError('STALE_WRITE', '测试剧情版本冲突');
      if (name === 'persist generation failure')
        await store.run(
          "UPDATE tasks SET attempt=2,status='running',draft_text='新尝试草稿' WHERE id='task'",
        );
    });
    await expect(
      new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('冲突');
    expect(
      await store.one('SELECT status,attempt,draft_text FROM tasks WHERE id=?', 'task'),
    ).toEqual({ status: 'running', attempt: 2, draft_text: '新尝试草稿' });
    expect(guarded.published).toHaveLength(0);
  });
  it('persists Persona invalidation in a durable step without retrying an invalid source', async () => {
    const params = await memory(),
      guarded = strictBindings();
    vi.mocked(syncPersonaCapabilities).mockRejectedValueOnce(
      new StoreError('STALE_WRITE', '角色资料来源已变化，请重新同步'),
    );
    await expect(
      new MemoryWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('角色资料来源已变化');
    expect(syncPersonaCapabilities).toHaveBeenCalledTimes(1);
    expect(guarded.names.filter((name) => name === 'learn experiences')).toHaveLength(1);
    expect(guarded.names).toContain('persist memory failure');
    expect(
      await store.one('SELECT status,last_error FROM outbox WHERE id=?', params.outboxId),
    ).toMatchObject({ status: 'failed', last_error: expect.stringContaining('STALE_WRITE') });
  });
  it('persists observation invalidation and preserves the committed atomic facts', async () => {
    const event = (await store.getEvents(branchId))[0]!;
    await store.propose(branchId, {
      kind: 'canon',
      subject: '白钥匙',
      predicate: '位置',
      value: '桌面',
      text: event.text,
      evidence: [
        {
          sourceId: event.sourceId,
          start: 0,
          end: Array.from(event.text).length,
          quote: event.text,
        },
      ],
    });
    vi.spyOn(Store.prototype, 'activateObservation').mockRejectedValue(
      new StoreError('OBSERVATION_STALE', 'Observation invalidated'),
    );
    const params = await memory(),
      guarded = strictBindings();
    await expect(
      new MemoryWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('Observation invalidated');
    expect(guarded.names.filter((name) => name === 'observe and reflect')).toHaveLength(1);
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'failed',
    });
    expect((await store.memories(branchId, { kinds: ['canon'] }))[0]?.value).toBe('桌面');
  });
  it('fences an older memory workflow terminal write from a newly retried job', async () => {
    const params = await memory('old-retry'),
      guarded = strictBindings();
    vi.mocked(syncPersonaCapabilities).mockRejectedValueOnce(
      new StoreError('STALE_WRITE', '旧整理失败'),
    );
    guarded.onStep(async (name) => {
      if (name === 'persist memory failure')
        await store.run(
          "UPDATE outbox SET payload_json=?,status='dispatched',last_error=NULL WHERE id='memory-job'",
          JSON.stringify({ retryId: 'new-retry' }),
        );
    });
    await expect(
      new MemoryWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('旧整理失败');
    expect(
      await store.one('SELECT status,last_error FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'dispatched', last_error: null });
  });
  it('skips duplicate completed jobs and out-of-date retry identities before any R2 processing', async () => {
    const params = await memory('current-retry'),
      guarded = strictBindings();
    await new MemoryWorkflow({} as ExecutionContext, guarded.env).run(
      { payload: { ...params, retryId: 'old-retry' } } as never,
      guarded.step,
    );
    expect(guarded.objects.size).toBe(0);
    expect(syncPersonaCapabilities).not.toHaveBeenCalled();
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'dispatched',
    });
  });
  it('repairs an abandoned cancelled generation without waiting for Workflow status availability', async () => {
    const params = await generation('cancelled');
    await store.run(
      'UPDATE outbox SET updated_at=? WHERE id=?',
      new Date(Date.now() - 30 * 60_000).toISOString(),
      params.outboxId,
    );
    const unavailable = vi.fn(async () => {
      throw new Error('Workflow status unavailable');
    });
    const env = { DB: db.db, GENERATION: { get: unavailable } } as unknown as Env;
    await dispatchOutbox(env);
    expect(unavailable).not.toHaveBeenCalled();
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'completed',
    });
  });
  it('waits for the final in-flight cancellation check before leaving narration and clears its timer', async () => {
    const params = await generation(),
      guarded = strictBindings();
    await store.run(
      'UPDATE tasks SET config_json=? WHERE id=?',
      JSON.stringify(defaults('gateway')),
      'task',
    );
    const model = deferred<string>(),
      entered = deferred<void>(),
      polling = deferred<void>(),
      releasePoll = deferred<void>();
    vi.mocked(complete).mockImplementation(async () => {
      entered.resolve();
      return model.promise;
    });
    let holdNextRead = false;
    const nativeDB = guarded.env.DB;
    function pollingStatement(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, {
        get(target, property) {
          if (property === 'bind')
            return (...args: unknown[]) => pollingStatement(target.bind(...args));
          if (property === 'first')
            return async () => {
              const result = await target.first();
              if (holdNextRead) {
                holdNextRead = false;
                polling.resolve();
                await releasePoll.promise;
              }
              return result;
            };
          return Reflect.get(target, property);
        },
      });
    }
    guarded.env.DB = new Proxy(nativeDB, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            const prepared = target.prepare(sql);
            return sql === 'SELECT * FROM tasks WHERE id=? AND owner_id=?'
              ? pollingStatement(prepared)
              : prepared;
          };
        return Reflect.get(target, property);
      },
    });
    vi.useFakeTimers();
    const clearTimer = vi.spyOn(globalThis, 'clearInterval');
    const result = new GenerationWorkflow({} as ExecutionContext, guarded.env)
      .run({ payload: params } as never, guarded.step)
      .then(
        () => null,
        (error) => error as Error,
      );
    await entered.promise;
    holdNextRead = true;
    await vi.advanceTimersByTimeAsync(1000);
    await polling.promise;
    model.resolve('白钥匙依然在桌面。');
    await vi.waitFor(() => expect(clearTimer).toHaveBeenCalledTimes(1));
    expect(guarded.names).not.toContain('validate narrative');
    expect(vi.getTimerCount()).toBe(0);
    await store.run(
      "UPDATE tasks SET status='cancelled',cancel_epoch=cancel_epoch+1 WHERE id='task'",
    );
    releasePoll.resolve();
    expect((await result)?.message).toContain('取消');
    expect(await store.one('SELECT status FROM outbox WHERE id=?', params.outboxId)).toEqual({
      status: 'completed',
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
