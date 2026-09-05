import {
  listNmemSpaces,
  loadNmemIndex,
  resolveSpaceId,
  saveNmemIndex,
  sessionThreadId,
  syncMemorySnapshotToNmem,
  syncThreadTurn,
  syncTurnBodyToNmem,
} from "../adapters/nmem";
import { nmemConnection, NmemOfflineError, takeNmemOffline } from "../adapters/nmem-connection";
import { workspaceFs } from "../adapters/r2";
import { loadMemory, loadPack, loadSession } from "../core/domain";
import { selectedNmemSpace } from "../core/memory";
import { loadSettings } from "./settings";
import { beginNmemSync, completeNmemSync, failNmemSync } from "./memory";

export async function connectionStatus(env: Env) {
  const state = await nmemConnection(env.DB);
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM nmem_jobs WHERE status IN ('deferred', 'running')",
  ).first<{ count: number }>();
  return { status: state.status, revision: state.revision, pending: pending?.count ?? 0 };
}

export async function connectNmem(env: Env) {
  const revision = await env.DB.prepare(
    `UPDATE nmem_connection SET status = 'probing', revision = revision + 1, updated_at = ?
    WHERE id = 'default' RETURNING revision`,
  )
    .bind(new Date().toISOString())
    .first<number>("revision");
  if (revision === null) throw new Error("nmem connection state missing");
  const listed = await listNmemSpaces({ ...env, nmemProbeRevision: revision, nmemDeadline: Date.now() + 1500 });
  const settings = await loadSettings(env.BUCKET);
  const selected = resolveSpaceId(settings.nmem.space, listed.spaces);
  if (!listed.available || !listed.spaces.some((space) => space.id === selected)) {
    await takeNmemOffline(env.DB, revision);
  } else {
    const connected = await env.DB.prepare(
      `UPDATE nmem_connection SET status = 'online', spaces_json = ?, updated_at = ?
      WHERE id = 'default' AND revision = ? AND status = 'probing'`,
    )
      .bind(JSON.stringify(listed.spaces), new Date().toISOString(), revision)
      .run();
    if (connected.meta.changes) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO nmem_snapshot_requests (workspace_id) SELECT id FROM workspaces WHERE 1
           ON CONFLICT(workspace_id) DO UPDATE SET revision = revision + 1`,
        ),
        env.DB.prepare("UPDATE nmem_jobs SET status = 'deferred' WHERE status = 'failed'"),
      ]);
    }
  }
  return connectionStatus(env);
}

export async function requestNmemSnapshot(env: Env, workspaceId: string, spaceId: string | null = null) {
  await env.DB.prepare(
    `INSERT INTO nmem_snapshot_requests (workspace_id, space_id) VALUES (?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET space_id = excluded.space_id, revision = revision + 1`,
  )
    .bind(workspaceId, spaceId)
    .run();
}

export async function wakeNmem(env: Env): Promise<void> {
  if ((await nmemConnection(env.DB)).status !== "online") return;
  const work = await env.DB.prepare(
    `SELECT task_id FROM nmem_jobs WHERE status IN ('deferred', 'running')
    UNION ALL SELECT workspace_id FROM nmem_snapshot_requests LIMIT 1`,
  ).first();
  if (!work) return;
  await env.NMEM_QUEUE.send({ kind: "nmem", taskId: "drain", sessionId: "" });
}

type Job = {
  task_id: string;
  workspace_id: string;
  session_id: string;
  steps_json: string;
  created_at: string;
  user_text: string;
  result_content: string;
};
type Steps = { memory?: string | null; thread?: boolean; core?: boolean };

/** The durable backlog, not the queue payload, is authoritative. One drainer preserves order. */
export async function drainNmem(env: Env): Promise<void> {
  if ((await nmemConnection(env.DB)).status !== "online") return;
  const owner = crypto.randomUUID();
  const ts = new Date().toISOString();
  const acquired = await env.DB.prepare(
    `UPDATE nmem_connection SET sync_owner = ?, sync_expires_at = ?
    WHERE id = 'default' AND status = 'online' AND (sync_expires_at IS NULL OR sync_expires_at < ?) RETURNING id`,
  )
    .bind(owner, new Date(Date.now() + 180_000).toISOString(), ts)
    .first();
  if (!acquired) return;
  const syncEnv = { ...env, nmemSyncOwner: owner };
  let more: boolean;
  try {
    const jobs = await env.DB.prepare(
      `SELECT j.*, g.user_text, g.result_content FROM nmem_jobs j
      JOIN generation_tasks g ON g.id = j.task_id
      WHERE j.status IN ('deferred', 'running') AND g.status = 'completed'
      ORDER BY j.rowid LIMIT 10`,
    ).all<Job>();
    more = jobs.results.length === 10;
    for (const job of jobs.results) {
      if ((await nmemConnection(env.DB)).status !== "online") break;
      const fs = workspaceFs(env.BUCKET, job.workspace_id);
      const settings = await loadSettings(env.BUCKET);
      const loaded = await loadSession(fs, job.session_id);
      const pack = await loadPack(fs, job.workspace_id);
      const spaces = await listNmemSpaces(env);
      const spaceId = resolveSpaceId(
        selectedNmemSpace(loaded.nmem_space, pack.nmem_space, settings.nmem.space),
        spaces.spaces,
      );
      if (!spaces.available || !spaceId || !spaces.spaces.some((space) => space.id === spaceId)) {
        await takeNmemOffline(env.DB);
        break;
      }
      const steps: Steps = JSON.parse(job.steps_json);
      const checkpoint = async () => {
        await env.DB.prepare("UPDATE nmem_jobs SET steps_json = ?, updated_at = ? WHERE task_id = ?")
          .bind(JSON.stringify(steps), new Date().toISOString(), job.task_id)
          .run();
      };
      const threadId = sessionThreadId(job.workspace_id, job.session_id);
      await beginNmemSync(env.DB, {
        taskId: job.task_id,
        workspaceId: job.workspace_id,
        sessionId: job.session_id,
        spaceId,
        attempt: 1,
      });
      await env.DB.prepare("UPDATE nmem_jobs SET status = 'running' WHERE task_id = ?").bind(job.task_id).run();
      try {
        if (!("memory" in steps)) {
          steps.memory = await syncTurnBodyToNmem(
            syncEnv,
            spaceId,
            job.workspace_id,
            job.session_id,
            job.user_text,
            job.result_content,
            job.task_id,
          );
          await checkpoint();
        }
        if (!steps.thread) {
          await syncThreadTurn(
            syncEnv,
            spaceId,
            null,
            threadId,
            `Light RP / ${job.workspace_id} / ${job.session_id}`,
            [
              { role: "user", content: job.user_text },
              { role: "assistant", content: job.result_content },
            ],
            job.task_id,
          );
          steps.thread = true;
          await checkpoint();
        }
        const memory = await loadMemory(fs);
        const count =
          memory.world.length +
          memory.player.length +
          Object.values(memory.characters).reduce((n, rows) => n + rows.length, 0);
        if (!steps.core) {
          const index = await loadNmemIndex((path) => fs.get(path));
          const synced = await syncMemorySnapshotToNmem(syncEnv, spaceId, index, job.workspace_id, memory);
          await saveNmemIndex((path, text, type) => fs.put(path, text, type), synced.index);
          steps.core = true;
          await checkpoint();
        }
        await completeNmemSync(env.DB, {
          taskId: job.task_id,
          coreMemoryCount: count,
          turnExternalId: steps.memory ?? null,
          threadId,
        });
        await env.DB.prepare("UPDATE nmem_jobs SET status = 'completed', updated_at = ? WHERE task_id = ?")
          .bind(new Date().toISOString(), job.task_id)
          .run();
      } catch (error) {
        if (error instanceof NmemOfflineError) {
          await env.DB.batch([
            env.DB.prepare("UPDATE nmem_jobs SET status = 'deferred' WHERE task_id = ?").bind(job.task_id),
            env.DB.prepare(
              "UPDATE generation_tasks SET nmem_sync_status = 'deferred', nmem_error = NULL WHERE id = ?",
            ).bind(job.task_id),
          ]);
          break;
        }
        await failNmemSync(env.DB, job.task_id, error, true);
        await env.DB.prepare("UPDATE nmem_jobs SET status = 'failed' WHERE task_id = ?").bind(job.task_id).run();
        throw error;
      }
    }
    if (!more && (await nmemConnection(env.DB)).status === "online") {
      const snapshots = await env.DB.prepare(
        "SELECT workspace_id, space_id, revision FROM nmem_snapshot_requests LIMIT 10",
      ).all<{
        workspace_id: string;
        space_id: string | null;
        revision: number;
      }>();
      for (const snapshot of snapshots.results) {
        const fs = workspaceFs(env.BUCKET, snapshot.workspace_id);
        const settings = await loadSettings(env.BUCKET);
        const listed = await listNmemSpaces(env);
        const pack = await loadPack(fs, snapshot.workspace_id);
        const spaceId = resolveSpaceId(
          snapshot.space_id || selectedNmemSpace(pack.nmem_space, settings.nmem.space),
          listed.spaces,
        );
        if (!listed.available || !spaceId || !listed.spaces.some((space) => space.id === spaceId)) {
          await takeNmemOffline(env.DB);
          break;
        }
        try {
          const synced = await syncMemorySnapshotToNmem(
            syncEnv,
            spaceId,
            await loadNmemIndex((path) => fs.get(path)),
            snapshot.workspace_id,
            await loadMemory(fs),
          );
          await saveNmemIndex((path, text, type) => fs.put(path, text, type), synced.index);
          await env.DB.prepare("DELETE FROM nmem_snapshot_requests WHERE workspace_id = ? AND revision = ?")
            .bind(snapshot.workspace_id, snapshot.revision)
            .run();
        } catch (error) {
          if (error instanceof NmemOfflineError) break;
          throw error;
        }
      }
      more = snapshots.results.length === 10;
    }
  } finally {
    await env.DB.prepare(
      "UPDATE nmem_connection SET sync_owner = NULL, sync_expires_at = NULL WHERE id = 'default' AND sync_owner = ?",
    )
      .bind(owner)
      .run();
  }
  if (more) await wakeNmem(env);
}
