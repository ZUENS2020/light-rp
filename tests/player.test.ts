import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store, now } from '../src/server/store';
import { setPlayerProfile } from '../src/server/player';
import { playerProfileSchema } from '../src/shared/player';
import { buildContext, validationRules } from '../src/server/context';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
let db: ReturnType<typeof createTestD1>, store: Store, branchId: string, sessionId: string;
beforeEach(async () => {
  db = createTestD1();
  store = new Store(db.db, 'player-owner');
  const world = await store.createWorld();
  const story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => db.close());
const profile = playerProfileSchema.parse({
  name: '林',
  identity: '特雷森学园训练员',
  description: '刚醒来，仍然失忆。',
});
const write = (expectedHead = 0, commandId = 'identity-command') =>
  setPlayerProfile(store, branchId, { expectedHead, commandId, profile });
it('saves a canonical identity once, rejects reused commands and stale writes atomically', async () => {
  const initial = await write();
  expect(initial.branch.scene.playerProfile).toEqual(profile);
  expect(initial.branch.headSeq).toBe(1);
  expect((await write()).replayed).toBe(true);
  expect(await store.getEvents(branchId)).toHaveLength(1);
  await expect(
    setPlayerProfile(store, branchId, {
      expectedHead: 0,
      commandId: 'identity-command',
      profile: { ...profile, identity: '学生' },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_REUSE' });
  await expect(write(0, 'different-command')).rejects.toMatchObject({ code: 'STALE_WRITE' });
  expect(await store.getEvents(branchId)).toHaveLength(1);
});
it('freezes identity at the fork prefix, survives sessions and unrelated scene cleanup, and cannot revive a deleted source', async () => {
  await write();
  const before = await store.fork({ branchId, atSeq: 0 });
  const after = await store.fork({ branchId, atSeq: 1 });
  await setPlayerProfile(store, branchId, {
    expectedHead: 1,
    commandId: 'changed-identity',
    profile: { ...profile, identity: '学生' },
  });
  expect((await store.getBranch(before.id)).scene.playerProfile).toBeUndefined();
  expect((await store.getBranch(after.id)).scene.playerProfile).toEqual(profile);
  await store.createSession({ branchId: after.id });
  await store.run("UPDATE branches SET scene_json='{}' WHERE id=?", after.id);
  expect((await store.getBranch(after.id)).scene.playerProfile).toEqual(profile);
  const original = (await store.getEvents(after.id))[0]!;
  await store.deleteSource(original.sourceId);
  expect((await store.getBranch(after.id)).scene.playerProfile).toBeUndefined();
  await expect(write()).rejects.toMatchObject({ code: 'PROFILE_DELETED' });
});
it('rejects an edit during generation with no new source, turn, snapshot or outbox', async () => {
  const at = now();
  await store.run(
    'INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?,?)',
    'busy',
    store.ownerId,
    branchId,
    sessionId,
    'busy-command',
    'running',
    '{}',
    '{}',
    at,
    at,
  );
  await expect(write()).rejects.toMatchObject({ code: 'STALE_WRITE' });
  expect((await store.getBranch(branchId)).headSeq).toBe(0);
  expect(await store.all('SELECT id FROM sources')).toHaveLength(0);
  expect(await store.all('SELECT id FROM outbox')).toHaveLength(0);
  expect(await store.all('SELECT branch_id FROM scene_snapshots')).toHaveLength(0);
});
it('includes identity and the same bounded agency convention in narration and validation, with a source fence', async () => {
  await write();
  const snapshot = await buildContext(
    {} as Env,
    store,
    branchId,
    { mode: 'roleplay', text: '我看着她。' },
    defaults('local-demo'),
    'player-context',
  );
  expect(snapshot.messages[0]!.content).toContain('特雷森学园训练员');
  expect(snapshot.messages[0]!.content).toContain('失忆不自动解除');
  const rule = validationRules(snapshot).find((v) => v.id === 'global:player-agency')!;
  expect(rule.text).toContain('“你没动”');
  expect(rule.text).toContain('禁止擅自编写玩家台词');
  expect(snapshot.messages[0]!.content).toContain(rule.text);
  expect(snapshot.sourceFence.map((v) => v.sourceId)).toContain(
    snapshot.branch.scene.playerProfileSourceId,
  );
  expect(await store.all('SELECT id FROM knowledge_grants')).toHaveLength(0);
  await setPlayerProfile(store, branchId, {
    expectedHead: 1,
    commandId: 'strict-control',
    profile: { ...profile, agency: 'strict' },
  });
  const strict = await buildContext(
    {} as Env,
    store,
    branchId,
    { mode: 'roleplay', text: '继续' },
    defaults('local-demo'),
    'strict-context',
  );
  expect(validationRules(strict).find((v) => v.id === 'global:player-agency')?.text).toContain(
    '严格模式',
  );
});
