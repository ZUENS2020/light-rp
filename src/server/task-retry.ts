import { Store, now } from './store';
import { ApiError } from './errors';
import { settingsSchema, type ModelSettings } from './settings';
import type { TaskRow } from './workflows';

/** Each explicit retry freezes the latest saved settings for its new attempt.
 * Older attempts keep their immutable R2 snapshots and never resume. */
export async function retryGeneration(s: Store, t: TaskRow, configInput: ModelSettings) {
  if (t.owner_id !== s.ownerId) throw new ApiError(404, '任务不存在');
  if (t.status !== 'failed')
    throw new ApiError(409, '只有失败任务可以原地重试；取消的输入请重新提交');
  const branch = await s.getBranch(t.branch_id);
  if (branch.headSeq !== t.expected_head) throw new ApiError(409, '剧情已改变，请分叉或重新提交');
  const config = settingsSchema.parse(configInput);
  const attempt = t.attempt + 1,
    at = now();
  await s.batch([
    s.guard('EXISTS(SELECT 1 FROM branches WHERE id=? AND owner_id=? AND head_seq=?)', [
      t.branch_id,
      s.ownerId,
      t.expected_head,
    ]),
    s.guard(
      "NOT EXISTS(SELECT 1 FROM tasks WHERE owner_id=? AND branch_id=? AND id<>? AND status IN ('queued','running','validating','committing'))",
      [s.ownerId, t.branch_id, t.id],
    ),
    s.guard(
      "EXISTS(SELECT 1 FROM tasks WHERE id=? AND owner_id=? AND status='failed' AND attempt=?)",
      [t.id, s.ownerId, t.attempt],
    ),
    {
      sql: "UPDATE tasks SET status='queued',attempt=?,error_json=NULL,context_json='{}',draft_text='',config_json=?,updated_at=? WHERE id=?",
      params: [attempt, JSON.stringify(config), at, t.id],
    },
    {
      sql: 'INSERT INTO outbox(id,owner_id,branch_id,kind,payload_json,created_at,updated_at)VALUES(?,?,?,?,?,?,?)',
      params: [
        `generation:${t.id}:${attempt}`,
        s.ownerId,
        t.branch_id,
        'generation',
        JSON.stringify({ taskId: t.id, ownerId: s.ownerId, attempt }),
        at,
        at,
      ],
    },
    s.cleanupGuards(),
  ]);
  return { taskId: t.id, attempt };
}
