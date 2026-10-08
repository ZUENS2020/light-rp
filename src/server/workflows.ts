import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { Store, StoreError, now, uuid, digest } from './store';
import type { Env } from './env';
import { complete, parseJson } from './model';
import { buildContext, type ContextSnapshot, type TurnInput } from './context';
import {
  analyze,
  extractionSchema,
  evidenceFor,
  memoryProposals,
  knowledgeGrantsFor,
  type AutomaticKnowledgeGrant,
  type Extraction,
} from './extraction';
import { settingsSchema, defaults } from './settings';
import { publish } from './runtime';
import { ApiError, errorMessage } from './errors';
import type { Event, MemoryProposal } from '../shared/domain';
import { estimateAssetTokens } from '../shared/assets';
import { indexMemories, cleanDeletedVectors, deleteMemoryVectors } from './vectors';
import {
  listEntities,
  resolveMemoryEntities,
  entityReviewProposals,
  type RejectedEntityFact,
} from './entities';
import { syncPersonaCapabilities } from './persona';
import type { ExtractionDecisionAudit } from './extraction-decisions';
export interface TaskRow {
  id: string;
  owner_id: string;
  branch_id: string;
  session_id: string;
  command_id: string;
  expected_head: number;
  status: string;
  attempt: number;
  input_json: string;
  config_json: string;
  context_json: string;
  draft_text: string;
  error_json: string | null;
  cancel_epoch: number;
  created_at: string;
  updated_at: string;
}
interface OutboxRow {
  id: string;
  owner_id: string;
  branch_id: string;
  kind: string;
  payload_json: string;
  status: string;
  attempts: number;
}
interface JobParams {
  ownerId: string;
  taskId?: string;
  attempt?: number;
  outboxId?: string;
  branchId?: string;
  throughSeq?: number;
  [key: string]: unknown;
}
const retry = {
  retries: { limit: 2, delay: '1 second' as const, backoff: 'exponential' as const },
  timeout: '10 minutes' as const,
};
/** One policy for normal projection, experiences/capabilities and branch replay.
 * Acquisition claims are already source-validated; grant only their supported
 * content spans. Historical artifacts with only knownBy yield an empty plan. */
async function applyAutomaticKnowledge(
  s: Store,
  branchId: string,
  grants: AutomaticKnowledgeGrant[],
  scopes: string[],
  options: { ownerEpoch?: number; sourceFence?: Parameters<Store['extract']>[1]['sourceFence'] },
) {
  const seen = new Set<string>();
  for (const grant of grants.filter((grant) => scopes.includes(grant.path.split('.')[0]!))) {
    const evidence = grant.evidence,
      identity = `${grant.actorId}:${evidence.sourceId}:${evidence.start}:${evidence.end}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const authorRevoke = await s.one(
      `SELECT 1 AS revoked FROM (
       SELECT g.status,ROW_NUMBER() OVER(PARTITION BY g.span_id,g.character_id ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC) AS rank
       FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id
       JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=?
       WHERE g.owner_id=? AND g.character_id IN (?,'*') AND g.source_id=? AND g.channel='author'
       AND p.start_offset<? AND p.end_offset>? AND p.source_version=? AND p.source_generation=?
       AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq)
       AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid))
       WHERE rank=1 AND status='revoke' LIMIT 1`,
      branchId,
      s.ownerId,
      grant.actorId,
      evidence.sourceId,
      evidence.end,
      evidence.start,
      evidence.sourceVersion ?? 1,
      evidence.sourceGeneration ?? 0,
    );
    if (authorRevoke) continue;
    // An idempotent replay neither duplicates a grant nor reverses an explicit
    // revocation of that same span. Source/owner fences are still checked on a
    // new write by MemoryEngine in its transaction.
    const existing = await s.one(
      `SELECT g.status FROM knowledge_grants g JOIN source_spans p ON p.id=g.span_id
       JOIN branch_lineage l ON l.ancestor_id=g.branch_id AND l.branch_id=?
       WHERE g.owner_id=? AND g.character_id IN (?,'*') AND g.source_id=?
       AND p.start_offset<=? AND p.end_offset>=? AND p.source_version=? AND p.source_generation=?
       AND (l.max_seq IS NULL OR g.recorded_seq<=l.max_seq)
       AND (l.max_grant_rowid IS NULL OR g.rowid<=l.max_grant_rowid)
       ORDER BY g.recorded_seq DESC,g.rowid DESC,l.depth ASC LIMIT 1`,
      branchId,
      s.ownerId,
      grant.actorId,
      evidence.sourceId,
      evidence.start,
      evidence.end,
      evidence.sourceVersion ?? 1,
      evidence.sourceGeneration ?? 0,
    );
    if (existing) continue;
    await s.grantKnowledge({
      branchId,
      characterId: grant.actorId,
      sourceId: evidence.sourceId,
      quote: evidence.quote,
      start: evidence.start,
      end: evidence.end,
      channel: grant.channel,
      automatic: true,
      ...options,
    });
  }
}
/** Persist binding I/O and stop retrying invalid evidence, versions or credentials.
 * https://developers.cloudflare.com/workflows/build/rules-of-workflows/ */
async function durable<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  options: WorkflowStepConfig | (() => Promise<T>),
  callback?: () => Promise<T>,
): Promise<T> {
  const run = typeof options === 'function' ? options : callback!;
  const guarded = async () => {
    try {
      return await run();
    } catch (error) {
      if (
        (error instanceof StoreError && error.status >= 400 && error.status < 500) ||
        (error instanceof ApiError && error.status >= 400 && error.status < 500)
      )
        throw new NonRetryableError(`[${error.code}] ${error.message}`);
      throw error;
    }
  };
  return typeof options === 'function' ? step.do(name, guarded) : step.do(name, options, guarded);
}
async function finishOutbox(
  s: Store,
  p: JobParams,
  status: 'completed' | 'failed',
  message: string | null,
) {
  if (p.outboxId)
    await s.run(
      "UPDATE outbox SET status=?,last_error=?,updated_at=? WHERE id=? AND owner_id=? AND COALESCE(json_extract(payload_json,'$.retryId'),'')=? AND status!='completed'",
      status,
      message,
      now(),
      p.outboxId,
      s.ownerId,
      String(p.retryId ?? ''),
    );
}
export function taskDto(t: TaskRow) {
  return {
    id: t.id,
    taskId: t.id,
    branchId: t.branch_id,
    sessionId: t.session_id,
    status: t.status,
    attempt: t.attempt,
    expectedHead: t.expected_head,
    draftText: t.draft_text,
    error: t.error_json ? JSON.parse(t.error_json) : null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}
function key(owner: string, task: string, attempt: number, file: string) {
  return `tasks/${encodeURIComponent(owner)}/${task}/${attempt}/${file}.json`;
}
async function artifact<T>(env: Env, path: string): Promise<T> {
  const object = await env.BUCKET.get(path);
  if (!object) throw new NonRetryableError('任务产物不存在');
  return object.json<T>();
}
async function put(env: Env, path: string, data: unknown) {
  await env.BUCKET.put(path, JSON.stringify(data), {
    httpMetadata: { contentType: 'application/json' },
  });
  return path;
}
async function getTask(s: Store, p: JobParams) {
  const t = await s.one<TaskRow>(
    'SELECT * FROM tasks WHERE id=? AND owner_id=?',
    p.taskId,
    s.ownerId,
  );
  if (!t) throw new NonRetryableError('任务不存在');
  return t;
}
async function live(s: Store, t: TaskRow) {
  const latest = await getTask(s, { ownerId: s.ownerId, taskId: t.id });
  if (
    ['cancelled', 'failed'].includes(latest.status) ||
    latest.attempt !== t.attempt ||
    latest.cancel_epoch !== t.cancel_epoch
  )
    throw new NonRetryableError('任务已取消或替换');
  return latest;
}
async function writeFence(s: Store, t: TaskRow, epoch: number) {
  const latest = await live(s, t);
  if (latest.status === 'completed' || (await s.ownerEpoch()) !== epoch)
    throw new NonRetryableError('产物来源已失效或任务已结束');
}
async function state(s: Store, t: TaskRow, status: string) {
  await s.run(
    "UPDATE tasks SET status=?,updated_at=? WHERE id=? AND owner_id=? AND attempt=? AND cancel_epoch=? AND status NOT IN ('completed','cancelled','failed')",
    status,
    now(),
    t.id,
    s.ownerId,
    t.attempt,
    t.cancel_epoch,
  );
  await live(s, t);
}
/** Stable IDs plus a D1 lease prevent concurrent API/Cron dispatchers from
 * creating the same Workflow. A crash after create remains recoverable by ID. */
export async function dispatchOutbox(env: Env) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const abandoned = await env.DB.prepare(
    "SELECT * FROM outbox WHERE status='dispatching' AND updated_at<? ORDER BY created_at LIMIT 40",
  )
    .bind(cutoff)
    .all<OutboxRow>();
  for (const row of abandoned.results ?? []) {
    // A crash is not a confirmed creation failure. Refund its claim so a
    // successful create followed by a lost D1 response cannot exhaust retries.
    await env.DB.prepare(
      "UPDATE outbox SET status='pending',attempts=MAX(attempts-1,0),last_error='派发租约已过期，按稳定任务ID恢复',updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='dispatching' AND updated_at<?",
    )
      .bind(now(), row.id, row.owner_id, row.payload_json, cutoff)
      .run();
  }
  const rows = await env.DB.prepare(
    "SELECT * FROM outbox WHERE status='pending' AND attempts<3 ORDER BY created_at LIMIT 40",
  ).all<OutboxRow>();
  for (const row of rows.results ?? []) {
    // Claim before any Workflow binding call. Only the winning dispatcher spends
    // an attempt; owner/payload fences also protect a newly retried intent.
    const claimedAt = now();
    const claimed = await env.DB.prepare(
      "UPDATE outbox SET status='dispatching',attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='pending' AND attempts<3",
    )
      .bind(claimedAt, row.id, row.owner_id, row.payload_json)
      .run();
    if (!claimed.meta.changes) continue;
    let created = false;
    try {
      const payload = JSON.parse(row.payload_json) as JobParams;
      const params = {
        ...payload,
        ownerId: row.owner_id,
        branchId: row.branch_id,
        outboxId: row.id,
      };
      const id = await workflowId(row.id, payload.retryId);
      const workflow = row.kind === 'generation' ? env.GENERATION : env.MEMORY;
      try {
        await workflow.createBatch([{ id, params }]);
      } catch (error) {
        try {
          await (await workflow.get(id)).status();
        } catch {
          throw error;
        }
      }
      created = true;
      await env.DB.prepare(
        "UPDATE outbox SET status='dispatched',last_error=NULL,updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='dispatching' AND updated_at=?",
      )
        .bind(now(), row.id, row.owner_id, row.payload_json, claimedAt)
        .run();
    } catch (error) {
      // Keep the lease if creation succeeded but its D1 acknowledgement failed.
      // The next expired-lease recovery checks the same stable Workflow ID.
      if (created) throw error;
      const failed = await env.DB.prepare(
        "UPDATE outbox SET last_error=?,status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='dispatching' AND updated_at=?",
      )
        .bind(
          errorMessage(error).slice(0, 1000),
          now(),
          row.id,
          row.owner_id,
          row.payload_json,
          claimedAt,
        )
        .run();
      if (failed.meta.changes && row.attempts >= 2) await failDispatchTask(env, row);
    }
  }
  // Repair runtime failures whose workflow reached a terminal error without a final DB update.
  const stalled = await env.DB.prepare(
    "SELECT * FROM outbox WHERE status='dispatched' AND updated_at<? ORDER BY created_at LIMIT 20",
  )
    .bind(cutoff)
    .all<OutboxRow>();
  for (const row of stalled.results ?? []) {
    const payload = JSON.parse(row.payload_json) as JobParams;
    const id = await workflowId(row.id, payload.retryId);
    try {
      if (row.kind === 'generation' && payload.taskId) {
        const task = await env.DB.prepare(
          'SELECT status,attempt FROM tasks WHERE id=? AND owner_id=?',
        )
          .bind(payload.taskId, row.owner_id)
          .first<{ status: string; attempt: number }>();
        if (task && ['completed', 'cancelled'].includes(task.status)) {
          await env.DB.prepare(
            "UPDATE outbox SET status='completed',last_error=NULL,updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='dispatched'",
          )
            .bind(now(), row.id, row.owner_id, row.payload_json)
            .run();
          continue;
        }
      }
      const instance = await (row.kind === 'generation' ? env.GENERATION : env.MEMORY).get(id);
      const status = await instance.status();
      if (['errored', 'terminated', 'complete'].includes(status.status)) {
        await env.DB.prepare(
          "UPDATE outbox SET status='failed',last_error=?,updated_at=? WHERE id=? AND owner_id=? AND payload_json=? AND status='dispatched'",
        )
          .bind(
            `工作流 ${status.status}，请查看并重试`,
            now(),
            row.id,
            row.owner_id,
            row.payload_json,
          )
          .run();
        if (row.kind === 'generation' && payload.taskId)
          await env.DB.prepare(
            "UPDATE tasks SET status='failed',error_json=?,updated_at=? WHERE id=? AND owner_id=? AND attempt=? AND status NOT IN ('completed','cancelled','failed')",
          )
            .bind(
              JSON.stringify({
                code: 'WORKFLOW_STOPPED',
                message: '工作流已停止，草稿保留，可重试',
              }),
              now(),
              payload.taskId,
              row.owner_id,
              Number(payload.attempt ?? 1),
            )
            .run();
      }
    } catch {
      /* transient status query: preserve durable dispatched intent */
    }
  }
}
async function workflowId(outboxId: string, retryId: unknown) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${outboxId}:${retryId ?? ''}`)),
  );
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function failDispatchTask(env: Env, row: OutboxRow) {
  const payload = JSON.parse(row.payload_json) as JobParams;
  if (row.kind !== 'generation' || !payload.taskId) return;
  await env.DB.prepare(
    "UPDATE tasks SET status='failed',error_json=?,updated_at=? WHERE id=? AND owner_id=? AND attempt=? AND status NOT IN ('completed','cancelled','failed') AND EXISTS(SELECT 1 FROM outbox WHERE id=? AND owner_id=? AND payload_json=? AND status='failed')",
  )
    .bind(
      JSON.stringify({
        code: 'WORKFLOW_DISPATCH_FAILED',
        message: '工作流派发失败，草稿保留，可重试',
      }),
      now(),
      payload.taskId,
      row.owner_id,
      Number(payload.attempt ?? 1),
      row.id,
      row.owner_id,
      row.payload_json,
    )
    .run();
}
export class GenerationWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const params = event.payload,
      s = new Store(this.env.DB, params.ownerId);
    let t: TaskRow | undefined;
    try {
      t = await durable(step, 'load generation task', retry, () => getTask(s, params));
      if (t.attempt !== params.attempt || ['cancelled', 'failed', 'completed'].includes(t.status)) {
        await durable(step, 'settle inactive generation', retry, () =>
          finishOutbox(
            s,
            params,
            t!.status === 'failed' && t!.attempt === params.attempt ? 'failed' : 'completed',
            t!.status === 'failed' ? t!.error_json : null,
          ),
        );
        return;
      }
      const task = t;
      for (let wait = 0; wait < 18; wait++) {
        const ready = await durable(step, `tail readiness ${wait}`, retry, async () => {
          await live(s, task);
          const cursor = await s.one<{ seq: number }>(
            "SELECT COALESCE(MAX(applied_seq),0) AS seq FROM memory_cursors WHERE branch_id=? AND extractor_version NOT LIKE '%observer%' AND extractor_version NOT LIKE '%observation%'",
            task.branch_id,
          );
          const pending = await s.getEvents(task.branch_id, {
            afterSeq: cursor?.seq ?? 0,
            limit: 18,
          });
          return pending.length <= 16;
        });
        if (ready) break;
        if (wait === 17) throw new NonRetryableError('必要记忆整理未能完成，请查看后台任务后重试');
        await step.sleep(`wait for memory ${wait}`, '10 seconds');
      }
      const snapshotKey = await durable(step, 'context snapshot', retry, async () => {
        await live(s, task);
        await state(s, task, 'running');
        await publish(this.env, task.branch_id, task.id, task.attempt, 'reset', { text: '' });
        const context = await buildContext(
          this.env,
          s,
          task.branch_id,
          JSON.parse(task.input_json) as TurnInput,
          settingsSchema.parse(JSON.parse(task.config_json)),
          task.command_id,
        );
        if (context.headSeq !== task.expected_head)
          throw new NonRetryableError('剧情已变化，请重新提交');
        await s.run(
          'UPDATE tasks SET context_json=?,updated_at=? WHERE id=? AND attempt=?',
          JSON.stringify({
            tokens: context.tokens,
            budget: context.budget,
            warnings: context.warnings,
            worldbookTriggers: context.worldbookTriggers,
            resources: context.resources,
            memoryIds: context.recall.items.map((i) => i.memory.id),
            procedureIds: context.recall.items
              .filter((i) => i.memory.kind === 'procedure')
              .map((i) => i.memory.id),
          }),
          now(),
          task.id,
          task.attempt,
        );
        const path = await put(this.env, key(s.ownerId, task.id, task.attempt, 'context'), context);
        try {
          await writeFence(s, task, context.ownerEpoch);
        } catch (error) {
          await this.env.BUCKET.delete(path);
          throw error;
        }
        return path;
      });
      await durable(step, 'record retrieved procedures', retry, async () => {
        const context = await artifact<ContextSnapshot>(this.env, snapshotKey);
        await writeFence(s, task, context.ownerEpoch);
        for (const item of context.recall.items.filter(
          (i) => i.memory.kind === 'procedure' && i.memory.status === 'active',
        ))
          await s.useProcedure({
            branchId: task.branch_id,
            procedureId: item.memory.id,
            phase: 'retrieved',
            outcome: 'unknown',
            evidence: [],
            usageKey: task.command_id,
            ownerEpoch: context.ownerEpoch,
            sourceFence: context.sourceFence,
          });
      });
      const narrationKey = await durable(step, 'narration', retry, async () => {
        await live(s, task);
        const saved = key(s.ownerId, task.id, task.attempt, 'narration');
        const previous = await this.env.BUCKET.get(saved);
        if (previous) return saved;
        await s.run(
          "UPDATE tasks SET draft_text='' WHERE id=? AND attempt=? AND status='running'",
          task.id,
          task.attempt,
        );
        await publish(this.env, task.branch_id, task.id, task.attempt, 'reset', { text: '' });
        const context = await artifact<ContextSnapshot>(this.env, snapshotKey);
        const input = JSON.parse(task.input_json) as TurnInput;
        let text = '',
          pending = '',
          lastFlush = 0;
        const controller = new AbortController();
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined,
          heartbeat: Promise<void> | undefined;
        const check = async () => {
          await live(s, task);
        };
        const flush = async (force = false) => {
          if (!pending || (!force && Date.now() - lastFlush < 200)) return;
          await check();
          const chunk = pending;
          pending = '';
          lastFlush = Date.now();
          await s.run(
            "UPDATE tasks SET draft_text=?,updated_at=? WHERE id=? AND attempt=? AND cancel_epoch=? AND status='running'",
            text,
            now(),
            task.id,
            task.attempt,
            task.cancel_epoch,
          );
          await publish(this.env, task.branch_id, task.id, task.attempt, 'delta', { text: chunk });
        };
        heartbeatTimer = setInterval(() => {
          if (!heartbeat)
            heartbeat = check()
              .catch((error) => controller.abort(error))
              .finally(() => {
                heartbeat = undefined;
              });
        }, 1000);
        try {
          if (context.settings.mode === 'local-demo') {
            const name = context.characters[0]?.data.name ?? '叙事者';
            const recalled = context.recall.items
              .filter((i) => i.memory.kind !== 'observation')
              .slice(0, 2)
              .map((i) => i.memory.text)
              .join('；');
            const demo = `【本地流程演示 · 未调用远程模型】\n\n${name}停下脚步，留意你说的“${input.text}”。${recalled ? `你们此前记下的线索仍然有效：${recalled}` : '此刻的故事尚未建立长期线索。'}\n\n下一步仍由你决定。`;
            for (const chunk of demo.match(/.{1,20}/gs) ?? []) {
              text += chunk;
              pending += chunk;
              await flush();
            }
            await flush(true);
          } else {
            await publish(this.env, task.branch_id, task.id, task.attempt, 'reset', { text: '' });
            text = await complete(this.env, context.settings, context.messages, {
              signal: controller.signal,
              onText: async (chunk) => {
                text += chunk;
                pending += chunk;
                await flush();
              },
            });
            await flush(true);
          }
          await check();
          await put(this.env, saved, { text });
          try {
            await writeFence(s, task, context.ownerEpoch);
          } catch (error) {
            await this.env.BUCKET.delete(saved);
            throw error;
          }
          return saved;
        } catch (error) {
          await flush(true).catch(() => undefined);
          if (error instanceof ApiError && [401, 403, 422].includes(error.status))
            throw new NonRetryableError(error.message);
          throw error;
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          await heartbeat;
        }
      });
      const extractionKey = await durable(step, 'validate narrative', retry, async () => {
        await state(s, task, 'validating');
        const context = await artifact<ContextSnapshot>(this.env, snapshotKey),
          narration = await artifact<{ text: string }>(this.env, narrationKey),
          input = JSON.parse(task.input_json) as TurnInput;
        let decisionAudit: ExtractionDecisionAudit | undefined;
        const controller = new AbortController();
        let heartbeat: Promise<void> | undefined;
        const heartbeatTimer = setInterval(() => {
          if (!heartbeat)
            heartbeat = writeFence(s, task, context.ownerEpoch)
              .catch((error) => controller.abort(error))
              .finally(() => {
                heartbeat = undefined;
              });
        }, 1000);
        const saveAudit = async () => {
          if (!decisionAudit) return;
          const audit = decisionAudit;
          decisionAudit = undefined;
          const path = await put(
            this.env,
            key(s.ownerId, task.id, task.attempt, 'decision'),
            audit,
          );
          try {
            await writeFence(s, task, context.ownerEpoch);
          } catch (error) {
            await this.env.BUCKET.delete(path);
            throw error;
          }
        };
        try {
          const data = await analyze(this.env, context, input, narration.text, {
            onDecision: (audit) => {
              decisionAudit = audit;
            },
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          await writeFence(s, task, context.ownerEpoch);
          await saveAudit();
          const path = await put(this.env, key(s.ownerId, task.id, task.attempt, 'extraction'), {
            input,
            extraction: data,
          });
          try {
            await writeFence(s, task, context.ownerEpoch);
          } catch (error) {
            await this.env.BUCKET.delete(path);
            throw error;
          }
          return path;
        } catch (error) {
          // The callback only captures metadata. Both successful and rejected
          // judgments are persisted by this awaited durable callback, with the
          // same source/cancel fence and cache destruction as extraction data.
          await saveAudit();
          if (error instanceof ApiError && error.status === 422)
            throw new NonRetryableError(error.message);
          throw error;
        } finally {
          clearInterval(heartbeatTimer);
          await heartbeat;
        }
      });
      await durable(step, 'commit narrative', retry, async () => {
        const current = await live(s, task);
        if (current.status === 'completed') return;
        await state(s, task, 'committing');
        const context = await artifact<ContextSnapshot>(this.env, snapshotKey),
          narration = await artifact<{ text: string }>(this.env, narrationKey),
          data = await artifact<{ input: TurnInput; extraction: Extraction }>(
            this.env,
            extractionKey,
          );
        const stub = this.env.BRANCH_RUNTIME.get(
          this.env.BRANCH_RUNTIME.idFromName(task.branch_id),
        );
        const turn = {
          branchId: task.branch_id,
          sessionId: task.session_id,
          requestId: task.command_id,
          expectedHead: task.expected_head,
          ownerEpoch: context.ownerEpoch,
          sourceFence: context.sourceFence,
          taskFence: { taskId: task.id, attempt: task.attempt, cancelEpoch: task.cancel_epoch },
          scene: { ...context.branch.scene, ...data.extraction.scene },
          messages: [
            {
              role: data.input.mode === 'author' ? 'correction' : 'user',
              text: data.input.text,
              speakerId: data.input.actorId,
              knownBy: [],
            },
            { role: 'assistant', text: narration.text, knownBy: [] },
          ],
        };
        const response = await stub.fetch('https://runtime/commit', {
          method: 'POST',
          body: JSON.stringify({ ownerId: s.ownerId, turn }),
        });
        if (!response.ok) throw new NonRetryableError('提交版本冲突或来源已失效，草稿已保留');
        await publish(this.env, task.branch_id, task.id, task.attempt, 'terminal', {
          status: 'completed',
          text: narration.text,
        });
      });
      // API polling and Cron dispatch the durable outbox from a Worker request;
      // spawning a Workflow from inside a Workflow breaks local request ownership.
      await durable(step, 'complete generation intent', retry, () =>
        finishOutbox(s, params, 'completed', null),
      );
    } catch (error) {
      const terminal = await durable(step, 'persist generation failure', retry, async () => {
        const current = await s.one<TaskRow>(
          'SELECT * FROM tasks WHERE id=? AND owner_id=?',
          params.taskId,
          s.ownerId,
        );
        if (
          current &&
          current.attempt === params.attempt &&
          !['completed', 'cancelled'].includes(current.status) &&
          (!t || current.cancel_epoch === t.cancel_epoch)
        )
          await s.run(
            "UPDATE tasks SET status='failed',error_json=?,updated_at=? WHERE id=? AND owner_id=? AND attempt=? AND cancel_epoch=? AND status NOT IN ('completed','cancelled')",
            JSON.stringify({
              code: 'GENERATION_FAILED',
              message: errorMessage(error).slice(0, 1200),
            }),
            now(),
            current.id,
            s.ownerId,
            current.attempt,
            current.cancel_epoch,
          );
        const latest = current ? await getTask(s, params) : null,
          settled =
            latest &&
            (['completed', 'cancelled'].includes(latest.status) ||
              latest.attempt !== params.attempt ||
              (t && latest.cancel_epoch !== t.cancel_epoch));
        await finishOutbox(
          s,
          params,
          settled ? 'completed' : 'failed',
          settled ? null : errorMessage(error).slice(0, 1000),
        );
        return latest && latest.attempt === params.attempt && latest.status === 'failed'
          ? {
              id: latest.id,
              branchId: latest.branch_id,
              attempt: latest.attempt,
              draft: latest.draft_text,
            }
          : null;
      });
      if (terminal)
        await durable(step, 'publish generation failure', retry, () =>
          publish(this.env, terminal.branchId, terminal.id, terminal.attempt, 'terminal', {
            status: 'failed',
            text: terminal.draft,
            error: { message: errorMessage(error).slice(0, 1200) },
          }),
        );
      throw error;
    }
  }
}
export class MemoryWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const p = event.payload,
      s = new Store(this.env.DB, p.ownerId);
    try {
      const row = await durable(step, 'load memory job', retry, async () =>
        p.outboxId
          ? await s.one<OutboxRow>(
              'SELECT * FROM outbox WHERE id=? AND owner_id=?',
              p.outboxId,
              s.ownerId,
            )
          : null,
      );
      if (
        !row ||
        row.status === 'completed' ||
        String((JSON.parse(row.payload_json) as JobParams).retryId ?? '') !==
          String(p.retryId ?? '')
      )
        return;
      const payload = JSON.parse(row.payload_json) as JobParams;
      if (row.kind.includes('delete') || row.kind.includes('cleanup')) {
        await durable(step, 'cleanup projections', retry, () =>
          cleanup(this.env, s, p.branchId ?? '', payload),
        );
      } else if (row.kind.includes('index')) {
        await durable(step, 'index projections', retry, async () => {
          if ((await modelSettings(s, this.env.MODEL_MODE)).mode !== 'local-demo')
            await indexMemories(this.env, s, p.branchId!);
        });
      } else if (payload.rebuild) {
        const target = await durable(step, 'load rebuild target', retry, async () => ({
          through: Number(payload.throughSeq ?? (await s.getBranch(p.branchId!)).headSeq),
          epoch: Number(payload.ownerEpoch ?? (await s.ownerEpoch())),
        }));
        await replayBranch(this.env, s, p.branchId!, target.through, target.epoch, step, row.id);
      } else {
        const preparedKey = await durable(step, 'prepare extraction', retry, async () => {
          const through = Number(
            p.throughSeq ??
              p.cursor ??
              payload.throughSeq ??
              payload.cursor ??
              (await s.getBranch(p.branchId!)).headSeq,
          );
          const selectedIds = Array.isArray(payload.eventIds)
            ? (payload.eventIds as string[])
            : undefined;
          const events = (
            await s.getEvents(p.branchId!, {
              asOfSeq: through,
              limit: 2000,
              afterSeq: Math.max(-1, through - 1999),
            })
          ).filter((e) => !selectedIds || selectedIds.includes(e.id));
          if (!events.length) {
            if (
              typeof payload.ownerEpoch === 'number' &&
              (await s.ownerEpoch()) !== payload.ownerEpoch
            )
              throw new NonRetryableError('来源已失效');
            return put(this.env, `jobs/${row.id}/prepared.json`, {
              events: [],
              extraction: null,
              through,
            });
          }
          let extraction: Extraction | undefined,
            input: TurnInput = {
              mode: 'roleplay',
              text: events.find((e) => e.role === 'user')?.text ?? '',
            };
          if (payload.taskId) {
            const saved = await this.env.BUCKET.get(
              key(s.ownerId, String(payload.taskId), Number(payload.attempt ?? 1), 'extraction'),
            );
            if (saved) {
              const parsed = await saved.json<{ input: TurnInput; extraction: Extraction }>();
              input = parsed.input;
              extraction = extractionSchema.parse(parsed.extraction);
            }
          }
          if (!extraction) {
            // Imported/corrected events still pass the same controlled evidence path.
            extraction = extractionSchema.parse({
              scene: {},
              facts: events.map((e) => ({
                kind: 'episode',
                subject: e.speakerId ?? 'narrator',
                predicate: 'episode',
                value: e.text,
                text: e.text,
                evidence: [
                  { source: e.role === 'assistant' ? 'assistant' : 'user', quote: e.text },
                ],
                knownBy: e.knownBy,
              })),
            });
            // Corrections are already handled by their explicit authoritative version API.
            extraction.facts = extraction.facts.filter((f) =>
              events.some((e) => e.role !== 'correction' && e.text === f.evidence[0]?.quote),
            );
          }
          const resolved = await resolveMemoryEntities(s, p.branchId!, extraction, events, [], {
            ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
          });
          extraction = resolved.extraction;
          knowledgeGrantsFor(extraction, events, resolved.entities);
          const path = await put(this.env, `jobs/${row.id}/prepared.json`, {
            events,
            extraction,
            input,
            through,
            rejectedFacts: resolved.rejectedFacts,
          });
          if (
            typeof payload.ownerEpoch === 'number' &&
            (await s.ownerEpoch()) !== payload.ownerEpoch
          ) {
            await this.env.BUCKET.delete(path);
            throw new NonRetryableError('来源已失效，请重新整理');
          }
          return path;
        });
        await durable(step, 'commit atomic facts', retry, async () => {
          const data = await artifact<{
            events: Event[];
            extraction: Extraction | null;
            input: TurnInput;
            through: number;
            rejectedFacts?: RejectedEntityFact[];
          }>(this.env, preparedKey);
          if (!data.extraction) return;
          const grants = knowledgeGrantsFor(
            data.extraction,
            data.events,
            await listEntities(s, p.branchId!, data.through),
          );
          const proposals = [
            ...memoryProposals(data.extraction, data.events, data.input.mode),
            ...entityReviewProposals(data.rejectedFacts ?? [], data.events),
          ];
          await applyAutomaticKnowledge(s, p.branchId!, grants, ['facts'], {
            ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
            sourceFence: payload.sourceFence as never,
          });
          await s.extract(p.branchId!, {
            eventIds: data.events.map((e) => e.id),
            proposals,
            cursor: data.through,
            sourceFence: (payload.sourceFence ?? []) as Parameters<
              Store['extract']
            >[1]['sourceFence'],
            ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
            extractorVersion: 'v3-facts',
          });
        });
        await durable(step, 'learn experiences', retry, async () => {
          const data = await artifact<{
            events: Event[];
            extraction: Extraction | null;
            through: number;
          }>(this.env, preparedKey);
          if (!data.extraction) return;
          const grants = knowledgeGrantsFor(
            data.extraction,
            data.events,
            await listEntities(s, p.branchId!, data.through),
          );
          await applyAutomaticKnowledge(s, p.branchId!, grants, ['experiences', 'capabilities'], {
            ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
            sourceFence: payload.sourceFence as never,
          });
          await syncPersonaCapabilities(
            s,
            p.branchId!,
            data.through,
            typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
          );
          for (const capability of data.extraction.capabilities) {
            const evidence = capability.evidence.map((e) => evidenceFor(e, data.events));
            await s.addCapability({
              branchId: p.branchId!,
              actorId: capability.actorId,
              name: capability.name,
              level: capability.level,
              ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
              sourceFence: payload.sourceFence as never,
              evidence,
            });
          }
          for (const experience of data.extraction.experiences) {
            const evidence = experience.evidence.map((e) => evidenceFor(e, data.events));
            await s.addExperience({
              ...experience,
              branchId: p.branchId!,
              evidence,
              ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
              sourceFence: payload.sourceFence as never,
              originSeq: Math.max(...data.events.map((e) => e.seq)),
            });
          }
          for (const usage of data.extraction.procedureUses)
            await s.useProcedure({
              ...usage,
              branchId: p.branchId!,
              ownerEpoch: typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
              sourceFence: payload.sourceFence as never,
              evidence: usage.evidence.map((e) => evidenceFor(e, data.events)),
            });
        });
        await durable(step, 'observe and reflect', retry, async () => {
          const data = await artifact<{ through: number; events: Event[] }>(this.env, preparedKey);
          await observe(
            this.env,
            s,
            p.branchId!,
            data.through,
            typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined,
          );
        });
        await durable(step, 'index projections', retry, async () => {
          const settings = await modelSettings(s, this.env.MODEL_MODE);
          if (settings.mode !== 'local-demo') await indexMemories(this.env, s, p.branchId!);
        });
      }
      await durable(step, 'complete memory job', retry, () =>
        finishOutbox(s, p, 'completed', null),
      );
    } catch (error) {
      await durable(step, 'persist memory failure', retry, () =>
        finishOutbox(s, p, 'failed', errorMessage(error).slice(0, 1000)),
      );
      throw error;
    }
  }
}
/** Replays source-prefix turns, not the parent's present-day projection. Each turn is a durable idempotent step. */
async function replayBranch(
  env: Env,
  s: Store,
  branchId: string,
  through: number,
  epoch: number,
  step: WorkflowStep,
  jobId: string,
) {
  const extractorVersion = `v3-rebuild:${jobId}`;
  const { branch, settings } = JSON.parse(
    await durable(step, 'load rebuild configuration', retry, async () =>
      JSON.stringify({
        branch: await s.getBranch(branchId),
        settings: await modelSettings(s, env.MODEL_MODE),
      }),
    ),
  ) as { branch: ContextSnapshot['branch']; settings: ContextSnapshot['settings'] };
  await durable(step, 'rebuild initial persona', retry, async () => {
    await syncPersonaCapabilities(s, branchId, 0, epoch);
  });
  let after = 0;
  while (after < through) {
    const page = await durable(step, `load rebuild page ${after}`, retry, async () => {
      const events = await s.getEvents(branchId, {
        afterSeq: after,
        asOfSeq: through,
        limit: 1000,
      });
      if (!events.length) return [];
      return s.all<{
        request_id: string;
        branch_id: string;
        first_seq: number;
        last_seq: number;
        max_seq: number | null;
        task_id: string | null;
        task_attempt: number | null;
      }>(
        `SELECT t.request_id,t.branch_id,t.first_seq,t.last_seq,l.max_seq,t.task_id,t.task_attempt FROM turns t JOIN branch_lineage l ON l.ancestor_id=t.branch_id AND l.branch_id=? WHERE t.owner_id=? AND t.first_seq>? AND t.first_seq<=? AND (l.max_seq IS NULL OR t.first_seq<=l.max_seq) ORDER BY t.first_seq`,
        branchId,
        s.ownerId,
        after,
        events.at(-1)!.seq,
      );
    });
    const rows = page;
    if (!rows.length) break;
    for (const turn of rows) {
      const seq = Math.min(through, turn.last_seq, turn.max_seq ?? Infinity);
      await durable(step, `replay ${turn.first_seq}-${seq}`, retry, async () => {
        if ((await s.ownerEpoch()) !== epoch)
          throw new NonRetryableError('重建来源已变化，请重新开始整理');
        const events = (
          await s.getEvents(branchId, { afterSeq: turn.first_seq - 1, asOfSeq: seq, limit: 20 })
        ).filter((e) => e.branchId === turn.branch_id && !e.deleted && e.text);
        const suppressed = await s.forgottenSpans(branchId);
        if (events.some((e) => suppressed.some((p) => p.sourceId === e.sourceId))) {
          await s.extract(branchId, {
            eventIds: events.map((e) => e.id),
            proposals: [],
            cursor: seq,
            ownerEpoch: epoch,
            extractorVersion,
          });
          return;
        }
        if (!events.length) {
          await s.extract(branchId, {
            eventIds: [],
            proposals: [],
            cursor: seq,
            ownerEpoch: epoch,
            extractorVersion,
          });
          return;
        }
        let extraction: Extraction | undefined,
          input: TurnInput = {
            mode: events.some((e) => e.role === 'correction') ? 'author' : 'roleplay',
            text: events.find((e) => e.role === 'user' || e.role === 'correction')?.text ?? '',
          };
        if (turn.task_id && seq === turn.last_seq) {
          const saved = await env.BUCKET.get(
            key(s.ownerId, turn.task_id, turn.task_attempt ?? 1, 'extraction'),
          );
          if (saved) {
            const data = await saved.json<{ input: TurnInput; extraction: Extraction }>();
            input = data.input;
            extraction = extractionSchema.parse(data.extraction);
          }
        }
        if (!extraction) {
          const resources = await s.getResourceBindings(branchId, seq),
            characters: ContextSnapshot['characters'] = [];
          for (const binding of resources.filter((r) => r.kind === 'character')) {
            const asset = await s.one<{ data_json: string }>(
              'SELECT r.data_json FROM asset_revisions r JOIN assets a ON a.id=r.asset_id WHERE r.asset_id=? AND r.revision=? AND a.owner_id=?',
              binding.assetId,
              binding.revision,
              s.ownerId,
            );
            if (asset)
              characters.push({
                id: binding.assetId,
                revision: binding.revision,
                data: JSON.parse(asset.data_json),
              });
          }
          const recall = {
            items: [],
            tokens: 0,
            visited: 0,
            truncated: false,
            degraded: [],
            cursor: 0,
          };
          const context: ContextSnapshot = {
            branch: { ...branch, headSeq: seq, scene: await s.sceneAsOf(branchId, seq) },
            settings,
            characters,
            resources,
            recall,
            entities: await listEntities(s, branchId, seq),
            messages: [],
            ownerEpoch: epoch,
            sourceFence: [],
            tokens: 0,
            budget: 32768,
            worldbookTriggers: {
              activated: [],
              skipped: [],
              tokens: 0,
              rounds: 0,
            } as unknown as ContextSnapshot['worldbookTriggers'],
            headSeq: seq,
            warnings: [],
          };
          const narration = events
            .filter((e) => e.role === 'assistant')
            .map((e) => e.text)
            .join('\n');
          if (narration) extraction = await analyze(env, context, input, narration);
          else extraction = extractionSchema.parse({ scene: context.branch.scene, facts: [] });
        }
        await syncPersonaCapabilities(s, branchId, seq, epoch);
        const resolution = await resolveMemoryEntities(s, branchId, extraction, events, [], {
          ownerEpoch: epoch,
          asOfSeq: seq,
        });
        extraction = resolution.extraction;
        const grants = knowledgeGrantsFor(extraction, events, resolution.entities);
        const sourceFence = [];
        for (const event of events) {
          const source = await s.source(event.sourceId);
          sourceFence.push({
            sourceId: event.sourceId,
            version: Number(source.version),
            generation: Number(source.generation),
          });
        }
        const proposals = [];
        for (const proposal of memoryProposals(extraction, events, input.mode))
          proposals.push({
            ...proposal,
            idempotencyKey: `rebuild:${await digest({ jobId, original: proposal.idempotencyKey })}`,
          });
        proposals.push(...entityReviewProposals(resolution.rejectedFacts, events));
        await applyAutomaticKnowledge(
          s,
          branchId,
          grants,
          ['facts', 'experiences', 'capabilities'],
          {
            ownerEpoch: epoch,
            sourceFence,
          },
        );
        await s.extract(branchId, {
          eventIds: events.map((e) => e.id),
          proposals,
          cursor: seq,
          extractorVersion,
          ownerEpoch: epoch,
          sourceFence,
        });
        for (const c of extraction.capabilities) {
          const evidence = c.evidence.map((e) => evidenceFor(e, events));
          await s.addCapability({
            branchId,
            actorId: c.actorId,
            name: c.name,
            level: c.level,
            evidence,
            ownerEpoch: epoch,
            sourceFence,
          });
        }
        for (const exp of extraction.experiences) {
          const evidence = exp.evidence.map((e) => evidenceFor(e, events));
          await s.addExperience({
            ...exp,
            branchId,
            evidence,
            originSeq: seq,
            ownerEpoch: epoch,
            sourceFence,
          });
        }
        return { through: seq };
      });
      after = seq;
    }
  }
  await durable(step, 'rebuild observations', retry, () =>
    observe(env, s, branchId, through, epoch),
  );
  await durable(step, 'rebuild semantic index', retry, async () => {
    if (settings.mode !== 'local-demo') await indexMemories(env, s, branchId);
  });
}
async function modelSettings(s: Store, mode: string) {
  const row = await s.one<{ data_json: string }>(
    'SELECT data_json FROM model_settings WHERE owner_id=?',
    s.ownerId,
  );
  return row ? settingsSchema.parse(JSON.parse(row.data_json)) : defaults(mode);
}
async function observe(env: Env, s: Store, branchId: string, through: number, ownerEpoch?: number) {
  const branch = await s.getBranch(branchId);
  if (through > branch.headSeq) return;
  const story = await s.getStory(branch.storyId);
  const settings = await modelSettings(s, env.MODEL_MODE);
  for (const viewer of ['director', ...story.characterIds]) {
    const records = await s.memories(branchId, { viewer, asOfSeq: through, limit: 1000 });
    for (const bucket of ['rules', 'facts', 'interpretations']) {
      const atomic = records.filter(
        (m) =>
          !['observation', 'experience'].includes(m.kind) &&
          m.status === 'active' &&
          (m.authority! >= 85
            ? 'rules'
            : ['canon', 'relation'].includes(m.kind) && m.authority! >= 70
              ? 'facts'
              : 'interpretations') === bucket,
      );
      if (!atomic.length) continue;
      const previous = records.filter(
        (m) => m.kind === 'observation' && m.subject === viewer && m.status === 'active',
      );
      const references: typeof atomic = [];
      const proofKeys = new Set<string>();
      for (const m of atomic) {
        const keys = m.evidence.map((e) => `${e.sourceId}:${e.start}:${e.end}`);
        if (new Set([...proofKeys, ...keys]).size > 32) continue;
        keys.forEach((k) => proofKeys.add(k));
        references.push(m);
        if (references.length >= 28) break;
      }
      if (!references.length) continue;
      const critical = references
        .filter((m) => m.kind === 'canon' || m.kind === 'procedure' || m.kind === 'relation')
        .map((m) => m.id);
      let text = references.map((m) => `[${m.id}] ${m.kind} · ${m.text}`).join('\n');
      if (estimateAssetTokens(text) > 4000 && settings.mode !== 'local-demo') {
        const result = parseJson(
          await complete(
            env,
            settings,
            [
              {
                role: 'system',
                content:
                  '你是观察压缩器。只返回JSON {text,retainedMemoryIds}。保留当前状态、承诺、未完成剧情、关系变化、关键限制和技能适用条件；不能把猜测改成事实。必须保留所有critical IDs，不得新增不存在ID，正文不能为空。',
              },
              {
                role: 'user',
                content: JSON.stringify({ observations: text, critical, tokenBudget: 4000 }),
              },
            ],
            { json: true, auxiliary: true },
          ),
        ) as { text?: string; retainedMemoryIds?: string[] };
        if (
          !result.text?.trim() ||
          critical.some((id) => !result.retainedMemoryIds?.includes(id)) ||
          result.retainedMemoryIds?.some((id) => !references.some((m) => m.id === id))
        )
          throw new Error('反思覆盖校验失败，旧原文和观察保留');
        if (estimateAssetTokens(result.text) > 4000) throw new Error('反思结果超预算');
        text = result.text;
      }
      const evidence = [
        ...new Map(
          references
            .flatMap((m) => m.evidence)
            .map((e) => [`${e.sourceId}:${e.start}:${e.end}`, e]),
        ).values(),
      ];
      const proposal: MemoryProposal = {
        kind: 'observation',
        subject: viewer,
        predicate: `rolling-observation:${bucket}`,
        value: text,
        text,
        evidence,
        knownBy: viewer === 'director' ? [] : [viewer],
        authority: 20,
        confidence: 0.5,
        originSeq: through,
        memoryKey: `observation:${viewer}:${bucket}`,
        idempotencyKey: `observation:${viewer}:${bucket}:${through}:${await digest(references.map((m) => m.id))}`,
        data: {
          bucket,
          memoryIds: references.map((m) => m.id),
          coverage: critical,
          throughSeq: through,
        },
      };
      await s.activateObservation({
        branchId,
        cursor: through,
        ownerEpoch,
        expectedMemoryIds: references.map((m) => m.id),
        proposals: [proposal],
        extractorVersion: `v3-observer:${viewer}:${bucket}`,
      });
    }
  }
}
async function cleanup(env: Env, s: Store, branchId: string, p: JobParams) {
  await cleanDeletedVectors(env, s);
  const ids = Array.isArray(p.memoryIds) ? (p.memoryIds as string[]) : [];
  if (branchId) await deleteMemoryVectors(env, s, branchId, ids);
  if (Array.isArray(p.r2Keys))
    for (const path of p.r2Keys) {
      if (typeof path === 'string') await env.BUCKET.delete(path);
    }
  // Source deletion also scrubs already-created task artifacts and draft/context copies.
  const deleted = await s.all<{ id: string; branch_id: string; deleted_at: string }>(
    "SELECT id,branch_id,deleted_at FROM sources WHERE owner_id=? AND status='deleted'",
    s.ownerId,
  );
  if (deleted.length) {
    const tasks = await s.all<TaskRow>('SELECT * FROM tasks WHERE owner_id=?', s.ownerId);
    for (const task of tasks) {
      if (!deleted.some((d) => d.deleted_at >= task.created_at)) continue;
      const prefix = `tasks/${encodeURIComponent(s.ownerId)}/${task.id}/`;
      let cursor: string | undefined;
      do {
        const list = await env.BUCKET.list({ prefix, cursor });
        if (list.objects.length) await env.BUCKET.delete(list.objects.map((o) => o.key));
        cursor = list.truncated ? list.cursor : undefined;
      } while (cursor);
      await s.run(
        "UPDATE tasks SET draft_text='',input_json='{}',context_json='{}',error_json=NULL WHERE id=? AND owner_id=?",
        task.id,
        s.ownerId,
      );
      const stub = env.BRANCH_RUNTIME.getByName(task.branch_id);
      await stub.fetch('https://runtime/clear', {
        method: 'POST',
        body: JSON.stringify({ taskIds: [task.id] }),
      });
    }
  }
  if (deleted.length) {
    const deletedBefore = deleted
      .map((d) => d.deleted_at)
      .sort()
      .at(-1)!;
    const jobs = await s.all<{ id: string }>(
      'SELECT id FROM outbox WHERE owner_id=? AND created_at<=?',
      s.ownerId,
      deletedBefore,
    );
    for (const job of jobs) await env.BUCKET.delete(`jobs/${job.id}/prepared.json`);
  }
}
