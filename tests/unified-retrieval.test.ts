import { describe, it, expect } from 'vitest';
import { Store } from '../src/server/store';
import { createTestD1 } from './d1';
import { indexMemories, searchLegalVectors } from '../src/server/vectors';
import type { Env } from '../src/server/env';

describe('candidate-first Chinese retrieval', () => {
  it('finds a lexical-only proper noun older than 5000 records and pages the index without deleting valid old vectors', async () => {
    const d = createTestD1(),
      s = new Store(d.db, 'retrieval-test');
    try {
      const w = await s.createWorld('检索'),
        story = await s.createStory({ worldId: w.id }),
        branchId = story.branchId,
        session = await s.createSession({ branchId });
      const e = (
        await s.appendTurn({
          branchId,
          sessionId: session.id,
          requestId: 'old-source',
          messages: [{ role: 'assistant', text: '灰晶镯保存在翠微阁。' }],
        })
      ).events[0]!;
      const old = await s.propose(branchId, {
        kind: 'canon',
        subject: '灰晶镯',
        predicate: '存放地点',
        value: '翠微阁',
        text: e.text,
        evidence: [
          { sourceId: e.sourceId, start: 0, end: Array.from(e.text).length, quote: e.text },
        ],
      });
      const insert = d.sqlite
        .prepare(`INSERT INTO memory_versions(id,owner_id,story_id,branch_id,memory_key,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,idempotency_key)
     SELECT ?,owner_id,story_id,branch_id,?,'episode','背景',predicate,'"无关内容"','风掠过草地。','风 掠 过 草 地 风掠 掠过 过草 草地','[]',NULL,70,.85,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,1,NULL,'active','{}',? FROM memory_versions WHERE id=?`);
      const evidence = d.sqlite.prepare(
        'INSERT INTO memory_evidence(memory_id,span_id) SELECT ?,span_id FROM memory_evidence WHERE memory_id=?',
      );
      d.sqlite.transaction(() => {
        for (let i = 0; i < 5100; i++) {
          const id = `later-${i}`;
          insert.run(id, id, id, old.id);
          evidence.run(id, old.id);
        }
      })();
      const answer = await s.recall(branchId, '灰晶镯与翠微阁', { maxGraphMs: 0 });
      expect(answer.items[0]?.memory.id).toBe(old.id);
      expect(answer.items[0]?.arms).toContain('lexical');
      const vectors = new Map<string, { id: string }>();
      let calls = 0;
      const env = {
        AI: {
          run: async (_m: string, args: { text: string[] }) => {
            calls++;
            return { data: args.text.map(() => Array(1024).fill(0.01)) };
          },
        },
        VECTORS: {
          upsert: async (items: { id: string }[]) => items.forEach((v) => vectors.set(v.id, v)),
          deleteByIds: async (ids: string[]) => ids.forEach((id) => vectors.delete(id)),
        },
      } as unknown as Env;
      await indexMemories(env, s, branchId);
      expect(vectors.size).toBe(5101);
      const before = calls;
      await indexMemories(env, s, branchId);
      expect(calls).toBe(before);
      const manifest = await s.one<{ vector_id: string }>(
        'SELECT vector_id FROM vector_manifest WHERE memory_id=?',
        old.id,
      );
      expect(vectors.has(manifest!.vector_id)).toBe(true);
      await s.forget(branchId, old.id);
      await indexMemories(env, s, branchId);
      expect(vectors.has(manifest!.vector_id)).toBe(false);
    } finally {
      d.close();
    }
  }, 120000);
  it('refills stale vector hits through D1 authorization while reusing one query embedding', async () => {
    const d = createTestD1(),
      s = new Store(d.db, 'refill-test');
    try {
      const world = await s.createWorld(),
        story = await s.createStory({ worldId: world.id });
      const branchId = story.branchId,
        session = await s.createSession({ branchId });
      const event = (
        await s.appendTurn({
          branchId,
          sessionId: session.id,
          requestId: 'source',
          messages: [{ role: 'assistant', text: '蓝钥匙在仓库。' }],
        })
      ).events[0]!;
      const original = await s.propose(branchId, {
        kind: 'canon',
        subject: '蓝钥匙',
        predicate: '位置',
        value: '仓库',
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
      for (let i = 1; i < 50; i++) {
        await s.run(
          'INSERT INTO memory_versions SELECT ?,owner_id,story_id,branch_id,?,kind,subject,predicate,value_json,text,search_text,known_by_json,observer_id,authority,confidence,valid_from,valid_to,origin_seq,recorded_seq,recorded_at,revision,supersedes_id,status,data_json,? FROM memory_versions WHERE id=?',
          `copy-${i}`,
          `copy-${i}`,
          `copy-${i}`,
          original.id,
        );
        await s.run(
          'INSERT INTO memory_evidence SELECT ?,span_id FROM memory_evidence WHERE memory_id=?',
          `copy-${i}`,
          original.id,
        );
      }
      const matches: { id: string; score: number }[] = [];
      let queryEmbeddings = 0;
      const requested: number[] = [];
      const env = {
        AI: {
          run: async (_m: string, args: { text: string[] }) => {
            queryEmbeddings++;
            return { data: args.text.map(() => Array(1024).fill(0.01)) };
          },
        },
        VECTORS: {
          upsert: async (items: { id: string }[]) =>
            items.forEach((v) => matches.push({ id: v.id, score: 1 })),
          deleteByIds: async () => {},
          query: async (_vector: number[], options: { topK: number }) => {
            requested.push(options.topK);
            return { matches: matches.slice(0, options.topK) };
          },
        },
      } as unknown as Env;
      await indexMemories(env, s, branchId);
      const outdated = await s.all<{ id: string }>(
        'SELECT id FROM memory_versions ORDER BY rowid LIMIT 10',
      );
      for (const [i, memory] of outdated.entries())
        await s.authorCorrection({
          branchId,
          commandId: `correct-stale-${i}`,
          memoryId: memory.id,
          text: '蓝钥匙的位置更正为档案室。',
          value: '档案室',
        });
      queryEmbeddings = 0;
      const legal = await searchLegalVectors(env, s, branchId, 'director', '蓝钥匙在哪');
      expect(legal).toHaveLength(40);
      expect(requested).toEqual([40, 80]);
      expect(queryEmbeddings).toBe(1);
      expect(
        (
          await s.memory.currentByIds(
            branchId,
            legal.map((m) => m.id),
          )
        ).length,
      ).toBe(40);
    } finally {
      d.close();
    }
  });
});
