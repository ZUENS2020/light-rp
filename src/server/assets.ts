import { Hono } from 'hono';
import type { AppEnv } from './env';
import { ApiError } from './errors';
import { Store, StoreError } from './store';
import { personaCapabilities } from './persona';
import {
  activateWorldbooks,
  exportAsset,
  importAsset,
  normalizeCharacter,
  normalizeWorldbook,
  patchAsset,
  patchAssetData,
  type AssetKind,
  type JsonObject,
  type WorldbookData,
} from '../shared/assets';

interface AssetRow {
  id: string;
  kind: AssetKind;
  name: string;
  revision: number;
  raw_json: string;
  data_json: string;
  png_key: string | null;
  created_at: string;
  updated_at: string;
}
const encoder = new TextEncoder();
const jsonObject = (value: unknown): JsonObject => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, '资料必须是 JSON 对象', 'INVALID_ASSET');
  return value as JsonObject;
};
const payload = (row: AssetRow) => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  revision: row.revision,
  data: JSON.parse(row.data_json),
  raw: JSON.parse(row.raw_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  hasPng: row.png_key !== null,
});
const encodeBody = (raw: JsonObject) => encoder.encode(JSON.stringify(raw));

export function createAssetsRouter() {
  const router = new Hono<AppEnv>();
  router.get('/', async (c) => {
    const ownerId = c.get('ownerId'),
      kind = c.req.query('kind');
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 200));
    const cursor = c.req.query('cursor') ?? '';
    const store = new Store(c.env.DB, ownerId);
    const rows = await store.all<AssetRow>(
      `SELECT * FROM assets WHERE owner_id=? AND (?='' OR kind=?) AND id>? ORDER BY id LIMIT ?`,
      ownerId,
      kind ?? '',
      kind ?? '',
      cursor,
      limit + 1,
    );
    const items = rows.slice(0, limit);
    return c.json({
      items: items.map(payload),
      nextCursor: rows.length > limit ? items.at(-1)!.id : null,
    });
  });
  router.post('/preview-worldbook', async (c) => {
    const body = await c.req.json<{
      data: unknown;
      text?: string;
      seed?: string;
      tokenBudget?: number;
      messages?: string[];
    }>();
    const book = normalizeWorldbook(jsonObject(body.data));
    return c.json(
      activateWorldbooks([book], {
        text: body.text ?? '',
        messages: body.messages,
        seed: body.seed ?? 'preview',
        tokenBudget: body.tokenBudget,
      }),
    );
  });
  router.post('/', async (c) => {
    let bytes: Uint8Array,
      filename = 'asset.json',
      desiredKind: AssetKind | undefined;
    if (c.req.header('content-type')?.includes('multipart/form-data')) {
      const form = await c.req.formData(),
        file = form.get('file');
      if (!(file instanceof File))
        throw new ApiError(422, '请选择 JSON 或 PNG 文件', 'INVALID_ASSET');
      if (file.size > 32_000_000) throw new ApiError(413, '资料超过 32 MB 限制', 'ASSET_TOO_LARGE');
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      if (form.get('kind') === 'character' || form.get('kind') === 'worldbook')
        desiredKind = form.get('kind') as AssetKind;
    } else {
      const body = await c.req.json<{ kind: AssetKind; data: unknown }>();
      if (!['character', 'worldbook'].includes(body.kind))
        throw new ApiError(422, '未知资料类型', 'INVALID_ASSET');
      desiredKind = body.kind;
      const supplied = jsonObject(body.data);
      const raw =
        supplied.spec || supplied.data ? supplied : patchAssetData({}, supplied, desiredKind);
      bytes = encodeBody(raw);
    }
    let imported: ReturnType<typeof importAsset>;
    try {
      imported = importAsset(bytes, filename);
    } catch (error) {
      throw new ApiError(
        422,
        error instanceof Error ? error.message : '资料无法读取',
        'INVALID_ASSET',
      );
    }
    if (desiredKind && desiredKind !== imported.kind)
      throw new ApiError(422, '文件内容与资料类型不匹配', 'INVALID_ASSET');
    if (imported.kind === 'character') personaCapabilities(imported.raw);
    const id = crypto.randomUUID(),
      ownerId = c.get('ownerId'),
      now = new Date().toISOString();
    const pngKey = imported.pngBytes
      ? `assets/${ownerId}/${id}/1-${crypto.randomUUID()}.png`
      : null;
    if (pngKey)
      await c.env.BUCKET.put(pngKey, imported.pngBytes!, {
        httpMetadata: { contentType: 'image/png' },
      });
    try {
      await new Store(c.env.DB, ownerId).batch([
        {
          sql: 'INSERT INTO assets(id,owner_id,kind,name,revision,raw_json,data_json,png_key,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?)',
          params: [
            id,
            ownerId,
            imported.kind,
            imported.name,
            JSON.stringify(imported.raw),
            JSON.stringify(imported.data),
            pngKey,
            now,
            now,
          ],
        },
        {
          sql: 'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,png_key,created_at) VALUES(?,?,1,?,?,?,?)',
          params: [
            crypto.randomUUID(),
            id,
            JSON.stringify(imported.raw),
            JSON.stringify(imported.data),
            pngKey,
            now,
          ],
        },
      ]);
    } catch (error) {
      if (pngKey) await c.env.BUCKET.delete(pngKey);
      throw error;
    }
    return c.json(
      {
        id,
        kind: imported.kind,
        name: imported.name,
        revision: 1,
        data: imported.data,
        raw: imported.raw,
        hasPng: pngKey !== null,
        warnings: imported.warnings,
      },
      201,
    );
  });
  router.get('/:id/export', async (c) => {
    const row = await new Store(c.env.DB, c.get('ownerId')).one<AssetRow>(
      'SELECT * FROM assets WHERE id=? AND owner_id=?',
      c.req.param('id'),
      c.get('ownerId'),
    );
    if (!row) throw new ApiError(404, '资料不存在', 'ASSET_NOT_FOUND');
    const format = c.req.query('format') ?? 'json';
    if (format !== 'json' && format !== 'png')
      throw new ApiError(422, '仅支持 JSON 或 PNG 导出', 'INVALID_EXPORT');
    if (format === 'png' && (row.kind !== 'character' || !row.png_key))
      throw new ApiError(422, '没有原始 PNG，可导出 JSON', 'PNG_UNAVAILABLE');
    const png = format === 'png' ? await c.env.BUCKET.get(row.png_key!) : null;
    if (format === 'png' && !png)
      throw new ApiError(422, '原始 PNG 已缺失，可导出 JSON', 'PNG_UNAVAILABLE');
    const exported = exportAsset(
      JSON.parse(row.raw_json) as JsonObject,
      format,
      png ? new Uint8Array(await png.arrayBuffer()) : undefined,
    );
    return new Response(exported.bytes as BodyInit, {
      headers: {
        'Content-Type': exported.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  });
  router.get('/:id/revisions', async (c) => {
    const store = new Store(c.env.DB, c.get('ownerId'));
    const asset = await store.one(
      'SELECT id FROM assets WHERE id=? AND owner_id=?',
      c.req.param('id'),
      c.get('ownerId'),
    );
    if (!asset) throw new ApiError(404, '资料不存在', 'ASSET_NOT_FOUND');
    const rows = await store.all(
      'SELECT revision,created_at,png_key FROM asset_revisions WHERE asset_id=? ORDER BY revision DESC LIMIT 100',
      c.req.param('id'),
    );
    return c.json({
      items: rows.map((row) => ({
        revision: row.revision,
        createdAt: row.created_at,
        hasPng: row.png_key !== null,
      })),
    });
  });
  router.get('/:id', async (c) => {
    const row = await new Store(c.env.DB, c.get('ownerId')).one<AssetRow>(
      'SELECT * FROM assets WHERE id=? AND owner_id=?',
      c.req.param('id'),
      c.get('ownerId'),
    );
    if (!row) throw new ApiError(404, '资料不存在', 'ASSET_NOT_FOUND');
    return c.json(payload(row));
  });
  router.patch('/:id', async (c) => {
    const id = c.req.param('id'),
      ownerId = c.get('ownerId');
    const store = new Store(c.env.DB, ownerId);
    const row = await store.one<AssetRow>(
      'SELECT * FROM assets WHERE id=? AND owner_id=?',
      id,
      ownerId,
    );
    if (!row) throw new ApiError(404, '资料不存在', 'ASSET_NOT_FOUND');
    const body = await c.req.json<{
      expectedRevision?: number;
      revision?: number;
      patch?: unknown;
      data?: unknown;
    }>();
    const expected = body.expectedRevision ?? body.revision;
    if (!Number.isInteger(expected))
      throw new ApiError(422, '更新必须提供 expectedRevision', 'REVISION_REQUIRED');
    if (expected !== row.revision)
      throw new ApiError(409, '资料已更新，请刷新后再保存', 'REVISION_CONFLICT');
    const previous = JSON.parse(row.raw_json) as JsonObject;
    let raw: JsonObject;
    if (body.data !== undefined) raw = patchAssetData(previous, jsonObject(body.data), row.kind);
    else raw = patchAsset(previous, jsonObject(body.patch));
    if (row.kind === 'character') personaCapabilities(raw);
    const data = row.kind === 'character' ? normalizeCharacter(raw) : normalizeWorldbook(raw);
    const revision = row.revision + 1,
      now = new Date().toISOString();
    let pngKey = row.png_key;
    if (row.png_key) {
      const original = await c.env.BUCKET.get(row.png_key);
      if (original) {
        pngKey = `assets/${ownerId}/${id}/${revision}-${crypto.randomUUID()}.png`;
        const exported = exportAsset(raw, 'png', new Uint8Array(await original.arrayBuffer()));
        await c.env.BUCKET.put(pngKey, exported.bytes, {
          httpMetadata: { contentType: 'image/png' },
        });
      } else pngKey = null;
    }
    const rawJson = JSON.stringify(raw),
      dataJson = JSON.stringify(data);
    try {
      const result = await store.batch([
        {
          sql: 'INSERT INTO asset_revisions(id,asset_id,revision,raw_json,data_json,png_key,created_at) SELECT ?,id,?,?,?,?,? FROM assets WHERE id=? AND owner_id=? AND revision=?',
          params: [
            crypto.randomUUID(),
            revision,
            rawJson,
            dataJson,
            pngKey,
            now,
            id,
            ownerId,
            expected,
          ],
        },
        {
          sql: 'UPDATE assets SET name=?,revision=?,raw_json=?,data_json=?,png_key=?,updated_at=? WHERE id=? AND owner_id=? AND revision=?',
          params: [data.name, revision, rawJson, dataJson, pngKey, now, id, ownerId, expected],
        },
      ]);
      if (result[1]!.meta.changes !== 1)
        throw new ApiError(409, '资料已更新，请刷新后再保存', 'REVISION_CONFLICT');
    } catch (error) {
      if (pngKey && pngKey !== row.png_key) await c.env.BUCKET.delete(pngKey);
      if (error instanceof StoreError && error.code === 'STALE_WRITE')
        throw new ApiError(409, '资料已更新，请刷新后再保存', 'REVISION_CONFLICT');
      throw error;
    }
    return c.json({
      id,
      kind: row.kind,
      name: data.name,
      revision,
      data,
      raw,
      hasPng: pngKey !== null,
    });
  });
  return router;
}

export const assetsRouter = createAssetsRouter();
