import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store, now } from '../src/server/store';
import type { Memory } from '../src/shared/domain';
let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  storyId: string,
  sessionId: string,
  memory: Memory;
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'export-owner');
  const world = await store.createWorld(),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  storyId = story.id;
  sessionId = (await store.createSession({ branchId })).id;
  const turn = await store.appendTurn({
    branchId,
    sessionId,
    requestId: 'old-key',
    messages: [{ role: 'assistant', text: '钥匙是红色。' }],
  });
  const event = turn.events[0]!;
  memory = await store.propose(branchId, {
    kind: 'canon',
    subject: 'key',
    predicate: 'color',
    text: event.text,
    value: '红',
    evidence: [
      { sourceId: event.sourceId, start: 0, end: Array.from(event.text).length, quote: event.text },
    ],
  });
});
afterEach(() => database.close());
describe('complete story audit exports', () => {
  it('exports immutable revision history, dependencies, lineage watermarks and card versions', async () => {
    await store.activateObservation({
      branchId,
      cursor: 1,
      expectedMemoryIds: [memory.id],
      proposals: [
        {
          kind: 'observation',
          subject: 'director',
          predicate: 'scene',
          text: memory.text,
          value: memory.text,
          evidence: memory.evidence,
        },
      ],
    });
    const corrected = await store.authorCorrection({
      branchId,
      sessionId,
      commandId: 'export-blue',
      expectedHead: 1,
      memoryId: memory.id,
      text: '作者纠正：钥匙是蓝色。',
      value: '蓝',
    });
    const fork = await store.fork({ branchId, atSeq: 1 });
    const at = now();
    await store.run(
      'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,png_key,created_at,updated_at)VALUES(?,?,?,?,?,?,?,?,?,?)',
      'card',
      store.ownerId,
      'character',
      '测试角色',
      2,
      '{}',
      '{}',
      'png/current',
      at,
      at,
    );
    await store.run(
      'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,png_key,created_at) VALUES(?,?,?,?,?,?,?)',
      'card-v1',
      'card',
      1,
      '{"unknown":true}',
      '{}',
      'png/original',
      at,
    );
    await store.run(
      'INSERT INTO resource_bindings(id,owner_id,branch_id,asset_id,revision,kind,recorded_seq,created_at) VALUES(?,?,?,?,?,?,?,?)',
      'binding',
      store.ownerId,
      branchId,
      'card',
      1,
      'character',
      0,
      at,
    );
    const archive = await store.exportStory(storyId);
    expect(archive.memories.map((m) => m.id)).toContain(memory.id);
    expect(archive.memories.map((m) => m.id)).toContain(corrected.id);
    expect(archive.memoryDependencies).toHaveLength(1);
    expect(
      archive.lineage?.some((row) => row.branch_id === fork.id && row.max_memory_rowid != null),
    ).toBe(true);
    expect(archive.memoryRows?.every((row) => Number.isInteger(row.rowid))).toBe(true);
    expect(archive.assetRevisions).toMatchObject([
      { id: 'card-v1', revision: 1, raw_json: '{"unknown":true}' },
    ]);
    expect(archive.attachments).toEqual([
      { key: 'png/original', kind: 'character-png', included: false },
    ]);
    expect(archive.resourceBindings).toMatchObject([{ asset_id: 'card', revision: 1 }]);
  });
  it('keeps forgotten audit history but scrubs deleted bodies and preserves tombstones', async () => {
    await store.forget(branchId, memory.id);
    const forgotten = await store.exportStory(storyId);
    expect(forgotten.memories.map((m) => m.status)).toContain('forgotten');
    expect(forgotten.memories.find((m) => m.id === memory.id)?.text).toBe('钥匙是红色。');
    await store.deleteSource(memory.sourceIds[0]!);
    const deleted = await store.exportStory(storyId);
    expect(deleted.sources.find((s) => s.id === memory.sourceIds[0])?.text).toBeNull();
    expect(deleted.memories.find((m) => m.id === memory.id)?.text).toBe('');
    expect(deleted.sourceSpans?.every((span) => span.quote === '')).toBe(true);
    expect(deleted.tombstones?.some((row) => row.kind === 'source')).toBe(true);
    expect(JSON.stringify(deleted)).not.toContain('钥匙是红色。');
    expect(deleted.sourceDeletionMembers).toHaveLength(2);
  });
  it('aborts the response when a source is deleted between export reads', async () => {
    const history = store.memory.storyHistory.bind(store.memory);
    let inject = true;
    store.memory.storyHistory = async (id) => {
      const rows = await history(id);
      if (inject) {
        inject = false;
        await store.deleteSource(memory.sourceIds[0]!);
      }
      return rows;
    };
    await expect(store.exportStory(storyId)).rejects.toMatchObject({ code: 'EXPORT_CHANGED' });
  });
  it('rejects another owner and exports procedure use and capability ledgers', async () => {
    await expect(new Store(database.db, 'other-owner').exportStory(storyId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const turn = await store.appendTurn({
      branchId,
      sessionId,
      requestId: 'ability',
      messages: [{ role: 'correction', text: '作者确认甲拥有开锁能力。' }],
    });
    const event = turn.events[0]!,
      proof = {
        sourceId: event.sourceId,
        start: 0,
        end: Array.from(event.text).length,
        quote: event.text,
      };
    await store.grantKnowledge({
      branchId,
      sourceId: event.sourceId,
      characterId: 'actor',
      quote: event.text,
    });
    await store.setCapability({
      branchId,
      actorId: 'actor',
      capability: '开锁',
      status: 'available',
      evidence: [proof],
    });
    let procedureId = '';
    for (let index = 0; index < 2; index++) {
      const execution = await store.appendTurn({
        branchId,
        sessionId,
        requestId: `execution-${index}`,
        messages: [{ role: 'assistant', text: `第${index + 1}次解锁成功。` }],
      });
      const result = execution.events[0]!,
        evidence = {
          sourceId: result.sourceId,
          start: 0,
          end: Array.from(result.text).length,
          quote: result.text,
        };
      await store.grantKnowledge({
        branchId,
        sourceId: result.sourceId,
        characterId: 'actor',
        quote: result.text,
      });
      const learned = await store.addExperience({
        branchId,
        actorId: 'actor',
        capability: '开锁',
        conditions: { tool: '钥匙' },
        steps: ['插入钥匙', '旋转'],
        outcome: 'success',
        evidence: [evidence],
      });
      procedureId = learned.procedure.id;
    }
    await store.useProcedure({
      branchId,
      procedureId,
      phase: 'retrieved',
      outcome: 'unknown',
      evidence: [],
      usageKey: 'next-scene',
    });
    const archive = await store.exportStory(storyId);
    expect(archive.capabilities).toHaveLength(1);
    expect(archive.grants).toHaveLength(3);
    expect(archive.turns).toHaveLength(4);
    expect(archive.scenes).toHaveLength(4);
    expect(archive.procedureUses).toMatchObject([{ phase: 'retrieved', outcome: 'unknown' }]);
  });
  it('erases forgotten and invalidated successor metadata instead of leaking it in audit', async () => {
    const sensitive = '黑鸦密会',
      event = (
        await store.appendTurn({
          branchId,
          sessionId,
          requestId: 'private-relation',
          messages: [{ role: 'assistant', text: `甲加入${sensitive}。` }],
        })
      ).events[0]!,
      evidence = {
        sourceId: event.sourceId,
        start: 0,
        end: Array.from(event.text).length,
        quote: event.text,
      };
    const relation = await store.propose(branchId, {
      kind: 'relation',
      subject: '甲',
      predicate: '成员',
      value: sensitive,
      text: event.text,
      evidence: [evidence],
    });
    await store.activateObservation({
      branchId,
      cursor: 2,
      expectedMemoryIds: [relation.id],
      proposals: [
        {
          kind: 'observation',
          subject: sensitive,
          predicate: '成员纪要',
          value: event.text,
          text: event.text,
          evidence: [evidence],
        },
      ],
    });
    await store.forget(branchId, relation.id);
    await store.deleteSource(event.sourceId);
    const archive = await store.exportStory(storyId);
    expect(JSON.stringify(archive)).not.toContain(sensitive);
    const inactive = archive.memories.filter((m) =>
      ['forgotten', 'invalidated'].includes(m.status),
    );
    expect(inactive).toHaveLength(2);
    expect(
      inactive.every((m) => m.subject === '' && m.predicate === '' && m.memoryKey === m.id),
    ).toBe(true);
  });
  it('keeps an independently evidenced author correction after deleting its older source', async () => {
    const corrected = await store.authorCorrection({
      branchId,
      sessionId,
      commandId: 'independent-blue',
      memoryId: memory.id,
      text: '作者纠正：钥匙是蓝色。',
      value: '蓝',
    });
    await store.deleteSource(memory.sourceIds[0]!);
    expect((await store.memories(branchId, { kinds: ['canon'] })).map((m) => m.id)).toEqual([
      corrected.id,
    ]);
    expect(
      (await store.exportStory(storyId)).memories.find((m) => m.id === corrected.id)?.text,
    ).toBe('作者纠正：钥匙是蓝色。');
  });
});
