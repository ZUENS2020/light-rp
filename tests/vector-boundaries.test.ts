import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import {
  cleanDeletedVectors,
  deleteMemoryVectors,
  indexMemories,
  resolveVectorCandidates,
  vectorId,
} from '../src/server/vectors';
import type { Env, VectorizeV2QueryOptions } from '../src/server/env';
import type { Evidence } from '../src/shared/domain';
import { buildContext, scopeKey } from '../src/server/context';
import { defaults } from '../src/server/settings';

const close: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of close.splice(0)) dispose();
});
async function fixture() {
  const database = createTestD1();
  close.push(database.close);
  const store = new Store(database.db, 'vector-owner'),
    world = await store.createWorld('向量边界故事'),
    at = new Date().toISOString();
  const actors = ['actor-a', 'actor-b'];
  for (const actor of actors)
    await store.run(
      'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
      actor,
      store.ownerId,
      'character',
      actor,
      '{}',
      '{}',
      at,
      at,
    );
  const story = await store.createStory({ worldId: world.id, characterIds: actors }),
    session = await store.createSession({ branchId: story.branchId });
  async function source(
    text: string,
    requestId: string,
    role: 'assistant' | 'correction' = 'assistant',
  ) {
    const turn = await store.appendTurn({
        branchId: story.branchId,
        sessionId: session.id,
        requestId,
        messages: [{ role, text }],
      }),
      event = turn.events[0]!;
    const evidence: Evidence = {
      sourceId: event.sourceId,
      start: 0,
      end: Array.from(text).length,
      quote: text,
    };
    for (const actor of actors)
      await store.grantKnowledge({
        branchId: story.branchId,
        sourceId: event.sourceId,
        characterId: actor,
        quote: text,
        channel: 'witnessed',
      });
    return { event, evidence };
  }
  const initial = await source('晴岚和阿澈都看见蓝钥匙藏在北礁。', 'key-source');
  const memory = await store.propose(story.branchId, {
    kind: 'canon',
    subject: '蓝钥匙',
    predicate: '位置',
    value: '北礁',
    text: initial.event.text,
    evidence: [initial.evidence],
    knownBy: actors,
  });
  const vectors = new Map<
    string,
    { id: string; values: number[]; namespace: string; metadata: unknown }
  >();
  let onUpsert: (() => Promise<void>) | null = null;
  const ai = vi.fn(async (_model: string, input: { text: string[] }) => ({
    data: input.text.map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
  }));
  const upsert = vi.fn(
    async (
      batch: Array<{ id: string; values: number[]; namespace: string; metadata: unknown }>,
    ) => {
      if (batch.some((vector) => new TextEncoder().encode(vector.id).length > 64))
        throw new Error('Vectorize64ByteLimit');
      if (onUpsert) await onUpsert();
      for (const vector of batch) vectors.set(vector.id, vector);
      return {};
    },
  );
  const deleted = vi.fn(async (ids: string[]) => {
    for (const id of ids) vectors.delete(id);
    return {};
  });
  const env = {
    DB: database.db,
    AI: { run: ai },
    VECTORS: { upsert, deleteByIds: deleted },
  } as unknown as Env;
  return {
    ...database,
    store,
    story,
    memory,
    initial,
    source,
    vectors,
    env,
    ai,
    upsert,
    deleted,
    setUpsertHook: (hook: typeof onUpsert) => {
      onUpsert = hook;
    },
  };
}

describe('vector projection boundaries with real D1 transactions', () => {
  it('keeps namespaced immutable memory IDs intact in the manifest and cache', async () => {
    const f = await fixture();
    const source = await f.source('月港通行证保存在钟楼。', 'namespaced-source');
    const record = await f.store.propose(f.story.branchId, {
      id: 'import:revision:7',
      kind: 'canon',
      subject: '月港通行证',
      predicate: 'location',
      value: '钟楼',
      text: source.event.text,
      evidence: [source.evidence],
      knownBy: ['actor-a', 'actor-b'],
    });
    await indexMemories(f.env, f.store, f.story.branchId);
    const rows = await f.store.all<{ vector_id: string; memory_id: string }>(
      'SELECT vector_id,memory_id FROM vector_manifest WHERE memory_id=?',
      record.id,
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) =>
          f.vectors.has(row.vector_id) && new TextEncoder().encode(row.vector_id).length === 64,
      ),
    ).toBe(true);
    const scope = await scopeKey(f.store.ownerId, f.story.branchId, 'director');
    const match = await resolveVectorCandidates(
      f.store,
      f.story.branchId,
      'director',
      scope,
      rows.map((row) => ({ id: row.vector_id, score: 0.9 })),
    );
    expect(match).toEqual([{ id: record.id, score: 0.9 }]);
    expect(
      await f.store.one('SELECT count(*) AS n FROM vector_manifest WHERE memory_id=?', record.id),
    ).toEqual({ n: 3 });
    expect(
      await f.store.one('SELECT count(*) AS n FROM embedding_cache WHERE memory_id=?', record.id),
    ).toEqual({ n: 1 });
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.ai).toHaveBeenCalledTimes(1);
  });
  it('embeds one immutable revision once across director and both character scopes', async () => {
    const f = await fixture();
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.ai).toHaveBeenCalledTimes(1);
    expect(f.ai.mock.calls[0]?.[1].text).toHaveLength(1);
    expect(f.vectors.size).toBe(3);
    expect(await f.store.one('SELECT count(*) AS n FROM embedding_cache')).toEqual({ n: 1 });
    expect(await f.store.one('SELECT count(*) AS n FROM vector_manifest')).toEqual({ n: 3 });
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.ai).toHaveBeenCalledTimes(1);
    expect(f.upsert).toHaveBeenCalledTimes(3);
  });
  it('removes every viewer vector for a superseded revision and rejects old recall candidates', async () => {
    const f = await fixture();
    await indexMemories(f.env, f.store, f.story.branchId);
    const correction = await f.source(
      '作者更正：蓝钥匙实际藏在南礁。',
      'key-correction',
      'correction',
    );
    const result = await f.store.correct(f.story.branchId, f.memory.id, {
      text: correction.event.text,
      value: '南礁',
      evidence: [correction.evidence],
    });
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.ai).toHaveBeenCalledTimes(2);
    const manifest = await f.store.all<{ vector_id: string; memory_id: string }>(
      'SELECT vector_id,memory_id FROM vector_manifest',
    );
    expect(manifest.every((row) => row.memory_id === result.id)).toBe(true);
    expect([...f.vectors.keys()].sort()).toEqual(manifest.map((row) => row.vector_id).sort());
    expect(
      await f.store.one('SELECT count(*) AS n FROM vector_manifest WHERE memory_id=?', f.memory.id),
    ).toEqual({ n: 0 });
    const recalled = await f.store.recall(f.story.branchId, '蓝钥匙位置', {
      viewer: 'actor-a',
      vectorCandidates: [
        { id: f.memory.id, score: 100 },
        { id: result.id, score: 1 },
      ],
    });
    expect(recalled.items.map((item) => item.memory.id)).not.toContain(f.memory.id);
    expect(recalled.items.map((item) => item.memory.value)).toContain('南礁');
  });
  it('rolls back cache and manifest, then removes a vector whose delayed upsert completes after source deletion', async () => {
    const f = await fixture();
    let erased = false;
    f.setUpsertHook(async () => {
      if (!erased) {
        erased = true;
        await f.store.deleteSource(f.initial.event.sourceId);
        await cleanDeletedVectors(f.env, f.store);
      }
    });
    await expect(indexMemories(f.env, f.store, f.story.branchId)).rejects.toThrow();
    expect(f.vectors.size).toBe(0);
    expect(await f.store.one('SELECT count(*) AS n FROM embedding_cache')).toEqual({ n: 0 });
    expect(await f.store.one('SELECT count(*) AS n FROM vector_manifest')).toEqual({ n: 0 });
    await cleanDeletedVectors(f.env, f.store);
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.vectors.size).toBe(0);
    expect(f.ai).toHaveBeenCalledTimes(1);
  });
  it('indexes the actual long author-correction ID using a 64-byte vector ID', async () => {
    const f = await fixture(),
      correction = await f.store.authorCorrection({
        branchId: f.story.branchId,
        commandId: 'long-author-correction',
        memoryId: f.memory.id,
        text: '作者确认蓝钥匙在西礁。',
        value: '西礁',
      });
    expect(new TextEncoder().encode(correction.id).length).toBeGreaterThan(64);
    await indexMemories(f.env, f.store, f.story.branchId);
    const rows = await f.store.all<{ vector_id: string }>(
      'SELECT vector_id FROM vector_manifest WHERE memory_id=?',
      correction.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.vector_id.length === 64 && f.vectors.has(row.vector_id))).toBe(
      true,
    );
    const scope = await scopeKey(f.store.ownerId, f.story.branchId, 'director'),
      candidates = await resolveVectorCandidates(
        f.store,
        f.story.branchId,
        'director',
        scope,
        rows.map((row) => ({ id: row.vector_id, score: 1 })),
      );
    const recall = await f.store.recall(f.story.branchId, 'unmatched foreign query', {
      vectorCandidates: candidates,
    });
    expect(recall.items.map((item) => item.memory.id)).toEqual([correction.id]);
    await f.store.deleteSource(correction.sourceIds[0]!);
    await cleanDeletedVectors(f.env, f.store);
    expect(f.vectors.size).toBe(0);
    expect(await f.store.one('SELECT count(*) AS n FROM vector_manifest')).toEqual({ n: 0 });
  });
  it('indexes and removes an actual long procedure-status revision', async () => {
    const f = await fixture(),
      ability = await f.source('作者确认甲具备开锁能力。', 'unlock-capability', 'correction');
    await f.store.setCapability({
      branchId: f.story.branchId,
      actorId: 'actor-a',
      capability: '开锁',
      status: 'available',
      evidence: [ability.evidence],
    });
    let procedureId = '';
    for (let index = 0; index < 2; index++) {
      const execution = await f.source(`第${index + 1}次开锁成功。`, `unlock-${index}`);
      procedureId = (
        await f.store.addExperience({
          branchId: f.story.branchId,
          actorId: 'actor-a',
          capability: '开锁',
          conditions: { tool: '钥匙' },
          steps: ['转动钥匙'],
          outcome: 'success',
          evidence: [execution.evidence],
        })
      ).procedure.id;
    }
    const suspended = await f.store.setProcedureStatus(f.story.branchId, procedureId, 'suspended'),
      active = await f.store.setProcedureStatus(f.story.branchId, suspended.id, 'active');
    expect(active.id.length).toBeGreaterThan(64);
    await indexMemories(f.env, f.store, f.story.branchId);
    const rows = await f.store.all<{ vector_id: string }>(
      'SELECT vector_id FROM vector_manifest WHERE memory_id=?',
      active.id,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.vector_id.length === 64 && f.vectors.has(row.vector_id))).toBe(
      true,
    );
    await f.store.forget(f.story.branchId, active.id);
    await deleteMemoryVectors(f.env, f.store, f.story.branchId, [active.id]);
    expect(rows.every((row) => !f.vectors.has(row.vector_id))).toBe(true);
  });
  it('does not map unknown, foreign-viewer or foreign-owner vector IDs', async () => {
    const f = await fixture();
    await indexMemories(f.env, f.store, f.story.branchId);
    const rows = await f.store.all<{ vector_id: string }>(
      "SELECT vector_id FROM vector_manifest WHERE viewer='director'",
    );
    const scope = await scopeKey(f.store.ownerId, f.story.branchId, 'actor-a'),
      matches = [
        ...rows.map((row) => ({ id: row.vector_id, score: 1 })),
        { id: 'unknown', score: 1 },
      ];
    expect(
      await resolveVectorCandidates(f.store, f.story.branchId, 'actor-a', scope, matches),
    ).toEqual([]);
    expect(
      await resolveVectorCandidates(
        new Store(f.db, 'foreign-owner'),
        f.story.branchId,
        'director',
        await scopeKey(f.store.ownerId, f.story.branchId, 'director'),
        matches,
      ),
    ).toEqual([]);
  });
  it('cleans all view projections for a forgotten revision and an interrupted unmanifested upsert', async () => {
    const f = await fixture();
    await indexMemories(f.env, f.store, f.story.branchId);
    const scope = await scopeKey(f.store.ownerId, f.story.branchId, 'director'),
      id = await vectorId(f.memory.id, scope);
    await f.store.run('DELETE FROM vector_manifest WHERE vector_id=?', id);
    expect(f.vectors.has(id)).toBe(true);
    await f.store.forget(f.story.branchId, f.memory.id);
    await deleteMemoryVectors(f.env, f.store, f.story.branchId, [f.memory.id]);
    expect(f.vectors.size).toBe(0);
    expect(await f.store.one('SELECT count(*) AS n FROM vector_manifest')).toEqual({ n: 0 });
  });
  it('migrates a recorded legacy vector ID without re-embedding its immutable memory', async () => {
    const f = await fixture();
    await indexMemories(f.env, f.store, f.story.branchId);
    const row = await f.store.one<{ vector_id: string }>(
        "SELECT vector_id FROM vector_manifest WHERE viewer='director'",
      ),
      legacy = 'legacy-vector-before-opaque-format',
      vector = f.vectors.get(row!.vector_id)!;
    f.vectors.delete(row!.vector_id);
    f.vectors.set(legacy, { ...vector, id: legacy });
    await f.store.run(
      'UPDATE vector_manifest SET vector_id=? WHERE vector_id=?',
      legacy,
      row!.vector_id,
    );
    await indexMemories(f.env, f.store, f.story.branchId);
    expect(f.vectors.has(legacy)).toBe(false);
    expect(f.vectors.has(row!.vector_id)).toBe(true);
    expect(f.ai).toHaveBeenCalledTimes(1);
  });
});

describe('Vectorize V2 query options', () => {
  it('uses V2 metadata retrieval enum in actual narrative context queries', async () => {
    const d = createTestD1();
    close.push(d.close);
    const s = new Store(d.db, 'v2-options-owner');
    const world = await s.createWorld(),
      story = await s.createStory({ worldId: world.id });
    const query = vi.fn(async (_vector: number[], options: VectorizeV2QueryOptions) => {
      expect(options.returnMetadata).toBe('none');
      expect(options.returnValues).toBe(false);
      return { matches: [], count: 0 };
    });
    const env = {
      DB: d.db,
      VECTORS: { query },
      AI: { run: async () => ({ data: [Array(1024).fill(0)] }) },
    } as unknown as Env;
    const context = await buildContext(
      env,
      s,
      story.branchId,
      { mode: 'roleplay', text: '寻找钥匙' },
      defaults('gateway'),
      'v2-query',
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(context.warnings).not.toContain('语义索引暂不可用，已使用词法、关系和原文补尾');
  });
  it('rejects legacy boolean metadata options at the binding type boundary', () => {
    // @ts-expect-error V1 booleans must never be accepted for this V2 deployment.
    const legacy: VectorizeV2QueryOptions = { returnMetadata: false };
    const valid: VectorizeV2QueryOptions = { returnMetadata: 'none', topK: 40 };
    expect(valid.returnMetadata).toBe('none');
    expect(legacy.returnMetadata).toBe(false);
  });
});
