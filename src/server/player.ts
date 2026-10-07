import { StoreError, stableJson, type Store } from './store';
import { playerProfileSchema, type PlayerProfile } from '../shared/player';

/** Recover settings from canonical author sources even after unrelated scene cleanup. */
export async function playerProfileAsOf(store: Store, branchId: string, seq: number) {
  const row = await store.one<{ source_id: string; text: string }>(
    `SELECT e.source_id,s.text FROM events e JOIN sources s ON s.id=e.source_id AND s.owner_id=e.owner_id
    JOIN branch_lineage l ON l.ancestor_id=e.branch_id AND l.branch_id=?
    WHERE e.owner_id=? AND e.seq<=? AND (l.max_seq IS NULL OR e.seq<=l.max_seq)
      AND e.request_id GLOB 'player-profile:*' AND e.role='correction' AND s.status='active'
    ORDER BY e.seq DESC LIMIT 1`,
    branchId,
    store.ownerId,
    seq,
  );
  if (!row) return null;
  const line = row.text.split('\n')[0]!;
  const prefix = '【玩家身份与描写设定】';
  if (!line.startsWith(prefix)) return null;
  try {
    return {
      profile: playerProfileSchema.parse(JSON.parse(line.slice(prefix.length))),
      sourceId: row.source_id,
    };
  } catch {
    return null;
  }
}

/** A branch-local author event: forks retain the profile at their exact event prefix. */
export async function setPlayerProfile(
  store: Store,
  branchId: string,
  input: { commandId: string; expectedHead: number; profile: PlayerProfile },
) {
  const branch = await store.getBranch(branchId);
  const profile = playerProfileSchema.parse(input.profile);
  const text = `【玩家身份与描写设定】${stableJson(profile)}\n这是作者给叙事者的设定，不代表场内角色已获知，也不自动恢复失忆玩家的记忆。`;
  const requestId = `player-profile:${input.commandId}`;
  const existing = await store.one<{ text: string | null; status: string }>(
    'SELECT s.text,s.status FROM events e JOIN sources s ON s.id=e.source_id WHERE e.owner_id=? AND e.branch_id=? AND e.request_id=?',
    store.ownerId,
    branchId,
    requestId,
  );
  if (existing) {
    if (existing.status !== 'active')
      throw new StoreError('PROFILE_DELETED', '身份设定来源已删除', 410);
    if (existing.text !== text)
      throw new StoreError('IDEMPOTENCY_REUSE', '同一请求不能写入不同身份');
    return { branch, profile, replayed: true };
  }
  const sessions = await store.listSessions(branchId);
  if (!sessions.length) throw new StoreError('SESSION_REQUIRED', '请先创建会话', 400);
  const result = await store.appendTurn(
    {
      branchId,
      sessionId: sessions[0]!.id,
      requestId,
      expectedHead: input.expectedHead,
      messages: [{ role: 'correction', text, knownBy: [] }],
      scene: { ...branch.scene, playerProfile: profile },
    },
    {
      fingerprint: { playerProfile: profile },
      prepare: async (events) => [
        store.guard(
          "NOT EXISTS(SELECT 1 FROM tasks WHERE owner_id=? AND branch_id=? AND status IN ('queued','running','validating','committing'))",
          [store.ownerId, branchId],
        ),
        {
          sql: "UPDATE branches SET scene_json=json_set(scene_json,'$.playerProfileSourceId',?) WHERE id=? AND owner_id=?",
          params: [events[0]!.sourceId, branchId, store.ownerId],
        },
        {
          sql: "UPDATE scene_snapshots SET scene_json=json_set(scene_json,'$.playerProfileSourceId',?) WHERE branch_id=? AND event_seq=?",
          params: [events[0]!.sourceId, branchId, events[0]!.seq],
        },
      ],
    },
  );
  return { ...result, profile };
}
