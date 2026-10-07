import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { buildContext } from '../src/server/context';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
let database: ReturnType<typeof createTestD1>, store: Store, branchId: string, sessionId: string;
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'forget-owner');
  const world = await store.createWorld('遗忘边界'),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => database.close());
async function fact() {
  const event = (
      await store.appendTurn({
        branchId,
        sessionId,
        requestId: 'fact-source',
        messages: [{ role: 'assistant', text: '密令是月影。公开线索是北门。' }],
      })
    ).events[0],
    proof = { sourceId: event.sourceId, start: 0, end: 7, quote: '密令是月影。' };
  proof.end = Array.from(proof.quote).length;
  const memory = await store.propose(branchId, {
    kind: 'canon',
    subject: '密令',
    predicate: '内容',
    value: '月影',
    text: proof.quote,
    evidence: [proof],
  });
  await store.extract(branchId, {
    eventIds: [event.id],
    proposals: [],
    cursor: 1,
    extractorVersion: 'v3-facts',
  });
  return { event, proof, memory };
}
describe('branch-scoped forgotten evidence across raw fallback and renamed extraction', () => {
  it('blocks reuse under a different predicate and omits raw context while retaining explicit source audit', async () => {
    const { event, proof, memory } = await fact();
    await store.forget(branchId, memory.id);
    await expect(
      store.propose(branchId, {
        kind: 'episode',
        subject: '回忆',
        predicate: '另一种表述',
        value: '月影',
        text: '密令是月影。',
        evidence: [proof],
      }),
    ).rejects.toMatchObject({ code: 'FORGOTTEN_SOURCE' });
    const context = await buildContext(
      {} as Env,
      store,
      branchId,
      { mode: 'roleplay', text: '继续剧情' },
      defaults('local-demo'),
      'forget',
    );
    expect(JSON.stringify(context.messages)).not.toContain('月影');
    expect((await store.readSourceSpan(branchId, event.sourceId)).text).toContain('月影');
  });
  it('preserves a fork created before forgetting and suppresses a fork created afterward', async () => {
    const { event, memory } = await fact(),
      prior = await store.fork({ branchId, atSeq: 1 });
    await store.forget(branchId, memory.id);
    const later = await store.fork({ branchId, atSeq: 1 });
    expect(await store.getRecallEvents(prior.id)).toHaveLength(1);
    expect(await store.getRecallEvents(later.id)).toHaveLength(0);
    expect(await store.memories(prior.id)).toHaveLength(1);
    expect((await store.getEvents(later.id))[0].sourceId).toBe(event.sourceId);
  });
  it('skips only overlapping extraction evidence and still advances the applied cursor', async () => {
    const { event, proof, memory } = await fact();
    await store.forget(branchId, memory.id);
    const result = await store.extract(branchId, {
      eventIds: [event.id],
      cursor: 1,
      extractorVersion: 'rebuild',
      proposals: [
        {
          kind: 'canon',
          subject: '密令',
          predicate: '重新命名',
          value: '月影',
          text: proof.quote,
          evidence: [proof],
        },
      ],
    });
    expect(result).toMatchObject({ accepted: [], cursor: 1 });
    expect(await store.memories(branchId)).toHaveLength(0);
  });
  it('audits immutable correction history without exposing parent future versions to a prior fork', async () => {
    const { memory } = await fact(),
      prior = await store.fork({ branchId, atSeq: 1 }),
      event = (
        await store.appendTurn({
          branchId,
          sessionId,
          requestId: 'correction',
          messages: [{ role: 'correction', text: '密令应为晨风。' }],
        })
      ).events[0],
      corrected = await store.correct(branchId, memory.id, {
        text: event.text,
        value: '晨风',
        evidence: [
          {
            sourceId: event.sourceId,
            start: 0,
            end: Array.from(event.text).length,
            quote: event.text,
          },
        ],
      });
    expect((await store.memoryVersions(branchId, corrected.id)).map((m) => m.value)).toEqual([
      '月影',
      '晨风',
    ]);
    expect((await store.memoryVersions(prior.id, memory.id)).map((m) => m.value)).toEqual(['月影']);
    await expect(store.memoryVersions(prior.id, corrected.id)).rejects.toMatchObject({
      code: 'MEMORY_REVISION_SCOPE',
    });
    const other = new Store(database.db, 'another-owner');
    await expect(other.memoryVersions(branchId, memory.id)).rejects.toMatchObject({ status: 404 });
  });
});
