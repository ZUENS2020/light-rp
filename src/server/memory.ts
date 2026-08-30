import { sha256, stableStringify } from "../core/ai";
import type { MemorySnapshot } from "../core/memory";
import { nowIso } from "../core/util";

type CoreMemoryRow = {
  scope: "world" | "player" | "character";
  characterId: string | null;
  content: string;
  memoryType: "fact" | "preference" | "promise" | "relationship" | "goal" | "important_event";
};

function inferMemoryType(content: string, fallback: CoreMemoryRow["memoryType"]): CoreMemoryRow["memoryType"] {
  const match = content.match(
    /(?:^\[(promise|relationship|fact|preference|goal|important_event)\])|(?:^|\n)type:\s*(promise|relationship|fact|preference|goal|important_event)\s*(?:\n|$)/i,
  );
  return (match?.[1] || match?.[2] || fallback) as CoreMemoryRow["memoryType"];
}

function coreRows(snapshot: MemorySnapshot): CoreMemoryRow[] {
  return [
    ...snapshot.world.map((content) => ({
      scope: "world" as const,
      characterId: null,
      content,
      memoryType: inferMemoryType(content, "fact"),
    })),
    ...snapshot.player.map((content) => ({
      scope: "player" as const,
      characterId: null,
      content,
      memoryType: inferMemoryType(content, "preference"),
    })),
    ...Object.entries(snapshot.characters).flatMap(([characterId, entries]) =>
      entries.map((content) => ({
        scope: "character" as const,
        characterId,
        content,
        memoryType: inferMemoryType(content, "fact"),
      })),
    ),
  ];
}

export async function mirrorCoreMemorySnapshot(
  db: D1Database,
  input: { workspaceId: string; sessionId?: string | null; taskId?: string | null; snapshot: MemorySnapshot },
): Promise<number> {
  const rows = coreRows(input.snapshot);
  const ts = nowIso();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE memories SET status = 'forgotten', updated_at = ?
         WHERE workspace_id = ? AND scope IN ('world', 'player', 'character') AND status = 'active'`,
      )
      .bind(ts, input.workspaceId),
  ];
  for (const row of rows) {
    const contentHash = await sha256(row.content);
    const identityHash = await sha256(`${input.workspaceId}:${row.scope}:${row.characterId || ""}:${contentHash}`);
    statements.push(
      db
        .prepare(
          `INSERT INTO memories (
             id, workspace_id, session_id, character_id, scope, content, content_hash, importance,
             source, created_at, updated_at, memory_type, status, source_task_id, provenance_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.8, 'core', ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content, importance = excluded.importance,
             updated_at = excluded.updated_at, memory_type = excluded.memory_type, status = 'active'`,
        )
        .bind(
          `core:${identityHash.slice(0, 56)}`,
          input.workspaceId,
          input.sessionId || null,
          row.characterId,
          row.scope,
          row.content,
          contentHash,
          ts,
          ts,
          row.memoryType,
          input.taskId || null,
          stableStringify({ origin: "memory_tool", target: row.scope, character_id: row.characterId }),
        ),
    );
  }
  await db.batch(statements);
  return rows.length;
}

export async function recordMemoryRecall(
  db: D1Database,
  input: {
    workspaceId: string;
    sessionId: string;
    taskId?: string | null;
    spaceId: string;
    query: string;
    rows: Record<string, unknown>[];
  },
): Promise<void> {
  const ts = nowIso();
  const hashes = await Promise.all(
    input.rows.map((row) => sha256(String(row.content || row.content_preview || row.title || ""))),
  );
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_recall_events (
           id, workspace_id, session_id, task_id, provider, space_id, query_hash,
           recalled_count, content_hashes_json, created_at
         ) VALUES (?, ?, ?, ?, 'nmem', ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.workspaceId,
        input.sessionId,
        input.taskId || null,
        input.spaceId,
        await sha256(input.query),
        input.rows.length,
        stableStringify(hashes),
        ts,
      ),
  ];
  if (input.taskId) {
    statements.push(
      db
        .prepare(`UPDATE generation_tasks SET nmem_recall_count = ?, updated_at = ? WHERE id = ?`)
        .bind(input.rows.length, ts, input.taskId),
    );
  }
  for (const row of input.rows) {
    const externalId = String(row.id || row.memory_id || "");
    if (!externalId) continue;
    statements.push(
      db
        .prepare(
          `UPDATE memories SET recall_count = recall_count + 1, last_recalled_at = ?, updated_at = ?
           WHERE external_id = ?`,
        )
        .bind(ts, ts, externalId),
    );
  }
  await db.batch(statements);
}

export async function beginNmemSync(
  db: D1Database,
  input: { taskId: string; workspaceId: string; sessionId: string; spaceId: string; attempt: number },
): Promise<void> {
  const ts = nowIso();
  await db.batch([
    db
      .prepare(
        `INSERT INTO memory_sync_runs (
           task_id, workspace_id, session_id, provider, space_id, status, attempt_count, created_at, updated_at
         ) VALUES (?, ?, ?, 'nmem', ?, 'running', ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           space_id = excluded.space_id, status = 'running', attempt_count = excluded.attempt_count,
           error = NULL, updated_at = excluded.updated_at`,
      )
      .bind(input.taskId, input.workspaceId, input.sessionId, input.spaceId, input.attempt, ts, ts),
    db
      .prepare(
        `UPDATE generation_tasks
         SET nmem_sync_status = 'running', nmem_error = NULL, updated_at = ? WHERE id = ?`,
      )
      .bind(ts, input.taskId),
  ]);
}

export async function completeNmemSync(
  db: D1Database,
  input: { taskId: string; coreMemoryCount: number; turnExternalId: string | null; threadId: string },
): Promise<void> {
  const ts = nowIso();
  await db.batch([
    db
      .prepare(
        `UPDATE memory_sync_runs SET
           status = 'completed', core_memory_count = ?, turn_external_id = ?, thread_id = ?,
           error = NULL, updated_at = ?, completed_at = ? WHERE task_id = ?`,
      )
      .bind(input.coreMemoryCount, input.turnExternalId, input.threadId, ts, ts, input.taskId),
    db
      .prepare(
        `UPDATE generation_tasks SET
           nmem_sync_status = 'completed', nmem_synced_at = ?, nmem_error = NULL,
           nmem_memory_count = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(ts, input.coreMemoryCount, ts, input.taskId),
  ]);
}

export async function failNmemSync(db: D1Database, taskId: string, error: unknown, dead = false): Promise<void> {
  const ts = nowIso();
  const status = dead ? "dead" : "failed";
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  await db.batch([
    db
      .prepare(`UPDATE memory_sync_runs SET status = ?, error = ?, updated_at = ? WHERE task_id = ?`)
      .bind(status, message, ts, taskId),
    db
      .prepare(`UPDATE generation_tasks SET nmem_sync_status = ?, nmem_error = ?, updated_at = ? WHERE id = ?`)
      .bind(status, message, ts, taskId),
  ]);
}

export async function memoryStatus(db: D1Database, sessionId: string) {
  const [counts, recall, sync] = await Promise.all([
    db
      .prepare(
        `SELECT scope, COUNT(*) AS count FROM memories
         WHERE workspace_id = (SELECT workspace_id FROM sessions WHERE id = ?) AND status = 'active'
         GROUP BY scope`,
      )
      .bind(sessionId)
      .all<{ scope: string; count: number }>(),
    db
      .prepare(
        `SELECT space_id, recalled_count, created_at FROM memory_recall_events
         WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(sessionId)
      .first<{ space_id: string; recalled_count: number; created_at: string }>(),
    db
      .prepare(
        `SELECT status, space_id, core_memory_count, error, updated_at FROM memory_sync_runs
         WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(sessionId)
      .first<{
        status: string;
        space_id: string;
        core_memory_count: number;
        error: string | null;
        updated_at: string;
      }>(),
  ]);
  return {
    core: Object.fromEntries((counts.results || []).map((row) => [row.scope, Number(row.count)])),
    recall: recall || null,
    sync: sync || null,
  };
}
