import { afterEach, describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assetsRouter } from '../src/server/assets';
import { ApiError } from '../src/server/errors';
import { StoreError } from '../src/server/store';
import type { AppEnv } from '../src/server/env';
import {
  planLegacy,
  restoreMigrationBundle,
  writeMigrationBundle,
} from '../scripts/migrate-legacy';
import {
  activateWorldbooks,
  compressedCardChunk,
  exportAsset,
  importAsset,
  normalizeCharacter,
  normalizeWorldbook,
  patchAsset,
  patchAssetData,
  readPngChunks,
  writePngChunks,
  type JsonObject,
} from '../src/shared/assets';

const text = new TextEncoder();
const v3: JsonObject = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  vendor: { keep: true },
  data: {
    name: '晴岚',
    description: '船长',
    personality: '谨慎',
    first_mes: '起航',
    mes_example: '航海示例',
    alternate_greetings: ['你好'],
    extensions: { untouched: { nested: 42 } },
    group_only_greetings: ['集合'],
    character_book: {
      name: '港口',
      extensions: { custom: 'retain' },
      entries: [
        {
          id: 'port',
          keys: ['港口'],
          content: '有灯塔',
          enabled: true,
          insertion_order: 1,
          use_regex: false,
          extensions: { custom: 'entry' },
        },
      ],
    },
  },
};
function image(metadata: ReturnType<typeof compressedCardChunk>[] = []) {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return writePngChunks([
    { type: 'IHDR', data: ihdr },
    { type: 'tEXt', data: text.encode('author\0原图作者') },
    { type: 'eXIf', data: new Uint8Array([1, 2, 3, 4]) },
    { type: 'IDAT', data: zlibSync(new Uint8Array(5)) },
    ...metadata,
    { type: 'IEND', data: new Uint8Array() },
  ]);
}
const book = (entry: JsonObject, extra: JsonObject = {}) =>
  normalizeWorldbook({
    name: 'book',
    entries: { a: { uid: 1, key: ['dragon'], content: 'secret', position: 0, ...entry } },
    ...extra,
  });
const activate = (entry: JsonObject, query = 'dragon') =>
  activateWorldbooks([book(entry)], { text: query, seed: 'turn-1', tokenBudget: 1000 });

describe('character asset round trips', () => {
  it('projects V2/V3 fields without discarding unknown JSON', () => {
    const imported = importAsset(text.encode(JSON.stringify(v3)), 'card.json');
    expect(imported.kind).toBe('character');
    expect(normalizeCharacter(imported.raw)).toMatchObject({
      name: '晴岚',
      firstMessage: '起航',
      exampleMessages: '航海示例',
      groupOnlyGreetings: ['集合'],
    });
    expect(JSON.parse(new TextDecoder().decode(exportAsset(imported.raw).bytes))).toEqual(v3);
  });
  it('accepts UI greeting aliases', () => {
    expect(
      normalizeCharacter({ name: '甲', firstMessage: 'first', mesExample: 'example' }),
    ).toMatchObject({ firstMessage: 'first', exampleMessages: 'example' });
  });
  it('clears fields deliberately and preserves unknown nested data', () => {
    const changed = patchAssetData(
      v3,
      { firstMessage: '', alternateGreetings: [], worldbook: null },
      'character',
    );
    expect(normalizeCharacter(changed)).toMatchObject({
      firstMessage: '',
      alternateGreetings: [],
      worldbook: null,
    });
    expect(changed.vendor).toEqual({ keep: true });
    expect((changed.data as JsonObject).extensions).toEqual({ untouched: { nested: 42 } });
    expect(v3.data && (v3.data as JsonObject).first_mes).toBe('起航');
  });
  it('keeps unknown fields on a worldbook entry when the UI replaces entries', () => {
    const raw: JsonObject = {
      name: 'book',
      entries: [
        {
          id: 'a',
          keys: ['old'],
          content: 'old',
          enabled: true,
          insertion_order: 1,
          extensions: { plugin: { color: 'red' } },
          future: 3,
        },
      ],
    };
    const changed = patchAssetData(
      raw,
      { entries: [{ id: 'a', key: [], content: '', enabled: false, order: 2 }] },
      'worldbook',
    );
    expect((changed.entries as JsonObject[])[0]).toMatchObject({
      future: 3,
      extensions: { plugin: { color: 'red' } },
      content: '',
    });
    expect(normalizeWorldbook(changed).entries[0]).toMatchObject({
      keys: [],
      content: '',
      enabled: false,
      order: 2,
    });
  });
  it('does not allow patch prototype mutation', () => {
    expect(() => patchAsset({}, JSON.parse('{"__proto__":{"x":1}}'))).toThrow('Invalid patch key');
  });
  it('rejects malformed card JSON', () => {
    expect(() => importAsset(text.encode('[]'))).toThrow('object');
    expect(() => importAsset(text.encode('{"description":"missing"}'))).toThrow('name');
  });
});

describe('PNG metadata', () => {
  it('prefers ccv3 over chara including compressed metadata', () => {
    const png = image([
      compressedCardChunk('chara', { name: 'old' }),
      compressedCardChunk('ccv3', v3),
    ]);
    const imported = importAsset(png, 'portrait.png');
    expect(imported.name).toBe('晴岚');
    expect(imported.pngBytes).toEqual(png);
  });
  it('exports updated metadata while retaining every unrelated chunk and image bytes', () => {
    const png = image([compressedCardChunk('ccv3', v3)]);
    const changed = patchAssetData(v3, { firstMessage: '', name: '新名字' }, 'character');
    const output = exportAsset(changed, 'png', png);
    const unrelated = (bytes: Uint8Array) =>
      readPngChunks(bytes).filter(
        (chunk) =>
          !['tEXt', 'zTXt', 'iTXt'].includes(chunk.type) ||
          new TextDecoder().decode(chunk.data).startsWith('author'),
      );
    expect(unrelated(output.bytes)).toEqual(unrelated(png));
    expect(importAsset(output.bytes, output.filename).raw).toEqual(changed);
    expect(readPngChunks(output.bytes).filter((chunk) => chunk.type === 'tEXt')).toHaveLength(3);
  });
  it('reads iTXt metadata', () => {
    const json = Buffer.from(JSON.stringify(v3)).toString('base64');
    const png = image([{ type: 'iTXt', data: text.encode(`ccv3\0\0\0\0\0${json}`) }]);
    expect(importAsset(png, 'portrait.png').raw).toEqual(v3);
  });
  it('rejects corrupted CRC and missing card metadata', () => {
    const png = image([compressedCardChunk('ccv3', v3)]);
    png[20] = png[20]! ^ 1;
    expect(() => importAsset(png, 'bad.png')).toThrow('checksum');
    expect(() => importAsset(image(), 'image.png')).toThrow('metadata');
    expect(() => exportAsset(v3, 'png')).toThrow('PNG');
  });
});

describe('worldbook behavior', () => {
  it.each([
    [0, 'dragon red', true],
    [0, 'dragon', false],
    [1, 'dragon red', true],
    [1, 'dragon red blue', false],
    [2, 'dragon', true],
    [2, 'dragon red', false],
    [3, 'dragon red blue', true],
    [3, 'dragon red', false],
  ])('implements secondary logic %s for %s', (logic, query, expected) => {
    const result = activate(
      { selective: true, selectiveLogic: logic, keysecondary: ['red', 'blue'] },
      query,
    );
    expect(result.activated.length > 0).toBe(expected);
  });
  it('requires a primary match even when negative secondary logic passes', () => {
    expect(
      activate({ selective: true, selectiveLogic: 2, keysecondary: ['red'] }, 'unrelated')
        .activated,
    ).toEqual([]);
  });
  it('applies disable, probability and budget even to constants', () => {
    expect(activate({ constant: true, disable: true }).skipped[0]?.reason).toBe('disabled');
    expect(activate({ constant: true, probability: 0 }).skipped[0]?.reason).toBe('probability');
    expect(
      activate({ constant: true, probability: 0, useProbability: false }).activated,
    ).toHaveLength(1);
    expect(
      activateWorldbooks([book({ constant: true })], { seed: 'x', tokenBudget: 0 }).skipped[0]
        ?.reason,
    ).toBe('token-budget');
  });
  it('keeps probability results stable through generation retries', () => {
    const books = [book({ probability: 50 })];
    const first = activateWorldbooks(books, { text: 'dragon', seed: 'same-turn' });
    expect(activateWorldbooks(books, { text: 'dragon', seed: 'same-turn' })).toEqual(first);
    const results = Array.from(
      { length: 100 },
      (_, i) => activateWorldbooks(books, { text: 'dragon', seed: `turn-${i}` }).activated.length,
    );
    expect(results).toContain(0);
    expect(results).toContain(1);
  });
  it('includes the incoming user text when message history is also present', () => {
    expect(
      activateWorldbooks([book({})], { text: 'dragon', messages: ['old'], seed: 'x' }).activated,
    ).toHaveLength(1);
  });
  it('handles ST regex and rejects invalid V3 regex without falling back to plaintext', () => {
    expect(activate({ key: ['/DRAGON/i'] }).activated).toHaveLength(1);
    const raw: JsonObject = {
      spec: 'lorebook_v3',
      data: {
        entries: [
          { keys: ['['], content: 'x', enabled: true, use_regex: true, insertion_order: 1 },
        ],
      },
    };
    expect(
      activateWorldbooks([normalizeWorldbook(raw)], { text: '[', seed: 'x' }).activated,
    ).toEqual([]);
  });
  it('uses recursive activation once per entry and obeys its budget', () => {
    const data = normalizeWorldbook({
      name: 'chain',
      recursive_scanning: true,
      token_budget: 20,
      entries: [
        { id: 1, keys: ['start'], content: 'next', enabled: true, insertion_order: 1 },
        { id: 2, keys: ['next'], content: 'end', enabled: true, insertion_order: 2 },
        { id: 3, keys: ['end'], content: 'start', enabled: true, insertion_order: 3 },
      ],
    });
    const result = activateWorldbooks([data], { text: 'start', seed: 'x', maxRecursion: 8 });
    expect(result.activated).toHaveLength(3);
    expect(new Set(result.activated.map((entry) => entry.entryId)).size).toBe(3);
    expect(result.activated.find((entry) => entry.entryId === '2')?.round).toBe(1);
    expect(
      activateWorldbooks([data], { text: 'start', seed: 'x', tokenBudget: 1 }).skipped.some(
        (entry) => entry.reason === 'token-budget',
      ),
    ).toBe(true);
  });
  it('maps all positions, honors extension precedence and reports unavailable outlets', () => {
    const positions = [
      'before',
      'after',
      'author-note-top',
      'author-note-bottom',
      'at-depth',
      'examples-top',
      'examples-bottom',
      'outlet',
    ];
    for (let position = 0; position < positions.length; position++) {
      expect(book({ position }).entries[0]?.position).toBe(positions[position]);
    }
    const data = normalizeWorldbook({
      entries: [
        {
          keys: ['dragon'],
          content: 'x',
          enabled: true,
          position: 'before_char',
          extensions: { position: 4, depth: 2, role: 1 },
        },
      ],
    });
    expect(data.entries[0]).toMatchObject({ position: 'at-depth', depth: 2, role: 'user' });
    expect(activate({ position: 7 }).skipped[0]?.reason).toBe('missing-outlet');
    expect(
      activateWorldbooks([book({ position: 2 })], {
        text: 'dragon',
        seed: 'x',
        availablePositions: ['before'],
      }).skipped[0]?.reason,
    ).toBe('unsupported-position');
  });
  it('does not interpret null ST timed-effect defaults as active unsupported features', () => {
    const data = book({
      extensions: { sticky: null, cooldown: null, group: '', vectorized: false },
    });
    expect(activateWorldbooks([data], { text: 'dragon', seed: 'x' }).activated).toHaveLength(1);
  });
});

function serverFixture() {
  const sqlite = new Database(':memory:');
  sqlite.exec(
    'PRAGMA foreign_keys=ON; CREATE TABLE assets(id TEXT PRIMARY KEY,owner_id TEXT,kind TEXT,name TEXT,revision INTEGER,raw_json TEXT,data_json TEXT,png_key TEXT,created_at TEXT,updated_at TEXT);CREATE TABLE asset_revisions(id TEXT PRIMARY KEY,asset_id TEXT REFERENCES assets(id),revision INTEGER,raw_json TEXT,data_json TEXT,png_key TEXT,created_at TEXT,UNIQUE(asset_id,revision));',
  );
  class Prepared {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) {
      this.values = values;
      return this;
    }
    async first() {
      return sqlite.prepare(this.sql).get(...this.values) ?? null;
    }
    async all() {
      return { success: true, results: sqlite.prepare(this.sql).all(...this.values), meta: {} };
    }
    execute() {
      const result = sqlite.prepare(this.sql).run(...this.values);
      return { success: true, results: [], meta: { changes: result.changes } };
    }
    async run() {
      return this.execute();
    }
  }
  const db = {
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) =>
      sqlite.transaction(() => statements.map((statement) => statement.execute()))(),
  } as unknown as D1Database;
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes.slice());
    },
    get: async (key: string) =>
      objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.slice().buffer } : null,
    delete: async (key: string) => {
      objects.delete(key);
    },
  } as unknown as R2Bucket;
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('ownerId', c.req.header('X-Test-Owner') ?? 'alice');
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { error: error.message },
      (error instanceof ApiError || error instanceof StoreError ? error.status : 500) as 400,
    ),
  );
  app.route('/api/v3/assets', assetsRouter);
  const env = { DB: db, BUCKET: bucket } as AppEnv['Bindings'];
  const request = (path: string, init?: RequestInit) =>
    app.request(`http://localhost/api/v3/assets${path}`, init, env);
  return { sqlite, request, objects };
}

describe('asset API persistence and ownership', () => {
  it('validates explicit capabilities before writing assets or a new revision', async () => {
    const fixture = serverFixture();
    try {
      const headers = { 'Content-Type': 'application/json' },
        invalid = {
          name: '明确能力',
          extensions: { lightrp: { capabilities: [{ name: '解锁', level: 7 }] } },
        };
      expect(
        (
          await fixture.request('', {
            method: 'POST',
            headers,
            body: JSON.stringify({ kind: 'character', data: invalid }),
          })
        ).status,
      ).toBe(422);
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 0 });
      const response = await fixture.request('', {
          method: 'POST',
          headers,
          body: JSON.stringify({ kind: 'character', data: { name: '明确能力' } }),
        }),
        created = (await response.json()) as { id: string };
      expect(
        (
          await fixture.request(`/${created.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ expectedRevision: 1, data: invalid }),
          })
        ).status,
      ).toBe(422);
      expect(fixture.sqlite.prepare('SELECT revision FROM assets').get()).toEqual({ revision: 1 });
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM asset_revisions').get()).toEqual({
        n: 1,
      });
    } finally {
      fixture.sqlite.close();
    }
  });
  it('preserves raw V3 JSON, fences revisions and does not expose another owner assets', async () => {
    const fixture = serverFixture();
    try {
      const created = await fixture.request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'character', data: v3 }),
      });
      expect(created.status).toBe(201);
      const asset = (await created.json()) as { id: string; raw: JsonObject };
      expect(asset.raw).toEqual(v3);
      expect(
        (await fixture.request(`/${asset.id}`, { headers: { 'X-Test-Owner': 'bob' } })).status,
      ).toBe(404);
      const list = await fixture.request('', { headers: { 'X-Test-Owner': 'bob' } });
      expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
      const changed = await fixture.request(`/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 1,
          data: { firstMessage: '', alternateGreetings: [], worldbook: null },
        }),
      });
      expect(changed.status).toBe(200);
      const result = (await changed.json()) as { revision: number; data: unknown; raw: JsonObject };
      expect(result.revision).toBe(2);
      expect(result.data).toMatchObject({
        firstMessage: '',
        alternateGreetings: [],
        worldbook: null,
      });
      expect(result.raw.vendor).toEqual({ keep: true });
      expect(
        (
          await fixture.request(`/${asset.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expectedRevision: 1, data: { name: 'stale' } }),
          })
        ).status,
      ).toBe(409);
      expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM asset_revisions').get()).toEqual({
        n: 2,
      });
      expect((await fixture.request(`/${asset.id}/export?format=png`)).status).toBe(422);
    } finally {
      fixture.sqlite.close();
    }
  });
  it('writes immutable PNG revision keys and exports the edited card with intact image chunks', async () => {
    const fixture = serverFixture();
    try {
      const png = image([compressedCardChunk('ccv3', v3)]),
        form = new FormData();
      form.set('file', new File([png as BlobPart], 'portrait.png', { type: 'image/png' }));
      const response = await fixture.request('', { method: 'POST', body: form });
      expect(response.status).toBe(201);
      const { id } = (await response.json()) as { id: string };
      const firstKey = Array.from(fixture.objects.keys())[0]!;
      const changed = await fixture.request(`/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 1, data: { name: '第二版' } }),
      });
      expect(changed.status).toBe(200);
      expect(fixture.objects.size).toBe(2);
      expect(fixture.objects.get(firstKey)).toEqual(png);
      const exported = await fixture.request(`/${id}/export?format=png`);
      expect(importAsset(new Uint8Array(await exported.arrayBuffer()), 'card.png').name).toBe(
        '第二版',
      );
    } finally {
      fixture.sqlite.close();
    }
  });
  it('supports UI native worldbook fields and preview skip reasons', async () => {
    const fixture = serverFixture();
    try {
      const body = {
        name: 'book',
        entries: [
          {
            uid: 10,
            key: ['dragon'],
            content: 'lore',
            enabled: true,
            constant: false,
            order: 100,
            position: 0,
          },
        ],
      };
      const response = await fixture.request('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'worldbook', data: body }),
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as { data: unknown }).data).toMatchObject({
        entries: [{ enabled: true, keys: ['dragon'] }],
      });
      const preview = await fixture.request('/preview-worldbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: body, text: 'unrelated', seed: 'x' }),
      });
      expect(((await preview.json()) as { skipped: unknown[] }).skipped).toEqual([
        { bookId: 'book-0', entryId: '10', reason: 'no-primary-match' },
      ]);
    } finally {
      fixture.sqlite.close();
    }
  });
});

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function migrationFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'lightrp-assets-'));
  temporary.push(root);
  const input = resolve(root, 'legacy'),
    output = resolve(root, 'bundle');
  await mkdir(resolve(input, 'characters'), { recursive: true });
  await mkdir(resolve(input, 'lorebooks'));
  await mkdir(resolve(input, 'sessions', 'old'), { recursive: true });
  await writeFile(resolve(input, 'characters', 'captain.json'), JSON.stringify(v3));
  await writeFile(
    resolve(input, 'characters', 'captain.png'),
    image([compressedCardChunk('ccv3', v3)]),
  );
  await writeFile(
    resolve(input, 'characters', 'without-image.yaml'),
    'name: 无图角色\ndescription: 离线旧卡\ncustom: preserved\n',
  );
  await writeFile(
    resolve(input, 'lorebooks', 'harbor.yaml'),
    'name: harbor\nentries:\n  - keys: [port]\n    content: lighthouse\n    enabled: true\n    insertion_order: 1\n    extensions: {}\n',
  );
  await writeFile(
    resolve(input, 'sessions', 'old', 'messages.jsonl'),
    '{"role":"user","content":"archived"}\n',
  );
  await writeFile(resolve(input, 'world.yaml'), 'name: 旧世界包\ncast: [captain]\n');
  await writeFile(
    resolve(input, 'characters', 'captain.mini.yaml'),
    'name: 派生卡\nsummary: excluded\n',
  );
  return { root, input, output };
}

describe('offline migration and restore', () => {
  it('plans without creating output, separates conversations, retains YAML and reports missing PNG', async () => {
    const fixture = await migrationFixture(),
      plan = await planLegacy(fixture.input);
    expect(plan.assets).toHaveLength(3);
    expect(plan.conversations).toEqual(['sessions/old/messages.jsonl']);
    expect(plan.missingPng).toEqual([
      { source: 'characters/without-image.yaml', name: '无图角色' },
    ]);
    expect(plan.assets.find((asset) => asset.name === '无图角色')?.raw.custom).toBe('preserved');
    expect(plan.skipped.some((item) => item.source === 'world.yaml')).toBe(true);
    await expect(access(fixture.output)).rejects.toThrow();
  });
  it('writes a new checksummed bundle and restores only assets through the real local API', async () => {
    const fixture = await migrationFixture(),
      plan = await planLegacy(fixture.input);
    await writeMigrationBundle(plan, fixture.output);
    const dry = await restoreMigrationBundle(fixture.output);
    expect(dry.dryRun).toBe(true);
    expect(dry.assets.every((asset) => asset.status === 'would-import')).toBe(true);
    expect(dry.conversations.imported).toBe(0);
    const server = serverFixture();
    try {
      const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        return server.request(url.pathname.replace('/api/v3/assets', '') + url.search, init);
      }) as typeof fetch;
      const preview = await restoreMigrationBundle(fixture.output, {
        target: 'http://localhost',
        fetch: fetcher,
      });
      expect(preview.assets).toHaveLength(3);
      expect(server.sqlite.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 0 });
      const restored = await restoreMigrationBundle(fixture.output, {
        target: 'http://localhost',
        write: true,
        fetch: fetcher,
      });
      expect(restored.assets.every((asset) => asset.status === 'imported')).toBe(true);
      expect(server.objects.size).toBe(1);
      const retried = await restoreMigrationBundle(fixture.output, {
        target: 'http://localhost',
        write: true,
        fetch: fetcher,
      });
      expect(retried.assets.every((asset) => asset.status === 'already-restored')).toBe(true);
      expect(server.sqlite.prepare('SELECT count(*) AS n FROM assets').get()).toEqual({ n: 3 });
      expect(
        await readFile(
          resolve(fixture.output, 'archive/conversations/sessions/old/messages.jsonl'),
          'utf8',
        ),
      ).toContain('archived');
    } finally {
      server.sqlite.close();
    }
  });
  it('rejects corrupted bundles, remote targets and overwriting existing output', async () => {
    const fixture = await migrationFixture(),
      plan = await planLegacy(fixture.input),
      manifest = await writeMigrationBundle(plan, fixture.output);
    await expect(writeMigrationBundle(plan, fixture.output)).rejects.toThrow();
    await expect(
      restoreMigrationBundle(fixture.output, { target: 'https://example.com', write: true }),
    ).rejects.toThrow('回环');
    await writeFile(resolve(fixture.output, manifest.assets[0]!.rawFile), '{}');
    await expect(restoreMigrationBundle(fixture.output)).rejects.toThrow('JSON 校验');
  });
});

describe('bounded worldbook regex activation', () => {
  it('skips sequential variable repeats and complex repeats with an explicit compatibility reason', () => {
    for (const key of [
      '/a+a+a+a+a+a+a+a+$/',
      '/(a?){80}$/',
      '/a{1,5}a{1,5}$/',
      '/(a|aa)+$/',
      '/(?=a+)a+$/',
      '/a{500000}$/',
    ]) {
      const data = book({ key: [key] });
      expect(data.entries[0]?.unsupported).toContain('unsafe-or-invalid-regex');
      const result = activateWorldbooks([data], {
        text: 'a'.repeat(200) + '!',
        seed: 'regex-safety',
      });
      expect(result.activated).toHaveLength(0);
      expect(result.skipped[0]?.reason).toBe('unsupported-regex');
    }
  });
  it('retains unsafe V3 raw regex and warns on import without executing it or treating it as plaintext', () => {
    const raw: JsonObject = {
      spec: 'lorebook_v3',
      data: {
        name: 'regex',
        entries: [{ keys: ['a+a+a+a+a+a+a+a+$'], use_regex: true, content: 'rule', enabled: true }],
      },
    };
    const imported = importAsset(text.encode(JSON.stringify(raw)), 'book.json');
    expect(imported.warnings.some((w) => w.includes('未参与自动触发'))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(exportAsset(imported.raw).bytes))).toEqual(raw);
    const result = activateWorldbooks([imported.data as ReturnType<typeof normalizeWorldbook>], {
      text: 'a'.repeat(200) + '!',
      seed: 'v3-safe',
    });
    expect(result.skipped[0]?.reason).toBe('unsupported-regex');
    expect(result.activated).toHaveLength(0);
  });
  it('still supports simple repeats, fixed-width dates, literal quantifiers and Unicode properties', () => {
    expect(activate({ key: ['/港口.*灯塔/'] }, '港口有灯塔').activated).toHaveLength(1);
    expect(activate({ key: ['/^\\d{4}-\\d{2}-\\d{2}$/'] }, '2026-10-07').activated).toHaveLength(1);
    expect(activate({ key: ['/a\\+a\\+/'] }, 'a+a+').activated).toHaveLength(1);
    expect(activate({ key: ['/^\\p{Script=Han}+$/u'] }, '港口').activated).toHaveLength(1);
  });
  it('finishes the former 201-character timeout case in a killable subprocess', () => {
    const script = `import { normalizeWorldbook, activateWorldbooks } from './src/shared/assets.ts';
      const book = normalizeWorldbook({ name:'safe', entries:{a:{uid:1,key:['/a+a+a+a+a+a+a+a+$/'],content:'rule'}} });
      const result=activateWorldbooks([book],{text:'a'.repeat(200)+'!',seed:'bounded'});
      console.log(JSON.stringify({activated:result.activated.length,reason:result.skipped[0]?.reason}));`;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 3000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ activated: 0, reason: 'unsupported-regex' });
  });
});
