/** Count real executions, not Queue deliveries that only collided with a lease. */
export const MAX_GENERATION_ATTEMPTS = 4;
const DELIVERY_GRACE_MS = 180_000;

/**
 * Recover orphaned generation work even when its Queue delivery was already exhausted.
 * Compatible with current schema (no execution_phase / commit journal yet).
 */
export async function recoverGenerationTasks(db: D1Database): Promise<void> {
  const now = new Date();
  const timestamp = now.toISOString();
  const cutoff = new Date(now.getTime() - DELIVERY_GRACE_MS).toISOString();
  const stale = `status IN ('pending', 'running')
    AND ((lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      OR (lease_expires_at IS NULL AND updated_at <= ?))`;
  const rows = await db
    .prepare(`SELECT id FROM generation_tasks WHERE ${stale} ORDER BY updated_at LIMIT 25`)
    .bind(timestamp, cutoff)
    .all<{ id: string }>();
  for (const { id } of rows.results) {
    // Both writes are atomic and recheck liveness. A heartbeat or competing recovery
    // must not resurrect work or lose its durable delivery marker incorrectly.
    const results = await db.batch([
      db
        .prepare(
          `UPDATE outbox_events SET published_at = NULL
        WHERE aggregate_id = ? AND event_type = 'generation.requested'
          AND EXISTS (SELECT 1 FROM generation_tasks WHERE id = ? AND ${stale} AND attempt_count < ?)`,
        )
        .bind(id, id, timestamp, cutoff, MAX_GENERATION_ATTEMPTS),
      db
        .prepare(
          `UPDATE generation_tasks SET
        status = CASE WHEN attempt_count >= ? THEN 'dead' ELSE 'pending' END,
        error_code = CASE WHEN attempt_count >= ? THEN 'TASK_RETRY_EXHAUSTED' ELSE 'TASK_LEASE_EXPIRED' END,
        error_message = CASE WHEN attempt_count >= ? THEN '生成多次中断，已停止自动重试，请重新生成。' ELSE '执行中断，正在自动恢复。' END,
        completed_at = CASE WHEN attempt_count >= ? THEN ? ELSE NULL END,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND ${stale}`,
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
        ),
    ]);
    if (results[1].meta.changes) console.info({ event: "generation.recovered", taskId: id });
  }
}
