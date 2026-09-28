import type { R2Fs } from "../adapters/r2";
import { parseScene, sceneYaml, type SceneState } from "../core/domain";

export type RetryBaseSource =
  "task_snapshot" | "retried_reply_never_committed" | "last_turn_snapshot" | "previous_turn_commit" | "kept_current";

/** Record the scene state a story reply was generated from (first write wins across lease retries). */
export async function recordSceneBefore(db: D1Database, taskId: string, scene: SceneState): Promise<void> {
  await db
    .prepare(`UPDATE generation_tasks SET scene_before_json = ? WHERE id = ? AND scene_before_json IS NULL`)
    .bind(JSON.stringify(scene), taskId)
    .run();
}

function sceneFromJson(raw: string | null | undefined): SceneState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // Round-trip through YAML so the shape is normalized exactly like state.yaml.
    return parseScene(sceneYaml(value as SceneState));
  } catch {
    return null;
  }
}

async function commitState(db: D1Database, taskId: string): Promise<SceneState | null> {
  const row = await db
    .prepare(
      `SELECT result_json FROM tool_executions
       WHERE task_id = ? AND tool_name = 'commit_turn' AND result_json IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(taskId)
    .first<{ result_json: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.result_json) as { state?: unknown };
    return parsed.state ? sceneFromJson(JSON.stringify(parsed.state)) : null;
  } catch {
    return null;
  }
}

/**
 * Scene state to regenerate a reply from: the state right before that reply was generated.
 * Never clears the state; when nothing better is known the current state is kept.
 */
export async function resolveRetryBaseScene(
  db: D1Database,
  fs: R2Fs,
  sessionId: string,
  input: { taskId: string | null; messages: Array<{ role: string; task_id?: string }>; retriedUserIndex: number },
): Promise<{ scene: SceneState | null; source: RetryBaseSource }> {
  const taskId = input.taskId;
  if (taskId) {
    const row = await db
      .prepare(`SELECT scene_before_json FROM generation_tasks WHERE id = ?`)
      .bind(taskId)
      .first<{ scene_before_json: string | null }>();
    const snapshot = sceneFromJson(row?.scene_before_json);
    if (snapshot) return { scene: snapshot, source: "task_snapshot" };
    if (!(await commitState(db, taskId))) {
      // The retried reply's commit never changed state.yaml: the current state IS the pre-reply state.
      return { scene: null, source: "retried_reply_never_committed" };
    }
    try {
      const raw = await fs.get(`sessions/${sessionId}/last_turn.json`);
      const last = raw ? (JSON.parse(raw) as { task_id?: unknown; scene_before?: unknown }) : {};
      if (last.task_id === taskId && last.scene_before) {
        const scene = sceneFromJson(JSON.stringify(last.scene_before));
        if (scene) return { scene, source: "last_turn_snapshot" };
      }
    } catch {
      /* ignore */
    }
  }
  // Legacy replies: the newest earlier turn whose commit recorded a state.
  const seen = new Set<string>();
  for (let i = input.retriedUserIndex - 1; i >= 0 && seen.size < 10; i -= 1) {
    const prevTask = input.messages[i]?.task_id;
    if (!prevTask || prevTask === taskId || seen.has(prevTask)) continue;
    seen.add(prevTask);
    const scene = await commitState(db, prevTask);
    if (scene) return { scene, source: "previous_turn_commit" };
  }
  return { scene: null, source: "kept_current" };
}
