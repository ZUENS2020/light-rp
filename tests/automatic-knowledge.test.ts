import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
let db: ReturnType<typeof createTestD1>, s: Store, branch: string, sourceId: string;
const text = '甲告诉乙钥匙在仓库。旁白另有私密。',
  quote = '甲告诉乙钥匙在仓库';
beforeEach(async () => {
  db = createTestD1();
  s = new Store(db.db, 'automatic-grant-test');
  const world = await s.createWorld('测试'),
    story = await s.createStory({ worldId: world.id });
  branch = story.branchId;
  const session = await s.createSession({ branchId: branch });
  const turn = await s.appendTurn({
    branchId: branch,
    sessionId: session.id,
    requestId: 'test-event',
    expectedHead: 0,
    messages: [{ role: 'assistant', text }],
  });
  sourceId = turn.events[0]!.sourceId;
});
afterEach(() => db.close());
describe('automatic acquisition cannot override author intent', () => {
  it('atomically blocks an automatic content grant covered by a whole-source author revocation', async () => {
    await s.grantKnowledge({
      branchId: branch,
      sourceId,
      characterId: '乙',
      channel: 'author',
      status: 'revoke',
    });
    const grants = await s.one('SELECT count(*) AS n FROM knowledge_grants'),
      projection = (await s.getBranch(branch)).projectionRevision;
    await expect(
      s.grantKnowledge({
        branchId: branch,
        sourceId,
        characterId: '乙',
        quote,
        channel: 'told',
        automatic: true,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await s.one('SELECT count(*) AS n FROM knowledge_grants')).toEqual(grants);
    expect((await s.getBranch(branch)).projectionRevision).toBe(projection);
    await expect(s.readSourceSpan(branch, sourceId, { viewer: '乙' })).rejects.toMatchObject({
      code: 'KNOWLEDGE_SCOPE',
    });
  });
  it('blocks a wildcard author revoke inherited at the fork boundary', async () => {
    await s.grantKnowledge({
      branchId: branch,
      sourceId,
      characterId: '*',
      quote,
      channel: 'author',
      status: 'revoke',
    });
    const child = await s.fork({ branchId: branch, atSeq: 1, name: '继承撤销' });
    await expect(
      s.grantKnowledge({
        branchId: child.id,
        sourceId,
        characterId: '乙',
        quote,
        channel: 'told',
        automatic: true,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    await expect(s.readSourceSpan(child.id, sourceId, { viewer: '乙' })).rejects.toMatchObject({
      code: 'KNOWLEDGE_SCOPE',
    });
    expect(
      await s.one('SELECT count(*) AS n FROM knowledge_grants WHERE branch_id=?', child.id),
    ).toEqual({ n: 0 });
  });
  it('uses the frozen parent grant boundary and preserves explicit author reauthorization', async () => {
    const child = await s.fork({ branchId: branch, atSeq: 1, name: '先分叉' });
    await s.grantKnowledge({
      branchId: branch,
      sourceId,
      characterId: '乙',
      quote,
      channel: 'author',
      status: 'revoke',
    });
    await s.grantKnowledge({
      branchId: child.id,
      sourceId,
      characterId: '乙',
      quote,
      channel: 'told',
      automatic: true,
    });
    expect((await s.readSourceSpan(child.id, sourceId, { viewer: '乙' })).text).toBe(quote);
    await s.grantKnowledge({
      branchId: branch,
      sourceId,
      characterId: '乙',
      quote,
      channel: 'author',
      status: 'grant',
    });
    await s.grantKnowledge({
      branchId: branch,
      sourceId,
      characterId: '乙',
      quote,
      channel: 'told',
      automatic: true,
    });
    expect((await s.readSourceSpan(branch, sourceId, { viewer: '乙' })).text).toBe(quote);
  });
});
