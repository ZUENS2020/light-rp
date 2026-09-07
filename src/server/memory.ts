import { sha256, stableStringify } from "../core/ai";
import type { MemorySnapshot } from "../core/memory";
import { nowIso } from "../core/util";

type CoreMemoryRow = {
  scope: "world" | "player" | "character";
  characterId: string | null;
  content: string;
  memoryType: "fact" | "preference" | "promise" | "relationship" | "goal" | "important_event";
};

type DesiredCoreRow = CoreMemoryRow & {
  id: string;
  contentHash: string;
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

async function desiredCoreRows(workspaceId: string, snapshot: MemorySnapshot): Promise<DesiredCoreRow[]> {
  const rows = coreRows(snapshot);
  return Promise.all(
    rows.map(async (row) => {
      const contentHash = await sha256(row.content);
      const identityHash = await sha256(`${workspaceId}:${row.scope}:${row.characterId || ""}:${contentHash}`);
      return {
        ...row,
        id: `core:${identityHash.slice(0, 56)}`,
        contentHash,
      };
    }),
  );
}

/**
 * Incrementally sync core memory rows for a workspace (R2 → D1 mirror).
 * Only forgets removed entries and upserts new/changed ones — never mass-forgets
 * then rewrites every active core row on an unchanged snapshot.
 * Identity remains `core:${hash}` derived from workspace+scope+character+content.
 */
export async function mirrorCoreMemorySnapshot(
  db: D1Database,
  input: { workspaceId: string; sessionId?: string | null; taskId?: string | null; snapshot: MemorySnapshot },
): Promise<number> {
  const desired = await desiredCoreRows(input.workspaceId, input.snapshot);
  const desiredIds = new Set(desired.map((row) => row.id));
  const existing = await db
    .prepare(
      `SELECT id FROM memories
       WHERE workspace_id = ? AND scope IN ('world', 'player', 'character') AND status = 'active'`,
    )
    .bind(input.workspaceId)
    .all<{ id: string }>();
  const existingIds = new Set((existing.results || []).map((row) => row.id));

  const toForget = [...existingIds].filter((id) => !desiredIds.has(id));
  const toUpsert = desired.filter((row) => !existingIds.has(row.id));
  if (!toForget.length && !toUpsert.length) return desired.length;

  const ts = nowIso();
  const statements: D1PreparedStatement[] = [];
  for (const id of toForget) {
    statements.push(
      db
        .prepare(`UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ? AND status = 'active'`)
        .bind(ts, id),
    );
  }
  for (const row of toUpsert) {
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
          row.id,
          input.workspaceId,
          input.sessionId || null,
          row.characterId,
          row.scope,
          row.content,
          row.contentHash,
          ts,
          ts,
          row.memoryType,
          input.taskId || null,
          stableStringify({ origin: "memory_tool", target: row.scope, character_id: row.characterId }),
        ),
    );
  }
  await db.batch(statements);
  return desired.length;
}

/** Core-memory status for the play UI (Hermes R2 stores mirrored into D1). */
export async function memoryStatus(db: D1Database, sessionId: string) {
  const counts = await db
    .prepare(
      `SELECT scope, COUNT(*) AS count FROM memories
       WHERE workspace_id = (SELECT workspace_id FROM sessions WHERE id = ?) AND status = 'active'
       GROUP BY scope`,
    )
    .bind(sessionId)
    .all<{ scope: string; count: number }>();
  return {
    core: Object.fromEntries((counts.results || []).map((row) => [row.scope, Number(row.count)])),
    recall: null,
    sync: null,
  };
}
