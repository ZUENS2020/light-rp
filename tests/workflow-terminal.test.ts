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
import { extractionSchema } from '../src/server/extraction';
import { modelRefusal } from '../src/server/narration';
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
  vi.mocked(complete)
    .mockReset()
    .mockRejectedValue(new Error('Unexpected model call in workflow test'));
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
function queueNarration(narrative: string) {
  return vi.mocked(complete).mockImplementationOnce(async (_env, _settings, _messages, options) => {
    await options?.onText?.(narrative);
    return narrative;
  });
}
function setJudge(
  env: Env,
  judge: (
    model: unknown,
    request: { questions: Record<string, unknown> },
    options: { signal: AbortSignal },
  ) => Promise<unknown>,
) {
  env.AI = {
    run: async (
      model: unknown,
      request: { questions: Record<string, unknown> },
      options: { signal: AbortSignal },
    ) =>
      model === '@cf/baai/bge-m3'
        ? { data: [Array(1024).fill(0)] }
        : judge(model, request, options),
  } as unknown as Env['AI'];
  env.VECTORS = {
    ...env.VECTORS,
    query: async () => ({ matches: [] }),
  } as unknown as Env['VECTORS'];
}

describe('durable task terminal states', () => {
  it('checks a saved narration artifact before resuming extraction', async () => {
    const params = await generation(),
      guarded = strictBindings();
    const text = '我不能写这段。你描述的内容是一个请求。';
    guarded.onStep(async (name) => {
      if (name === 'narration')
        guarded.objects.set(
          `tasks/${store.ownerId}/task/1/narration.json`,
          JSON.stringify({ text }),
        );
    });
    await expect(
      new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('MODEL_REFUSAL');
    expect(complete).not.toHaveBeenCalled();
    expect(guarded.names).not.toContain('validate narrative');
    expect((await store.getBranch(branchId)).headSeq).toBe(1);
  });
  it.each(['plain', 'declared'] as const)(
    'preserves a %s refusal draft without extracting, committing or retrying the model',
    async (kind) => {
      const params = await generation(),
        guarded = strictBindings(),
        narrative = '我不能写这段。你描述的内容属于一个请求，我可以提供替代版本。';
      await store.run(
        'UPDATE tasks SET config_json=? WHERE id=?',
        JSON.stringify(defaults('gateway')),
        params.taskId,
      );
      vi.mocked(complete).mockImplementationOnce(async (_env, _settings, _messages, options) => {
        await options?.onText?.(narrative.slice(0, 7));
        await options?.onText?.(narrative.slice(7));
        if (kind === 'declared') throw modelRefusal();
        return narrative;
      });
      const before = await store.getEvents(branchId);
      await expect(
        new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
          { payload: params } as never,
          guarded.step,
        ),
      ).rejects.toThrow('MODEL_REFUSAL');
      expect(complete).toHaveBeenCalledTimes(1);
      expect(await store.getEvents(branchId)).toEqual(before);
      expect((await store.getBranch(branchId)).headSeq).toBe(1);
      const task = await store.one<{ status: string; draft_text: string; error_json: string }>(
        'SELECT status,draft_text,error_json FROM tasks WHERE id=?',
        params.taskId,
      );
      expect(task).toMatchObject({ status: 'failed', draft_text: narrative });
      expect(JSON.parse(task!.error_json).code).toBe('MODEL_REFUSAL');
      expect(
        [...guarded.objects.keys()].some((k) => /\/(narration|extraction)\.json$/.test(k)),
      ).toBe(false);
      expect(guarded.names).not.toContain('validate narrative');
      expect(
        await store.all("SELECT id FROM outbox WHERE kind='memory' AND status!='completed'"),
      ).toHaveLength(0);
      expect(await store.one("SELECT status FROM outbox WHERE id='generation-job'")).toEqual({
        status: 'failed',
      });
    },
  );
  it.each([
    [0.03, 'rejected'],
    [0.6, 'uncertain'],
  ] as const)(
    'persists a %s judgment audit in an awaited step, preserving the draft without committing a turn',
    async (probability, status) => {
      const params = await generation(),
        guarded = strictBindings(),
        settings = { ...defaults('gateway'), decisionModel: '@cf/cloudflare/clef' },
        narrative = '钥匙实际在仓库。';
      await store.run(
        'UPDATE tasks SET config_json=? WHERE id=?',
        JSON.stringify(settings),
        params.taskId,
      );
      queueNarration(narrative).mockResolvedValueOnce(
        JSON.stringify({
          scene: {},
          facts: [
            {
              kind: 'canon',
              subject: '钥匙',
              predicate: '位置',
              value: '仓库',
              text: narrative,
              evidence: [{ source: 'assistant', quote: narrative }],
            },
          ],
        }),
      );
      const run = vi.fn(
        async (_model: unknown, request: { questions: Record<string, unknown> }) => ({
          model: 'clef',
          answers: Object.fromEntries(
            Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: probability }]),
          ),
          usage: { input_tokens: 120, output_tokens: 0 },
        }),
      );
      setJudge(guarded.env, run);
      await expect(
        new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
          { payload: params } as never,
          guarded.step,
        ),
      ).rejects.toThrow('判断模型未确认');
      const path = `tasks/${store.ownerId}/task/1/decision.json`,
        audit = JSON.parse(guarded.objects.get(path)!);
      expect(audit).toMatchObject({
        status,
        candidates: [{ path: 'facts.0', usage: { input_tokens: 120 } }],
      });
      expect(JSON.stringify(audit)).not.toContain(narrative);
      expect(run).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(2);
      expect((await store.getBranch(branchId)).headSeq).toBe(1);
      expect(
        await store.one('SELECT status,draft_text FROM tasks WHERE id=?', params.taskId),
      ).toEqual({ status: 'failed', draft_text: narrative });
    },
  );
  it('keeps a supported judgment in both its standalone audit and validated extraction artifact', async () => {
    const params = await generation(),
      guarded = strictBindings(),
      settings = { ...defaults('gateway'), decisionModel: '@cf/cloudflare/clef' },
      narrative = '钥匙实际在仓库。';
    await store.run(
      'UPDATE tasks SET config_json=? WHERE id=?',
      JSON.stringify(settings),
      params.taskId,
    );
    queueNarration(narrative).mockResolvedValueOnce(
      JSON.stringify({
        scene: {},
        facts: [
          {
            kind: 'canon',
            subject: '钥匙',
            predicate: '位置',
            value: '仓库',
            text: narrative,
            evidence: [{ source: 'assistant', quote: narrative }],
          },
        ],
      }),
    );
    setJudge(guarded.env, async (_model, request) => ({
      model: 'clef',
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.98 }]),
      ),
      usage: { input_tokens: 120, output_tokens: 0 },
    }));
    const stub = guarded.env.BRANCH_RUNTIME.get(guarded.env.BRANCH_RUNTIME.idFromName(branchId)),
      originalFetch = stub.fetch.bind(stub);
    guarded.env.BRANCH_RUNTIME = {
      idFromName: (id: string) => id,
      get: () => ({
        fetch: async (url: string, options: RequestInit) => {
          if (url.endsWith('/commit')) {
            await new Store(guarded.env.DB, store.ownerId).appendTurn(
              JSON.parse(String(options.body)).turn,
            );
            return Response.json({ ok: true });
          }
          return originalFetch(url, options);
        },
      }),
    } as unknown as Env['BRANCH_RUNTIME'];
    await new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
      { payload: params } as never,
      guarded.step,
    );
    const audit = JSON.parse(guarded.objects.get(`tasks/${store.ownerId}/task/1/decision.json`)!);
    const data = JSON.parse(guarded.objects.get(`tasks/${store.ownerId}/task/1/extraction.json`)!);
    expect(audit.status).toBe('supported');
    expect(data.extraction.decisionAudit).toEqual(audit);
    expect((await store.getBranch(branchId)).headSeq).toBe(3);
    expect(await store.one('SELECT status FROM tasks WHERE id=?', params.taskId)).toEqual({
      status: 'completed',
    });
  });
  it('destroys a late decision audit after the source epoch changes instead of caching invalid evidence', async () => {
    const params = await generation(),
      guarded = strictBindings(),
      settings = { ...defaults('gateway'), decisionModel: '@cf/cloudflare/clef' },
      narrative = '钥匙实际在仓库。';
    await store.run(
      'UPDATE tasks SET config_json=? WHERE id=?',
      JSON.stringify(settings),
      params.taskId,
    );
    queueNarration(narrative).mockResolvedValueOnce(
      JSON.stringify({
        scene: {},
        facts: [
          {
            kind: 'canon',
            subject: '钥匙',
            predicate: '位置',
            value: '仓库',
            text: narrative,
            evidence: [{ source: 'assistant', quote: narrative }],
          },
        ],
      }),
    );
    setJudge(guarded.env, async (_model, request) => {
      await new Store(guarded.env.DB, store.ownerId).run(
        'UPDATE owners SET deletion_epoch=deletion_epoch+1 WHERE owner_id=?',
        store.ownerId,
      );
      return {
        model: 'clef',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.04 }]),
        ),
        usage: { input_tokens: 120, output_tokens: 0 },
      };
    });
    await expect(
      new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
        { payload: params } as never,
        guarded.step,
      ),
    ).rejects.toThrow('来源已失效');
    expect(guarded.objects.has(`tasks/${store.ownerId}/task/1/decision.json`)).toBe(false);
    expect(guarded.objects.has(`tasks/${store.ownerId}/task/1/extraction.json`)).toBe(false);
    expect((await store.getBranch(branchId)).headSeq).toBe(1);
  });
  it('aborts a judge batch on durable cancellation and never starts the remaining paid candidates', async () => {
    vi.useFakeTimers();
    const params = await generation(),
      guarded = strictBindings(),
      entered = deferred<void>(),
      settings = { ...defaults('gateway'), decisionModel: '@cf/cloudflare/clef' },
      narrative = '钥匙实际在仓库。';
    await store.run(
      'UPDATE tasks SET config_json=? WHERE id=?',
      JSON.stringify(settings),
      params.taskId,
    );
    const extraction = extractionSchema.parse({
      scene: {},
      facts: Array.from({ length: 8 }, () => ({
        kind: 'canon',
        subject: '钥匙',
        predicate: '位置',
        value: '仓库',
        text: narrative,
        evidence: [{ source: 'assistant', quote: narrative }],
      })),
    });
    queueNarration(narrative).mockResolvedValueOnce(JSON.stringify(extraction));
    const run = vi.fn(
      async (_model: unknown, _request: unknown, options: { signal: AbortSignal }) => {
        entered.resolve();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        );
      },
    );
    setJudge(guarded.env, run);
    const workflow = new GenerationWorkflow({} as ExecutionContext, guarded.env).run(
      { payload: params } as never,
      guarded.step,
    );
    const rejected = expect(workflow).rejects.toThrow('任务已取消');
    await entered.promise;
    await store.run(
      "UPDATE tasks SET status='cancelled',cancel_epoch=cancel_epoch+1 WHERE id=?",
      params.taskId,
    );
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(run).toHaveBeenCalledTimes(4);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(
      await store.one('SELECT status,draft_text FROM tasks WHERE id=?', params.taskId),
    ).toEqual({ status: 'cancelled', draft_text: narrative });
    expect(guarded.objects.has(`tasks/${store.ownerId}/task/1/decision.json`)).toBe(false);
    expect((await store.getBranch(branchId)).headSeq).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
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
  it('completes a saved extraction with an unsupported entity as a review draft and advances its source cursor', async () => {
    const event = (await store.getEvents(branchId))[0]!;
    const params = await memory('entity-review'),
      guarded = strictBindings();
    await store.run(
      'UPDATE outbox SET payload_json=? WHERE id=?',
      JSON.stringify({
        throughSeq: 1,
        ownerEpoch: await store.ownerEpoch(),
        retryId: 'entity-review',
        taskId: 'saved-extraction',
        attempt: 1,
      }),
      params.outboxId,
    );
    guarded.objects.set(
      `tasks/${encodeURIComponent(store.ownerId)}/saved-extraction/1/extraction.json`,
      JSON.stringify({
        input: { mode: 'roleplay', text: '' },
        extraction: extractionSchema.parse({
          scene: {},
          facts: [
            {
              kind: 'canon',
              subject: '没有命名的人',
              predicate: '位置',
              value: '桌面',
              text: event.text,
              evidence: [{ source: 'assistant', quote: event.text }],
            },
          ],
        }),
      }),
    );
    await new MemoryWorkflow({} as ExecutionContext, guarded.env).run(
      { payload: params } as never,
      guarded.step,
    );
    expect(
      await store.one('SELECT status,last_error FROM outbox WHERE id=?', params.outboxId),
    ).toEqual({ status: 'completed', last_error: null });
    const records = await store.memories(branchId, { includeInactive: true });
    expect(records.filter((m) => m.status === 'draft')).toHaveLength(1);
    expect(records.some((m) => m.status === 'active' && m.predicate === 'source_episode')).toBe(
      true,
    );
    expect(
      await store.one(
        "SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version='v3-facts'",
        branchId,
      ),
    ).toEqual({ applied_seq: 1 });
    expect(await store.all('SELECT * FROM entities')).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
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
