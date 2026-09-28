import {
  OUTPUT_CHANNEL_CONTRACT,
  affinityKey,
  canonicalTools,
  sha256,
  stableStringify,
  type AiModelConfig,
} from "../core/ai";
import type { LlmMessage, ToolCall } from "../core/assemble";
import { estimateTokens } from "../core/budget";
import { nowIso } from "../core/util";
import { resolveSessionModel, sessionRuntime } from "./models";

type EventKind = "checkpoint" | "context" | "user" | "assistant" | "tool_call" | "tool_result" | "summary" | "memory";

type EventRow = {
  kind: EventKind;
  role: "user" | "assistant" | "tool";
  payload_json: string;
};

export type PreparedPrompt = {
  messages: LlmMessage[];
  model: AiModelConfig;
  affinityKey: string;
  promptEpoch: number;
  stablePrefixTokens: number;
  volatileTokens: number;
};

async function rotateEpoch(db: D1Database, sessionId: string, reason: string, model: AiModelConfig): Promise<number> {
  const current = await sessionRuntime(db, sessionId);
  const nextEpoch = current.prompt_epoch + 1;
  const nextAffinity = await affinityKey(sessionId, model, nextEpoch);
  await db
    .prepare(
      `UPDATE sessions
       SET prompt_epoch = ?, prompt_epoch_reason = ?, affinity_key = ?, next_event_sequence = 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(nextEpoch, reason, nextAffinity, nowIso(), sessionId)
    .run();
  return nextEpoch;
}

export async function createPromptEpoch(db: D1Database, sessionId: string, reason: string): Promise<number> {
  return rotateEpoch(db, sessionId, reason, await resolveSessionModel(db, sessionId));
}

async function appendEvent(
  db: D1Database,
  input: {
    sessionId: string;
    epoch: number;
    kind: EventKind;
    role: "user" | "assistant" | "tool";
    payload: Record<string, unknown>;
    hashSeed?: string;
    stable?: boolean;
  },
): Promise<boolean> {
  const payloadJson = stableStringify(input.payload);
  const contentHash = await sha256(input.hashSeed || payloadJson);
  if (input.kind === "checkpoint" || input.kind === "context" || input.kind === "memory") {
    const existing = await db
      .prepare(
        `SELECT id FROM llm_events
         WHERE session_id = ? AND prompt_epoch = ? AND kind = ? AND content_hash = ?`,
      )
      .bind(input.sessionId, input.epoch, input.kind, contentHash)
      .first<{ id: string }>();
    if (existing) return false;
  }
  const runtime = await sessionRuntime(db, input.sessionId);
  if (runtime.prompt_epoch !== input.epoch) return false;
  await db.batch([
    db
      .prepare(
        `INSERT INTO llm_events (
           id, session_id, prompt_epoch, sequence, kind, role, payload_json, content_hash, stable, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.sessionId,
        input.epoch,
        runtime.prompt_epoch === input.epoch ? await nextEventSequence(db, input.sessionId) : 1,
        input.kind,
        input.role,
        payloadJson,
        contentHash,
        input.stable ? 1 : 0,
        nowIso(),
      ),
    db
      .prepare(`UPDATE sessions SET next_event_sequence = next_event_sequence + 1, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), input.sessionId),
  ]);
  return true;
}

async function nextEventSequence(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT next_event_sequence AS value FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ value: number }>();
  return row?.value || 1;
}

async function taskUserExists(db: D1Database, sessionId: string, epoch: number, taskId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM llm_events
       WHERE session_id = ? AND prompt_epoch = ? AND kind = 'user'
         AND json_extract(payload_json, '$.task_id') = ? LIMIT 1`,
    )
    .bind(sessionId, epoch, taskId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function epochHasRoleplayEvents(db: D1Database, sessionId: string, epoch: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM llm_events
       WHERE session_id = ? AND prompt_epoch = ? AND kind IN ('user', 'assistant') LIMIT 1`,
    )
    .bind(sessionId, epoch)
    .first<{ id: string }>();
  return Boolean(row);
}

async function currentCheckpoint(
  db: D1Database,
  sessionId: string,
  epoch: number,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT payload_json FROM llm_events
       WHERE session_id = ? AND prompt_epoch = ? AND kind = 'checkpoint'
       ORDER BY sequence LIMIT 1`,
    )
    .bind(sessionId, epoch)
    .first<{ payload_json: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const DYNAMIC_CONTEXT_HEADER = "## 隐藏上下文增量";
/** Legacy post-commit full-state event (no longer written; still present in older epochs). */
const LEGACY_STATE_HEADER = "## 场景状态变化";

function isStateSnapshotRow(row: EventRow): boolean {
  if (row.kind !== "context") return false;
  try {
    const content = String((JSON.parse(row.payload_json) as { content?: unknown }).content || "");
    return content.startsWith(DYNAMIC_CONTEXT_HEADER) || content.startsWith(LEGACY_STATE_HEADER);
  } catch {
    return false;
  }
}

/**
 * The scene state is a full snapshot re-sent every turn. Replaying every past copy made the
 * state (and its wording) dominate the prompt and confused the model about what is current,
 * so only the newest snapshot is kept; rows stay in D1 for forensics.
 */
export function latestStateOnly<T extends EventRow>(rows: T[]): T[] {
  let last = -1;
  rows.forEach((row, index) => {
    if (isStateSnapshotRow(row)) last = index;
  });
  return rows.filter((row, index) => index === last || !isStateSnapshotRow(row));
}

function rowToMessage(row: EventRow): LlmMessage | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.kind === "tool_call") {
    return {
      role: "assistant",
      content: typeof payload.content === "string" ? payload.content : null,
      tool_calls: (payload.tool_calls as ToolCall[] | undefined) || [],
    };
  }
  if (row.kind === "tool_result") {
    return {
      role: "tool",
      content: typeof payload.content === "string" ? payload.content : "",
      tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : "",
    };
  }
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!content) return null;
  return { role: row.role, content };
}

export async function preparePrompt(
  db: D1Database,
  input: {
    sessionId: string;
    taskId: string;
    systemParts: string[];
    checkpoint: string;
    dynamicContext: string;
    userContent: string;
    tools: unknown[] | null;
    model?: AiModelConfig;
    /**
     * Recent roleplay tail replayed right after a *new* epoch checkpoint. Without it every
     * epoch rotation (compaction, stable-prefix change) restarted the model with zero verbatim
     * history — only the checkpoint and the scene state.
     */
    seedHistory?: Array<{ role: string; content: string }>;
    /** Per-epoch deduplicated context parts (minis, lore): appended once per epoch per content. */
    contextParts?: Array<{ key: string; content: string }>;
    /** Per-character memory blocks: appended once per epoch per character. */
    memoryParts?: Array<{ key: string; content: string }>;
  },
): Promise<PreparedPrompt> {
  const model = input.model || (await resolveSessionModel(db, input.sessionId));
  if (!model.enabled) throw new Error(`model '${model.label}' is disabled`);
  let runtime = await sessionRuntime(db, input.sessionId);
  const systems = input.systemParts.map((part) => part.trim()).filter(Boolean);
  const stableHash = await sha256(
    stableStringify({ systems, tools: canonicalTools(input.tools), contract: OUTPUT_CHANNEL_CONTRACT }),
  );
  let checkpoint = await currentCheckpoint(db, input.sessionId, runtime.prompt_epoch);
  if (checkpoint && checkpoint.stable_hash !== stableHash) {
    await rotateEpoch(db, input.sessionId, "stable_prefix_changed", model);
    runtime = await sessionRuntime(db, input.sessionId);
    checkpoint = null;
  }
  if (!checkpoint) {
    await appendEvent(db, {
      sessionId: input.sessionId,
      epoch: runtime.prompt_epoch,
      kind: "checkpoint",
      role: "user",
      payload: { content: `## Epoch 初始上下文检查点\n${input.checkpoint}`.trim(), stable_hash: stableHash },
      hashSeed: `checkpoint:${stableHash}:${input.checkpoint}`,
      stable: true,
    });
    // The rewrite/regenerate path (replaceSessionTranscriptProjection) already reseeds the
    // epoch with transcript turns before any checkpoint exists. Seeding again duplicated the
    // tail (live epoch 358: seq 21–24 repeated seq 16–19), inflating every later prompt.
    const seedHistory = (await epochHasRoleplayEvents(db, input.sessionId, runtime.prompt_epoch))
      ? []
      : input.seedHistory || [];
    for (const [index, message] of seedHistory.entries()) {
      const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
      const content = String(message.content || "").trim();
      if (!role || !content) continue;
      await appendEvent(db, {
        sessionId: input.sessionId,
        epoch: runtime.prompt_epoch,
        kind: role,
        role,
        payload: { content, seed: true },
        hashSeed: `seed:${runtime.prompt_epoch}:${index}:${content}`,
      });
    }
  }
  for (const part of input.memoryParts || []) {
    if (!part.content.trim()) continue;
    // Keyed by character only: later changes arrive as 核心记忆变更 deltas, not re-sends.
    await appendEvent(db, {
      sessionId: input.sessionId,
      epoch: runtime.prompt_epoch,
      kind: "memory",
      role: "user",
      payload: { content: part.content.trim() },
      hashSeed: `part:${part.key}`,
      stable: false,
    });
  }
  for (const part of input.contextParts || []) {
    if (!part.content.trim()) continue;
    await appendEvent(db, {
      sessionId: input.sessionId,
      epoch: runtime.prompt_epoch,
      kind: "context",
      role: "user",
      payload: { content: part.content.trim() },
      hashSeed: `part:${part.key}:${part.content.trim()}`,
      stable: false,
    });
  }
  if (input.dynamicContext.trim()) {
    await appendEvent(db, {
      sessionId: input.sessionId,
      epoch: runtime.prompt_epoch,
      kind: "context",
      role: "user",
      payload: { content: `${DYNAMIC_CONTEXT_HEADER}\n${input.dynamicContext}`.trim(), task_id: input.taskId },
      // One copy per task (idempotent on retry). Older copies are hidden by latestStateOnly().
      hashSeed: `dynamic:${input.taskId}`,
      stable: false,
    });
  }
  if (!(await taskUserExists(db, input.sessionId, runtime.prompt_epoch, input.taskId))) {
    await appendEvent(db, {
      sessionId: input.sessionId,
      epoch: runtime.prompt_epoch,
      kind: "user",
      role: "user",
      payload: { content: input.userContent, task_id: input.taskId },
      hashSeed: `task-user:${input.taskId}`,
    });
  }
  const rows = await db
    .prepare(
      `SELECT kind, role, payload_json FROM llm_events
       WHERE session_id = ? AND prompt_epoch = ? ORDER BY sequence`,
    )
    .bind(input.sessionId, runtime.prompt_epoch)
    .all<EventRow>();
  const eventMessages = latestStateOnly(rows.results || [])
    .map(rowToMessage)
    .filter((item): item is LlmMessage => Boolean(item));
  const checkpointTokens = estimateTokens(
    String(
      (checkpoint || (await currentCheckpoint(db, input.sessionId, runtime.prompt_epoch)))?.content || input.checkpoint,
    ),
  );
  return {
    messages: [...systems.map((content) => ({ role: "system", content })), ...eventMessages],
    model,
    affinityKey: runtime.affinity_key,
    promptEpoch: runtime.prompt_epoch,
    stablePrefixTokens: systems.reduce(
      (sum, content) => sum + estimateTokens(content),
      estimateTokens(OUTPUT_CHANNEL_CONTRACT) + checkpointTokens,
    ),
    volatileTokens: estimateTokens(input.dynamicContext) + estimateTokens(input.userContent),
  };
}

export async function appendToolCallEvent(
  db: D1Database,
  sessionId: string,
  taskId: string,
  content: string,
  calls: ToolCall[],
): Promise<void> {
  const runtime = await sessionRuntime(db, sessionId);
  const hashSeed = `tool-call:${taskId}:${stableStringify(calls)}`;
  const hash = await sha256(hashSeed);
  const existing = await db
    .prepare(
      `SELECT id FROM llm_events WHERE session_id = ? AND prompt_epoch = ? AND kind = 'tool_call' AND content_hash = ?`,
    )
    .bind(sessionId, runtime.prompt_epoch, hash)
    .first<{ id: string }>();
  if (existing) return;
  await appendEvent(db, {
    sessionId,
    epoch: runtime.prompt_epoch,
    kind: "tool_call",
    role: "assistant",
    payload: { content, tool_calls: calls, task_id: taskId },
    hashSeed,
  });
}

export async function appendToolResultEvent(
  db: D1Database,
  sessionId: string,
  taskId: string,
  call: ToolCall,
  content: string,
): Promise<void> {
  const runtime = await sessionRuntime(db, sessionId);
  const hashSeed = `tool-result:${taskId}:${call.id}:${await sha256(stableStringify(call.arguments))}`;
  const hash = await sha256(hashSeed);
  const existing = await db
    .prepare(
      `SELECT id FROM llm_events WHERE session_id = ? AND prompt_epoch = ? AND kind = 'tool_result' AND content_hash = ?`,
    )
    .bind(sessionId, runtime.prompt_epoch, hash)
    .first<{ id: string }>();
  if (existing) return;
  await appendEvent(db, {
    sessionId,
    epoch: runtime.prompt_epoch,
    kind: "tool_result",
    role: "tool",
    payload: { content, tool_call_id: call.id, task_id: taskId },
    hashSeed,
  });
}

/** Persist deferred-commit scene/memory deltas into the live prompt epoch. */
export async function appendHiddenPromptEvents(
  db: D1Database,
  sessionId: string,
  events: Array<{ kind: "context" | "memory"; content: string; hashSeed?: string }>,
  taskId?: string | null,
): Promise<number> {
  if (!events.length) return 0;
  const runtime = await sessionRuntime(db, sessionId);
  let written = 0;
  for (const event of events) {
    const ok = await appendEvent(db, {
      sessionId,
      epoch: runtime.prompt_epoch,
      kind: event.kind,
      role: "user",
      payload: {
        content: event.content,
        ...(taskId ? { task_id: taskId } : {}),
      },
      hashSeed: event.hashSeed || event.content,
      stable: false,
    });
    if (ok) written += 1;
  }
  return written;
}
