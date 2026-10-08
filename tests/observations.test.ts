import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import {
  rollObservations,
  queueObservationBackfill,
  OBSERVATION_TOKENS,
} from '../src/server/observations';
import { defaults } from '../src/server/settings';
import type { Env } from '../src/server/env';
import type { Event, Memory, QuerySpec } from '../src/shared/domain';
import { estimateAssetTokens } from '../src/shared/assets';
import { buildContext } from '../src/server/context';
vi.mock('../src/server/model', async (original) => ({
  ...(await original<typeof import('../src/server/model')>()),
  complete: vi.fn(),
}));
import { complete } from '../src/server/model';

let db: ReturnType<typeof createTestD1>, store: Store, branchId: string, sessionId: string;
const objects = new Map<string, string>();
const env = {
  BUCKET: {
    put: async (key: string, value: string) => {
      objects.set(key, value);
    },
    get: async (key: string) =>
      objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
    delete: async (key: string) => {
      objects.delete(key);
    },
  },
} as unknown as Env;
const settings = { ...defaults('openai'), contextWindow: 131072, auxiliaryMaxOutput: 32768 };
const immediate = async (_name: string, callback: () => Promise<string>) => callback();
beforeEach(async () => {
  db = createTestD1();
  store = new Store(db.db, 'rolling-owner');
  objects.clear();
  const world = await store.createWorld('压缩测试'),
    story = await store.createStory({ worldId: world.id });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  vi.mocked(complete)
    .mockReset()
    .mockImplementation(async (_env, _settings, messages) => {
      const input = JSON.parse(messages[1]!.content.split('\n上一份结果')[0]!);
      // Synthetic reflector retains all named assertions and commitments, while
      // removing repetitive filler. This tests the integration, not LLM quality.
      const data = [
        input.previous?.text ?? '',
        ...input.additions.map((a: { text: string }) => a.text),
      ].join('\n');
      const important = [...new Set(data.match(/【[^】]+】/gu) ?? [])];
      return JSON.stringify({
        text: `历史与当前状态：${important.join('；')}。`,
        retainedIds: input.requiredIds,
      });
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
async function event(text: string, role: 'assistant' | 'correction' = 'assistant') {
  return (
    await store.appendTurn({
      branchId,
      sessionId,
      requestId: crypto.randomUUID(),
      messages: [{ role, text }],
    })
  ).events[0]!;
}
async function fact(e: Event, text = e.text, extra = {}) {
  return store.propose(branchId, {
    kind: 'canon',
    subject: '信物',
    predicate: '状态',
    value: text,
    text,
    evidence: [{ sourceId: e.sourceId, start: 0, end: Array.from(e.text).length, quote: e.text }],
    ...extra,
  });
}
async function roll(id = branchId, through?: number) {
  return rollObservations(
    env,
    store,
    id,
    through ?? (await store.getBranch(id)).headSeq,
    await store.ownerEpoch(),
    settings,
    immediate,
  );
}
async function root(
  bucket = 'narrative',
  viewer = 'director',
  id = branchId,
): Promise<Memory | undefined> {
  return (await store.memories(id, { viewer, kinds: ['observation'] })).find(
    (m) => m.subject === viewer && m.predicate === `rolling-observation:${bucket}`,
  );
}
async function progress(scope = 'director:narrative', id = branchId) {
  const row = await store.one<{
    revision: number;
    state_json: string;
    observation_id: string | null;
  }>('SELECT * FROM observation_progress WHERE branch_id=? AND scope=?', id, scope);
  return { ...row, state: JSON.parse(row!.state_json) };
}

describe('durable rolling observer and reflector', () => {
  it('backfills existing user stories exactly once without starting paid fixture jobs', async () => {
    await event('需要补整理的已有剧情。');
    await store.run("UPDATE outbox SET status='completed' WHERE branch_id=?", branchId);
    const fixtures = new Store(db.db, 'evaluation:fixture');
    const w = await fixtures.createWorld(),
      story = await fixtures.createStory({ worldId: w.id });
    const session = await fixtures.createSession({ branchId: story.branchId });
    await fixtures.appendTurn({
      branchId: story.branchId,
      sessionId: session.id,
      requestId: 'fixture',
      messages: [{ role: 'assistant', text: '评测素材。' }],
    });
    await fixtures.run(
      "UPDATE outbox SET status='evaluation-fixture' WHERE branch_id=?",
      story.branchId,
    );
    await queueObservationBackfill({ ...env, DB: db.db, MODEL_MODE: 'openai' });
    await queueObservationBackfill({ ...env, DB: db.db, MODEL_MODE: 'openai' });
    const jobs = await store.all<{ branch_id: string; payload_json: string }>(
      "SELECT branch_id,payload_json FROM outbox WHERE id LIKE 'rolling-v1:%'",
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.branch_id).toBe(branchId);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({ compressOnly: true, throughSeq: 1 });
  });
  it('merges old observations with every new page, including events without extracted facts', async () => {
    const first = await event('【约定：归还怀表】' + '黄昏安静。'.repeat(180));
    await roll();
    const previous = await root();
    await event('【最新：找到车站】' + '沿路检查。'.repeat(180));
    await roll();
    const current = await root();
    expect(current!.text).toContain('约定：归还怀表');
    expect(current!.text).toContain('最新：找到车站');
    expect(current!.data?.previousObservationId).toBe(previous!.id);
    expect(current!.sourceIds).toContain(first.sourceId);
    expect((await progress()).state).toMatchObject({
      throughSeq: 2,
      eventSeq: 2,
      eventOffset: 0,
      reflectionCount: 1,
    });
    expect(estimateAssetTokens(current!.text)).toBeLessThanOrEqual(OBSERVATION_TOKENS);
    expect(await store.getEvents(branchId)).toHaveLength(2);
    const count = (await store.all('SELECT id FROM observation_batches')).length;
    await roll();
    expect((await store.all('SELECT id FROM observation_batches')).length).toBe(count);
  });
  it('splits a long opening by Unicode offsets and reaches its final fragment', async () => {
    const e = await event('【开头：等待信使】' + '桥边🙂'.repeat(8000) + '【结尾：信使抵达】');
    await roll();
    const state = (await progress()).state;
    expect(state.eventSeq).toBe(1);
    expect(state.eventOffset).toBe(0);
    expect(state.observedCount).toBeGreaterThan(1);
    expect((await root())!.text).toContain('信使抵达');
    expect((await store.getEvents(branchId))[0]!.text).toBe(e.text);
    const spans = await store.all<{ start_offset: number; end_offset: number; quote: string }>(
      'SELECT p.* FROM source_spans p WHERE source_id=? ORDER BY start_offset',
      e.sourceId,
    );
    for (const span of spans)
      expect(Array.from(e.text).slice(span.start_offset, span.end_offset).join('')).toBe(
        span.quote,
      );
    expect(spans.at(-1)!.end_offset).toBe(Array.from(e.text).length);
    await store.extract(branchId, {
      eventIds: [e.id],
      proposals: [],
      cursor: 1,
      extractorVersion: 'v3-facts',
    });
    const context = await buildContext(
      env,
      store,
      branchId,
      { mode: 'roleplay', text: '从信使抵达处继续。' },
      { ...defaults('local-demo'), contextWindow: 10000, maxOutput: 2000 },
      'opening',
    );
    expect(context.tokens).toBeLessThanOrEqual(context.budget);
    expect(JSON.stringify(context.messages)).toContain('信使抵达');
    expect(JSON.stringify(context.messages)).not.toContain('桥边🙂'.repeat(1800));
  });
  it('covers more than 28 facts/32 source spans and preserves historical state changes', async () => {
    const sources: Event[] = [];
    for (let i = 0; i < 80; i++) {
      const e = await event(`【地点${i}】`);
      sources.push(e);
      await fact(e);
    }
    await roll();
    const facts = await root('facts');
    expect((await progress('director:facts')).state.throughSeq).toBe(80);
    expect((await progress('director:facts')).state.observedCount).toBe(80);
    expect(facts!.text).toContain('地点0');
    expect(facts!.text).toContain('地点79');
    expect(facts!.sourceIds).toHaveLength(80);
    expect((await store.memories(branchId, { kinds: ['canon'] }))[0]!.text).toBe('【地点79】');
    const all = await store.all('SELECT id FROM memory_versions WHERE kind=?', 'observation');
    const counts = await store.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memory_evidence GROUP BY memory_id',
    );
    expect(counts.every((r) => r.n <= 128)).toBe(true);
    expect(all.length).toBeGreaterThan(4);
  });
  it('never activates a failed reflection or advances its prefix; retries resume from the saved page', async () => {
    await event('【旧约定】' + '旧街景。'.repeat(160));
    await roll();
    const before = await progress(),
      previous = await root();
    await event('【新增结果】' + '新的记忆。'.repeat(500));
    vi.mocked(complete)
      .mockResolvedValueOnce('{')
      .mockResolvedValueOnce(JSON.stringify({ text: '', retainedIds: [] }))
      .mockResolvedValueOnce(JSON.stringify({ text: '缺少覆盖', retainedIds: [] }));
    await expect(roll()).rejects.toThrow('反思覆盖校验失败');
    expect((await progress()).state.throughSeq).toBe(before.state.throughSeq);
    expect((await root())!.id).toBe(previous!.id);
    expect((await store.getEvents(branchId))[1]!.text).toContain('新增结果');
    await roll();
    expect((await progress()).state.throughSeq).toBe(2);
    expect((await root())!.text).toContain('旧约定');
    expect((await root())!.text).toContain('新增结果');
  });
  it('rejects a source deletion between preparation and activation, including inherited summaries', async () => {
    const first = await event('【密令：星河】');
    await roll();
    const child = await store.fork({ branchId, atSeq: 1 });
    await roll(child.id);
    await event('下一页。');
    let removed = false;
    const deleteBeforeCommit = async (name: string, callback: () => Promise<string>) => {
      if (name.includes('narrative') && name.endsWith(' activate') && !removed) {
        removed = true;
        await store.deleteSource(first.sourceId);
      }
      return callback();
    };
    await expect(
      rollObservations(
        env,
        store,
        branchId,
        2,
        await store.ownerEpoch(),
        settings,
        deleteBeforeCommit,
      ),
    ).rejects.toThrow();
    expect(await root()).toBeUndefined();
    expect(await root('narrative', 'director', child.id)).toBeUndefined();
    await roll();
    await roll(child.id);
    expect(JSON.stringify(await store.memories(branchId))).not.toContain('星河');
    expect(JSON.stringify(await store.memories(child.id))).not.toContain('星河');
  });
  it('rebuilds changed/corrected evidence and keeps a prior fork isolated', async () => {
    const first = await event('【钥匙：红】'),
      old = await fact(first);
    await roll();
    const child = await store.fork({ branchId, atSeq: 1 });
    const correction = await event('【钥匙：蓝】', 'correction');
    await store.correct(branchId, old.id, {
      text: correction.text,
      value: '蓝',
      evidence: [
        {
          sourceId: correction.sourceId,
          start: 0,
          end: Array.from(correction.text).length,
          quote: correction.text,
        },
      ],
    });
    await roll();
    await roll(child.id);
    expect((await root('facts'))?.text ?? '').not.toContain('钥匙：红');
    expect((await root('rules'))!.text).toContain('钥匙：蓝');
    expect((await root('facts', 'director', child.id))!.text).toContain('钥匙：红');
    expect(JSON.stringify(await store.memories(child.id))).not.toContain('钥匙：蓝');
  });
  it('filters every transitive source grant and processes newly acquired old knowledge', async () => {
    await store.run(
      'UPDATE stories SET character_ids_json=? WHERE id=?',
      JSON.stringify(['甲', '乙']),
      (await store.getBranch(branchId)).storyId,
    );
    const secret = await event('【密令：藏书】');
    await store.grantKnowledge({
      branchId,
      sourceId: secret.sourceId,
      characterId: '甲',
      channel: 'author',
    });
    await roll();
    expect((await root('narrative', '甲'))!.text).toContain('藏书');
    expect(await root('narrative', '乙')).toBeUndefined();
    const second = await event('【公开：钟响】');
    await store.grantKnowledge({
      branchId,
      sourceId: second.sourceId,
      characterId: '甲',
      channel: 'author',
    });
    await roll();
    // The current summary has only a bounded direct anchor set. Revoking an
    // older transitive input must still hide the entire dependent summary.
    await store.grantKnowledge({
      branchId,
      sourceId: secret.sourceId,
      characterId: '甲',
      channel: 'author',
      status: 'revoke',
    });
    expect(await root('narrative', '甲')).toBeUndefined();
    await roll();
    expect(JSON.stringify(await store.memories(branchId, { viewer: '甲' }))).not.toContain('藏书');
    await store.grantKnowledge({
      branchId,
      sourceId: secret.sourceId,
      characterId: '乙',
      channel: 'author',
    });
    await roll();
    expect((await root('narrative', '乙'))!.text).toContain('藏书');
    expect((await root('narrative', '乙'))!.text).toContain('获知序号 2');
  });
  it('retains method conditions and failed evidence, including candidate and suspended revisions', async () => {
    const capability = await event('甲掌握铁丝解锁能力。', 'correction');
    const proof = (e: Event) => ({
      sourceId: e.sourceId,
      start: 0,
      end: Array.from(e.text).length,
      quote: e.text,
    });
    await store.setCapability({
      branchId,
      actorId: '甲',
      capability: '解锁',
      status: 'available',
      evidence: [proof(capability)],
    });
    const method = {
      branchId,
      actorId: '甲',
      capability: '解锁',
      conditions: { tool: '【前提：铁丝】' },
      steps: ['【方法：插入铁丝】', '转动锁芯'],
    };
    const first = await store.addExperience({
      ...method,
      outcome: 'success',
      evidence: [proof(await event('首次开锁成功。'))],
    });
    expect(first.procedure.status).toBe('draft');
    await roll();
    expect((await root('interpretations'))!.text).toContain('【前提：铁丝】');
    expect((await root('interpretations'))!.text).toContain('draft');
    expect(await store.memories(branchId, { kinds: ['procedure'] })).toHaveLength(0);
    const second = await store.addExperience({
      ...method,
      outcome: 'success',
      evidence: [proof(await event('第二次独立开锁成功。'))],
    });
    expect(second.procedure.status).toBe('active');
    await roll();
    const failure = await event('【失败：同前提反例】');
    const failed = await store.addExperience({
      ...method,
      outcome: 'failure',
      failureCategory: 'method_counterexample',
      evidence: [proof(failure)],
    });
    expect(failed.procedure.status).toBe('suspended');
    const inputs: string[] = [];
    const ordinary = vi.mocked(complete).getMockImplementation()!;
    vi.mocked(complete).mockImplementation(async (...args) => {
      inputs.push(args[2][1]!.content);
      return ordinary(...args);
    });
    await roll();
    const observed = await root('interpretations');
    const contents = [observed!.text, ...inputs].join('\n');
    expect(contents).toContain('【前提：铁丝】');
    expect(contents).toContain('method_counterexample');
    expect(contents).toContain('suspended');
    expect(observed!.sourceIds).toContain(failure.sourceId);
    const dependencies = await store.all<{ depends_on_id: string }>(
      `WITH RECURSIVE d(id) AS (SELECT ? UNION SELECT md.depends_on_id FROM memory_dependencies md JOIN d ON md.memory_id=d.id) SELECT id AS depends_on_id FROM d`,
      observed!.id,
    );
    expect(dependencies.some((d) => d.depends_on_id === failed.procedure.id)).toBe(true);
    expect(await store.memories(branchId, { kinds: ['procedure'] })).toHaveLength(0);
  });
  it('guards progress against concurrent pages and an older workflow cannot rewind a newer target', async () => {
    await event('【最初】');
    await roll();
    await event('【第二页】');
    let injected = false;
    const competing = async (name: string, callback: () => Promise<string>) => {
      if (name.includes('narrative') && name.endsWith(' activate') && !injected) {
        injected = true;
        await event('【第三页】');
        await roll();
      }
      return callback();
    };
    await rollObservations(env, store, branchId, 2, await store.ownerEpoch(), settings, competing);
    expect((await progress()).state.throughSeq).toBe(3);
    expect((await root())!.text).toContain('第三页');
    await roll(branchId, 1);
    expect((await progress()).state.throughSeq).toBe(3);
  });
  it('reprepares fact writes after two observation projection conflicts with one atomic result', async () => {
    const e = await event('【事实：信物在北门】'),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (
        specs.some((q) => q.sql.includes('INSERT OR IGNORE INTO memory_event_applications')) &&
        ++attempts <= 2
      )
        await store.run(
          'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=?',
          branchId,
        );
      return batch(specs);
    };
    await store.extract(branchId, {
      eventIds: [e.id],
      cursor: 1,
      extractorVersion: 'v3-facts',
      proposals: [
        {
          kind: 'canon',
          subject: '信物',
          predicate: '位置',
          value: '北门',
          text: e.text,
          evidence: [
            { sourceId: e.sourceId, start: 0, end: Array.from(e.text).length, quote: e.text },
          ],
        },
      ],
    });
    expect(attempts).toBe(3);
    expect(await store.memories(branchId, { kinds: ['canon'] })).toHaveLength(1);
    expect(
      await store.one(
        'SELECT COUNT(*) AS n FROM memory_event_applications WHERE branch_id=?',
        branchId,
      ),
    ).toEqual({ n: 1 });
    expect(
      await store.one(
        'SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version=?',
        branchId,
        'v3-facts',
      ),
    ).toEqual({ applied_seq: 1 });
  });
  it('leaves facts and their watermark untouched after persistent projection contention', async () => {
    const e = await event('【待整理事实】'),
      batch = store.batch.bind(store);
    let attempts = 0;
    store.batch = async (specs: QuerySpec[]) => {
      if (specs.some((q) => q.sql.includes('INSERT OR IGNORE INTO memory_event_applications'))) {
        attempts++;
        await store.run(
          'UPDATE branches SET projection_revision=projection_revision+1 WHERE id=?',
          branchId,
        );
      }
      return batch(specs);
    };
    await expect(
      store.extract(branchId, {
        eventIds: [e.id],
        cursor: 1,
        extractorVersion: 'v3-facts',
        proposals: [],
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(attempts).toBe(3);
    expect(
      await store.one(
        'SELECT COUNT(*) AS n FROM memory_event_applications WHERE branch_id=?',
        branchId,
      ),
    ).toEqual({ n: 0 });
    expect(
      await store.one(
        'SELECT applied_seq FROM memory_cursors WHERE branch_id=? AND extractor_version=?',
        branchId,
        'v3-facts',
      ),
    ).toBeNull();
  });
  it('discovers late atomic inputs at an unchanged event watermark', async () => {
    const e = await event('【约定：赴会】');
    await roll();
    await fact(e);
    await roll();
    expect((await root('facts'))!.text).toContain('赴会');
    expect((await progress('director:facts')).state.observedCount).toBe(1);
  });
  it('publishes the complete watermark after a full page of invisible sources and exports resumable progress', async () => {
    for (let i = 0; i < 24; i++) await event(`短事件${i}。`);
    await roll();
    expect((await root())!.data?.throughSeq).toBe(24);
    const archive = await store.exportStory((await store.getBranch(branchId)).storyId);
    expect(archive.observationProgress?.some((r) => r.scope === 'director:narrative')).toBe(true);
    const outputs: string[] = [];
    await event('下一页。');
    await rollObservations(
      env,
      store,
      branchId,
      25,
      await store.ownerEpoch(),
      settings,
      async (name, callback) => {
        const value = await callback();
        if (!name.endsWith(' viewers')) outputs.push(value);
        return value;
      },
    );
    expect(
      outputs.every((v) => v === '' || v.startsWith('jobs/') || v.startsWith('{"accepted":')),
    ).toBe(true);
    expect(outputs.join('')).not.toContain('下一页');
  });
  it('completes a 500-event replay with nested branch prefixes and bounded prompts', async () => {
    await event('【长期约定：返还信物】');
    for (let i = 2; i <= 500; i++)
      await event(
        `第${i}次经过街口。` + '脚步渐远。'.repeat(6) + (i === 500 ? '【末尾：到达北门】' : ''),
      );
    await roll();
    expect((await progress()).state.throughSeq).toBe(500);
    expect((await root())!.text).toContain('返还信物');
    expect((await root())!.text).toContain('到达北门');
    expect(estimateAssetTokens((await root())!.text)).toBeLessThanOrEqual(OBSERVATION_TOKENS);
    const child = await store.fork({ branchId, atSeq: 200 });
    await roll(child.id);
    const nested = await store.fork({ branchId: child.id, atSeq: 100 });
    await roll(nested.id);
    expect((await progress('director:narrative', child.id)).state.throughSeq).toBe(200);
    expect((await root('narrative', 'director', nested.id))!.text).toContain('返还信物');
    expect(JSON.stringify(await store.memories(child.id))).not.toContain('到达北门');
    for (const call of vi.mocked(complete).mock.calls)
      expect(estimateAssetTokens(call[2].map((m) => m.content).join('\n'))).toBeLessThan(10000);
  }, 30000);
});
