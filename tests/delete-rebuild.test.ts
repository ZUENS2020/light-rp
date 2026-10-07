import { afterEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';

const disposals: (() => void)[] = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));
async function fixture() {
  const database = createTestD1();
  disposals.push(database.close);
  const store = new Store(database.db, 'independent-delete-owner');
  const world = await store.createWorld(),
    story = await store.createStory({ worldId: world.id });
  const branchId = story.branchId,
    session = await store.createSession({ branchId });
  const proof = async (text: string) => {
    const event = (
      await store.appendTurn({
        branchId,
        sessionId: session.id,
        requestId: crypto.randomUUID(),
        messages: [{ role: 'assistant', text }],
      })
    ).events[0]!;
    return { sourceId: event.sourceId, start: 0, end: Array.from(text).length, quote: text };
  };
  const first = await proof('甲在北门看见红钥匙。'),
    second = await proof('乙独立确认钥匙是红色。');
  const memory = await store.propose(branchId, {
    kind: 'canon',
    subject: 'key',
    predicate: 'color',
    value: '红',
    text: '钥匙是红色。',
    evidence: [first, second],
  });
  return { database, store, branchId, first, second, memory };
}
describe('source deletion queues a safe projection from remaining evidence', () => {
  it('invalidates the combined body and persists source-only rebuild intent for parent and inherited child', async () => {
    const f = await fixture(),
      child = await f.store.fork({ branchId: f.branchId, atSeq: 2 }),
      epoch = await f.store.ownerEpoch();
    await f.store.deleteSource(f.first.sourceId);
    const jobs = await f.store.all<{ branch_id: string; payload_json: string }>(
      "SELECT branch_id,payload_json FROM outbox WHERE json_extract(payload_json,'$.reason')='remaining-independent-sources'",
    );
    expect(jobs.map((j) => j.branch_id).sort()).toEqual([f.branchId, child.id].sort());
    for (const job of jobs)
      expect(JSON.parse(job.payload_json)).toMatchObject({
        rebuild: true,
        throughSeq: 2,
        ownerEpoch: epoch + 1,
      });
    expect(await f.store.memories(f.branchId)).toEqual([]);
    expect((await f.store.source(f.second.sourceId)).text).toBe(f.second.quote);
    expect((await f.store.source(f.first.sourceId)).text).toBeNull();
    expect(jobs.every((j) => !j.payload_json.includes('红钥匙'))).toBe(true);
  });
  it('does not request regeneration for a forgotten item even when an independent source remains', async () => {
    const f = await fixture();
    await f.store.forget(f.branchId, f.memory.id);
    await f.store.deleteSource(f.first.sourceId);
    expect(
      await f.store.all(
        "SELECT id FROM outbox WHERE json_extract(payload_json,'$.reason')='remaining-independent-sources'",
      ),
    ).toEqual([]);
  });
});
