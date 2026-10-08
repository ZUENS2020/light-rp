import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/server/store';
import { extractionSchema, type Extraction } from '../src/server/extraction';
import {
  assertEntityResolution,
  entityResolutionPrompt,
  listEntities,
  resolveExtractionEntities,
  resolveMemoryEntities,
  entityReviewProposals,
  type EntityCharacter,
} from '../src/server/entities';
import type { Event } from '../src/shared/domain';
import { createTestD1 } from './d1';

let database: ReturnType<typeof createTestD1>;
let store: Store;
let branchId: string;
let sessionId: string;
let worldId: string;
let characters: EntityCharacter[];
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'owner');
  const world = await store.createWorld({ name: '双名之城' });
  worldId = world.id;
  characters = [
    { id: 'card-a', revision: 1, data: { name: '小明', nickname: '守门人' } },
    { id: 'card-b', revision: 1, data: { name: '小明', nickname: '测绘师' } },
  ];
  for (const character of characters) {
    const at = new Date().toISOString(),
      data = JSON.stringify(character.data);
    await store.run(
      'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?)',
      character.id,
      store.ownerId,
      'character',
      character.data.name,
      data,
      data,
      at,
      at,
    );
    await store.run(
      'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,1,?,?,?)',
      crypto.randomUUID(),
      character.id,
      data,
      data,
      at,
    );
  }
  const story = await store.createStory({
    worldId,
    characterIds: characters.map((character) => character.id),
  });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
});
afterEach(() => database.close());
async function turn(text: string, target = branchId, session = sessionId) {
  return (
    await store.appendTurn({
      branchId: target,
      sessionId: session,
      requestId: crypto.randomUUID(),
      messages: [{ role: 'assistant', text }],
    })
  ).events[0]!;
}
function extracted(
  event: Event,
  subjects: {
    subject: string;
    predicate?: string;
    value?: string | string[];
    kind?: 'canon' | 'relation';
  }[],
): Extraction {
  return extractionSchema.parse({
    scene: {},
    facts: subjects.map((fact) => ({
      subject: fact.subject,
      predicate: fact.predicate || 'state',
      value: fact.value ?? '存在',
      kind: fact.kind || 'canon',
      text: event.text,
      evidence: [{ source: 'assistant', quote: event.text }],
    })),
  });
}
const resolve = (
  event: Event,
  facts: Parameters<typeof extracted>[1],
  target = branchId,
  cast = characters,
) => resolveExtractionEntities(store, target, extracted(event, facts), [event], cast);

describe('explicit character IDs and homonym disambiguation', () => {
  it('quarantines unsupported entity candidates without blocking valid facts or reviving partial registrations', async () => {
    const event = await turn('门开着。白钥匙在桌面。');
    const proposed = extracted(event, [
      { subject: '门', predicate: '持有', kind: 'relation', value: '无依据钥匙' },
      { subject: '白钥匙', predicate: '位置', value: '桌面' },
    ]);
    const resolved = await resolveMemoryEntities(store, branchId, proposed, [event], characters);
    expect(resolved.rejectedFacts).toMatchObject([
      { factIndex: 0, path: 'value', code: 'ENTITY_NAME_EVIDENCE' },
    ]);
    expect(resolved.extraction.facts).toHaveLength(1);
    expect(
      (await listEntities(store, branchId))
        .filter((e) => e.kind === 'entity')
        .map((e) => e.name)
        .sort(),
    ).toEqual(['桌面', '白钥匙']);
    const reviews = entityReviewProposals(resolved.rejectedFacts, [event]);
    await store.extract(branchId, {
      eventIds: [event.id],
      cursor: event.seq,
      extractorVersion: 'v3-facts',
      proposals: reviews,
    });
    await store.extract(branchId, {
      eventIds: [event.id],
      cursor: event.seq,
      extractorVersion: 'v3-facts',
      proposals: reviews,
    });
    const all = await store.memories(branchId, { includeInactive: true });
    expect(all.filter((m) => m.status === 'draft')).toHaveLength(1);
    expect(all.filter((m) => m.status === 'active')).toHaveLength(1);
    expect(
      (await store.recall(branchId, '无依据钥匙')).items.every((i) => i.memory.status === 'active'),
    ).toBe(true);
    expect((await store.recall(branchId, '白钥匙', { viewer: characters[0]!.id })).items).toEqual(
      [],
    );
    expect(
      (
        await store.one<{ applied_seq: number }>(
          "SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version='v3-facts'",
          branchId,
        )
      )?.applied_seq,
    ).toBe(event.seq);
    await store.deleteSource(event.sourceId);
    await expect(
      resolveMemoryEntities(store, branchId, proposed, [event], characters),
    ).rejects.toMatchObject({ code: 'ENTITY_SOURCE' });
    expect((await store.recall(branchId, '白钥匙')).items).toEqual([]);
  });
  it('quarantines ambiguous homonyms while keeping explicit card IDs usable', async () => {
    const event = await turn('两位小明站在北门。');
    const resolved = await resolveMemoryEntities(
      store,
      branchId,
      extracted(event, [
        { subject: '小明', kind: 'relation', value: '小明' },
        { subject: characters[0]!.id },
      ]),
      [event],
      characters,
    );
    expect(resolved.rejectedFacts[0]?.code).toBe('ENTITY_AMBIGUOUS');
    expect(resolved.rejectedFacts).toHaveLength(1);
    expect(resolved.extraction.facts[0]?.subject).toBe(characters[0]!.id);
    await expect(
      resolveMemoryEntities(
        store,
        branchId,
        extracted({ ...event, sourceId: 'invalid' }, [{ subject: '小明' }]),
        [{ ...event, sourceId: 'invalid' }],
        characters,
      ),
    ).rejects.toMatchObject({ code: 'ENTITY_SOURCE' });
  });
  it('keeps two 小明 cards independent and leaves name-only reference ambiguous', async () => {
    const event = await turn('两位小明站在北门，各有不同任务。');
    const ambiguous = await resolve(event, [{ subject: '小明' }]);
    expect(ambiguous.ambiguities).toMatchObject([
      { factIndex: 0, path: 'subject', reference: '小明', reason: 'ambiguous_alias' },
    ]);
    expect(ambiguous.ambiguities[0]!.candidates.map((candidate) => candidate.id).sort()).toEqual([
      'card-a',
      'card-b',
    ]);
    expect(ambiguous.draftFactIndexes).toEqual([0]);
    expect(() => assertEntityResolution(ambiguous)).toThrow('实体引用需要消歧');
    expect(await store.all('SELECT * FROM entities')).toEqual([]);
    const explicit = await resolve(event, [
      { subject: 'card-a', value: '守门' },
      { subject: 'card-b', value: '测绘' },
    ]);
    expect(explicit.extraction.facts.map((fact) => fact.subject)).toEqual(['card-a', 'card-b']);
    expect(explicit.ambiguities).toEqual([]);
    expect((await listEntities(store, branchId)).map((entity) => entity.id).sort()).toEqual([
      'card-a',
      'card-b',
    ]);
    expect(entityResolutionPrompt(await listEntities(store, branchId))).toContain(
      '即使名称相同也不得合并',
    );
  });
  it('resolves an explicit nickname without merging the homonymous cards', async () => {
    const event = await turn('守门人把地图递给测绘师。');
    const result = await resolve(event, [
      { subject: '守门人', kind: 'relation', predicate: 'friend', value: '测绘师' },
    ]);
    expect(result.extraction.facts[0]).toMatchObject({ subject: 'card-a', value: 'card-b' });
    expect(result.ambiguities).toEqual([]);
  });
  it('uses explicit nickname priority but refuses shared nicknames and invented IDs', async () => {
    const event = await turn('小明看着门口。');
    const preferred = characters.map((character) => ({
      ...character,
      data: { ...character.data, nickname: character.id === 'card-a' ? '小明' : '测绘师' },
    }));
    expect(
      (await resolve(event, [{ subject: '小明' }], branchId, preferred)).extraction.facts[0]!
        .subject,
    ).toBe('card-a');
    const shared = characters.map((character) => ({
      ...character,
      data: { ...character.data, nickname: '守门人' },
    }));
    const sharedEvent = await turn('守门人靠近门口。');
    expect(
      (await resolve(sharedEvent, [{ subject: '守门人' }], branchId, shared)).ambiguities[0]!
        .candidates,
    ).toHaveLength(2);
    const unknown = await resolve(event, [{ subject: '00000000-0000-4000-8000-000000000000' }]);
    expect(unknown.ambiguities[0]!.reason).toBe('unknown_id');
  });
});

describe('source-bound object identities and alias indexing', () => {
  it('uses a stable source/story/name ID across retries and maps relation targets', async () => {
    const event = await turn('白钥匙在仓库。');
    const first = await resolve(event, [
      { subject: '白钥匙', predicate: 'location', value: '仓库' },
    ]);
    const repeated = await resolve(event, [
      { subject: '白钥匙', predicate: 'location', value: '仓库' },
    ]);
    expect(first.extraction.facts[0]).toEqual(repeated.extraction.facts[0]);
    expect(first.extraction.facts[0]!.subject).toMatch(/^ent_[a-f0-9]{64}$/);
    expect(first.extraction.facts[0]!.value).toMatch(/^ent_[a-f0-9]{64}$/);
    expect(await store.all('SELECT * FROM entities')).toHaveLength(2);
    const another = await store.createStory({ worldId });
    const session = await store.createSession({ branchId: another.branchId });
    const otherEvent = await turn('白钥匙在仓库。', another.branchId, session.id);
    const other = await resolve(otherEvent, [{ subject: '白钥匙' }], another.branchId, []);
    expect(other.extraction.facts[0]!.subject).not.toBe(first.extraction.facts[0]!.subject);
  });
  it('records an evidenced alias and reuses it in a later event', async () => {
    const introduction = await turn('白钥匙又名银羽。');
    const first = await resolve(introduction, [
      { subject: '白钥匙', predicate: 'alias', value: '银羽' },
    ]);
    const later = await turn('银羽依然完好。');
    const resolved = await resolve(later, [{ subject: '银羽', value: '完好' }]);
    expect(resolved.extraction.facts[0]!.subject).toBe(first.extraction.facts[0]!.subject);
    const entity = (await listEntities(store, branchId)).find(
      (entity) => entity.id === first.extraction.facts[0]!.subject,
    )!;
    expect(entity.aliases.sort()).toEqual(['白钥匙', '银羽']);
    expect(await store.all('SELECT * FROM entity_aliases')).toHaveLength(2);
  });
  it('leaves a shared alias ambiguous instead of fusing two entities', async () => {
    const first = await turn('甲匣别名宝盒。'),
      second = await turn('乙匣别名宝盒。');
    const a = await resolve(first, [{ subject: '甲匣', predicate: 'alias', value: '宝盒' }]);
    const b = await resolve(second, [{ subject: '乙匣', predicate: 'alias', value: '宝盒' }]);
    expect(a.extraction.facts[0]!.subject).not.toBe(b.extraction.facts[0]!.subject);
    const third = await turn('宝盒被打开。');
    const ambiguous = await resolve(third, [{ subject: '宝盒', value: '打开' }]);
    expect(ambiguous.ambiguities[0]!.candidates).toHaveLength(2);
    expect(
      (await listEntities(store, branchId)).filter((entity) => entity.kind === 'entity'),
    ).toHaveLength(2);
  });
  it('rejects invented new names and refuses noncanonical or sibling sources', async () => {
    const event = await turn('只有一座门。');
    await expect(resolve(event, [{ subject: '不存在的人' }])).rejects.toMatchObject({
      code: 'ENTITY_NAME_EVIDENCE',
    });
    const child = await store.fork({ branchId, atSeq: event.seq });
    const later = await turn('未来钥匙出现。');
    await expect(resolve(later, [{ subject: '未来钥匙' }], child.id)).rejects.toMatchObject({
      code: 'ENTITY_SOURCE',
    });
    await expect(
      resolve({ ...event, sourceId: 'uncommitted-source' }, [{ subject: '门' }]),
    ).rejects.toMatchObject({ code: 'ENTITY_SOURCE' });
    expect(await store.all('SELECT * FROM entities')).toEqual([]);
  });
});

describe('branch cutoff and irreversible source invalidation', () => {
  it('excludes future aliases, objects and resource revisions during historical replay', async () => {
    const birth = await turn('白钥匙是蓝色的。');
    const first = await resolve(birth, [{ subject: '白钥匙' }]);
    const alias = await turn('白钥匙又名银羽。');
    await resolve(alias, [{ subject: '白钥匙', predicate: 'alias', value: '银羽' }]);
    const future = await turn('红箱出现。');
    await resolve(future, [{ subject: '红箱' }]);
    const updated = { name: '小明', nickname: '未来门神' },
      data = JSON.stringify(updated);
    await store.run('UPDATE assets SET revision=2,data_json=? WHERE id=?', data, 'card-a');
    await store.run(
      'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,created_at) VALUES(?,?,2,?,?,?)',
      crypto.randomUUID(),
      'card-a',
      data,
      data,
      new Date().toISOString(),
    );
    await store.applyResourceUpdates(branchId, ['card-a']);
    const past = await listEntities(store, branchId, birth.seq);
    expect(
      past.find((entity) => entity.id === first.extraction.facts[0]!.subject)!.aliases,
    ).toEqual(['白钥匙']);
    expect(past.some((entity) => entity.name === '红箱')).toBe(false);
    expect(past.find((entity) => entity.id === 'card-a')!.aliases).toContain('守门人');
    expect(past.find((entity) => entity.id === 'card-a')!.aliases).not.toContain('未来门神');
    expect(
      (await listEntities(store, branchId)).find((entity) => entity.id === 'card-a')!.aliases,
    ).toContain('未来门神');
    const replay = await resolveExtractionEntities(
      store,
      branchId,
      extracted(birth, [{ subject: '白钥匙' }]),
      [birth],
      [{ id: 'card-a', data: updated }],
      { asOfSeq: birth.seq },
    );
    expect(replay.extraction.facts[0]!.subject).toBe(first.extraction.facts[0]!.subject);
    expect(replay.entities.find((entity) => entity.id === 'card-a')!.aliases).not.toContain(
      '未来门神',
    );
    await expect(
      resolveExtractionEntities(
        store,
        branchId,
        extracted(future, [{ subject: '红箱' }]),
        [future],
        [],
        { asOfSeq: birth.seq },
      ),
    ).rejects.toMatchObject({ code: 'ENTITY_SOURCE' });
  });
  it('freezes parent future entities/aliases while allowing an independent child alias', async () => {
    const birth = await turn('白钥匙是蓝色的。');
    const object = await resolve(birth, [{ subject: '白钥匙', predicate: 'color', value: '蓝色' }]);
    const id = object.extraction.facts[0]!.subject;
    const child = await store.fork({ branchId, atSeq: birth.seq });
    const parentAlias = await turn('白钥匙又名银羽。');
    await resolve(parentAlias, [{ subject: id, predicate: 'alias', value: '银羽' }]);
    const future = await turn('红钥匙出现。');
    await resolve(future, [{ subject: '红钥匙' }]);
    const childSession = await store.createSession({ branchId: child.id });
    const childAlias = await turn('白钥匙又名灰羽。', child.id, childSession.id);
    await resolve(childAlias, [{ subject: id, predicate: 'alias', value: '灰羽' }], child.id);
    const parentEntity = (await listEntities(store, branchId)).find((entity) => entity.id === id)!;
    const childEntities = await listEntities(store, child.id);
    expect(parentEntity.aliases.sort()).toEqual(['白钥匙', '银羽']);
    expect(childEntities.find((entity) => entity.id === id)!.aliases.sort()).toEqual([
      '灰羽',
      '白钥匙',
    ]);
    expect(childEntities.some((entity) => entity.name === '红钥匙')).toBe(false);
  });
  it('erases an alias when its source is deleted and erases identity names across derived branches', async () => {
    const birth = await turn('白钥匙是蓝色的。');
    const first = await resolve(birth, [{ subject: '白钥匙', predicate: 'color', value: '蓝色' }]);
    const id = first.extraction.facts[0]!.subject;
    const alias = await turn('白钥匙又名银羽。');
    await resolve(alias, [{ subject: id, predicate: 'alias', value: '银羽' }]);
    const child = await store.fork({ branchId, atSeq: alias.seq });
    await store.deleteSource(alias.sourceId);
    expect(
      (await listEntities(store, child.id)).find((entity) => entity.id === id)!.aliases,
    ).toEqual(['白钥匙']);
    expect(JSON.stringify(await store.all('SELECT alias FROM entity_aliases'))).not.toContain(
      '银羽',
    );
    await store.deleteSource(birth.sourceId);
    for (const branch of [branchId, child.id])
      expect((await listEntities(store, branch)).some((entity) => entity.id === id)).toBe(false);
    expect(
      JSON.stringify(await store.all('SELECT name,normalized_name FROM entities')),
    ).not.toContain('白钥匙');
    expect(await store.all('SELECT * FROM entity_aliases')).toEqual([]);
    await expect(resolve(birth, [{ subject: '白钥匙' }])).rejects.toMatchObject({
      code: 'ENTITY_SOURCE',
    });
  });
  it('rejects a stale deletion epoch atomically and excludes source-version mismatches', async () => {
    const erased = await turn('旧对象出现。');
    const epoch = await store.ownerEpoch();
    const live = await turn('新对象出现。');
    await store.deleteSource(erased.sourceId);
    await expect(
      resolveExtractionEntities(
        store,
        branchId,
        extracted(live, [{ subject: '新对象' }]),
        [live],
        characters,
        { ownerEpoch: epoch },
      ),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await store.all('SELECT * FROM entities')).toEqual([]);
    const created = await resolve(live, [{ subject: '新对象' }]);
    await store.run('UPDATE sources SET version=version+1 WHERE id=?', live.sourceId);
    expect(
      (await listEntities(store, branchId)).some(
        (entity) => entity.id === created.extraction.facts[0]!.subject,
      ),
    ).toBe(false);
  });
});
