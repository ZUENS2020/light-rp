import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
const [directory, base = 'http://127.0.0.1:8788'] = process.argv.slice(2);
if (!directory)
  throw new Error(
    'Usage: tsx scripts/backup-legacy.ts <independent-backup-directory> [loopback-reader-url]',
  );
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname))
  throw new Error('The reader must use loopback.');
const root = resolve(directory);
await mkdir(root, { recursive: true });
const files: { key: string; size: number; sha256: string }[] = [];
let cursor: string | null = null;
do {
  const url = new URL('/list', base);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`List failed: ${response.status}`);
  const list = (await response.json()) as {
    objects: { key: string; size: number }[];
    cursor: string | null;
  };
  for (const object of list.objects) {
    const path = resolve(root, object.key);
    if (!path.startsWith(root + sep)) throw new Error('Unsafe legacy key');
    await mkdir(join(path, '..'), { recursive: true });
    const target = new URL('/object', base);
    target.searchParams.set('key', object.key);
    const result = await fetch(target);
    if (!result.ok) throw new Error(`Object download failed: ${result.status}`);
    const bytes = new Uint8Array(await result.arrayBuffer());
    if (bytes.byteLength !== object.size) throw new Error('Object changed during export');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let existing: Uint8Array | undefined;
    try {
      existing = await readFile(path);
    } catch {
      /* new export */
    }
    if (existing && createHash('sha256').update(existing).digest('hex') !== sha256)
      throw new Error('Backup path already contains a different revision');
    if (!existing) await writeFile(path, bytes, { flag: 'wx' });
    files.push({ key: object.key, size: bytes.length, sha256 });
  }
  cursor = list.cursor;
} while (cursor);
await writeFile(
  join(root, 'backup-manifest.json'),
  JSON.stringify(
    { format: 'lightrp-v2-r2-backup', createdAt: new Date().toISOString(), files },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    files: files.length,
    bytes: files.reduce((n, f) => n + f.size, 0),
    directory: root,
  }),
);
