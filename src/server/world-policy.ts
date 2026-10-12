import { StoreError, now, type Store } from './store';
import { worldPolicyWriteSchema } from '../shared/world-policy';
import type { z } from 'zod';

export async function setWorldPolicy(
  store: Store,
  worldId: string,
  input: z.infer<typeof worldPolicyWriteSchema>,
) {
  const body = worldPolicyWriteSchema.parse(input);
  await store.getWorld(worldId);
  const existing = await store.one<{ mode: string; revision: number }>(
    'SELECT mode,revision FROM world_policy_changes WHERE world_id=? AND command_id=?',
    worldId,
    body.commandId,
  );
  if (existing) {
    if (existing.mode !== body.mode || existing.revision !== body.expectedRevision + 1)
      throw new StoreError('IDEMPOTENCY_REUSE', '同一请求不能写入不同工作区设置');
    return store.getWorld(worldId);
  }
  const at = now();
  await store.batch([
    {
      sql: 'UPDATE worlds SET narrative_mode=?,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND policy_revision=?',
      params: [body.mode, at, worldId, store.ownerId, body.expectedRevision],
    },
    store.guard('changes()=1'),
    {
      sql: 'INSERT INTO world_policy_changes VALUES(?,?,?,?,?)',
      params: [worldId, body.commandId, body.expectedRevision + 1, body.mode, at],
    },
    store.cleanupGuards(),
  ]);
  return store.getWorld(worldId);
}
