/** Count real executions, not Queue deliveries that only collided with a lease. */
export const MAX_GENERATION_ATTEMPTS = 4;
/** Grace before treating a leased/running (or post-attempt) task as abandoned via lease expiry. */
export const DELIVERY_GRACE_MS = 180_000;
/**
 * Running with an active lease but no recent `updated_at` (partial write / heartbeat)
 * is treated as a dead worker even if `lease_expires_at` is still in the future.
 * Must be longer than LEASE_HEARTBEAT_INTERVAL_MS so healthy streams are not killed.
 */
export const STALE_RUNNING_GRACE_MS = 120_000;
/**
 * Never-started pending (attempt_count=0, no lease) may have lost its Queue delivery
 * after outbox was marked published. Republish well before DELIVERY_GRACE_MS so the
 * user does not sit on "generating" for 180s + cron interval with zero LLM work.
 */
export const PENDING_NEVER_STARTED_GRACE_MS = 30_000;

const STALE_TASK_PREDICATE = `status IN ('pending', 'running')
    AND (
      (lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      OR (lease_expires_at IS NULL AND updated_at <= ?)
      OR (status = 'running' AND lease_expires_at IS NOT NULL AND updated_at <= ?)
    )`;

/**
 * Recover orphaned generation work even when its Queue delivery was already exhausted.
 * Compatible with current schema (no execution_phase / commit journal yet).
 *
 * SELECT stale ids first; UPDATE/batch only runs when there is at least one stale id.
 * Quiet cron ticks with zero stale tasks perform zero D1 writes.
 *
 * Stale-running path: a live worker heartbeats `updated_at` (partials + lease renew).
 * If `updated_at` is older than STALE_RUNNING_GRACE_MS, clear lease and republish even
 * when `lease_expires_at` is still in the future (zombie after Worker/Gateway death).
 */
export async function recoverGenerationTasks(db: D1Database): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString();
  const cutoff = new Date(now.getTime() - DELIVERY_GRACE_MS).toISOString();
  const staleRunningCutoff = new Date(now.getTime() - STALE_RUNNING_GRACE_MS).toISOString();
  const rows = await db
    .prepare(`SELECT id FROM generation_tasks WHERE ${STALE_TASK_PREDICATE} ORDER BY updated_at LIMIT 25`)
    .bind(timestamp, cutoff, staleRunningCutoff)
    .all<{ id: string }>();
  const staleIds = rows.results || [];
  if (!staleIds.length) return;

  for (const { id } of staleIds) {
    // Both writes are atomic and recheck liveness. A heartbeat or competing recovery
    // must not resurrect work or lose its durable delivery marker incorrectly.
    const results = await db.batch([
      db
        .prepare(
          `UPDATE outbox_events SET published_at = NULL
        WHERE aggregate_id = ? AND event_type = 'generation.requested'
          AND EXISTS (SELECT 1 FROM generation_tasks WHERE id = ? AND ${STALE_TASK_PREDICATE} AND attempt_count < ?)`,
        )
        .bind(id, id, timestamp, cutoff, staleRunningCutoff, MAX_GENERATION_ATTEMPTS),
      db
        .prepare(
          `UPDATE generation_tasks SET
        status = CASE WHEN attempt_count >= ? THEN 'dead' ELSE 'pending' END,
        error_code = CASE WHEN attempt_count >= ? THEN 'TASK_RETRY_EXHAUSTED' ELSE 'TASK_LEASE_EXPIRED' END,
        error_message = CASE WHEN attempt_count >= ? THEN '生成多次中断，已停止自动重试，请重新生成。' ELSE '执行中断，正在自动恢复。' END,
        completed_at = CASE WHEN attempt_count >= ? THEN ? ELSE NULL END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND ${STALE_TASK_PREDICATE}`,
        )
        .bind(
          MAX_GENERATION_ATTEMPTS,
          MAX_GENERATION_ATTEMPTS,
          MAX_GENERATION_ATTEMPTS,
          MAX_GENERATION_ATTEMPTS,
          timestamp,
          timestamp,
          id,
          timestamp,
          cutoff,
          staleRunningCutoff,
        ),
    ]);
    if (results[1].meta.changes) console.info({ event: "generation.recovered", taskId: id });
  }
}

/**
 * Clear published_at for never-started pending whose Queue delivery was likely lost.
 * Bumps updated_at so the next force-republish waits another PENDING_NEVER_STARTED_GRACE_MS.
 * Quiet when nothing matches (SELECT then conditional UPDATE).
 */
export async function resetNeverStartedPublishedOutbox(db: D1Database): Promise<string[]> {
  const now = new Date();
  const timestamp = now.toISOString();
  const cutoff = new Date(now.getTime() - PENDING_NEVER_STARTED_GRACE_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT g.id AS id FROM generation_tasks g
       JOIN outbox_events o ON o.aggregate_id = g.id AND o.event_type = 'generation.requested'
       WHERE g.status = 'pending'
         AND g.attempt_count = 0
         AND g.lease_expires_at IS NULL
         AND g.updated_at <= ?
         AND o.published_at IS NOT NULL
       ORDER BY g.updated_at LIMIT 25`,
    )
    .bind(cutoff)
    .all<{ id: string }>();
  const ids = (rows.results || []).map((r) => r.id);
  if (!ids.length) return [];

  const resetIds: string[] = [];
  for (const id of ids) {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE outbox_events SET published_at = NULL
           WHERE aggregate_id = ? AND event_type = 'generation.requested' AND published_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM generation_tasks
               WHERE id = ? AND status = 'pending' AND attempt_count = 0
                 AND lease_expires_at IS NULL AND updated_at <= ?
             )`,
        )
        .bind(id, id, cutoff),
      db
        .prepare(
          `UPDATE generation_tasks
           SET updated_at = ?,
               error_code = COALESCE(error_code, 'TASK_QUEUE_REPUBLISH'),
               error_message = COALESCE(error_message, '队列投递可能丢失，正在重新投递。')
           WHERE id = ? AND status = 'pending' AND attempt_count = 0
             AND lease_expires_at IS NULL AND updated_at <= ?`,
        )
        .bind(timestamp, id, cutoff),
    ]);
    if (results[0].meta.changes) {
      resetIds.push(id);
      console.info({ event: "generation.pending_republish_reset", taskId: id });
    }
  }
  return resetIds;
}
