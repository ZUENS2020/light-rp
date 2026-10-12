import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import type { Memory, QuerySpec } from '../src/shared/domain';

let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  sessionId: string,
  original: Memory;
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'author-owner');
  const world = await store.createWorld(),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  const turn = await store.appendTurn({
    branchId,
    sessionId,
    requestId: 'initial-turn',
    messages: [{ role: 'assistant', text: '仓库里有红钥匙。' }],
  });
  const source = turn.events[0]!;
  original = await store.propose(branchId, {
    kind: 'canon',
    subject: 'key',
    predicate: 'color',
    text: source.text,
    value: '红',
    evidence: [
      {
        sourceId: source.sourceId,
        start: 0,
        end: Array.from(source.text).length,
        quote: source.text,
      },
    ],
  });
});
afterEach(() => database.close());
const correction = (overrides: Partial<Parameters<Store['authorCorrection']>[0]> = {}) =>
  store.authorCorrection({
    branchId,
    sessionId,
    commandId: 'author-blue-key',
    expectedHead: 1,
    memoryId: original.id,
    text: '作者纠正：钥匙是蓝色。',
    value: '蓝',
    ...overrides,
  });
async function counts() {
  return {
    events: (await store.all('SELECT id FROM events')).length,
    sources: (await store.all('SELECT id FROM sources')).length,
    memories: (await store.all('SELECT id FROM memory_versions')).length,
    outbox: (await store.all('SELECT id FROM outbox')).length,
    head: (await store.getBranch(branchId)).headSeq,
    epoch: await store.ownerEpoch(),
  };
}

describe('atomic author corrections', () => {
  it('commits source, authority revision, supersession and next-epoch outbox together', async () => {
    const oldEpoch = await store.ownerEpoch(),
      result = await correction();
    expect(result).toMatchObject({
      value: '蓝',
      authority: 100,
      recordedSeq: 2,
      supersedesId: original.id,
      data: { correction: true },
    });
    expect(result.evidence[0]?.quote).toBe('作者纠正：钥匙是蓝色。');
    expect((await store.memories(branchId, { kinds: ['canon'] })).map((m) => m.id)).toEqual([
      result.id,
    ]);
    expect(await store.ownerEpoch()).toBe(oldEpoch + 1);
    const outboxes = await store.all<{ payload_json: string }>(
      "SELECT payload_json FROM outbox WHERE kind='memory' ORDER BY rowid",
    );
    expect(JSON.parse(outboxes.at(-1)!.payload_json)).toMatchObject({
      ownerEpoch: oldEpoch + 1,
      throughSeq: 2,
    });
  });
  it('rolls back the event, head, sources, epoch and outbox when memory insertion fails', async () => {
    const before = await counts();
    database.sqlite.exec(
      "CREATE TRIGGER reject_author_projection BEFORE INSERT ON memory_versions WHEN NEW.id LIKE 'correction_%' BEGIN SELECT RAISE(ABORT,'test-projection-failure'); END;",
    );
    await expect(correction()).rejects.toThrow('test-projection-failure');
    expect(await counts()).toEqual(before);
    expect((await store.memories(branchId))[0]?.id).toBe(original.id);
  });
  it('rejects a stale event head without partial writes', async () => {
    const before = await counts();
    await expect(correction({ expectedHead: 0 })).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await counts()).toEqual(before);
  });
  it('rejects a projection race before appending the author source', async () => {
    const before = await counts(),
      batch = store.batch.bind(store);
    let inject = true;
    store.batch = async (specs: QuerySpec[]) => {
      if (inject) {
        inject = false;
        await store.run(
          'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=?',
          branchId,
        );
      }
      return batch(specs);
    };
    await expect(correction()).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await counts()).toEqual(before);
  });
  it('replays one command once, rejects reused payload and preserves explicit null', async () => {
    const first = await correction({ value: null }),
      before = await counts();
    expect(first.value).toBeNull();
    const replay = await correction({ value: null });
    expect(replay.id).toBe(first.id);
    expect(await counts()).toEqual(before);
    await expect(correction({ value: '绿' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_REUSE' });
    expect(await counts()).toEqual(before);
  });
  it('does not create any event for an invalid or cross-story target', async () => {
    const before = await counts();
    await expect(correction({ memoryId: 'unknown-memory' })).rejects.toMatchObject({
      code: 'MEMORY_NOT_CURRENT',
    });
    expect(await counts()).toEqual(before);
    const world = await store.createWorld(),
      story = await store.createStory({ worldId: world.id }),
      session = await store.createSession({ branchId: story.branchId });
    const otherBefore = await counts();
    await expect(
      correction({
        branchId: story.branchId,
        sessionId: session.id,
        memoryId: original.id,
        expectedHead: 0,
      }),
    ).rejects.toMatchObject({ code: 'MEMORY_NOT_CURRENT' });
    expect(await counts()).toEqual(otherBefore);
  });
  it('records dependent invalidation at the correction event so an earlier fork remains valid', async () => {
    const observation = await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [original.id],
      proposals: [
        {
          kind: 'observation',
          subject: 'director',
          predicate: 'scene',
          value: '红钥匙',
          text: '仓库里有红钥匙。',
          evidence: original.evidence,
          memoryKey: 'scene-summary',
        },
      ],
    });
    await correction();
    expect(await store.memories(branchId, { kinds: ['observation'] })).toHaveLength(0);
    const fork = await store.fork({ branchId, atSeq: 1 });
    expect((await store.memories(fork.id, { kinds: ['observation'] })).map((m) => m.id)).toEqual(
      observation.accepted,
    );
    expect((await store.memories(fork.id, { kinds: ['canon'] }))[0]?.value).toBe('红');
  });
  it('supports a new author rule and fences an older in-flight generation', async () => {
    const oldEpoch = await store.ownerEpoch();
    const rule = await correction({
      memoryId: undefined,
      subjectId: 'world',
      predicate: 'magic',
      text: '作者设定：此世界不能使用魔法。',
      value: false,
    });
    expect(rule).toMatchObject({
      kind: 'canon',
      subject: 'world',
      predicate: 'magic',
      value: false,
      authority: 100,
    });
    const before = await counts();
    await expect(
      store.appendTurn({
        branchId,
        sessionId,
        requestId: 'late-generator',
        expectedHead: 2,
        ownerEpoch: oldEpoch,
        messages: [{ role: 'assistant', text: '红钥匙又出现了。' }],
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await counts()).toEqual(before);
  });
  it('resolves a unique subject/predicate target and invalidates its observations', async () => {
    await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [original.id],
      proposals: [
        {
          kind: 'observation',
          subject: 'director',
          predicate: 'colors',
          text: original.text,
          value: original.text,
          evidence: original.evidence,
        },
      ],
    });
    const result = await correction({ memoryId: undefined, subjectId: 'key', predicate: 'color' });
    expect(result.supersedesId).toBe(original.id);
    expect(await store.memories(branchId, { kinds: ['observation'] })).toHaveLength(0);
  });
  it('requires memoryId for ambiguous multi-value relations instead of guessing a target', async () => {
    for (const value of ['乙', '丙'])
      await store.propose(branchId, {
        kind: 'relation',
        subject: '甲',
        predicate: '朋友',
        value,
        text: `甲和${value}是朋友`,
        evidence: original.evidence,
      });
    const before = await counts();
    await expect(
      correction({ memoryId: undefined, subjectId: '甲', predicate: '朋友' }),
    ).rejects.toMatchObject({ code: 'CORRECTION_AMBIGUOUS', status: 422 });
    expect(await counts()).toEqual(before);
  });
  it('updates and corrects an older fact beyond the first 1000 listing results', async () => {
    // Seed valid versions with the original exact proof to exercise a large
    // projection without coupling this regression to the extraction model.
    database.sqlite
      .exec(`WITH RECURSIVE filler(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM filler WHERE n<1001)
      INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key)
      SELECT m.id||'-filler-'||n,m.owner_id,m.story_id,m.branch_id,'filler:'||n,m.kind,'filler-'||n,m.predicate,m.value_json,m.text,m.search_text,m.known_by_json,m.observer_id,m.authority,m.confidence,m.valid_from,m.valid_to,m.origin_seq,m.recorded_seq,m.recorded_at,1,NULL,m.status,m.data_json,'filler-idem:'||n FROM memory_versions m CROSS JOIN filler WHERE m.id='${original.id}';
      INSERT INTO memory_evidence(memory_id,span_id) SELECT m.id,e.span_id FROM memory_versions m JOIN memory_evidence e ON e.memory_id='${original.id}' WHERE m.id LIKE '${original.id}-filler-%';`);
    expect((await store.memories(branchId)).some((m) => m.id === original.id)).toBe(false);
    const revised = await store.propose(branchId, {
      kind: 'canon',
      subject: 'key',
      predicate: 'color',
      text: original.text,
      value: '红',
      evidence: original.evidence,
      idempotencyKey: 'large-projection-revision',
    });
    expect(revised.supersedesId).toBe(original.id);
    expect(revised.revision).toBe(2);
    const corrected = await correction({
      memoryId: undefined,
      subjectId: 'key',
      predicate: 'color',
    });
    expect(corrected.supersedesId).toBe(revised.id);
    expect(corrected.revision).toBe(3);
    expect(
      (await store.memories(branchId, { kinds: ['canon'] })).find((m) => m.subject === 'key')
        ?.value,
    ).toBe('蓝');
  });
});
