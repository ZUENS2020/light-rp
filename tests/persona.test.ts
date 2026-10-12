import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { personaCapabilities, syncPersonaCapabilities } from '../src/server/persona';
import { normalizeCharacter } from '../src/shared/assets';

let database: ReturnType<typeof createTestD1>,
  store: Store,
  worldId: string,
  branchId: string,
  sessionId: string;
const actorId = 'persona-actor';
function card(capabilities: unknown = [{ name: '解锁', level: '初级' }]) {
  return {
    spec: 'chara_card_v3',
    data: {
      name: '小明',
      description: '卡中还提到了火球术，但没有声明拥有它。私人经历不能成为能力来源。',
      extensions: { lightrp: { capabilities } },
    },
  };
}
async function asset(raw = card(), revision = 1) {
  const at = new Date().toISOString(),
    rawJson = JSON.stringify(raw),
    dataJson = JSON.stringify(normalizeCharacter(raw));
  if (revision === 1)
    await store.run(
      'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      actorId,
      store.ownerId,
      'character',
      '小明',
      revision,
      rawJson,
      dataJson,
      at,
      at,
    );
  else
    await store.run(
      'UPDATE assets SET revision=?,raw_json=?,data_json=?,updated_at=? WHERE id=? AND owner_id=?',
      revision,
      rawJson,
      dataJson,
      at,
      actorId,
      store.ownerId,
    );
  await store.run(
    'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,?,?,?,?)',
    `${actorId}-${revision}`,
    actorId,
    revision,
    rawJson,
    dataJson,
    at,
  );
}
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'persona-owner');
  worldId = (await store.createWorld('角色能力世界')).id;
  await asset();
  const story = await store.createStory({ worldId, characterIds: [actorId] });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => database.close());

describe('explicit source-bound character card capabilities', () => {
  it('reads only structured extension configuration and retains precise persona evidence without other private card text', async () => {
    const synced = await syncPersonaCapabilities(store, branchId);
    expect(synced.capabilities).toHaveLength(1);
    expect(synced.capabilities[0]).toMatchObject({
      actorId,
      capability: '解锁',
      status: 'available',
      recordedSeq: 0,
      data: { origin: 'persona', assetId: actorId, assetRevision: 1, level: '初级' },
    });
    const source = await store.source(synced.sources[0].sourceId);
    expect(source).toMatchObject({
      kind: 'character_card',
      version: 1,
      world_id: worldId,
      story_id: null,
      branch_id: null,
    });
    expect(source.text).toBe('{"capabilities":[{"level":"初级","name":"解锁"}]}');
    expect(source.text).not.toMatch(/私人经历|火球术/);
    const role = await store.memories(branchId, { viewer: actorId });
    expect(role).toHaveLength(1);
    expect(role[0].evidence[0].quote).toBe('{"level":"初级","name":"解锁"}');
    expect(
      (await store.readSourceSpan(branchId, synced.sources[0].sourceId, { viewer: actorId })).text,
    ).toBe('{"level":"初级","name":"解锁"}');
    expect((await store.getBranch(branchId)).headSeq).toBe(0);
  });
  it('does not infer abilities from prose, normal fields, another extension, or a name without explicit configuration', () => {
    expect(
      personaCapabilities({
        name: '小明',
        description: '会隐身',
        capabilities: [{ name: '隐身' }],
        extensions: { other: { capabilities: [{ name: '火球' }] } },
      }),
    ).toEqual([]);
    expect(
      personaCapabilities({
        extensions: { lightrp: { capabilities: [{ name: '🏹射击', level: '大师😀' }] } },
      }),
    ).toEqual([{ name: '🏹射击', level: '大师😀' }]);
    expect(() => personaCapabilities(card([{ name: '解锁', level: 7 }]))).toThrow('level');
    expect(() =>
      personaCapabilities(
        card([
          { name: '解锁', level: '低' },
          { name: '解锁', level: '高' },
        ]),
      ),
    ).toThrow('两个不同级别');
  });
  it('uses one canonical source across stories in a world and keeps each branch knowledge grant separate', async () => {
    const first = await syncPersonaCapabilities(store, branchId),
      story = await store.createStory({ worldId, characterIds: [actorId] }),
      other = await syncPersonaCapabilities(store, story.branchId);
    expect(other.sources[0].sourceId).toBe(first.sources[0].sourceId);
    expect(await store.all("SELECT id FROM sources WHERE kind='character_card'")).toHaveLength(1);
    expect(await store.listCapabilities(story.branchId)).toHaveLength(1);
    expect(await store.memories(story.branchId, { viewer: actorId })).toHaveLength(1);
    const anotherWorld = await store.createWorld('另一世界'),
      separate = await store.createStory({ worldId: anotherWorld.id, characterIds: [actorId] }),
      separateSync = await syncPersonaCapabilities(store, separate.branchId);
    expect(separateSync.sources[0].sourceId).not.toBe(first.sources[0].sourceId);
  });
  it('replays the same persona projection without duplicate capabilities or grants or reviving revoked knowledge', async () => {
    const synced = await syncPersonaCapabilities(store, branchId),
      capability = synced.capabilities[0],
      count = await store.one('SELECT count(*) AS n FROM knowledge_grants');
    await syncPersonaCapabilities(store, branchId);
    expect(await store.one('SELECT count(*) AS n FROM knowledge_grants')).toEqual(count);
    expect(await store.all('SELECT id FROM capability_versions')).toHaveLength(1);
    const proof = capability.evidence[0];
    await store.grantKnowledge({
      branchId,
      sourceId: proof.sourceId,
      characterId: actorId,
      spanId: proof.spanId,
      start: proof.start,
      end: proof.end,
      quote: proof.quote,
      channel: 'author',
      status: 'revoke',
    });
    await syncPersonaCapabilities(store, branchId);
    expect(await store.memories(branchId, { viewer: actorId })).toHaveLength(0);
    expect((await store.listCapabilities(branchId))[0].status).toBe('available');
  });
  it('invalidates an old card-only ability after explicit revision removal while an old-revision fork remains intact', async () => {
    const first = await syncPersonaCapabilities(store, branchId),
      child = await store.fork({ branchId, atSeq: 0 });
    await asset(card([]), 2);
    await store.applyResourceUpdates(branchId, [actorId]);
    await syncPersonaCapabilities(store, branchId);
    expect(await store.listCapabilities(branchId)).toHaveLength(0);
    expect(await store.memories(branchId, { viewer: actorId })).toHaveLength(0);
    expect((await store.listCapabilities(child.id))[0].data.assetRevision).toBe(1);
    expect((await store.source(first.sources[0].sourceId)).status).toBe('active');
    await expect(
      store.readSourceSpan(branchId, first.sources[0].sourceId, { viewer: actorId }),
    ).rejects.toMatchObject({ code: 'RESOURCE_REVISION' });
    const restoredPrefix = await syncPersonaCapabilities(store, child.id);
    expect(restoredPrefix.sources[0].sourceId).toBe(first.sources[0].sourceId);
    expect(restoredPrefix.capabilities[0].data.level).toBe('初级');
  });
  it('records an upgrade at the resource application event and does not adopt that future version in historical sync or forks', async () => {
    const first = await syncPersonaCapabilities(store, branchId);
    await asset(card([{ name: '解锁', level: '高级' }]), 2);
    await store.applyResourceUpdates(branchId, [actorId]);
    const updated = await syncPersonaCapabilities(store, branchId);
    expect(updated.capabilities[0]).toMatchObject({
      recordedSeq: 1,
      data: { level: '高级', assetRevision: 2 },
    });
    expect(updated.sources[0].sourceId).not.toBe(first.sources[0].sourceId);
    expect(updated.capabilities[0].evidence).toHaveLength(2);
    const historic = await syncPersonaCapabilities(store, branchId, 0);
    expect(historic.capabilities[0]).toMatchObject({
      recordedSeq: 0,
      data: { level: '初级', assetRevision: 1 },
    });
    expect((await store.listCapabilities(branchId))[0].data.level).toBe('高级');
    const child = await store.fork({ branchId, atSeq: 0 });
    expect((await store.listCapabilities(child.id))[0].data.level).toBe('初级');
    expect(
      (await syncPersonaCapabilities(store, child.id)).capabilities[0].data.assetRevision,
    ).toBe(1);
  });
  it('retains an independently learned capability when the newer card removes its initial declaration', async () => {
    await syncPersonaCapabilities(store, branchId);
    const text = '小明经过独立学习，解锁能力已经达到大师级。',
      event = (
        await store.appendTurn({
          branchId,
          sessionId,
          requestId: 'independent-learning',
          messages: [{ role: 'assistant', text }],
        })
      ).events[0],
      evidence = [
        { sourceId: event.sourceId, start: 0, end: Array.from(text).length, quote: text },
      ];
    await store.grantKnowledge({
      branchId,
      sourceId: event.sourceId,
      characterId: actorId,
      channel: 'witnessed',
    });
    await store.setCapability({
      branchId,
      actorId,
      capability: '解锁',
      status: 'available',
      data: { level: '大师', origin: 'learned' },
      evidence,
    });
    await asset(card([]), 2);
    await store.applyResourceUpdates(branchId, [actorId]);
    await syncPersonaCapabilities(store, branchId);
    expect((await store.listCapabilities(branchId))[0]).toMatchObject({
      data: { level: '大师', origin: 'learned' },
    });
  });
  it('does not overwrite independent ability state even if the card still lists the same ability', async () => {
    const text = '小明独立学习了大师级解锁，随后能力已经丧失。',
      event = (
        await store.appendTurn({
          branchId,
          sessionId,
          requestId: 'lost-independent',
          messages: [{ role: 'assistant', text }],
        })
      ).events[0];
    await store.setCapability({
      branchId,
      actorId,
      capability: '解锁',
      status: 'lost',
      data: { origin: 'learned' },
      evidence: [{ sourceId: event.sourceId, start: 0, end: Array.from(text).length, quote: text }],
    });
    const synced = await syncPersonaCapabilities(store, branchId);
    expect(synced.skipped).toContainEqual({
      assetId: actorId,
      revision: 1,
      capability: '解锁',
      reason: 'independent-source',
    });
    expect(synced.capabilities[0].status).toBe('lost');
  });
  it('never recreates a deleted canonical asset source in the same revision or a second story', async () => {
    const first = await syncPersonaCapabilities(store, branchId),
      sourceId = first.sources[0].sourceId,
      epoch = await store.ownerEpoch();
    await store.deleteSource(sourceId);
    const retried = await syncPersonaCapabilities(store, branchId);
    expect(retried.skipped).toContainEqual({
      assetId: actorId,
      revision: 1,
      reason: 'deleted-source',
    });
    expect(retried.capabilities).toHaveLength(0);
    const other = await store.createStory({ worldId, characterIds: [actorId] });
    expect((await syncPersonaCapabilities(store, other.branchId)).capabilities).toHaveLength(0);
    expect(await store.all("SELECT id FROM sources WHERE kind='character_card'")).toHaveLength(1);
    expect(await store.source(sourceId)).toMatchObject({
      status: 'deleted',
      text: null,
      generation: 1,
    });
    await expect(syncPersonaCapabilities(store, branchId, undefined, epoch)).rejects.toMatchObject({
      code: 'STALE_WRITE',
    });
  });
});
