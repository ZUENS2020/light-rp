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
/** Reuse one query embedding; refill only when D1 rejected stale or unauthorized hits. */
export async function searchLegalVectors(
  env: Env,
  s: Store,
  branchId: string,
  viewer: string,
  text: string,
): Promise<{ id: string; score: number }[]> {
  const [encoded] = await embed(env, [text.slice(0, 2000)]);
  const scope = await scopeKey(s.ownerId, branchId, viewer);
  const namespace = await branchNamespace(s.ownerId, branchId);
  let legal: { id: string; score: number }[] = [];
  for (const topK of [40, 80, 100]) {
    const result = await env.VECTORS.query(encoded!, {
      topK,
      namespace,
      filter: { scope },
      returnMetadata: 'none',
      returnValues: false,
    });
    const mapped = await resolveVectorCandidates(s, branchId, viewer, scope, result.matches);
    const current = new Set(
      (
        await s.memory.currentByIds(
          branchId,
          mapped.map((m) => m.id),
          { viewer },
        )
      ).map((m) => m.id),
    );
    legal = mapped.filter((m) => current.has(m.id)).slice(0, 40);
    if (legal.length >= 40 || result.matches.length < topK) break;
  }
  return legal;
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
    const scope = await scopeKey(s.ownerId, branchId, viewer);
    const fingerprint = await digest({
      epoch: await s.ownerEpoch(),
      resources: await s.getResourceBindings(branchId),
      policy: await s.one('SELECT * FROM memory_policies WHERE branch_id=?', branchId),
      grants: await s.one(
        'SELECT COALESCE(MAX(rowid),0) AS n FROM knowledge_grants WHERE owner_id=?',
        s.ownerId,
      ),
    });
    const progress = await s.one<{ after_version: number; fingerprint: string }>(
      'SELECT * FROM vector_index_progress WHERE branch_id=? AND viewer=?',
      branchId,
      viewer,
    );
    let after = progress?.fingerprint === fingerprint ? progress.after_version : 0;
    const recorded = await s.all<{ vector_id: string; memory_id: string }>(
      'SELECT vector_id,memory_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=?',
      s.ownerId,
      branchId,
      viewer,
    );
    for (const m of recorded)
      if (m.vector_id !== (await vectorId(m.memory_id, scope))) {
        after = 0;
        break;
      }
    const watermark = Number(
      (await s.one<{ n: number }>('SELECT COALESCE(MAX(rowid),0) AS n FROM memory_versions'))!.n,
    );
    for (;;) {
      const page = await s.memory.page(branchId, {
        viewer,
        afterVersion: after,
        beforeVersion: watermark + 1,
        limit: 80,
        asOfSeq: branch.headSeq,
      });
      const records = page.items;
      const manifest = await s.all<{ vector_id: string; memory_id: string }>(
        'SELECT vector_id,memory_id FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=? AND scope=? AND memory_id IN (SELECT value FROM json_each(?))',
        s.ownerId,
        branchId,
        viewer,
        scope,
        JSON.stringify(records.map((m) => m.id)),
      );
      const desired = new Map(
        await Promise.all(records.map(async (m) => [m.id, await vectorId(m.id, scope)] as const)),
      );
      const existing = new Set(
        manifest.filter((m) => desired.get(m.memory_id) === m.vector_id).map((m) => m.memory_id),
      );
      for (const m of manifest.filter((m) => desired.get(m.memory_id) !== m.vector_id)) {
        await env.VECTORS.deleteByIds([m.vector_id]);
        await s.run(
          'DELETE FROM vector_manifest WHERE owner_id=? AND vector_id=?',
          s.ownerId,
          m.vector_id,
        );
      }
      const missing = records.filter((m) => !existing.has(m.id));
      for (let offset = 0; offset < missing.length; offset += 20) {
        const batch = missing.slice(offset, offset + 20),
          values = new Map<string, number[]>(),
          uncached = [];
        const cachedRows = await s.all<{ memory_id: string; values_json: string }>(
          'SELECT memory_id,values_json FROM embedding_cache WHERE owner_id=? AND model=? AND memory_id IN (SELECT value FROM json_each(?))',
          s.ownerId,
          '@cf/baai/bge-m3',
          JSON.stringify(batch.map((m) => m.id)),
        );
        const cachedById = new Map(
          cachedRows.map((r) => [r.memory_id, JSON.parse(r.values_json) as number[]]),
        );
        for (const m of batch) {
          const cached = cachedById.get(m.id);
          if (cached?.length === 1024 && cached.every(Number.isFinite)) values.set(m.id, cached);
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
          valid = new Set(
            (
              await s.memory.currentByIds(
                branchId,
                batch.map((m) => m.id),
                { viewer },
              )
            ).map((m) => m.id),
          );
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
          (
            await s.memory.currentByIds(
              branchId,
              batch.map((m) => m.id),
              { viewer },
            )
          ).map((m) => m.id),
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
      await s.batch([
        s.epochGuard(await s.ownerEpoch()),
        {
          sql: 'INSERT INTO vector_index_progress(branch_id,viewer,after_version,fingerprint) VALUES(?,?,?,?) ON CONFLICT(branch_id,viewer) DO UPDATE SET after_version=excluded.after_version,fingerprint=excluded.fingerprint',
          params: [branchId, viewer, page.after, fingerprint],
        },
        s.cleanupGuards(),
      ]);
      if (page.exhausted) break;
      if (page.after <= after) throw new Error('vector index page did not advance');
      after = page.after;
    }
    // Absence from a page never means deletion. Check each manifest revision explicitly.
    let last = '';
    for (;;) {
      const page = await s.all<{ vector_id: string; memory_id: string; scope: string }>(
        'SELECT vector_id,memory_id,scope FROM vector_manifest WHERE owner_id=? AND branch_id=? AND viewer=? AND vector_id>? ORDER BY vector_id LIMIT 80',
        s.ownerId,
        branchId,
        viewer,
        last,
      );
      if (!page.length) break;
      const expected = new Map(
        await Promise.all(
          page.map(async (m) => [m.memory_id, await vectorId(m.memory_id, scope)] as const),
        ),
      );
      const valid = new Set(
        (
          await s.memory.currentByIds(
            branchId,
            page.map((m) => m.memory_id),
            { viewer },
          )
        ).map((m) => m.id),
      );
      const stale = page.filter(
        (m) =>
          m.scope !== scope || m.vector_id !== expected.get(m.memory_id) || !valid.has(m.memory_id),
      );
      if (stale.length) {
        await env.VECTORS.deleteByIds(stale.map((m) => m.vector_id));
        await s.batch(
          stale.map((m) => ({
            sql: 'DELETE FROM vector_manifest WHERE owner_id=? AND vector_id=?',
            params: [s.ownerId, m.vector_id],
          })),
        );
      }
      last = page.at(-1)!.vector_id;
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
