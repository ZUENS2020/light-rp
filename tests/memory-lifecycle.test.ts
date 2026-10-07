import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import type { Evidence, ExperienceInput, MemoryProposal } from '../src/shared/domain';

let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  sessionId: string,
  storyId: string;
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'owner');
  const world = await store.createWorld('世界'),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  storyId = story.id;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => database.close());
async function event(text: string, role: 'assistant' | 'correction' = 'assistant') {
  return (
    await store.appendTurn({
      branchId,
      sessionId,
      requestId: crypto.randomUUID(),
      messages: [{ role, text }],
    })
  ).events[0];
}
function proof(source: { sourceId: string; text: string }, quote = source.text): Evidence {
  const start = Array.from(source.text.slice(0, source.text.indexOf(quote))).length;
  return { sourceId: source.sourceId, start, end: start + Array.from(quote).length, quote };
}
function fact(
  source: { sourceId: string; text: string },
  extra: Partial<MemoryProposal> = {},
): MemoryProposal {
  return {
    kind: 'canon',
    subject: '小明',
    predicate: 'location',
    value: '白云城',
    text: '小明在白云城',
    evidence: [proof(source)],
    ...extra,
  };
}
const method = {
  actorId: '小明',
  capability: '解锁',
  conditions: { tool: '铁丝' },
  steps: ['插入铁丝', '转动锁芯'],
};
async function capability() {
  const source = await event('作者确认小明有铁丝解锁能力', 'correction');
  return store.addCapability({
    branchId,
    ...method,
    status: 'available',
    evidence: [proof(source)],
  });
}
async function experience(text: string, extra: Partial<ExperienceInput> = {}) {
  const source = await event(text);
  return store.addExperience({
    branchId,
    ...method,
    outcome: 'success',
    evidence: [proof(source)],
    ...extra,
  });
}

describe('memory lifecycle transaction regressions', () => {
  it('uses the span ledger for later knowledge acquisition and revocation, with frozen fork grants', async () => {
    const source = await event('白钥匙在桌上。秘密红钥匙在地下。'),
      memory = await store.propose(
        branchId,
        fact(source, {
          subject: '白钥匙',
          predicate: 'location',
          value: '桌上',
          evidence: [proof(source, '白钥匙在桌上。')],
        }),
      ),
      child = await store.fork({ branchId, atSeq: 1 });
    expect(await store.memories(branchId, { viewer: '小明' })).toHaveLength(0);
    await event('作者补充角色知情');
    await store.grantKnowledge({
      branchId,
      sourceId: source.sourceId,
      characterId: '小明',
      quote: '白钥匙在桌上。',
      channel: 'author',
    });
    expect((await store.memories(branchId, { viewer: '小明' })).map((m) => m.id)).toEqual([
      memory.id,
    ]);
    expect(await store.memories(branchId, { viewer: '小明', asOfSeq: 1 })).toHaveLength(0);
    expect(await store.memories(child.id, { viewer: '小明' })).toHaveLength(0);
    expect((await store.readSourceSpan(branchId, source.sourceId, { viewer: '小明' })).text).toBe(
      '白钥匙在桌上。',
    );
    await store.grantKnowledge({
      branchId,
      sourceId: source.sourceId,
      characterId: '小明',
      quote: '白钥匙在桌上。',
      channel: 'author',
      status: 'revoke',
    });
    expect(await store.memories(branchId, { viewer: '小明' })).toHaveLength(0);
  });
  it('records delayed witnessed knowledge at its source event and blocks old deletion epochs', async () => {
    const source = await event('小明看见白钥匙'),
      memory = await store.propose(branchId, fact(source)),
      epoch = await store.ownerEpoch();
    await event('第二回合');
    await event('第三回合');
    const grant = await store.grantKnowledge({
      branchId,
      sourceId: source.sourceId,
      characterId: '小明',
      channel: 'witnessed',
      ownerEpoch: epoch,
    });
    expect(grant.acquiredSeq).toBe(1);
    const child = await store.fork({ branchId, atSeq: 1 });
    expect((await store.memories(child.id, { viewer: '小明' })).map((m) => m.id)).toEqual([
      memory.id,
    ]);
    await store.forget(branchId, memory.id);
    await expect(
      store.grantKnowledge({
        branchId,
        sourceId: source.sourceId,
        characterId: '乙',
        channel: 'author',
        ownerEpoch: epoch,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(
      store.addCapability({
        branchId,
        actorId: '小明',
        capability: '火球术',
        status: 'available',
        evidence: [proof(source)],
        ownerEpoch: epoch,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(
      store.addExperience({
        branchId,
        ...method,
        outcome: 'success',
        evidence: [proof(source)],
        ownerEpoch: epoch,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
  });
  it('preserves immutable evidence through ordinary observation compression, then invalidates explicit corrections', async () => {
    const source = await event('小明在白云城'),
      atomic = await store.propose(branchId, fact(source));
    const first = await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [atomic.id],
      proposals: [
        fact(source, { kind: 'observation', predicate: 'summary', text: '小明位于白云城' }),
      ],
    });
    const dependent = await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [first.accepted[0]],
      proposals: [
        fact(source, {
          kind: 'observation',
          subject: '故事',
          predicate: 'continuity',
          text: '小明的旅程从白云城开始',
        }),
      ],
    });
    await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [atomic.id],
      proposals: [
        fact(source, {
          kind: 'observation',
          predicate: 'summary',
          text: '白云城是小明此时的所在地',
        }),
      ],
    });
    expect((await store.memories(branchId, { kinds: ['observation'] })).map((m) => m.id)).toContain(
      dependent.accepted[0],
    );
    const correction = await event('作者更正小明其实在青川', 'correction');
    await store.correct(branchId, atomic.id, {
      value: '青川',
      text: '小明在青川',
      evidence: [proof(correction)],
    });
    expect(await store.memories(branchId, { kinds: ['observation'] })).toHaveLength(0);
  });
  it('keeps materialized heads consistent with delayed valid time and forget does not resurrect an older version', async () => {
    const early = await event('第5天在白云城'),
      later = await event('第10天在青川'),
      current = await store.propose(
        branchId,
        fact(later, { value: '青川', text: '小明在青川', validFrom: 10 }),
      );
    await store.propose(branchId, fact(early, { validFrom: 5 }));
    expect(
      await store.one(
        'SELECT memory_id FROM memory_heads WHERE branch_id=? AND memory_key=?',
        branchId,
        current.memoryKey,
      ),
    ).toMatchObject({ memory_id: current.id });
    await store.activateObservation({
      branchId,
      cursor: 2,
      expectedMemoryIds: [current.id],
      proposals: [fact(later, { kind: 'observation', value: '青川', text: '当前小明在青川' })],
    });
    await store.forget(branchId, current.id);
    expect(await store.memories(branchId)).toHaveLength(0);
    expect(await store.memories((await store.fork({ branchId, atSeq: 2 })).id)).toHaveLength(0);
  });
  it('replays observation activation without duplicate versions and does not advance the ingest cursor', async () => {
    const source = await event('小明在白云城'),
      atomic = await store.propose(branchId, fact(source)),
      input = {
        branchId,
        cursor: 1,
        extractorVersion: 'v3-observer',
        expectedMemoryIds: [atomic.id],
        proposals: [fact(source, { kind: 'observation', predicate: 'summary' })],
      };
    const first = await store.activateObservation(input),
      again = await store.activateObservation(input);
    expect(again).toMatchObject({
      batchId: first.batchId,
      accepted: first.accepted,
      replayed: true,
    });
    expect(await store.all('SELECT * FROM observation_batches')).toHaveLength(1);
    expect(await store.memories(branchId, { kinds: ['observation'] })).toHaveLength(1);
    expect((await store.recall(branchId, '白云城')).cursor).toBe(0);
  });
  it('queues a child prefix rebuild and excludes late parent extraction until rebuilt in the child', async () => {
    const source = await event('小明在白云城'),
      child = await store.fork({ branchId, atSeq: 1 });
    await store.propose(branchId, fact(source));
    expect(await store.memories(child.id)).toHaveLength(0);
    const job = await store.one<{ payload_json: string }>(
      'SELECT payload_json FROM outbox WHERE branch_id=? AND kind=?',
      child.id,
      'memory',
    );
    expect(JSON.parse(job!.payload_json)).toMatchObject({
      branchId: child.id,
      parentBranchId: branchId,
      throughSeq: 1,
      rebuild: true,
    });
    await store.extract(child.id, { eventIds: [source.id], proposals: [fact(source)], cursor: 1 });
    expect((await store.memories(child.id))[0].value).toBe('白云城');
  });
  it('scrubs completed and active task bodies before the source deletion transaction returns', async () => {
    const secret = '被删除的秘密',
      source = await event(secret),
      at = new Date().toISOString();
    for (const status of ['running', 'completed'])
      await store.run(
        'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,status,input_json,config_json,context_json,draft_text,error_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        status,
        store.ownerId,
        branchId,
        sessionId,
        status,
        status,
        JSON.stringify({ text: secret }),
        '{}',
        JSON.stringify({ source: secret }),
        secret,
        JSON.stringify({ message: secret }),
        at,
        at,
      );
    await store.deleteSource(source.sourceId);
    const tasks = await store.all(
      'SELECT status,input_json,context_json,draft_text,error_json FROM tasks',
    );
    expect(JSON.stringify(tasks)).not.toContain(secret);
    expect(tasks.find((t) => t.status === 'cancelled')).toBeTruthy();
    expect(tasks.find((t) => t.status === 'completed')).toBeTruthy();
  });
  it('scrubs current and historical derived scenes in the source story without touching other worlds', async () => {
    const secret = '地下秘密入口',
      result = await store.appendTurn({
        branchId,
        sessionId,
        requestId: 'scene-secret',
        messages: [{ role: 'assistant', text: secret }],
        scene: { location: secret },
      }),
      child = await store.fork({ branchId, atSeq: 1 }),
      otherWorld = await store.createWorld('独立世界'),
      otherStory = await store.createStory({ worldId: otherWorld.id }),
      otherSession = await store.createSession({ branchId: otherStory.branchId });
    await store.appendTurn({
      branchId: otherStory.branchId,
      sessionId: otherSession.id,
      requestId: 'other-scene',
      messages: [{ role: 'assistant', text: '海岛' }],
      scene: { location: '海岛' },
    });
    await store.deleteSource(result.events[0].sourceId);
    expect((await store.getBranch(branchId)).scene).toEqual({});
    expect((await store.getBranch(child.id)).scene).toEqual({});
    expect(await store.sceneAsOf(branchId, 1)).toEqual({});
    expect(JSON.stringify(await store.exportStory(storyId))).not.toContain(secret);
    expect((await store.getBranch(otherStory.branchId)).scene).toEqual({ location: '海岛' });
  });
  it('accepts resolved vector candidates only after branch and viewer authorization', async () => {
    const source = await event('门后的秘密'),
      memory = await store.propose(
        branchId,
        fact(source, { subject: '秘钥', predicate: 'hidden', text: '隐秘密码蓝天' }),
      );
    expect(
      (
        await store.recall(branchId, 'unmatched query', {
          vectorCandidates: [{ id: memory.id, score: 0.9 }],
        })
      ).items.map((i) => i.memory.id),
    ).toEqual([memory.id]);
    expect(
      (
        await store.recall(branchId, 'unmatched query', {
          viewer: '小明',
          vectorCandidates: [{ id: memory.id, score: 0.9 }],
        })
      ).items,
    ).toHaveLength(0);
  });
  it('exports all event pages beyond the normal contextual window', async () => {
    for (let round = 0; round < 101; round++)
      await store.appendTurn({
        branchId,
        sessionId,
        requestId: `export-${round}`,
        messages: Array.from({ length: 20 }, (_, i) => ({
          role: 'assistant',
          text: `独立事件 ${round * 20 + i}`,
        })),
      });
    const archive = await store.exportStory(storyId);
    expect(archive.events).toHaveLength(2020);
    expect(archive.events.at(-1)?.text).toBe('独立事件 2019');
  });
});

describe('procedure evidence and replay regressions', () => {
  it('does not invent a capability from two successful outcomes and rejects manual promotion', async () => {
    await experience('第一次打开了门');
    const two = await experience('第二次打开了门');
    expect(two.procedure.data?.successes).toBe(2);
    expect(two.procedure.status).toBe('draft');
    expect(await store.listCapabilities(branchId)).toHaveLength(0);
    await expect(
      store.setProcedureStatus(branchId, two.procedure.id, 'active'),
    ).rejects.toMatchObject({ code: 'PROCEDURE_PROMOTION' });
  });
  it('counts different assistant spans of one committed attempt once', async () => {
    await capability();
    const result = await store.appendTurn({
      branchId,
      sessionId,
      requestId: 'one-attempt',
      messages: [
        { role: 'assistant', text: '开门成功' },
        { role: 'assistant', text: '开门结果再次确认' },
      ],
    });
    await store.addExperience({
      branchId,
      ...method,
      outcome: 'success',
      evidence: [proof(result.events[0])],
    });
    const repeated = await store.addExperience({
      branchId,
      ...method,
      outcome: 'success',
      evidence: [proof(result.events[1])],
    });
    expect(repeated.procedure.data?.successes).toBe(1);
    expect(repeated.procedure.status).toBe('draft');
  });
  it('blocks promotion on an unresolved failure while stochastic outcomes do not suspend the method', async () => {
    await capability();
    await experience('一次成功');
    const promoted = await experience('二次成功');
    expect(promoted.procedure.status).toBe('active');
    const stochastic = await experience('外部偶然风暴使本次失败', {
      outcome: 'failure',
      failureCategory: 'stochastic_outcome',
    });
    expect(stochastic.procedure.status).toBe('active');
    const unresolved = await experience('发生未解释的失败', {
      outcome: 'failure',
      failureCategory: 'unresolved',
    });
    expect(unresolved.procedure.status).toBe('draft');
    await expect(
      store.setProcedureStatus(branchId, unresolved.procedure.id, 'active'),
    ).rejects.toMatchObject({ code: 'PROCEDURE_PROMOTION' });
  });
  it('does not resurrect a capability on replay after an explicit loss', async () => {
    const acquired = await capability(),
      loss = await event('作者确认能力已经丧失', 'correction');
    await store.addCapability({ branchId, ...method, status: 'lost', evidence: [proof(loss)] });
    await store.addCapability({
      branchId,
      ...method,
      status: 'available',
      evidence: acquired.evidence,
    });
    expect((await store.listCapabilities(branchId))[0].status).toBe('lost');
  });
  it('repairs a crash after a procedure use committed, keeping one use and one execution experience', async () => {
    await capability();
    const first = await experience('第一次方法成功'),
      source = await event('第二次执行成功。结果确认成功。'),
      input = {
        branchId,
        procedureId: first.procedure.id,
        revisionId: first.procedure.id,
        phase: 'applied' as const,
        outcome: 'success' as const,
        evidence: [proof(source, '第二次执行成功。')],
      },
      original = store.memory.addExperience.bind(store.memory);
    store.memory.addExperience = async () => {
      throw new Error('simulated crash after the real ledger transaction');
    };
    await expect(store.useProcedure(input)).rejects.toThrow('simulated crash');
    expect(await store.all('SELECT * FROM procedure_uses')).toHaveLength(1);
    store.memory.addExperience = original;
    const repaired = await store.useProcedure(input);
    expect(repaired).toMatchObject({ replayed: true, procedure: { status: 'active' } });
    const again = await store.useProcedure({
      ...input,
      evidence: [proof(source, '结果确认成功。')],
    });
    expect(again.id).toBe(repaired.id);
    expect(await store.all('SELECT * FROM procedure_uses')).toHaveLength(1);
    expect(await store.memories(branchId, { kinds: ['experience'] })).toHaveLength(2);
  });
});

describe('default memory identity includes complete semantic evidence', () => {
  it('creates a revision when method data changes while prose and source remain the same', async () => {
    const source = await event('甲把钥匙插入锁孔，门打开了。');
    const proposal: MemoryProposal = {
      kind: 'procedure',
      subject: '甲',
      predicate: '开锁',
      value: '开锁',
      text: '使用钥匙开锁',
      evidence: [proof(source)],
      data: { steps: ['插入钥匙'], successes: 2 },
    };
    const first = await store.propose(branchId, proposal);
    const second = await store.propose(branchId, {
      ...proposal,
      data: { steps: ['插入钥匙', '旋转'], successes: 3 },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.revision).toBe(first.revision + 1);
    expect(second.supersedesId).toBe(first.id);
    expect(second.data).toEqual({ steps: ['插入钥匙', '旋转'], successes: 3 });
    expect((await store.memoryVersions(branchId, second.id)).map((m) => m.id)).toEqual([
      first.id,
      second.id,
    ]);
  });
  it('replays unordered multi-source proof without duplicate versions or changing the episode key', async () => {
    const firstSource = await event('甲确认钥匙在仓库。'),
      secondSource = await event('乙也确认钥匙在仓库。');
    const proposal: MemoryProposal = {
      kind: 'episode',
      subject: '钥匙',
      predicate: 'location-proof',
      value: '仓库',
      text: '两人确认钥匙位置',
      evidence: [proof(firstSource), proof(secondSource)],
      data: { witnesses: ['甲', '乙'] },
    };
    const first = await store.propose(branchId, proposal),
      count = (await store.all('SELECT id FROM memory_versions')).length;
    const repeated = await store.propose(branchId, {
      ...proposal,
      evidence: [...proposal.evidence].reverse(),
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.memoryKey).toBe(first.memoryKey);
    expect((await store.all('SELECT id FROM memory_versions')).length).toBe(count);
  });
  it('distinguishes exact evidence spans from the same source without random span IDs in identity', async () => {
    const source = await event('甲确认白钥匙在桌上。乙也确认白钥匙在桌上。');
    const proposal: MemoryProposal = {
      kind: 'episode',
      subject: '钥匙',
      predicate: 'location-proof',
      value: '桌上',
      text: '确认钥匙位置',
      evidence: [proof(source, '甲确认白钥匙在桌上。')],
    };
    const first = await store.propose(branchId, proposal);
    const secondProposal = { ...proposal, evidence: [proof(source, '乙也确认白钥匙在桌上。')] };
    const second = await store.propose(branchId, secondProposal);
    expect(second.id).not.toBe(first.id);
    expect(second.supersedesId).toBe(first.id);
    expect((await store.propose(branchId, secondProposal)).id).toBe(second.id);
    expect(await store.all('SELECT id FROM memory_versions')).toHaveLength(2);
  });
  it('preserves caller supplied idempotency keys when a replay changes optional data', async () => {
    const source = await event('甲使用钥匙打开门。');
    const proposal: MemoryProposal = {
      kind: 'episode',
      subject: '甲',
      predicate: '开门',
      value: '成功',
      text: source.text,
      evidence: [proof(source)],
      data: { successes: 1 },
      idempotencyKey: 'explicit-extraction-step',
    };
    const first = await store.propose(branchId, proposal);
    const repeated = await store.propose(branchId, { ...proposal, data: { successes: 2 } });
    expect(repeated.id).toBe(first.id);
    expect(repeated.data).toEqual({ successes: 1 });
    expect(await store.all('SELECT id FROM memory_versions')).toHaveLength(1);
  });
});
