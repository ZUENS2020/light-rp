import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import {
  applyThreadChanges,
  beginUnified,
  memoryPolicy,
  plotThreads,
  recordPage,
  rollUnified,
  rebuildNarrativeUnit,
} from '../src/server/narrative-memory';
import { defaults } from '../src/server/settings';
import { extractionSchema } from '../src/server/extraction';
import { ContextComposer } from '../src/server/context-composer';
import type { Env } from '../src/server/env';
import { buildContext } from '../src/server/context';
import { complete } from '../src/server/model';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/server/model', () => ({
  complete: vi.fn(async (_env, _settings, messages) => {
    const input = JSON.parse(messages[1].content);
    return JSON.stringify({
      text: '原文的局部纪要：送钥匙的承诺仍未履行。',
      retainedIds: input.items.map((i: { id: string }) => i.id),
      sceneEnd: input.raw === true,
      arcEnd: true,
      chapterEnd: true,
      threadChanges: [],
      ...(input.extractThreads ? { extraction: { scene: {}, facts: [], threadChanges: [] } } : {}),
    });
  }),
  parseJson: (raw: string) => JSON.parse(raw),
}));
let d: ReturnType<typeof createTestD1>, s: Store, branchId: string, sessionId: string, env: Env;
beforeEach(async () => {
  d = createTestD1();
  s = new Store(d.db, 'unified-test');
  const w = await s.createWorld('长篇');
  const story = await s.createStory({ worldId: w.id });
  branchId = story.branchId;
  sessionId = (await s.createSession({ branchId })).id;
  const data = new Map<string, string>();
  env = {
    DB: d.db,
    MODEL_MODE: 'openai',
    BUCKET: {
      put: async (k: string, v: string) => {
        data.set(k, v);
      },
      get: async (k: string) =>
        data.has(k) ? { json: async () => JSON.parse(data.get(k)!) } : null,
      delete: async (k: string) => {
        data.delete(k);
      },
    },
  } as unknown as Env;
});
afterEach(() => d.close());
async function event(text: string) {
  return (
    await s.appendTurn({
      branchId,
      sessionId,
      requestId: crypto.randomUUID(),
      messages: [{ role: 'assistant', text }],
    })
  ).events[0]!;
}
async function roll() {
  const b = await s.getBranch(branchId);
  await rollUnified(
    env,
    s,
    branchId,
    b.headSeq,
    await s.ownerEpoch(),
    defaults('openai'),
    async (_name, fn) => fn(),
    `test/${b.headSeq}`,
  );
}
const change = {
  title: '送还钥匙',
  type: 'promise' as const,
  state: 'open' as const,
  completion: '把蓝钥匙交给乙',
  text: '甲承诺把蓝钥匙交给乙',
  evidence: [{ source: 'assistant' as const, quote: '甲承诺把蓝钥匙交给乙。' }],
  knowledge: [],
};
describe('one source, one state owner', () => {
  it('backfills threads from old online turns without relearning their facts, while fully extracting imports', async () => {
    const old = await event(change.evidence[0]!.quote);
    await s.run(
      'UPDATE turns SET task_id=? WHERE branch_id=? AND request_id=(SELECT request_id FROM events WHERE id=?)',
      'legacy-task',
      branchId,
      old.id,
    );
    const imported = await event('钥匙是蓝色。');
    const model = vi.mocked(complete);
    const good = model.getMockImplementation()!;
    model.mockImplementationOnce(async (_env, _settings, messages) => {
      const input = JSON.parse(messages[1]!.content as string);
      expect(input.learningSourceIds).toEqual([imported.sourceId]);
      const result = JSON.parse(await good(_env, _settings, messages));
      result.extraction.facts = [
        {
          kind: 'episode',
          subject: '甲',
          predicate: '承诺',
          value: old.text,
          text: old.text,
          evidence: [{ source: 'assistant', quote: old.text }],
        },
      ];
      return JSON.stringify(result);
    });
    model.mockImplementationOnce(async (_env, _settings, messages) => {
      expect(messages[1]!.content).toContain('不属于learningSourceIds');
      const result = JSON.parse(
        await good(_env, _settings, [
          messages[0]!,
          { ...messages[1]!, content: (messages[1]!.content as string).split('\n修复：')[0]! },
        ]),
      );
      result.extraction.facts = [
        {
          kind: 'canon',
          subject: '钥匙',
          predicate: '颜色',
          value: '蓝色',
          text: imported.text,
          evidence: [{ source: 'assistant', quote: imported.text }],
        },
      ];
      result.extraction.threadChanges = [change];
      return JSON.stringify(result);
    });
    await roll();
    expect((await s.memories(branchId, { kinds: ['canon'] })).map((m) => m.value)).toEqual([
      '蓝色',
    ]);
    expect(
      await s.memories(branchId, { kinds: ['episode', 'experience', 'procedure'] }),
    ).toHaveLength(0);
    expect(await plotThreads(s, branchId)).toHaveLength(1);
  });
  it('points a repair at the unsupported candidate while keeping its claim out of persistent errors', async () => {
    const e = await event('甲站在门口等候。');
    let quote = e.text;
    const model = vi.mocked(complete);
    const good = model.getMockImplementation()!;
    const unsupported = async (
      _env: Parameters<typeof complete>[0],
      _settings: Parameters<typeof complete>[1],
      messages: Parameters<typeof complete>[2],
    ) => {
      const input = JSON.parse((messages[1]!.content as string).split('\n修复：')[0]!);
      return JSON.stringify({
        text: '甲在门口等候。',
        sceneEnd: false,
        arcEnd: false,
        chapterEnd: false,
        retainedIds: input.items.map((i: { id: string }) => i.id),
        extraction: {
          scene: {},
          facts: [
            {
              kind: 'canon',
              subject: '甲',
              predicate: '结果',
              value: '私密的无依据成功断言',
              text: '私密的无依据成功断言',
              evidence: [{ source: 'assistant', quote }],
            },
          ],
        },
      });
    };
    model.mockImplementationOnce(unsupported);
    model.mockImplementationOnce(async (_env, _settings, messages) => {
      expect(messages[1]!.content).toContain('facts.0.value');
      expect(messages[1]!.content).toContain('"candidate"');
      return good(_env, _settings, [
        messages[0]!,
        { ...messages[1]!, content: (messages[1]!.content as string).split('\n修复：')[0]! },
      ]);
    });
    await roll();
    expect((await s.memories(branchId)).some((m) => m.text === '私密的无依据成功断言')).toBe(false);
    const failed = await event('乙仍未答复。');
    quote = failed.text;
    model
      .mockImplementationOnce(unsupported)
      .mockImplementationOnce(unsupported)
      .mockImplementationOnce(unsupported);
    const error = await roll().then(
      () => null,
      (error: Error) => error,
    );
    expect(error?.message).toContain('局部归档校验失败：世界事实的value');
    expect(error?.message).not.toContain('私密的无依据成功断言');
    expect(await s.all("SELECT * FROM narrative_units WHERE level='segment'")).toHaveLength(1);
  });
  it('repairs an invented scene identity before activating an archive or advancing the cursor', async () => {
    await event('甲在门口等待，送钥匙的承诺仍未履行。');
    const model = vi.mocked(complete);
    const good = model.getMockImplementation()!;
    model.mockImplementationOnce(async (_env, _settings, messages) => {
      const input = JSON.parse(messages[1]!.content as string);
      expect(input.idRules.scenePresent).toEqual([]);
      const value = JSON.parse(await good(_env, _settings, messages));
      value.extraction.scene.present = ['invented-npc'];
      return JSON.stringify(value);
    });
    model.mockImplementationOnce(async (_env, _settings, messages) => {
      expect(messages[1]!.content).toContain('scene.present只能使用绑定角色ID []');
      expect(await s.all('SELECT * FROM narrative_units')).toHaveLength(0);
      return good(_env, _settings, [
        messages[0]!,
        { ...messages[1]!, content: (messages[1]!.content as string).split('\n修复：')[0]! },
      ]);
    });
    await roll();
    expect(await s.all("SELECT * FROM narrative_units WHERE level='segment'")).toHaveLength(1);
    expect((await memoryPolicy(s, branchId)).status).toBe('active');
  });
  it('records a stable thread once, never creating an experience, success, knowledge or ability', async () => {
    const e = await event('甲承诺把蓝钥匙交给乙。');
    await applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], await s.ownerEpoch());
    await applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], await s.ownerEpoch());
    expect(await plotThreads(s, branchId)).toHaveLength(1);
    expect(await s.memories(branchId, { kinds: ['experience', 'procedure'] })).toHaveLength(0);
    expect(await s.listCapabilities(branchId)).toHaveLength(0);
    expect(await s.all('SELECT * FROM knowledge_grants')).toHaveLength(0);
    const t = (await plotThreads(s, branchId))[0]!;
    const result = await event('甲把蓝钥匙交给乙，承诺已经履行。');
    await applyThreadChanges(
      s,
      branchId,
      {
        threadChanges: [
          {
            ...change,
            threadId: t.id,
            state: 'resolved',
            text: '钥匙已经交还',
            evidence: [{ source: 'assistant', quote: result.text }],
          },
        ],
      },
      [result],
      await s.ownerEpoch(),
    );
    expect((await plotThreads(s, branchId))[0]?.state).toBe('resolved');
    expect((await s.memoryVersions(branchId, t.revisionId))[0]?.data?.threadState).toBe('open');
    expect(await s.memories(branchId, { kinds: ['experience', 'procedure'] })).toHaveLength(0);
  });
  it('seals Scene → Arc → Chapter without resolving the promise, and retries install no duplicate nodes', async () => {
    const first = await event(change.evidence[0]!.quote);
    await applyThreadChanges(
      s,
      branchId,
      { threadChanges: [change] },
      [first],
      await s.ownerEpoch(),
    );
    for (let i = 0; i < 25; i++) {
      if (i) await event(`第${i}幕，甲望向远方。`);
      await roll();
    }
    const before = await s.all('SELECT * FROM narrative_units');
    await roll();
    expect(await s.all('SELECT * FROM narrative_units')).toHaveLength(before.length);
    expect(before.some((m) => m.level === 'chapter')).toBe(true);
    expect((await plotThreads(s, branchId))[0]?.state).toBe('open');
    expect((await memoryPolicy(s, branchId)).status).toBe('active');
    const page = await recordPage(s, branchId, 'archive');
    expect(page.items.every((m) => m.evidence.length > 0)).toBe(true);
  });
  it('the DB blocks late legacy writers and rolls back even empty progress updates', async () => {
    const e = await event('甲望向山间。');
    await roll();
    const b = await s.getBranch(branchId);
    const count = (await s.all('SELECT id FROM memory_versions')).length;
    await expect(
      s.activateObservation({
        branchId,
        cursor: b.headSeq,
        expectedMemoryIds: [],
        proposals: [
          {
            kind: 'observation',
            subject: 'director',
            predicate: 'rolling-observation:narrative',
            value: e.text,
            text: e.text,
            evidence: [
              { sourceId: e.sourceId, start: 0, end: Array.from(e.text).length, quote: e.text },
            ],
            data: { version: 'rolling-v1' },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await s.all('SELECT id FROM memory_versions')).toHaveLength(count);
    await expect(
      s.activateObservation({
        branchId,
        cursor: b.headSeq,
        expectedMemoryIds: [],
        proposals: [],
        progress: { scope: 'director:narrative', expectedRevision: 0, state: {} },
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
  });
  it('a sealed parent and its children consume the source once, with actual coverage distinct from processed prefix', async () => {
    await event('甲望向山间。');
    await roll();
    const units = (await recordPage(s, branchId, 'archive')).items;
    const parent = units.find((m) => m.data?.level === 'scene')!,
      child = units.find((m) => m.data?.level === 'segment')!;
    const composer = new ContextComposer(units);
    const p = composer.preview(parent, 'director', 'archive', ['selected'])!;
    expect(p.content).not.toContain('quote');
    p.accept();
    expect(composer.preview(child, 'director', 'recall', ['vector'])).toBeNull();
    expect(composer.preview(parent, 'director', 'recall', ['lexical'])).toBeNull();
    const e = (await s.getEvents(branchId))[0]!;
    expect(composer.covers('director', e.sourceId, Array.from(e.text).length)).toBe(true);
    expect(composer.covers('other', e.sourceId, Array.from(e.text).length)).toBe(false);
  });
  it('source deletion invalidates threads, archives and nested branch records, while late tasks cannot revive them', async () => {
    const e = await event(change.evidence[0]!.quote);
    await applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], await s.ownerEpoch());
    await roll();
    const child = await s.fork({ branchId, atSeq: 1 });
    await s.deleteSource(e.sourceId);
    expect(await plotThreads(s, branchId)).toHaveLength(0);
    expect((await recordPage(s, branchId, 'archive')).items).toHaveLength(0);
    expect((await recordPage(s, child.id, 'archive')).items).toHaveLength(0);
    await expect(
      applyThreadChanges(s, branchId, { threadChanges: [change] }, [e], 0),
    ).rejects.toThrow();
  });
  it('backs up the policy and derived directories alongside canonical revisions', async () => {
    await event('甲望向山间。');
    await roll();
    const b = await s.getBranch(branchId),
      exported = await s.exportStory(b.storyId);
    expect(exported.memoryPolicies?.length).toBe(1);
    expect(exported.narrativeUnits!.length).toBeGreaterThan(0);
  });
  it('rebuilds one archive from sources without extracting events, attempts or abilities', async () => {
    await event('甲望向山间。');
    await roll();
    const segment = (await recordPage(s, branchId, 'archive')).items.find(
      (m) => m.data?.level === 'segment',
    )!;
    const before = (await s.getEvents(branchId)).length;
    await rebuildNarrativeUnit(
      env,
      s,
      branchId,
      segment.id,
      defaults('openai'),
      await s.ownerEpoch(),
    );
    expect(await s.getEvents(branchId)).toHaveLength(before);
    expect(await s.memories(branchId, { kinds: ['experience', 'procedure'] })).toHaveLength(0);
  });
  it('restores a full SQLite snapshot with policy, source deletion fences, FTS and archive directories intact', async () => {
    const first = await event(change.evidence[0]!.quote);
    await applyThreadChanges(
      s,
      branchId,
      { threadChanges: [change] },
      [first],
      await s.ownerEpoch(),
    );
    await roll();
    const erased = await event('应当被销毁的旧口令。');
    await s.deleteSource(erased.sourceId);
    const directory = await mkdtemp(join(tmpdir(), 'lrp-unified-recovery-'));
    let restored: ReturnType<typeof createTestD1> | undefined;
    try {
      const path = join(directory, 'snapshot.sqlite');
      await writeFile(path, d.sqlite.serialize(), { mode: 0o600 });
      restored = createTestD1({ schema: false, filename: path });
      const recovered = new Store(restored.db, s.ownerId);
      expect(await recovered.getBranch(branchId)).toEqual(await s.getBranch(branchId));
      expect(await memoryPolicy(recovered, branchId)).toEqual(await memoryPolicy(s, branchId));
      expect(await plotThreads(recovered, branchId)).toEqual(await plotThreads(s, branchId));
      expect((await recordPage(recovered, branchId, 'archive')).items).toEqual(
        (await recordPage(s, branchId, 'archive')).items,
      );
      expect(await recovered.source(erased.sourceId)).toMatchObject({ status: 'deleted' });
      expect(await recovered.recall(branchId, '送还钥匙')).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            memory: expect.objectContaining({ predicate: 'plot-thread' }),
          }),
        ]),
      });
      expect(restored.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      restored?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
