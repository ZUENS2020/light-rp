import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import type { Memory, QuerySpec } from '../src/shared/domain';
let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  sessionId: string,
  procedure: Memory;
const method = {
  actorId: 'actor',
  capability: '开锁',
  conditions: { tool: '钥匙' },
  steps: ['插入钥匙', '旋转'],
};
async function proof(text: string, role: 'assistant' | 'correction' = 'assistant') {
  const event = (
    await store.appendTurn({
      branchId,
      sessionId,
      requestId: crypto.randomUUID(),
      messages: [{ role, text }],
    })
  ).events[0]!;
  await store.grantKnowledge({
    branchId,
    sourceId: event.sourceId,
    characterId: 'actor',
    quote: text,
  });
  return { sourceId: event.sourceId, start: 0, end: Array.from(text).length, quote: text };
}
async function counts() {
  return {
    head: (await store.getBranch(branchId)).headSeq,
    epoch: await store.ownerEpoch(),
    events: (await store.all('SELECT id FROM events')).length,
    memories: (await store.all('SELECT id FROM memory_versions')).length,
    grants: (await store.all('SELECT id FROM knowledge_grants')).length,
    outbox: (await store.all('SELECT id FROM outbox')).length,
  };
}
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'status-owner');
  const world = await store.createWorld(),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  await store.setCapability({
    branchId,
    actorId: 'actor',
    capability: '开锁',
    status: 'available',
    evidence: [await proof('作者确认甲拥有开锁能力。', 'correction')],
  });
  for (let i = 0; i < 2; i++)
    procedure = (
      await store.addExperience({
        branchId,
        ...method,
        outcome: 'success',
        evidence: [await proof(`第${i + 1}次解锁成功。`)],
      })
    ).procedure;
});
afterEach(() => database.close());
const suspend = (options = { commandId: 'suspend-method', expectedHead: 3 }) =>
  store.setProcedureStatus(branchId, procedure.id, 'suspended', options);
describe('atomic procedure status changes', () => {
  it('commits the author event, exact evidence, actor knowledge and status in one transaction', async () => {
    const before = await counts(),
      result = await suspend();
    expect(result).toMatchObject({
      status: 'suspended',
      recordedSeq: 4,
      supersedesId: procedure.id,
      data: { manualStatus: 'suspended' },
    });
    expect(await store.ownerEpoch()).toBe(before.epoch + 1);
    expect(result.evidence.some((proof) => proof.quote === '作者将「开锁」标记为暂停。')).toBe(
      true,
    );
    expect(
      (
        await store.memories(branchId, {
          viewer: 'actor',
          kinds: ['procedure'],
          includeInactive: true,
        })
      )[0]?.id,
    ).toBe(result.id);
    const snapshot = await counts();
    expect((await store.setProcedureStatus(branchId, result.id, 'suspended')).id).toBe(result.id);
    expect(await counts()).toEqual(snapshot);
  });
  it('rolls back the event and all ledger changes if status projection insertion fails', async () => {
    const before = await counts();
    database.sqlite.exec(
      "CREATE TRIGGER reject_status BEFORE INSERT ON memory_versions WHEN NEW.id LIKE 'procedure_status_%' BEGIN SELECT RAISE(ABORT,'status-projection-failed'); END;",
    );
    await expect(suspend()).rejects.toThrow('status-projection-failed');
    expect(await counts()).toEqual(before);
  });
  it('rejects stale expected head without appending a management event', async () => {
    const before = await counts();
    await expect(suspend({ commandId: 'stale-suspend', expectedHead: 2 })).rejects.toMatchObject({
      code: 'STALE_WRITE',
    });
    expect(await counts()).toEqual(before);
  });
  it('replays one command and rejects a changed desired status', async () => {
    const first = await suspend(),
      before = await counts();
    expect((await suspend()).id).toBe(first.id);
    expect(await counts()).toEqual(before);
    await expect(
      store.setProcedureStatus(branchId, procedure.id, 'retired', {
        commandId: 'suspend-method',
        expectedHead: 3,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_REUSE' });
    expect(await counts()).toEqual(before);
  });
  it('does not let author controls bypass the two-independent-success requirement', async () => {
    const candidate = (
      await store.addExperience({
        branchId,
        ...method,
        steps: ['换一种动作'],
        outcome: 'success',
        evidence: [await proof('采用另一种动作解锁成功。')],
      })
    ).procedure;
    expect(candidate.status).toBe('draft');
    const before = await counts();
    await expect(store.setProcedureStatus(branchId, candidate.id, 'active')).rejects.toMatchObject({
      code: 'PROCEDURE_PROMOTION',
    });
    expect(await counts()).toEqual(before);
  });
  it('does not promote a method after losing its required capability', async () => {
    await store.setCapability({
      branchId,
      actorId: 'actor',
      capability: '开锁',
      status: 'lost',
      evidence: [await proof('作者确认甲失去开锁能力。', 'correction')],
    });
    const before = await counts();
    await expect(store.setProcedureStatus(branchId, procedure.id, 'active')).rejects.toMatchObject({
      code: 'PROCEDURE_PROMOTION',
    });
    expect(await counts()).toEqual(before);
  });
  it('does not reactivate a method with a confirmed counterexample', async () => {
    const failed = (
      await store.addExperience({
        branchId,
        ...method,
        outcome: 'failure',
        failureCategory: 'method_counterexample',
        evidence: [await proof('相同钥匙和步骤下，解锁方法确定失败。')],
      })
    ).procedure;
    const before = await counts();
    await expect(store.setProcedureStatus(branchId, failed.id, 'active')).rejects.toMatchObject({
      code: 'PROCEDURE_PROMOTION',
    });
    expect(await counts()).toEqual(before);
  });
  it('keeps the earlier active method in a branch forked before the status event', async () => {
    await suspend();
    const fork = await store.fork({ branchId, atSeq: 3 });
    expect((await store.memories(fork.id, { kinds: ['procedure'] }))[0]?.status).toBe('active');
    expect(await store.memories(branchId, { kinds: ['procedure'] })).toHaveLength(0);
  });
  it('retries unrelated background projection races without duplicating the author event', async () => {
    const before = await counts(),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => String(q.params?.[0]).startsWith('procedure_status_'))) {
        attempts++;
        if (attempts <= 2)
          await store.run(
            'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=?',
            branchId,
          );
      }
      return batch(specs);
    };
    const result = await suspend();
    expect(attempts).toBe(3);
    expect(result.status).toBe('suspended');
    const after = await counts();
    expect(after.events).toBe(before.events + 1);
    expect(after.head).toBe(before.head + 1);
    expect(after.epoch).toBe(before.epoch + 1);
    expect((await suspend()).id).toBe(result.id);
    expect(await counts()).toEqual(after);
  });
  it('bounds retries and leaves no author event when projection contention persists', async () => {
    const before = await counts(),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => String(q.params?.[0]).startsWith('procedure_status_'))) {
        attempts++;
        await store.run(
          'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=?',
          branchId,
        );
      }
      return batch(specs);
    };
    await expect(suspend()).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(attempts).toBe(4);
    expect(await counts()).toEqual(before);
  });
  it('does not retry or bypass expectedHead after a concurrent plot commit', async () => {
    const before = await counts(),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => String(q.params?.[0]).startsWith('procedure_status_'))) {
        attempts++;
        if (attempts === 1)
          await store.appendTurn({
            branchId,
            sessionId,
            requestId: 'other-plot-turn',
            messages: [{ role: 'assistant', text: '另一个回合已提交。' }],
          });
      }
      return batch(specs);
    };
    await expect(suspend()).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(attempts).toBe(1);
    expect((await counts()).events).toBe(before.events + 1);
    expect(await store.ownerEpoch()).toBe(before.epoch);
    expect((await store.memories(branchId, { kinds: ['procedure'] }))[0]?.id).toBe(procedure.id);
  });
  it('does not retry if background evidence changes the targeted procedure', async () => {
    const before = await counts(),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => String(q.params?.[0]).startsWith('procedure_status_'))) {
        attempts++;
        if (attempts === 1)
          await store.propose(branchId, {
            memoryKey: procedure.memoryKey,
            kind: 'procedure',
            subject: procedure.subject,
            predicate: procedure.predicate,
            value: procedure.value,
            text: procedure.text,
            evidence: procedure.evidence,
            knownBy: procedure.knownBy,
            data: { ...procedure.data, successes: 3 },
          });
      }
      return batch(specs);
    };
    await expect(suspend()).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(attempts).toBe(1);
    expect((await counts()).events).toBe(before.events);
    expect(await store.ownerEpoch()).toBe(before.epoch);
    expect(
      await store.all("SELECT id FROM memory_versions WHERE id LIKE 'procedure_status_%'"),
    ).toHaveLength(0);
  });
  it('does not retry activation after the required capability changes', async () => {
    const suspended = await suspend(),
      before = await counts(),
      batch = store.batch.bind(store);
    const originalProof = (await store.getEvents(branchId))[0]!;
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => String(q.params?.[0]).startsWith('procedure_status_'))) {
        attempts++;
        if (attempts === 1)
          await store.setCapability({
            branchId,
            actorId: 'actor',
            capability: '开锁',
            status: 'lost',
            evidence: [
              {
                sourceId: originalProof.sourceId,
                start: 0,
                end: Array.from(originalProof.text).length,
                quote: originalProof.text,
              },
            ],
          });
      }
      return batch(specs);
    };
    await expect(
      store.setProcedureStatus(branchId, suspended.id, 'active', {
        commandId: 'reactivate-method',
        expectedHead: 4,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(attempts).toBe(1);
    expect((await counts()).events).toBe(before.events);
    expect(await store.ownerEpoch()).toBe(before.epoch);
  });
});
