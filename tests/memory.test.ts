import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/server/store';
import { rrf, searchTokens } from '../src/server/memory';
import type { Evidence, MemoryProposal, TurnMessage } from '../src/shared/domain';

function result<T>(rows: T[] = [], changes = 0): D1Result<T> {
  return {
    success: true,
    results: rows,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}
class SqlStatement implements D1PreparedStatement {
  constructor(
    readonly db: Database.Database,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...values: unknown[]) {
    return new SqlStatement(this.db, this.sql, values);
  }
  execute<T>(): D1Result<T> {
    const s = this.db.prepare(this.sql);
    if (s.reader) return result(s.all(...this.params) as T[]);
    const r = s.run(...this.params);
    return result([], r.changes);
  }
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as
      Record<string, unknown> | undefined;
    return row ? (colName ? (row[colName] as T) : (row as T)) : null;
  }
  async run<T = Record<string, unknown>>() {
    return this.execute<T>();
  }
  async all<T = Record<string, unknown>>() {
    return this.execute<T>();
  }
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const s = this.db.prepare(this.sql),
      rows = s.raw(true).all(...this.params) as T[];
    return options?.columnNames ? [s.columns().map((c) => c.name), ...rows] : rows;
  }
}
export class SqlD1 implements D1Database {
  readonly sqlite = new Database(':memory:');
  constructor() {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      this.sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  prepare(sql: string) {
    return new SqlStatement(this.sqlite, sql);
  }
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return this.sqlite.transaction(() =>
      statements.map((s) => {
        if (!(s instanceof SqlStatement)) throw new Error('Adapter statement mismatch');
        return s.execute<T>();
      }),
    )();
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
  withSession(): D1DatabaseSession {
    return {
      prepare: (sql) => this.prepare(sql),
      batch: <T>(s: D1PreparedStatement[]) => this.batch<T>(s),
      getBookmark: () => null,
    };
  }
  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}
let db: SqlD1, s: Store, branchId: string, sessionId: string, worldId: string, storyId: string;
beforeEach(async () => {
  db = new SqlD1();
  s = new Store(db, 'alice');
  const world = await s.createWorld({ name: '星海' });
  worldId = world.id;
  const story = await s.createStory({ worldId });
  storyId = story.id;
  branchId = story.branchId;
  sessionId = (await s.createSession({ branchId })).id;
});
async function turn(
  text: string,
  role: TurnMessage['role'] = 'assistant',
  extra: Partial<TurnMessage> = {},
) {
  const b = await s.getBranch(branchId);
  return (
    await s.appendTurn({
      branchId,
      sessionId,
      expectedHead: b.headSeq,
      requestId: crypto.randomUUID(),
      messages: [{ role, text, ...extra }],
    })
  ).events[0];
}
function proof(e: { sourceId: string; text: string }, quote = e.text): Evidence {
  const index = e.text.indexOf(quote),
    start = Array.from(e.text.slice(0, index)).length;
  return { sourceId: e.sourceId, start, end: start + Array.from(quote).length, quote };
}
function proposal(
  e: { sourceId: string; text: string },
  p: Partial<MemoryProposal> = {},
): MemoryProposal {
  return {
    kind: 'canon',
    subject: '小明',
    predicate: 'location',
    value: '白云城',
    text: '小明在白云城',
    evidence: [proof(e)],
    ...p,
  };
}

describe('D1 event log and branch snapshots', () => {
  it('isolates owners and excludes sibling or post-fork evidence', async () => {
    const event = await turn('小明在白云城');
    const child = await s.fork({ branchId, atSeq: 1 });
    const later = await turn('小明去了青川');
    const other = new Store(db, 'bob');
    await expect(other.getBranch(branchId)).rejects.toMatchObject({ status: 404 });
    await expect(s.propose(child.id, proposal(later))).rejects.toMatchObject({
      code: 'SOURCE_SCOPE',
    });
    await s.propose(child.id, proposal(event));
    expect(await s.memories(child.id)).toHaveLength(1);
  });
  it('makes request replay idempotent and CAS rollback includes events and outbox', async () => {
    const request = {
      branchId,
      sessionId,
      requestId: 'same-command',
      expectedHead: 0,
      messages: [{ role: 'assistant' as const, text: '原回合' }],
    };
    await s.appendTurn(request);
    expect((await s.appendTurn(request)).replayed).toBe(true);
    await expect(
      s.appendTurn({ ...request, messages: [{ role: 'assistant', text: '另一回合' }] }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_REUSE' });
    await expect(s.appendTurn({ ...request, requestId: 'stale' })).rejects.toMatchObject({
      code: 'STALE_WRITE',
    });
    expect((await s.getEvents(branchId)).length).toBe(1);
    expect((await s.all('SELECT * FROM outbox')).length).toBe(1);
  });
  it('checks task attempt/cancel fences and completes task in the turn transaction', async () => {
    const at = new Date().toISOString();
    await s.run(
      'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?, ?,?)',
      'task',
      s.ownerId,
      branchId,
      sessionId,
      'command',
      'running',
      '{}',
      '{}',
      at,
      at,
    );
    const input = {
      branchId,
      sessionId,
      requestId: 'task-command',
      messages: [{ role: 'assistant' as const, text: '结果' }],
      taskFence: { taskId: 'task', attempt: 2, cancelEpoch: 0 },
    };
    await expect(s.appendTurn(input)).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect((await s.getBranch(branchId)).headSeq).toBe(0);
    await s.appendTurn({ ...input, taskFence: { taskId: 'task', attempt: 1, cancelEpoch: 0 } });
    expect(await s.one('SELECT status,draft_text FROM tasks WHERE id=?', 'task')).toMatchObject({
      status: 'completed',
      draft_text: '结果',
    });
    await s.run("UPDATE tasks SET status='cancelled' WHERE id=? AND status='running'", 'task');
    expect(await s.one('SELECT status FROM tasks WHERE id=?', 'task')).toMatchObject({
      status: 'completed',
    });
  });
  it('forks scene and memory at the chosen event, freezing later parent projections', async () => {
    const first = await s.appendTurn({
      branchId,
      sessionId,
      requestId: 'one',
      messages: [{ role: 'assistant', text: '小明在白云城' }],
      scene: { location: '白云城' },
    });
    const old = await s.propose(branchId, proposal(first.events[0]));
    const child = await s.fork({ branchId, atSeq: 1 });
    const next = await turn('作者纠正：小明其实在青川', 'correction');
    await s.correct(branchId, old.id, {
      value: '青川',
      text: '小明在青川',
      evidence: [proof(next)],
    });
    expect((await s.memories(child.id))[0].value).toBe('白云城');
    expect((await s.memories(branchId))[0].value).toBe('青川');
    expect((await s.getBranch(child.id)).scene).toEqual({ location: '白云城' });
  });
  it('keeps delayed extraction at its evidence prefix and scene validity is historical', async () => {
    const first = await turn('第5天小明住在白云城');
    const next = await turn('第10天小明搬到了青川');
    await s.propose(
      branchId,
      proposal(next, { value: '青川', text: '小明住在青川', validFrom: 10 }),
    );
    const older = await s.propose(branchId, proposal(first, { validFrom: 5 }));
    expect(older.recordedSeq).toBe(1);
    expect((await s.memories(branchId, { sceneTime: 6 }))[0].value).toBe('白云城');
    expect((await s.memories(branchId, { sceneTime: 11 }))[0].value).toBe('青川');
    const child = await s.fork({ branchId, atSeq: 1 });
    expect((await s.memories(child.id))[0].value).toBe('白云城');
  });
  it('tracks a contiguous extraction cursor when later jobs finish first', async () => {
    const e1 = await turn('第一幕'),
      e2 = await turn('第二幕');
    expect(
      (
        await s.extract(branchId, {
          eventIds: [e2.id],
          proposals: [proposal(e2, { kind: 'episode' })],
          cursor: 2,
        })
      ).cursor,
    ).toBe(0);
    expect(
      (
        await s.extract(branchId, {
          eventIds: [e1.id],
          proposals: [proposal(e1, { kind: 'episode' })],
          cursor: 2,
        })
      ).cursor,
    ).toBe(2);
    expect((await s.recall(branchId, '幕')).cursor).toBe(2);
    expect((await s.memories(branchId, { kinds: ['episode'] })).length).toBe(2);
  });
});

describe('evidence and character cognition', () => {
  it('validates exact Unicode code-point spans including emoji at the database layer', async () => {
    const e = await turn('😀小明在白云城');
    const evidence = proof(e, '小明');
    expect(evidence.start).toBe(1);
    const m = await s.propose(branchId, proposal(e, { evidence: [evidence] }));
    expect(m.evidence[0].quote).toBe('小明');
    await expect(
      s.propose(branchId, proposal(e, { evidence: [{ ...evidence, start: 2, end: 4 }] })),
    ).rejects.toMatchObject({ code: 'EXACT_SOURCE' });
    await expect(
      s.run(
        'INSERT INTO source_spans(id,source_id,source_version,source_generation,start_offset,end_offset,quote,created_at) VALUES(?,?,1,0,2,4,?,?)',
        'bad',
        e.sourceId,
        '小明',
        new Date().toISOString(),
      ),
    ).rejects.toThrow('SOURCE_FENCE_OR_QUOTE');
  });
  it('grants only a witnessed span and never shares the rest of its source', async () => {
    const e = await turn('小明看见白钥匙。秘密：红钥匙藏在地下。');
    await s.grantKnowledge({
      branchId,
      sourceId: e.sourceId,
      characterId: '小明',
      quote: '小明看见白钥匙。',
      channel: 'witnessed',
    });
    await s.propose(
      branchId,
      proposal(e, {
        predicate: 'seen',
        value: '白钥匙',
        text: '小明看见白钥匙',
        evidence: [proof(e, '小明看见白钥匙。')],
        knownBy: ['小明'],
      }),
    );
    await s.propose(
      branchId,
      proposal(e, {
        subject: '红钥匙',
        predicate: 'location',
        value: '地下',
        text: '红钥匙在地下',
        evidence: [proof(e, '秘密：红钥匙藏在地下。')],
        knownBy: ['小明'],
      }),
    );
    expect(await s.memories(branchId, { viewer: '小明' })).toHaveLength(1);
    expect((await s.readSourceSpan(branchId, e.sourceId, { viewer: '小明' })).text).not.toContain(
      '秘密',
    );
    await expect(
      s.readSourceSpan(branchId, e.sourceId, {
        viewer: '小明',
        start: 0,
        end: Array.from(e.text).length,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('distinguishes character belief from world truth and refuses model credibility scores', async () => {
    const e = await turn('甲说钥匙在仓库，乙相信了；钥匙实际上在井底。');
    await s.grantKnowledge({
      branchId,
      sourceId: e.sourceId,
      characterId: '乙',
      quote: '甲说钥匙在仓库，乙相信了',
      channel: 'told',
    });
    const belief = await s.propose(
      branchId,
      proposal(e, {
        kind: 'belief',
        subject: '钥匙',
        predicate: 'location',
        value: '仓库',
        observerId: '乙',
        text: '乙相信钥匙在仓库',
        knownBy: ['乙'],
        evidence: [proof(e, '甲说钥匙在仓库，乙相信了')],
        authority: 999,
        confidence: 1,
      }),
    );
    await s.propose(
      branchId,
      proposal(e, {
        subject: '钥匙',
        predicate: 'location',
        value: '井底',
        text: '钥匙在井底',
        evidence: [proof(e, '钥匙实际上在井底。')],
      }),
    );
    expect(belief.authority).toBe(70);
    expect(belief.confidence).toBe(0.85);
    expect((await s.memories(branchId, { viewer: '乙' })).map((m) => m.value)).toEqual(['仓库']);
    expect(await s.memories(branchId, { viewer: '甲' })).toEqual([]);
    expect((await s.memories(branchId)).length).toBe(2);
  });
  it('retrieves two-character Chinese names and respects a combined fact/source token budget', async () => {
    const e = await turn('小明在白云城喝茶');
    await s.propose(branchId, proposal(e));
    expect(searchTokens('小明')).toContain('小明');
    expect((await s.recall(branchId, '小明')).items.length).toBe(1);
    expect(await s.recall(branchId, '小明', { maxTokens: 1 })).toMatchObject({
      items: [],
      truncated: true,
    });
    const scores = rrf([['a', 'b'], ['b']]);
    expect(scores.get('b')!.score).toBeGreaterThan(scores.get('a')!.score);
  });
});

describe('correction, deletion, and stale derived work', () => {
  it('rejects observations prepared from a corrected fact and preserves accepted source guards', async () => {
    const e = await turn('小明在白云城'),
      m = await s.propose(branchId, proposal(e));
    const o = {
      branchId,
      cursor: 1,
      expectedMemoryIds: [m.id],
      proposals: [
        proposal(e, { kind: 'observation', predicate: 'summary', text: '小明的所在地是白云城' }),
      ],
    };
    await s.activateObservation(o);
    const fix = await turn('作者更正：小明在青川', 'correction');
    await s.correct(branchId, m.id, { text: '小明在青川', value: '青川', evidence: [proof(fix)] });
    await expect(s.activateObservation(o)).rejects.toMatchObject({ code: 'OBSERVATION_STALE' });
    expect(await s.memories(branchId, { kinds: ['observation'] })).toHaveLength(0);
  });
  it('forget prevents old-source re-extraction but is isolated from a prior fork', async () => {
    const e = await turn('小明在白云城'),
      m = await s.propose(branchId, proposal(e)),
      child = await s.fork({ branchId, atSeq: 1 });
    await s.forget(branchId, m.id);
    expect(await s.memories(branchId)).toHaveLength(0);
    expect(await s.memories(child.id)).toHaveLength(1);
    await expect(s.propose(branchId, proposal(e))).rejects.toMatchObject({
      code: 'FORGOTTEN_REPLAY',
    });
  });
  it('global source deletion scrubs text, spans, values, derivatives and old fenced commits', async () => {
    const secret = '机密咒语青鸾',
      e = await turn(secret),
      m = await s.propose(
        branchId,
        proposal(e, { value: secret, text: secret, data: { steps: [secret] } }),
      );
    await s.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [m.id],
      proposals: [
        proposal(e, { kind: 'observation', predicate: 'secret', text: secret, value: secret }),
      ],
    });
    const child = await s.fork({ branchId, atSeq: 1 }),
      epoch = await s.ownerEpoch();
    await s.deleteSource(e.sourceId);
    expect((await s.getEvents(branchId))[0]).toMatchObject({ text: '', deleted: true });
    expect(await s.memories(child.id)).toHaveLength(0);
    expect(
      JSON.stringify(
        await s.all('SELECT text,value_json,data_json,subject,predicate FROM memory_versions'),
      ),
    ).not.toContain(secret);
    expect(JSON.stringify(await s.all('SELECT quote FROM source_spans'))).not.toContain(secret);
    await expect(
      s.appendTurn({
        branchId,
        sessionId,
        requestId: 'late',
        ownerEpoch: epoch,
        sourceFence: [{ sourceId: e.sourceId, version: 1, generation: 0 }],
        messages: [{ role: 'assistant', text: '迟到剧情' }],
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(s.propose(branchId, proposal(e))).rejects.toMatchObject({
      code: 'SOURCE_DELETED',
    });
    expect(JSON.stringify(await s.exportStory(storyId))).not.toContain(secret);
  });
  it('keeps raw events and accepted memory versions immutable outside deletion scrubs', async () => {
    const e = await turn('小明在白云城'),
      m = await s.propose(branchId, proposal(e));
    await expect(s.run('UPDATE events SET role=? WHERE id=?', 'system', e.id)).rejects.toThrow(
      'IMMUTABLE_EVENT',
    );
    await expect(
      s.run('UPDATE memory_versions SET text=? WHERE id=?', '假记忆', m.id),
    ).rejects.toThrow('IMMUTABLE_MEMORY_VERSION');
  });
});

describe('experience, procedures and capabilities', () => {
  async function capability() {
    const e = await turn('小明已经掌握铁丝解锁能力');
    await s.setCapability({
      branchId,
      actorId: '小明',
      capability: '解锁',
      status: 'available',
      evidence: [proof(e)],
    });
  }
  async function experience(
    text: string,
    outcome: 'success' | 'failure' | 'partial' | 'unknown' = 'success',
    failureCategory?: 'method_counterexample' | 'precondition_mismatch',
  ) {
    const e = await turn(text);
    await s.grantKnowledge({
      branchId,
      sourceId: e.sourceId,
      characterId: '小明',
      channel: 'witnessed',
    });
    return s.addExperience({
      branchId,
      actorId: '小明',
      capability: '解锁',
      conditions: { tool: '铁丝' },
      steps: ['插入铁丝', '转动锁芯'],
      outcome,
      failureCategory,
      evidence: [proof(e)],
    });
  }
  it('requires two non-overlapping episode successes under the same method and conditions', async () => {
    await capability();
    const one = await experience('第一次小明用铁丝打开了锁');
    expect(one.procedure.status).toBe('draft');
    expect(one.procedure.data?.successes).toBe(1);
    const repeated = await s.addExperience({
      branchId,
      actorId: '小明',
      capability: '解锁',
      conditions: { tool: '铁丝' },
      steps: ['插入铁丝', '转动锁芯'],
      outcome: 'success',
      evidence: one.experience.evidence,
    });
    expect(repeated.procedure.status).toBe('draft');
    const two = await experience('第二次小明用铁丝打开了另一把锁');
    expect(two.procedure.status).toBe('active');
    expect(two.procedure.data?.successes).toBe(2);
  });
  it('records precondition failures separately and suspends a direct method counterexample', async () => {
    await capability();
    await experience('一把锁打开了');
    await experience('另一把锁打开了');
    const mismatch = await experience('缺少铁丝，所以无法尝试', 'failure', 'precondition_mismatch');
    expect(mismatch.procedure.status).toBe('active');
    const counterexample = await experience(
      '正确条件与步骤下铁丝折断，方法失败',
      'failure',
      'method_counterexample',
    );
    expect(counterexample.procedure.status).toBe('suspended');
    expect(counterexample.procedure.data?.counterexamples).toHaveLength(1);
  });
  it('does not count planned or unknown usage as successful experience', async () => {
    const one = await experience('用铁丝开锁成功'),
      two = await experience('再次用铁丝开锁成功');
    const before = (await s.memories(branchId, { kinds: ['experience'] })).length;
    await s.useProcedure({
      branchId,
      procedureId: two.procedure.id,
      phase: 'planned',
      outcome: 'success',
      evidence: [],
    });
    expect((await s.memories(branchId, { kinds: ['experience'] })).length).toBe(before);
    await s.useProcedure({
      branchId,
      procedureId: two.procedure.id,
      phase: 'applied',
      outcome: 'unknown',
      evidence: one.experience.evidence,
    });
    expect((await s.memories(branchId, { kinds: ['experience'] })).length).toBe(before);
  });
  it('stores capability acquisition separately and freezes it at a fork', async () => {
    const e = await turn('小明学会了初级火球术');
    await s.setCapability({
      branchId,
      actorId: '小明',
      capability: '火球术',
      status: 'available',
      data: { level: '初级' },
      evidence: [proof(e)],
    });
    const child = await s.fork({ branchId, atSeq: 1 });
    const loss = await turn('小明失去了火球术');
    await s.setCapability({
      branchId,
      actorId: '小明',
      capability: '火球术',
      status: 'lost',
      evidence: [proof(loss)],
    });
    expect((await s.capabilities(child.id))[0].status).toBe('available');
    expect((await s.capabilities(branchId))[0].status).toBe('lost');
    await s.deleteSource(e.sourceId);
    expect(await s.capabilities(child.id)).toHaveLength(0);
  });
});
