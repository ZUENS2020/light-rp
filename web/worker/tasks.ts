import { nowIso } from "./util";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export type GenerationTaskRow = {
  id: string;
  world_id: string;
  session_id: string;
  user_text: string;
  status: TaskStatus;
  content: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export async function insertPending(
  db: D1Database,
  input: { id: string; worldId: string; sessionId: string; userText: string },
): Promise<void> {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO generation_tasks (id, world_id, session_id, user_text, status, content, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    )
    .bind(input.id, input.worldId, input.sessionId, input.userText, ts, ts)
    .run();
}

export async function getTask(db: D1Database, id: string): Promise<GenerationTaskRow | null> {
  const row = await db
    .prepare(
      `SELECT id, world_id, session_id, user_text, status, content, error, created_at, updated_at
       FROM generation_tasks WHERE id = ?`,
    )
    .bind(id)
    .first<GenerationTaskRow>();
  return row ?? null;
}

async function skipIfTerminal(db: D1Database, id: string): Promise<GenerationTaskRow | null> {
  const existing = await getTask(db, id);
  if (!existing || existing.status === "completed" || existing.status === "failed") return null;
  return existing;
}

export async function markRunning(db: D1Database, id: string): Promise<void> {
  if (!(await skipIfTerminal(db, id))) return;
  await db.prepare(`UPDATE generation_tasks SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')`).bind(nowIso(), id).run();
}

export async function markCompleted(db: D1Database, id: string, content: string): Promise<void> {
  if (!(await skipIfTerminal(db, id))) return;
  await db
    .prepare(`UPDATE generation_tasks SET status = 'completed', content = ?, error = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')`)
    .bind(content, nowIso(), id)
    .run();
}

export async function markFailed(db: D1Database, id: string, error: string): Promise<void> {
  if (!(await skipIfTerminal(db, id))) return;
  await db
    .prepare(`UPDATE generation_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')`)
    .bind(error, nowIso(), id)
    .run();
}
