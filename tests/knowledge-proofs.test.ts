import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createTestD1 } from './d1';
import { Store } from '../src/server/store';
import { normalizeCharacter } from '../src/shared/assets';
import { defaults } from '../src/server/settings';
import { extractionSchema, validateExtraction, type Extraction } from '../src/server/extraction';
import type { ContextSnapshot } from '../src/server/context';
import type { Env } from '../src/server/env';
import type { WorkflowStep } from 'cloudflare:workers';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('../src/server/persona', () => ({
  syncPersonaCapabilities: vi.fn(async () => ({ sources: [], capabilities: [], skipped: [] })),
}));
import { MemoryWorkflow } from '../src/server/workflows';

let database: ReturnType<typeof createTestD1>,
  store: Store,
  branchId: string,
  sessionId: string,
  env: Env;
let objects: Map<string, string>;
const characters = [
  { id: 'actor-a', revision: 1, data: normalizeCharacter({ name: '甲' }) },
  { id: 'actor-b', revision: 1, data: normalizeCharacter({ name: '乙' }) },
  { id: 'actor-c', revision: 1, data: normalizeCharacter({ name: '丙' }) },
];
beforeEach(async () => {
  database = createTestD1();
  store = new Store(database.db, 'knowledge-proof-owner');
  const world = await store.createWorld('逐片段知情测试'),
    at = new Date().toISOString();
  for (const character of characters) {
    const data = JSON.stringify(character.data);
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
      character.id + '-revision',
      character.id,
      data,
      data,
      at,
    );
  }
  const story = await store.createStory({
    worldId: world.id,
    characterIds: characters.map((character) => character.id),
  });
  branchId = story.branchId;
  sessionId = (await store.createSession({ branchId })).id;
  objects = new Map();
  env = {
    DB: database.db,
    MODEL_MODE: 'local-demo',
    BUCKET: {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
      get: async (key: string) =>
        objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
      delete: async (key: string | string[]) => {
        for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
      },
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      }),
    },
  } as unknown as Env;
});
afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});
const input = { mode: 'roleplay' as const, text: '继续' };
const context = () =>
  ({ characters, entities: [], scene: {}, recall: { items: [] } }) as unknown as ContextSnapshot;
function episode(quote: string, knowledge: unknown[] = []) {
  return {
    kind: 'episode',
    subject: 'narrator',
    predicate: 'reported',
    value: '仓库',
    text: '乙被告知钥匙在仓库',
    evidence: [{ source: 'assistant', quote }],
    knownBy: ['actor-a', 'actor-b', 'actor-c'],
    knowledge,
  };
}
const proof = (quote: string, actorId = 'actor-b', channel = 'told') => ({
  actorId,
  source: 'assistant',
  channel,
  quote,
});
const parsed = (facts: unknown[], extra: Record<string, unknown> = {}) =>
  extractionSchema.parse({ scene: {}, facts, ...extra });
const steps = () =>
  ({
    do: async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
      typeof options === 'function' ? (options as () => Promise<unknown>)() : callback!(),
  }) as unknown as WorkflowStep;
async function run(outboxId: string, target = branchId) {
  return new MemoryWorkflow({} as ExecutionContext, env).run(
    { payload: { ownerId: store.ownerId, branchId: target, outboxId } } as never,
    steps(),
  );
}
async function cachedTurn(text: string, extraction: Extraction) {
  const at = new Date().toISOString(),
    id = crypto.randomUUID(),
    branch = await store.getBranch(branchId);
  await store.run(
    "INSERT INTO tasks(id,owner_id,branch_id,session_id,command_id,expected_head,status,input_json,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'running',?,?,?,?)",
    id,
    store.ownerId,
    branchId,
    sessionId,
    id,
    branch.headSeq,
    JSON.stringify(input),
    JSON.stringify(defaults('local-demo')),
    at,
    at,
  );
  const turn = await store.appendTurn({
    branchId,
    sessionId,
    requestId: id,
    expectedHead: branch.headSeq,
    taskFence: { taskId: id, attempt: 1, cancelEpoch: 0 },
    messages: [
      { role: 'user', text: input.text },
      { role: 'assistant', text },
    ],
  });
  objects.set(
    `tasks/${store.ownerId}/${id}/1/extraction.json`,
    JSON.stringify({ input, extraction }),
  );
  const row = await store.one<{ id: string }>(
    "SELECT id FROM outbox WHERE branch_id=? AND json_extract(payload_json,'$.taskId')=?",
    branchId,
    id,
  );
  return { sourceId: turn.events[1]!.sourceId, outboxId: row!.id, through: turn.branch.headSeq };
}
async function noAccess(sourceId: string, viewer = 'actor-b', target = branchId) {
  await expect(store.readSourceSpan(target, sourceId, { viewer })).rejects.toMatchObject({
    code: 'KNOWLEDGE_SCOPE',
  });
  expect(
    (await store.memories(target, { viewer })).filter((memory) =>
      memory.sourceIds.includes(sourceId),
    ),
  ).toEqual([]);
}
describe('automatic knowledge acquisition is evidence, not a knownBy assertion', () => {
  it('keeps the actual q04 whole-paragraph episode director-only despite all three knownBy hints', async () => {
    const text = '甲明确告诉乙钥匙就在仓库；乙听清并相信。丙在远处没有听到。';
    const turn = await cachedTurn(text, parsed([episode(text)]));
    await run(turn.outboxId);
    for (const character of characters) await noAccess(turn.sourceId, character.id);
    expect((await store.memories(branchId, { kinds: ['episode'] }))[0]?.text).toContain('被告知');
  });
  it('grants only a sufficient told content span and never the neighboring director secret', async () => {
    const content = '甲明确告诉乙钥匙就在仓库',
      acquisition = content + '；乙听清并相信。',
      text = acquisition + '丙没有听到。甲内心知道藏宝图在南门。';
    const turn = await cachedTurn(text, parsed([episode(content, [proof(acquisition)])]));
    await run(turn.outboxId);
    expect((await store.readSourceSpan(branchId, turn.sourceId, { viewer: 'actor-b' })).text).toBe(
      content,
    );
    await expect(
      store.readSourceSpan(branchId, turn.sourceId, {
        viewer: 'actor-b',
        start: 0,
        end: Array.from(text).length,
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE' });
    await noAccess(turn.sourceId, 'actor-c');
    expect(
      (await store.memories(branchId, { viewer: 'actor-b', kinds: ['episode'] }))[0]?.knownBy,
    ).toEqual(['actor-b']);
    const before = await store.one('SELECT count(*) AS n FROM knowledge_grants');
    await store.run("UPDATE outbox SET status='pending' WHERE id=?", turn.outboxId);
    await run(turn.outboxId);
    expect(await store.one('SELECT count(*) AS n FROM knowledge_grants')).toEqual(before);
  });
  it.each([
    ['甲谎称：“乙听到钥匙在仓库。”实际上乙不知道钥匙位置。', '乙听到钥匙在仓库'],
    ['甲想象乙听到钥匙在仓库。乙实际上尚未获知钥匙位置。', '乙听到钥匙在仓库'],
    ['如果乙听到钥匙在仓库，乙就会行动。', '乙听到钥匙在仓库'],
    ['甲计划告诉乙钥匙在仓库。', '告诉乙钥匙在仓库'],
    ['甲没有告诉乙钥匙在仓库。', '告诉乙钥匙在仓库'],
    ['甲声称乙听到钥匙在仓库。', '乙听到钥匙在仓库'],
    ['甲说乙听到钥匙在仓库。', '乙听到钥匙在仓库'],
    ["甲说：'乙听到钥匙在仓库。'", '乙听到钥匙在仓库'],
    ['甲说：‘乙听到钥匙在仓库。’', '乙听到钥匙在仓库'],
    ['乙听到钥匙在仓库是一个尚未确认的猜测。', '乙听到钥匙在仓库'],
  ])(
    'rejects nested/nonactual/clipped acquisition and leaves real D1 source unreadable: %s',
    async (text, quote) => {
      const extraction = parsed([
        episode(quote, [proof(quote, 'actor-b', quote.startsWith('告诉') ? 'told' : 'witnessed')]),
      ]);
      expect(() => validateExtraction(extraction, input, text, context())).toThrow('知情证据');
      const turn = await cachedTurn(text, extraction);
      await expect(run(turn.outboxId)).rejects.toThrow('知情证据');
      await noAccess(turn.sourceId);
      expect(await store.one('SELECT status FROM outbox WHERE id=?', turn.outboxId)).toEqual({
        status: 'failed',
      });
    },
  );
  it('rejects unknown, ungrounded, cross-actor, and unrelated internal proof even for an episode', () => {
    for (const [text, actor, quote] of [
      ['乙在场；甲看见钥匙在仓库。', 'actor-b', '甲看见钥匙在仓库'],
      ['乙听到钥匙在仓库。丙没有听到。', 'actor-c', '乙听到钥匙在仓库'],
      ['乙是否听到钥匙在仓库仍然未知。', 'actor-b', '乙是否听到钥匙在仓库仍然未知'],
      ['乙听到钥匙在仓库；甲内心想起密道。', 'actor-b', '乙听到钥匙在仓库；甲内心想起密道'],
    ])
      expect(() =>
        validateExtraction(
          parsed([episode(quote!, [proof(quote!, actor!, 'witnessed')])]),
          input,
          text!,
          context(),
        ),
      ).toThrow('知情证据');
    const text = '甲告诉乙钥匙在仓库。丙没有听到。';
    expect(() =>
      validateExtraction(
        parsed([episode(text, [proof('甲告诉乙钥匙在仓库')])]),
        input,
        text,
        context(),
      ),
    ).toThrow('内容证据');
  });
  it('uses the same proof policy for experiences and capabilities; acting never grants adjoining private narration', async () => {
    const text = '甲完成开锁练习，门已打开。丙内心知道藏宝图在南门。';
    const extra = {
      experiences: [
        {
          actorId: 'actor-a',
          capability: '开锁',
          conditions: {},
          steps: ['转动钥匙'],
          outcome: 'success',
          evidence: [{ source: 'assistant', quote: text }],
        },
      ],
      capabilities: [
        {
          actorId: 'actor-a',
          name: '开锁',
          level: '初级',
          evidence: [{ source: 'assistant', quote: text }],
        },
      ],
    };
    const turn = await cachedTurn(text, parsed([], extra));
    await run(turn.outboxId);
    await noAccess(turn.sourceId, 'actor-a');
    expect(await store.memories(branchId, { kinds: ['experience'] })).toHaveLength(1);
    const invalid = parsed([], {
      experiences: [{ ...extra.experiences[0], knowledge: [proof(text, 'actor-a', 'witnessed')] }],
      capabilities: [
        { ...extra.capabilities[0], knowledge: [proof(text, 'actor-a', 'witnessed')] },
      ],
    });
    expect(() => validateExtraction(invalid, input, text, context())).toThrow('知情证据');
  });
  it('preserves proof semantics and privacy during nested rebuild and does not mint grants from legacy artifacts', async () => {
    const content = '甲告诉乙钥匙在仓库',
      text = content + '。丙没有听到。';
    const supported = await cachedTurn(text, parsed([episode(content, [proof(content)])]));
    await run(supported.outboxId);
    const legacyText = '所有人不知道的导演秘密在南门。',
      legacy = await cachedTurn(legacyText, parsed([episode(legacyText)]));
    await run(legacy.outboxId);
    const child = await store.fork({ branchId, atSeq: legacy.through });
    const job = await store.one<{ id: string }>(
      "SELECT id FROM outbox WHERE branch_id=? AND json_extract(payload_json,'$.rebuild')=1",
      child.id,
    );
    await run(job!.id, child.id);
    expect(
      (await store.readSourceSpan(child.id, supported.sourceId, { viewer: 'actor-b' })).text,
    ).toBe(content);
    await noAccess(legacy.sourceId, 'actor-b', child.id);
  });
  it('retains explicit author grants independently of automatic evidence hints', async () => {
    const text = '导演秘密：钥匙在南门。',
      turn = await cachedTurn(text, parsed([episode(text)]));
    await store.grantKnowledge({
      branchId,
      characterId: 'actor-b',
      sourceId: turn.sourceId,
      channel: 'author',
    });
    await run(turn.outboxId);
    expect((await store.readSourceSpan(branchId, turn.sourceId, { viewer: 'actor-b' })).text).toBe(
      text,
    );
  });
  it('never revives an inherited author revoke during child rebuild', async () => {
    const content = '甲告诉乙钥匙在仓库',
      turn = await cachedTurn(content + '。', parsed([episode(content, [proof(content)])]));
    await run(turn.outboxId);
    await store.grantKnowledge({
      branchId,
      sourceId: turn.sourceId,
      characterId: 'actor-b',
      quote: content,
      channel: 'author',
      status: 'revoke',
    });
    const child = await store.fork({ branchId, atSeq: turn.through }),
      job = await store.one<{ id: string }>(
        "SELECT id FROM outbox WHERE branch_id=? AND json_extract(payload_json,'$.rebuild')=1",
        child.id,
      );
    await noAccess(turn.sourceId, 'actor-b', child.id);
    await run(job!.id, child.id);
    await noAccess(turn.sourceId, 'actor-b', child.id);
    expect(
      await store.one(
        'SELECT count(*) AS n FROM knowledge_grants WHERE branch_id=? AND character_id=?',
        child.id,
        'actor-b',
      ),
    ).toEqual({ n: 0 });
  });
  it.each([
    '乙不知道北桥的暗号。甲告诉乙钥匙在仓库。',
    '最初乙不知道钥匙位置。后来甲告诉乙钥匙在仓库。',
    '甲明确告诉乙：“我心里决定子夜去东桥见线人。”',
  ])(
    'permits a grounded receipt despite an unrelated unknown, an earlier unknown or a disclosed thought: %s',
    async (text) => {
      const quote = text.startsWith('甲明确') ? text : '甲告诉乙钥匙在仓库';
      const turn = await cachedTurn(text, parsed([episode(quote, [proof(quote)])]));
      await run(turn.outboxId);
      expect(
        (await store.readSourceSpan(branchId, turn.sourceId, { viewer: 'actor-b' })).text,
      ).toBe(quote);
    },
  );
  it('allows only the performing actor to acquire a minimal confirmed own-experience span', async () => {
    const content = '甲将钥匙插入锁孔并转动，门确实打开',
      text = content + '。丙内心知道隐藏的机关。',
      knowledge = [proof(content, 'actor-a', 'witnessed')];
    const extraction = parsed([], {
      experiences: [
        {
          actorId: 'actor-a',
          capability: '开锁',
          conditions: {},
          steps: ['插入钥匙', '转动'],
          outcome: 'success',
          evidence: [{ source: 'assistant', quote: content }],
          knowledge,
        },
      ],
    });
    const turn = await cachedTurn(text, extraction);
    await run(turn.outboxId);
    expect((await store.readSourceSpan(branchId, turn.sourceId, { viewer: 'actor-a' })).text).toBe(
      content,
    );
    expect(
      await store.memories(branchId, { viewer: 'actor-a', kinds: ['experience'] }),
    ).toHaveLength(1);
    await noAccess(turn.sourceId, 'actor-b');
  });
  it('widens channels while preserving sparse rowids, source foreign keys, and pre-migration fork ACL fences', async () => {
    const db = createTestD1({ schema: false });
    try {
      for (const file of ['0001_initial.sql', '0002_runtime.sql', '0003_entities.sql'])
        db.sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
      const s = new Store(db.db, 'migration-owner'),
        world = await s.createWorld('迁移'),
        story = await s.createStory({ worldId: world.id }),
        session = await s.createSession({ branchId: story.branchId });
      const turn = await s.appendTurn({
        branchId: story.branchId,
        sessionId: session.id,
        requestId: 'old',
        messages: [{ role: 'assistant', text: '钥匙在仓库。' }],
      });
      const sourceId = turn.events[0]!.sourceId;
      await s.grantKnowledge({
        branchId: story.branchId,
        sourceId,
        characterId: 'actor-a',
        channel: 'author',
      });
      const fork = await s.fork({ branchId: story.branchId, atSeq: 1 });
      await s.grantKnowledge({
        branchId: story.branchId,
        sourceId,
        characterId: 'actor-b',
        channel: 'author',
      });
      await s.run('UPDATE knowledge_grants SET rowid=9 WHERE character_id=?', 'actor-b');
      const before = await s.all('SELECT rowid,* FROM knowledge_grants ORDER BY rowid');
      db.sqlite.exec(
        readFileSync(new URL('../migrations/0004_knowledge_channels.sql', import.meta.url), 'utf8'),
      );
      expect(await s.all('SELECT rowid,* FROM knowledge_grants ORDER BY rowid')).toEqual(before);
      expect((await s.readSourceSpan(fork.id, sourceId, { viewer: 'actor-a' })).text).toContain(
        '仓库',
      );
      await expect(
        s.readSourceSpan(fork.id, sourceId, { viewer: 'actor-b' }),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE' });
      await s.grantKnowledge({
        branchId: story.branchId,
        sourceId,
        characterId: 'actor-c',
        channel: 'rumor',
      });
      await s.grantKnowledge({
        branchId: story.branchId,
        sourceId,
        characterId: 'actor-c',
        channel: 'inferred',
      });
      expect(db.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(
        await s.one("SELECT name FROM sqlite_master WHERE type='index' AND name='grants_scope'"),
      ).toEqual({ name: 'grants_scope' });
    } finally {
      db.close();
    }
  });
});
