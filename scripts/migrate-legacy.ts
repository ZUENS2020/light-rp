import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import {
  exportAsset,
  importAsset,
  patchAsset,
  readPngChunks,
  type AssetKind,
  type JsonObject,
} from '../src/shared/assets';

interface MigrationAsset {
  id: string;
  kind: AssetKind;
  name: string;
  source: string;
  raw: JsonObject;
  fingerprint: string;
  pngSource: string | null;
  warnings: string[];
}
export interface MigrationPlan {
  format: 'lightrp-legacy-plan';
  version: 1;
  input: string;
  assets: MigrationAsset[];
  conversations: string[];
  skipped: Array<{ source: string; reason: string }>;
  errors: Array<{ source: string; reason: string }>;
  missingPng: Array<{ source: string; name: string }>;
}
interface BundleAsset {
  id: string;
  kind: AssetKind;
  name: string;
  source: string;
  fingerprint: string;
  rawFile: string;
  rawHash: string;
  pngFile: string | null;
  pngHash: string | null;
  warnings: string[];
}
interface BundleManifest {
  format: 'lightrp-assets-migration';
  version: 1;
  assets: BundleAsset[];
  conversations: Array<{ source: string; file: string; hash: string }>;
  missingPng: MigrationPlan['missingPng'];
  skipped: MigrationPlan['skipped'];
  errors: MigrationPlan['errors'];
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const normalized = (path: string) => path.split(sep).join('/');
const stem = (path: string) => path.replace(/\.(json|ya?ml|png)$/i, '').toLowerCase();
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

async function inventory(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files.push(normalized(relative(root, path)));
        if (files.length > 20000) throw new Error('备份超过 20,000 个文件，请拆分处理');
      }
    }
  }
  await walk(root);
  return files.sort();
}

/** The operator supplies an offline export directory; this function never accesses cloud storage. */
export async function planLegacy(input: string): Promise<MigrationPlan> {
  const root = await realpath(resolve(input));
  if (!(await stat(root)).isDirectory()) throw new Error('--input 必须是离线备份目录');
  const files = await inventory(root);
  const plan: MigrationPlan = {
    format: 'lightrp-legacy-plan',
    version: 1,
    input: root,
    assets: [],
    conversations: [],
    skipped: [],
    errors: [],
    missingPng: [],
  };
  const pngs = new Map<string, string>();
  for (const source of files.filter((file) => /\.png$/i.test(file))) pngs.set(stem(source), source);
  for (const source of files) {
    if (
      /(^|\/)(sessions?|chats?|conversations?)(\/|$)/i.test(source) ||
      /\.(jsonl)$/i.test(source)
    ) {
      plan.conversations.push(source);
      continue;
    }
    if (
      /\.mini\.ya?ml$/i.test(source) ||
      /(^|\/)(memory|memories|runs|cache)(\/|$)/i.test(source)
    ) {
      plan.skipped.push({ source, reason: '旧自动记忆/派生卡不迁入新运行数据' });
      continue;
    }
    if (!/\.(json|ya?ml|png)$/i.test(source)) {
      plan.skipped.push({ source, reason: '非角色卡/世界书资料' });
      continue;
    }
    try {
      const file = await readFile(resolve(root, source));
      if (file.length > 32_000_000) throw new Error('资料超过 32 MB');
      let bytes: Uint8Array = file;
      if (/\.ya?ml$/i.test(source)) {
        const document = parseDocument(file.toString('utf8'), { uniqueKeys: true });
        if (document.errors.length) throw new Error('YAML 结构错误');
        const value = document.toJS({ maxAliasCount: 100 });
        const converted = Array.isArray(value)
          ? { name: basename(source, extname(source)), entries: value }
          : value;
        bytes = new TextEncoder().encode(JSON.stringify(converted));
      }
      if (/\.json$/i.test(source)) {
        const value: unknown = JSON.parse(file.toString('utf8').replace(/^\uFEFF/, ''));
        const body = object(object(value).data ?? value);
        if (
          Array.isArray(body.messages) ||
          Array.isArray(body.events) ||
          Array.isArray(body.turns)
        ) {
          plan.conversations.push(source);
          continue;
        }
        if (Array.isArray(value)) {
          const entries = value.map(object);
          if (
            !entries.every(
              (entry) =>
                typeof entry.content === 'string' && (entry.keys || entry.key || entry.keywords),
            )
          ) {
            plan.skipped.push({ source, reason: '未知 JSON 数组格式' });
            continue;
          }
          bytes = new TextEncoder().encode(
            JSON.stringify({ name: basename(source, extname(source)), entries: value }),
          );
        }
      }
      if (!/\.png$/i.test(source)) {
        let value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        let raw = object(value),
          body = object(raw.data ?? raw);
        if (!body.entries && /(^|\/)(lorebooks?|worldbooks?)(\/|$)/i.test(source)) {
          const entries = Object.values(body);
          if (
            entries.length &&
            entries.every((entry) => typeof object(entry).content === 'string')
          ) {
            value = { name: basename(source, extname(source)), entries: body };
            raw = object(value);
            body = raw;
            bytes = new TextEncoder().encode(JSON.stringify(value));
          }
        }
        const recognized =
          body.entries !== undefined ||
          String(raw.spec ?? '').startsWith('chara_card_') ||
          (typeof body.name === 'string' &&
            ([
              'description',
              'personality',
              'scenario',
              'first_mes',
              'firstMessage',
              'mes_example',
              'behavior',
              'speech',
              'backstory',
            ].some((key) => key in body) ||
              /(^|\/)(characters?|cards?)(\/|$)/i.test(source)));
        if (!recognized) {
          plan.skipped.push({ source, reason: '非角色卡/世界书对象（配置和世界包索引不迁入）' });
          continue;
        }
      }
      const imported = importAsset(bytes, source),
        fingerprint = hash(JSON.stringify(imported.raw));
      const pngSource = imported.pngBytes
        ? source
        : imported.kind === 'character'
          ? (pngs.get(stem(source)) ?? null)
          : null;
      const warning = imported.warnings.slice();
      if (pngSource && !imported.pngBytes) {
        try {
          readPngChunks(new Uint8Array(await readFile(resolve(root, pngSource))));
        } catch {
          throw new Error('角色卡的配对 PNG 损坏');
        }
      }
      const entry: MigrationAsset = {
        id: `legacy-${fingerprint.slice(0, 24)}`,
        kind: imported.kind,
        name: imported.name,
        source,
        raw: imported.raw,
        fingerprint,
        pngSource,
        warnings: warning,
      };
      // A card JSON and its same-path PNG represent one asset; the editable JSON is authoritative.
      const existing = plan.assets.findIndex(
        (asset) => asset.kind === entry.kind && stem(asset.source) === stem(source),
      );
      if (existing >= 0) {
        if (/\.png$/i.test(source)) {
          plan.assets[existing]!.pngSource = source;
          continue;
        }
        if (plan.assets[existing]!.pngSource) entry.pngSource = plan.assets[existing]!.pngSource;
        plan.assets[existing] = entry;
      } else if (!plan.assets.some((asset) => asset.fingerprint === fingerprint))
        plan.assets.push(entry);
      else plan.skipped.push({ source, reason: '重复资料（相同原始 JSON）' });
    } catch (error) {
      if (/\.png$/i.test(source) && String(error).includes('no chara/ccv3')) {
        plan.skipped.push({
          source,
          reason: '普通 PNG，可与同名 JSON 配对；没有独立角色 metadata',
        });
        continue;
      }
      if (
        /\.ya?ml$/i.test(source) &&
        !/(^|\/)(characters?|cards?|lorebooks?|worldbooks?)(\/|$)/i.test(source)
      ) {
        plan.skipped.push({ source, reason: '非角色/世界书 YAML' });
        continue;
      }
      plan.errors.push({ source, reason: error instanceof Error ? error.message : '资料读取失败' });
    }
  }
  plan.missingPng = plan.assets
    .filter((asset) => asset.kind === 'character' && !asset.pngSource)
    .map((asset) => ({ source: asset.source, name: asset.name }));
  return plan;
}

/** Produces a new bundle only; source files and existing output directories are never overwritten. */
export async function writeMigrationBundle(
  plan: MigrationPlan,
  output: string,
): Promise<BundleManifest> {
  const out = resolve(output);
  if (out === plan.input || out.startsWith(plan.input + sep))
    throw new Error('输出目录不能位于旧备份目录内部');
  await mkdir(out, { recursive: false });
  const manifest: BundleManifest = {
    format: 'lightrp-assets-migration',
    version: 1,
    assets: [],
    conversations: [],
    missingPng: plan.missingPng,
    skipped: plan.skipped,
    errors: plan.errors,
  };
  await mkdir(resolve(out, 'assets'));
  await mkdir(resolve(out, 'archive', 'conversations'), { recursive: true });
  for (const asset of plan.assets) {
    const rawFile = `assets/${asset.id}.json`,
      bytes = Buffer.from(JSON.stringify(asset.raw, null, 2));
    await writeFile(resolve(out, rawFile), bytes, { flag: 'wx' });
    const pngFile = asset.pngSource ? `assets/${asset.id}.png` : null;
    let pngHash: string | null = null;
    if (asset.pngSource && pngFile) {
      const png = await readFile(resolve(plan.input, asset.pngSource));
      pngHash = hash(png);
      await writeFile(resolve(out, pngFile), png, { flag: 'wx' });
    }
    manifest.assets.push({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      source: asset.source,
      fingerprint: asset.fingerprint,
      rawFile,
      rawHash: hash(bytes),
      pngFile,
      pngHash,
      warnings: asset.warnings,
    });
  }
  for (const source of plan.conversations) {
    const file = `archive/conversations/${source}`,
      path = resolve(out, file);
    await mkdir(dirname(path), { recursive: true });
    await copyFile(resolve(plan.input, source), path);
    manifest.conversations.push({ source, file, hash: hash(await readFile(path)) });
  }
  await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}

async function safeBundleFile(root: string, file: string): Promise<Uint8Array> {
  const path = await realpath(resolve(root, file));
  if (!path.startsWith(root + sep)) throw new Error('迁移包包含越界路径');
  const info = await stat(path);
  if (!info.isFile() || info.size > 32_000_000) throw new Error('迁移包资料不是文件或超过限制');
  return new Uint8Array(await readFile(path));
}
function fingerprinted(raw: JsonObject, fingerprint: string): JsonObject {
  const wrapped = raw.data !== null && typeof raw.data === 'object' && !Array.isArray(raw.data);
  const body = wrapped ? object(raw.data) : raw,
    ext = object(body.extensions),
    namespace = object(ext.lightrp);
  const changed = patchAsset(body, {
    extensions: { ...ext, lightrp: { ...namespace, migrationFingerprint: fingerprint } },
  });
  return wrapped ? patchAsset(raw, { data: changed }) : changed;
}
function getFingerprint(raw: unknown): string {
  const source = object(raw),
    body = object(source.data ?? source);
  return String(object(object(body.extensions).lightrp).migrationFingerprint ?? '');
}

/** Local HTTP import is the real restore path, so both D1 revisions and R2 metadata use app invariants. */
export async function restoreMigrationBundle(
  input: string,
  options: { target?: string; write?: boolean; fetch?: typeof fetch } = {},
) {
  const root = await realpath(resolve(input));
  const manifest = JSON.parse(
    await readFile(resolve(root, 'manifest.json'), 'utf8'),
  ) as BundleManifest;
  if (
    manifest.format !== 'lightrp-assets-migration' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.assets)
  )
    throw new Error('未知迁移包版本');
  const prepared: Array<{ asset: BundleAsset; raw: JsonObject; png: Uint8Array | null }> = [];
  for (const asset of manifest.assets) {
    const bytes = await safeBundleFile(root, asset.rawFile);
    if (hash(bytes) !== asset.rawHash) throw new Error(`JSON 校验失败：${asset.id}`);
    const imported = importAsset(bytes, asset.rawFile);
    if (imported.kind !== asset.kind || hash(JSON.stringify(imported.raw)) !== asset.fingerprint)
      throw new Error(`资料身份校验失败：${asset.id}`);
    const png = asset.pngFile ? await safeBundleFile(root, asset.pngFile) : null;
    if (png && hash(png) !== asset.pngHash) throw new Error(`PNG 校验失败：${asset.id}`);
    if (png) readPngChunks(png);
    prepared.push({ asset, raw: fingerprinted(imported.raw, asset.fingerprint), png });
  }
  const existing = new Map<string, string>(),
    fetcher = options.fetch ?? fetch;
  let target: URL | null = null;
  if (options.target) {
    target = new URL(options.target);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.username ||
      target.password ||
      !['http:', 'https:'].includes(target.protocol)
    )
      throw new Error('恢复仅支持本机回环服务，不接受生产地址');
    let cursor = '';
    const seen = new Set<string>();
    do {
      const url = new URL('/api/v3/assets', target);
      url.searchParams.set('limit', '500');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetcher(url);
      if (!response.ok) throw new Error(`本地资料检查失败：HTTP ${response.status}`);
      const page = (await response.json()) as {
        items: Array<{ id: string; raw?: unknown }>;
        nextCursor?: string | null;
      };
      for (const item of page.items) {
        const fingerprint = getFingerprint(item.raw);
        if (fingerprint) existing.set(fingerprint, item.id);
      }
      cursor = page.nextCursor ?? '';
      if (cursor && seen.has(cursor)) throw new Error('本地分页游标重复');
      seen.add(cursor);
    } while (cursor);
  }
  if (options.write && !target)
    throw new Error('--write 恢复必须指定 --target http://127.0.0.1:8787');
  const result: Array<{
    sourceId: string;
    name: string;
    kind: AssetKind;
    status: string;
    restoredId?: string;
    png: boolean;
  }> = [];
  for (const { asset, raw, png } of prepared) {
    const already = existing.get(asset.fingerprint);
    if (already) {
      result.push({
        sourceId: asset.id,
        name: asset.name,
        kind: asset.kind,
        status: 'already-restored',
        restoredId: already,
        png: png !== null,
      });
      continue;
    }
    if (!options.write) {
      result.push({
        sourceId: asset.id,
        name: asset.name,
        kind: asset.kind,
        status: 'would-import',
        png: png !== null,
      });
      continue;
    }
    let body: FormData | string, headers: Record<string, string> | undefined;
    if (png) {
      const exported = exportAsset(raw, 'png', png),
        form = new FormData();
      form.set(
        'file',
        new File([exported.bytes as BlobPart], exported.filename, { type: 'image/png' }),
      );
      form.set('kind', asset.kind);
      body = form;
    } else {
      body = JSON.stringify({ kind: asset.kind, data: raw });
      headers = { 'Content-Type': 'application/json' };
    }
    const response = await fetcher(new URL('/api/v3/assets', target!), {
      method: 'POST',
      headers,
      body,
    });
    if (!response.ok)
      throw new Error(
        `本地导入失败：${asset.id} HTTP ${response.status}；已完成资料可通过 fingerprint 安全重试`,
      );
    const restored = (await response.json()) as { id: string };
    existing.set(asset.fingerprint, restored.id);
    result.push({
      sourceId: asset.id,
      name: asset.name,
      kind: asset.kind,
      status: 'imported',
      restoredId: restored.id,
      png: png !== null,
    });
  }
  return {
    dryRun: !options.write,
    assets: result,
    conversations: { archived: manifest.conversations.length, imported: 0 },
    missingPng: manifest.missingPng,
  };
}

async function main() {
  const args = process.argv.slice(2),
    mode = args[0] === 'restore' ? 'restore' : 'plan';
  const value = (key: string) => {
    const equal = args.find((arg) => arg.startsWith(`--${key}=`));
    if (equal) return equal.slice(key.length + 3);
    const index = args.indexOf(`--${key}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const input = value('input');
  if (args.includes('--help') || !input) {
    process.stdout.write(
      '离线迁移（默认 dry-run，无网络/写入）：\n  npx tsx scripts/migrate-legacy.ts plan --input /离线旧备份\n  npx tsx scripts/migrate-legacy.ts plan --input /离线旧备份 --output /全新迁移包 --write\n  npx tsx scripts/migrate-legacy.ts restore --input /迁移包\n  npx tsx scripts/migrate-legacy.ts restore --input /迁移包 --target http://127.0.0.1:8787\n  npx tsx scripts/migrate-legacy.ts restore --input /迁移包 --target http://127.0.0.1:8787 --write\n',
    );
    if (!input && !args.includes('--help')) process.exitCode = 1;
    return;
  }
  const write = args.includes('--write');
  if (args.includes('--dry-run') && write) throw new Error('--dry-run 与 --write 不能同时使用');
  if (mode === 'restore')
    process.stdout.write(
      JSON.stringify(
        await restoreMigrationBundle(input, { target: value('target'), write }),
        null,
        2,
      ) + '\n',
    );
  else {
    const plan = await planLegacy(input);
    if (write) {
      const output = value('output');
      if (!output) throw new Error('--write 必须指定全新 --output 目录');
      await writeMigrationBundle(plan, output);
    }
    process.stdout.write(
      JSON.stringify(
        { ...plan, assets: plan.assets.map(({ raw: _raw, ...asset }) => asset), dryRun: !write },
        null,
        2,
      ) + '\n',
    );
    if (plan.errors.length) process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : '迁移失败') + '\n');
    process.exitCode = 1;
  });
