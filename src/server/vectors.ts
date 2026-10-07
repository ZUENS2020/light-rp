import type { Env } from './env';
import type { Store } from './store';
import { digest, now } from './store';
import { branchNamespace, scopeKey } from './context';

/** Vectorize IDs are limited to 64 UTF-8 bytes; storage IDs remain opaque. */
export async function vectorId(memoryId: string, scope: string): Promise<string> {
  return digest({ format: 'lightrp-vector-v2', memoryId, scope });
}
export async function resolveVectorCandidates(
  s: Store,
  branchId: string,
  viewer: string,
  scope: string,
  matches: { id: string; score: number }[],
): Promise<{ id: string; score: number }[]> {
  if (!matches.length) return [];
  const rows = await s.all<{ vector_id: string; memory_id: string }>(
    'SELECT vector_id,memory_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=? AND scope=? AND vector_id IN (SELECT value FROM json_each(?))',
    s.ownerId,
    branchId,
    viewer,
    scope,
    JSON.stringify(matches.map((match) => match.id)),
  );
  const mapping = new Map(rows.map((row) => [row.vector_id, row.memory_id]));
  return matches
    .filter((match) => mapping.has(match.id))
    .map((match) => ({ id: mapping.get(match.id)!, score: match.score }));
}
/** Removes manifest IDs, plus deterministic IDs from an interrupted pre-manifest upsert. */
export async function deleteMemoryVectors(
  env: Env,
  s: Store,
  branchId: string,
  memoryIds: string[],
) {
  if (!memoryIds.length) return;
  const branch = await s.getBranch(branchId),
    story = await s.getStory(branch.storyId);
  const rows = await s.all<{ vector_id: string }>(
    'SELECT vector_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND memory_id IN (SELECT value FROM json_each(?))',
    s.ownerId,
    branchId,
    JSON.stringify(memoryIds),
  );
  const ids = new Set(rows.map((row) => row.vector_id));
  for (const viewer of ['director', ...story.characterIds]) {
    const scope = await scopeKey(s.ownerId, branchId, viewer);
    for (const memoryId of memoryIds) ids.add(await vectorId(memoryId, scope));
  }
  const all = [...ids];
  for (let offset = 0; offset < all.length; offset += 100) {
    const batch = all.slice(offset, offset + 100);
    await env.VECTORS.deleteByIds(batch);
    await s.run(
      'DELETE FROM vector_manifest WHERE owner_id=? AND vector_id IN (SELECT value FROM json_each(?))',
      s.ownerId,
      JSON.stringify(batch),
    );
  }
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const result = await env.AI.run('@cf/baai/bge-m3', { text: texts });
  if (
    !('data' in result) ||
    !result.data ||
    result.data.length !== texts.length ||
    result.data.some((v) => v.length !== 1024 || v.some((n) => !Number.isFinite(n)))
  )
    throw new Error('embedding 维度或数量不一致');
  return result.data;
}
/** Immutable revision IDs prevent an old task from overwriting a newer vector. */
export async function indexMemories(env: Env, s: Store, branchId: string) {
  const branch = await s.getBranch(branchId),
    story = await s.getStory(branch.storyId),
    namespace = await branchNamespace(s.ownerId, branchId);
  for (const viewer of ['director', ...story.characterIds]) {
    const records = await s.memories(branchId, { viewer, limit: 5000 }),
      scope = await scopeKey(s.ownerId, branchId, viewer);
    const manifest = await s.all<{ vector_id: string; memory_id: string }>(
      'SELECT vector_id,memory_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=?',
      s.ownerId,
      branchId,
      viewer,
    );
    const desired = new Map(
        await Promise.all(
          records.map(async (memory) => [memory.id, await vectorId(memory.id, scope)] as const),
        ),
      ),
      stale = manifest.filter((memory) => desired.get(memory.memory_id) !== memory.vector_id);
    if (stale.length) {
      for (let i = 0; i < stale.length; i += 100) {
        await env.VECTORS.deleteByIds(stale.slice(i, i + 100).map((m) => m.vector_id));
        await s.batch(
          stale.slice(i, i + 100).map((m) => ({
            sql: 'DELETE FROM vector_manifest WHERE vector_id=?',
            params: [m.vector_id],
          })),
        );
      }
    }
    const staleIds = new Set(stale.map((memory) => memory.vector_id)),
      existing = new Set(
        manifest
          .filter((memory) => !staleIds.has(memory.vector_id))
          .map((memory) => memory.memory_id),
      ),
      missing = records.filter((memory) => !existing.has(memory.id));
    for (let offset = 0; offset < missing.length; offset += 20) {
      const batch = missing.slice(offset, offset + 20),
        values = new Map<string, number[]>(),
        uncached = [];
      for (const m of batch) {
        const cached = await s.one<{ values_json: string }>(
          'SELECT values_json FROM embedding_cache WHERE memory_id=? AND owner_id=?',
          m.id,
          s.ownerId,
        );
        if (cached) values.set(m.id, JSON.parse(cached.values_json));
        else uncached.push(m);
      }
      if (uncached.length) {
        const encoded = await embed(
          env,
          uncached.map((m) => `${m.subject} ${m.predicate} ${m.text}`.slice(0, 2000)),
        );
        for (const [i, m] of uncached.entries()) values.set(m.id, encoded[i]!);
      }
      const epoch = await s.ownerEpoch(),
        valid = new Set((await s.memories(branchId, { viewer, limit: 5000 })).map((m) => m.id));
      const mapping = new Map<string, string>();
      const vectors = batch
        .filter((memory) => valid.has(memory.id))
        .map((memory) => {
          const id = desired.get(memory.id)!;
          mapping.set(id, memory.id);
          return {
            id,
            namespace,
            values: values.get(memory.id)!,
            metadata: { scope, kind: memory.kind, revision: memory.revision },
          };
        });
      if (!vectors.length) continue;
      await env.VECTORS.upsert(vectors);
      try {
        await s.batch([
          s.epochGuard(epoch),
          ...vectors.flatMap((v) => [
            {
              sql: 'INSERT OR IGNORE INTO embedding_cache(memory_id,owner_id,model,values_json,created_at) VALUES(?,?,?,?,?)',
              params: [
                mapping.get(v.id)!,
                s.ownerId,
                '@cf/baai/bge-m3',
                JSON.stringify(v.values),
                now(),
              ],
            },
            {
              sql: 'INSERT OR IGNORE INTO vector_manifest(vector_id,owner_id,branch_id,memory_id,viewer,scope,created_at) VALUES(?,?,?,?,?,?,?)',
              params: [v.id, s.ownerId, branchId, mapping.get(v.id)!, viewer, scope, now()],
            },
          ]),
          s.cleanupGuards(),
        ]);
      } catch (error) {
        await env.VECTORS.deleteByIds(vectors.map((v) => v.id));
        throw error;
      }
      const stillValid = new Set(
        (await s.memories(branchId, { viewer, limit: 5000 })).map((m) => m.id),
      );
      const revoked = vectors.filter((v) => !stillValid.has(mapping.get(v.id)!));
      if (revoked.length) {
        await env.VECTORS.deleteByIds(revoked.map((v) => v.id));
        await s.batch(
          revoked.map((v) => ({
            sql: 'DELETE FROM vector_manifest WHERE vector_id=?',
            params: [v.id],
          })),
        );
      }
    }
  }
}
export async function cleanDeletedVectors(env: Env, s: Store) {
  const rows = await s.all<{ vector_id: string; memory_id: string }>(
    'SELECT v.vector_id,v.memory_id FROM vector_manifest v JOIN source_deletion_members d ON d.memory_id=v.memory_id WHERE v.owner_id=?',
    s.ownerId,
  );
  for (let offset = 0; offset < rows.length; offset += 100) {
    const batch = rows.slice(offset, offset + 100);
    await env.VECTORS.deleteByIds(batch.map((v) => v.vector_id));
    await s.batch(
      batch.flatMap((v) => [
        { sql: 'DELETE FROM vector_manifest WHERE vector_id=?', params: [v.vector_id] },
        {
          sql: 'DELETE FROM embedding_cache WHERE memory_id=? AND owner_id=?',
          params: [v.memory_id, s.ownerId],
        },
      ]),
    );
  }
  await s.run(
    'DELETE FROM embedding_cache WHERE owner_id=? AND memory_id IN (SELECT memory_id FROM source_deletion_members)',
    s.ownerId,
  );
}
