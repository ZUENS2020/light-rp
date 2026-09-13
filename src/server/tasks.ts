import {
  OUTPUT_CHANNEL_CONTRACT,
  affinityKey,
  sha256,
  stableStringify,
  type AiModelConfig,
  type AiUsage,
  type ResponseCacheStatus,
} from "../core/ai";
import { DEFAULT_CONTEXT, estimateTokens } from "../core/budget";
import { nowIso } from "../core/util";
import { resolveSessionModel, sessionRuntime } from "./models";
import { MAX_GENERATION_ATTEMPTS, recoverGenerationTasks } from "./generation-recovery";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "dead";
export type TaskKind = "turn" | "regenerate" | "rewrite" | "compact" | "summary" | "memory" | "probe";

export type GenerationTaskRow = {
  id: string;
  workspace_id: string;
  world_id: string;
  session_id: string;
  kind: TaskKind;
  idempotency_key: string;
  user_text: string;
  target_message_id: string | null;
  status: TaskStatus;
  model_snapshot_json: string;
  request_hash: string | null;
  response_cache_status: ResponseCacheStatus;
  prompt_tokens: number;
  cached_input_tokens: number;
  stable_prefix_tokens: number;
  volatile_tokens: number;
  output_contract_tokens: number;
  nmem_sync_status: "not_requested" | "pending" | "running" | "completed" | "failed" | "dead";
  nmem_synced_at: string | null;
  nmem_error: string | null;
  nmem_memory_count: number;
  nmem_recall_count: number;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  result_message_id: string | null;
  result_content: string | null;
  content: string | null;
  error_code: string | null;
  error_message: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type TaskCompletion = {
  content: string;
  includeInPrompt?: boolean;
  hiddenEvents?: Array<{
    kind: "context" | "memory";
    content: string;
    hashSeed?: string;
  }>;
  rotatePromptEpochReason?: "context_compacted";
  requestHash?: string;
  cacheStatus?: ResponseCacheStatus;
  usage?: AiUsage;
  stablePrefixTokens?: number;
  volatileTokens?: number;
};

const TASK_COLUMNS = `id, workspace_id, workspace_id AS world_id, session_id, kind, idempotency_key,
  COALESCE(user_text, '') AS user_text, target_message_id, status, model_snapshot_json, request_hash,
  response_cache_status, prompt_tokens, cached_input_tokens, stable_prefix_tokens, volatile_tokens,
  output_contract_tokens, attempt_count, lease_owner, lease_expires_at, result_message_id,
  nmem_sync_status, nmem_synced_at, nmem_error, nmem_memory_count, nmem_recall_count,
  result_content, result_content AS content, error_code, error_message, error_message AS error,
  created_at, updated_at, completed_at`;

export class ActiveTaskConflict extends Error {
  constructor(readonly task: GenerationTaskRow) {
    super("已有生成任务进行中");
    this.name = "ActiveTaskConflict";
  }
}

export async function getTask(db: D1Database, id: string): Promise<GenerationTaskRow | null> {
  return (
    (await db
      .prepare(`SELECT ${TASK_COLUMNS} FROM generation_tasks WHERE id = ?`)
      .bind(id)
      .first<GenerationTaskRow>()) || null
  );
}

export async function getTaskByIdempotency(
  db: D1Database,
  sessionId: string,
  key: string,
): Promise<GenerationTaskRow | null> {
  return (
    (await db
      .prepare(`SELECT ${TASK_COLUMNS} FROM generation_tasks WHERE session_id = ? AND idempotency_key = ?`)
      .bind(sessionId, key)
      .first<GenerationTaskRow>()) || null
  );
}

export async function getActiveTask(
  db: D1Database,
  workspaceId: string,
  sessionId: string,
): Promise<GenerationTaskRow | null> {
  return (
    (await db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM generation_tasks
         WHERE workspace_id = ? AND session_id = ? AND status IN ('pending', 'running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, sessionId)
      .first<GenerationTaskRow>()) || null
  );
}

export async function createTurnTask(
  db: D1Database,
  input: {
    workspaceId: string;
    sessionId: string;
    text: string;
    idempotencyKey: string;
    kind?: TaskKind;
    targetMessageId?: string | null;
  },
): Promise<{ task: GenerationTaskRow; duplicate: boolean; userMessageId: string }> {
  const duplicate = await getTaskByIdempotency(db, input.sessionId, input.idempotencyKey);
  if (duplicate) return { task: duplicate, duplicate: true, userMessageId: "" };
  const active = await getActiveTask(db, input.workspaceId, input.sessionId);
  if (active) throw new ActiveTaskConflict(active);
  const runtime = await sessionRuntime(db, input.sessionId);
  if (runtime.workspace_id !== input.workspaceId) throw new Error("session/workspace mismatch");
  const model = await resolveSessionModel(db, input.sessionId);
  if (!model.enabled) throw new Error(`model '${model.label}' is disabled`);
  const taskId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const ts = nowIso();
  const snapshot = stableStringify(model);
  const kind = input.kind || "turn";
  const statements = [
    db
      .prepare(
        `INSERT INTO messages (id, session_id, sequence, role, content, client_message_id, task_id, created_at)
         SELECT ?, id, next_message_sequence, 'user', ?, ?, ?, ? FROM sessions WHERE id = ?`,
      )
      .bind(userMessageId, input.text, input.idempotencyKey, taskId, ts, input.sessionId),
    db
      .prepare(
        `INSERT INTO generation_tasks (
           id, workspace_id, session_id, kind, idempotency_key, user_text, target_message_id, status,
           model_snapshot_json, output_contract_tokens, nmem_sync_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'not_requested', ?, ?)`,
      )
      .bind(
        taskId,
        input.workspaceId,
        input.sessionId,
        kind,
        input.idempotencyKey,
        input.text,
        input.targetMessageId || null,
        snapshot,
        estimateTokens(OUTPUT_CHANNEL_CONTRACT),
        ts,
        ts,
      ),
    db
      .prepare(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload_json, created_at)
         VALUES (?, 'generation_task', ?, 'generation.requested', ?, ?)`,
      )
      .bind(
        outboxId,
        taskId,
        stableStringify({ taskId, workspaceId: input.workspaceId, sessionId: input.sessionId }),
        ts,
      ),
    db
      .prepare(
        `UPDATE sessions
         SET next_message_sequence = next_message_sequence + 1,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(ts, input.sessionId),
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    const racedDuplicate = await getTaskByIdempotency(db, input.sessionId, input.idempotencyKey);
    if (racedDuplicate) return { task: racedDuplicate, duplicate: true, userMessageId: "" };
    const racedActive = await getActiveTask(db, input.workspaceId, input.sessionId);
    if (racedActive) throw new ActiveTaskConflict(racedActive);
    throw error;
  }
  const task = await getTask(db, taskId);
  if (!task) throw new Error("generation task transaction did not commit");
  return { task, duplicate: false, userMessageId };
}

export async function insertPending(
  db: D1Database,
  input: {
    id: string;
    worldId: string;
    sessionId: string;
    userText: string;
    idempotencyKey?: string;
    model?: AiModelConfig;
  },
): Promise<void> {
  const ts = nowIso();
  const model = input.model || (await resolveSessionModel(db, input.sessionId));
  await db
    .prepare(
      `INSERT INTO generation_tasks (
         id, workspace_id, session_id, kind, idempotency_key, user_text, status,
         model_snapshot_json, output_contract_tokens, nmem_sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, 'turn', ?, ?, 'pending', ?, ?, 'not_requested', ?, ?)`,
    )
    .bind(
      input.id,
      input.worldId,
      input.sessionId,
      input.idempotencyKey || input.id,
      input.userText,
      stableStringify(model),
      estimateTokens(OUTPUT_CHANNEL_CONTRACT),
      ts,
      ts,
    )
    .run();
}


/** How many tip user/assistant turns to re-seed into llm_events after epoch rotate. */
const TRANSCRIPT_RESEED_EVENTS = Math.max(20, DEFAULT_CONTEXT.history.protect_recent_turns * 2);

/**
 * Replace D1 messages projection after rewrite/regenerate, rotate prompt epoch, and
 * re-seed the truncated transcript tip into llm_events so preparePrompt still sees dorm/scene
 * context (DELETE alone left the AI path with only stale summary/memory).
 * Trailing user is omitted from llm_events — preparePrompt appends the current task user.
 */
export async function replaceSessionTranscriptProjection(
  db: D1Database,
  sessionId: string,
  messages: Array<{ role: string; content: string; task_id?: string; ts?: string }>,
  reason = "transcript_edited",
): Promise<void> {
  const projected = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const runtime = await sessionRuntime(db, sessionId);
  const model = await resolveSessionModel(db, sessionId);
  const nextEpoch = runtime.prompt_epoch + 1;
  const nextAffinity = await affinityKey(sessionId, model, nextEpoch);
  const ts = nowIso();
  let seed = projected.slice(-TRANSCRIPT_RESEED_EVENTS);
  if (seed.length && seed[seed.length - 1]!.role === "user") {
    seed = seed.slice(0, -1);
  }
  const statements = [
    db.prepare(`DELETE FROM messages WHERE session_id = ?`).bind(sessionId),
    db.prepare(`DELETE FROM llm_events WHERE session_id = ?`).bind(sessionId),
  ];
  for (const [index, message] of projected.entries()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (id, session_id, sequence, role, content, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          sessionId,
          index + 1,
          message.role,
          message.content,
          message.task_id || null,
          message.ts || ts,
        ),
    );
  }
  for (const [index, message] of seed.entries()) {
    const payload: Record<string, unknown> = { content: message.content };
    if (message.task_id) payload.task_id = message.task_id;
    const payloadJson = stableStringify(payload);
    const contentHash = await sha256(payloadJson);
    const kind = message.role === "assistant" ? "assistant" : "user";
    statements.push(
      db
        .prepare(
          `INSERT INTO llm_events (id, session_id, prompt_epoch, sequence, kind, role, payload_json, content_hash, stable, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          sessionId,
          nextEpoch,
          index + 1,
          kind,
          message.role,
          payloadJson,
          contentHash,
          message.ts || ts,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE sessions
         SET next_message_sequence = ?,
             next_event_sequence = ?,
             prompt_epoch = ?,
             prompt_epoch_reason = ?,
             affinity_key = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .bind(projected.length + 1, seed.length + 1, nextEpoch, reason, nextAffinity, ts, sessionId),
  );
  await db.batch(statements);
}

export async function markOutboxPublished(db: D1Database, taskId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE outbox_events SET published_at = ?, attempt_count = attempt_count + 1 WHERE aggregate_id = ? AND published_at IS NULL`,
    )
    .bind(nowIso(), taskId)
    .run();
}

export async function publishTask(env: Env, task: GenerationTaskRow): Promise<void> {
  await env.GENERATE_QUEUE.send({
    kind: "generation",
    taskId: task.id,
    workspaceId: task.workspace_id,
    sessionId: task.session_id,
  });
  await markOutboxPublished(env.DB, task.id);
}

/**
 * Recover expired leases as well as sends lost after the input transaction.
 * Quiet ticks: recoverGenerationTasks early-returns with zero writes when nothing is
 * stale; the outbox SELECT only drives publishTask/markOutboxPublished for unpublished
 * rows (published_at IS NULL), so idle minutes do not touch updated_at.
 */
export async function flushGenerationOutbox(env: Env): Promise<void> {
  await recoverGenerationTasks(env.DB);
  const rows = await env.DB.prepare(
    `SELECT o.aggregate_id AS id FROM outbox_events o JOIN generation_tasks g ON g.id = o.aggregate_id
     WHERE o.event_type = 'generation.requested' AND o.published_at IS NULL AND g.status IN ('pending', 'running')
     ORDER BY o.created_at LIMIT 25`,
  ).all<{ id: string }>();
  for (const row of rows.results || []) {
    const task = await getTask(env.DB, row.id);
    if (task && (task.status === "pending" || task.status === "running")) await publishTask(env, task);
  }
}

export async function leaseTask(
  db: D1Database,
  id: string,
  owner: string,
  /** GLM story turns often take 500–700s; 180s caused false TASK_LEASE_EXPIRED mid-flight. */
  seconds = 1200,
): Promise<GenerationTaskRow | null> {
  const now = new Date();
  const expires = new Date(now.getTime() + seconds * 1000).toISOString();
  await db
    .prepare(
      `UPDATE generation_tasks
       SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'running')
         AND attempt_count < ?
         AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_owner = ?)`,
    )
    .bind(owner, expires, now.toISOString(), id, MAX_GENERATION_ATTEMPTS, now.toISOString(), owner)
    .run();
  const task = await getTask(db, id);
  return task?.lease_owner === owner && task.status === "running" ? task : null;
}

export async function markRunning(db: D1Database, id: string): Promise<void> {
  await leaseTask(db, id, `legacy-${id}`);
}

export async function completeTask(db: D1Database, id: string, completion: TaskCompletion): Promise<void> {
  const task = await getTask(db, id);
  if (!task || task.status === "completed" || task.status === "dead") return;
  const runtime = await sessionRuntime(db, task.session_id);
  const messageId = crypto.randomUUID();
  const includeInPrompt = completion.includeInPrompt !== false;
  const outboxId = crypto.randomUUID();
  const ts = nowIso();
  const contentHash = await sha256(completion.content);
  const hiddenEvents = includeInPrompt ? completion.hiddenEvents || [] : [];
  const firstEventSequence = includeInPrompt ? await nextPromptEventSequence(db, task.session_id) : 0;
  const usage = completion.usage || { prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0 };
  const nextEpoch = completion.rotatePromptEpochReason ? runtime.prompt_epoch + 1 : null;
  const nextAffinity =
    nextEpoch == null
      ? null
      : await affinityKey(task.session_id, await resolveSessionModel(db, task.session_id), nextEpoch);
  const sessionUpdate = completion.rotatePromptEpochReason
    ? db
        .prepare(
          `UPDATE sessions
           SET next_message_sequence = next_message_sequence + 1,
               prompt_epoch = ?, prompt_epoch_reason = ?, affinity_key = ?, next_event_sequence = 1,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(nextEpoch, completion.rotatePromptEpochReason, nextAffinity, ts, task.session_id)
    : db
        .prepare(
          `UPDATE sessions
           SET next_message_sequence = next_message_sequence + 1,
               next_event_sequence = next_event_sequence + ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .bind(includeInPrompt ? 1 + hiddenEvents.length : 0, ts, task.session_id);
  const statements = [
    db
      .prepare(
        `INSERT INTO messages (id, session_id, sequence, role, content, task_id, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?, ?)`,
      )
      .bind(
        messageId,
        task.session_id,
        runtime.prompt_epoch ? await nextMessageSequence(db, task.session_id) : 1,
        completion.content,
        id,
        ts,
      ),
    db
      .prepare(
        `UPDATE generation_tasks SET
           status = 'completed', result_message_id = ?, result_content = ?, request_hash = ?,
           response_cache_status = ?, prompt_tokens = ?, cached_input_tokens = ?,
           stable_prefix_tokens = ?, volatile_tokens = ?, error_code = NULL, error_message = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .bind(
        messageId,
        completion.content,
        completion.requestHash || null,
        completion.cacheStatus || "unknown",
        usage.prompt_tokens,
        usage.cached_input_tokens,
        completion.stablePrefixTokens || 0,
        completion.volatileTokens || 0,
        ts,
        ts,
        id,
      ),
    sessionUpdate,
    db
      .prepare(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload_json, created_at)
         VALUES (?, 'generation_task', ?, 'generation.completed', ?, ?)`,
      )
      .bind(
        outboxId,
        id,
        stableStringify({ taskId: id, workspaceId: task.workspace_id, sessionId: task.session_id }),
        ts,
      ),
  ];
  if (includeInPrompt) {
    statements.splice(
      1,
      0,
      db
        .prepare(
          `INSERT INTO llm_events (id, session_id, prompt_epoch, sequence, kind, role, payload_json, content_hash, stable, created_at)
           VALUES (?, ?, ?, ?, 'assistant', 'assistant', ?, ?, 0, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          task.session_id,
          runtime.prompt_epoch,
          firstEventSequence,
          stableStringify({ content: completion.content, task_id: id }),
          contentHash,
          ts,
        ),
    );
    for (const [index, event] of hiddenEvents.entries()) {
      statements.splice(
        2 + index,
        0,
        db
          .prepare(
            `INSERT INTO llm_events (id, session_id, prompt_epoch, sequence, kind, role, payload_json, content_hash, stable, created_at)
             VALUES (?, ?, ?, ?, ?, 'user', ?, ?, 0, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            task.session_id,
            runtime.prompt_epoch,
            firstEventSequence + index + 1,
            event.kind,
            stableStringify({ content: event.content, task_id: id }),
            await sha256(event.hashSeed || event.content),
            ts,
          ),
      );
    }
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE generation_tasks
           SET nmem_sync_status = 'not_requested', nmem_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .bind(ts, id),
    );
  }
  await db.batch(statements);
}

async function nextMessageSequence(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT next_message_sequence AS value FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ value: number }>();
  return row?.value || 1;
}

async function nextPromptEventSequence(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT next_event_sequence AS value FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ value: number }>();
  return row?.value || 1;
}

export async function markCompleted(db: D1Database, id: string, content: string): Promise<void> {
  await completeTask(db, id, { content });
}

export async function markFailed(
  db: D1Database,
  id: string,
  error: string,
  options: { code?: string; dead?: boolean } = {},
): Promise<void> {
  const ts = nowIso();
  await db
    .prepare(
      `UPDATE generation_tasks SET
         status = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL,
         completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`,
    )
    .bind(
      options.dead ? "dead" : "pending",
      options.code || null,
      error.slice(0, 2000),
      Number(Boolean(options.dead)),
      ts,
      ts,
      id,
    )
    .run();
}

export async function listMessages(
  db: D1Database,
  sessionId: string,
  cursor?: number,
  limit = 50,
): Promise<{
  messages: Array<{ id: string; sequence: number; role: "user" | "assistant"; content: string; created_at: string }>;
  next_cursor: number | null;
}> {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const rows = await db
    .prepare(
      `SELECT id, sequence, role, content, created_at FROM messages
       WHERE session_id = ? AND (? IS NULL OR sequence < ?)
       ORDER BY sequence DESC LIMIT ?`,
    )
    .bind(sessionId, cursor ?? null, cursor ?? null, safeLimit + 1)
    .all<{ id: string; sequence: number; role: "user" | "assistant"; content: string; created_at: string }>();
  const results = rows.results || [];
  const hasMore = results.length > safeLimit;
  const page = results.slice(0, safeLimit);
  return { messages: page.reverse(), next_cursor: hasMore ? page[page.length - 1]?.sequence || null : null };
}

export async function getCachedToolExecution(
  db: D1Database,
  taskId: string,
  toolCallId: string,
  argumentsHash: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT result_json FROM tool_executions
       WHERE task_id = ? AND tool_call_id = ? AND arguments_hash = ? AND status = 'completed'`,
    )
    .bind(taskId, toolCallId, argumentsHash)
    .first<{ result_json: string | null }>();
  return row?.result_json || null;
}

export async function recordToolExecution(
  db: D1Database,
  input: { taskId: string; toolCallId: string; toolName: string; arguments: Record<string, unknown>; result: string },
): Promise<void> {
  const argsJson = stableStringify(input.arguments);
  const hash = await sha256(argsJson);
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO tool_executions (
        id, task_id, tool_call_id, tool_name, arguments_hash, arguments_json, result_json, status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
       ON CONFLICT(task_id, tool_call_id, arguments_hash) DO NOTHING`,
    )
    .bind(crypto.randomUUID(), input.taskId, input.toolCallId, input.toolName, hash, argsJson, input.result, ts, ts)
    .run();
}
