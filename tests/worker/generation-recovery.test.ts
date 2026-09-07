import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, expect, inject, it, vi } from "vitest";
import { ensureSessionProjection, ensureWorkspaceProjection } from "../../src/server/models";
import {
  createTurnTask,
  flushGenerationOutbox,
  getActiveTask,
  getTask,
  leaseTask,
  listMessages,
  markOutboxPublished,
} from "../../src/server/tasks";
import { MAX_GENERATION_ATTEMPTS, recoverGenerationTasks } from "../../src/server/generation-recovery";

const migrations = inject("D1_MIGRATIONS");
const old = "2000-01-01T00:00:00.000Z";

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.prepare("DELETE FROM workspaces WHERE id = 'recovery'").run();
  await ensureWorkspaceProjection(env.DB, { id: "recovery", name: "Recovery", playerName: "Test" });
  await ensureSessionProjection(env.DB, { id: "recovery-session", workspaceId: "recovery", title: "Test" });
});

async function turn(text = "keep my input") {
  return (
    await createTurnTask(env.DB, {
      workspaceId: "recovery",
      sessionId: "recovery-session",
      text,
      idempotencyKey: crypto.randomUUID(),
    })
  ).task;
}

async function expire(id: string) {
  await env.DB.prepare("UPDATE generation_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
    .bind(old, old, id)
    .run();
}

function queueEnv() {
  const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  return { send, runtime: { ...env, GENERATE_QUEUE: { ...env.GENERATE_QUEUE, send } } };
}

it("recovers a published task after its consumer died", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "dead-owner");
  await markOutboxPublished(env.DB, task.id);
  await expire(task.id);
  const { runtime, send } = queueEnv();
  await Promise.all([recoverGenerationTasks(env.DB), recoverGenerationTasks(env.DB)]);
  await flushGenerationOutbox(runtime);
  await flushGenerationOutbox(runtime);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id }));
  expect(await getTask(env.DB, task.id)).toMatchObject({
    status: "pending",
    lease_owner: null,
    attempt_count: 1,
    error_code: "TASK_LEASE_EXPIRED",
  });
  expect((await listMessages(env.DB, task.session_id)).messages).toHaveLength(1);
});

it("leaves a healthy lease alone", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "healthy-owner");
  await markOutboxPublished(env.DB, task.id);
  await env.DB.prepare("UPDATE generation_tasks SET updated_at = ? WHERE id = ?").bind(old, task.id).run();
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(send).not.toHaveBeenCalled();
  expect(await getTask(env.DB, task.id)).toMatchObject({
    status: "running",
    lease_owner: "healthy-owner",
    attempt_count: 1,
  });
});

it("recovers lost pending deliveries after the grace window", async () => {
  const task = await turn();
  await markOutboxPublished(env.DB, task.id);
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(send).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE generation_tasks SET updated_at = ? WHERE id = ?").bind(old, task.id).run();
  await flushGenerationOutbox(runtime);
  expect(send).toHaveBeenCalledOnce();
});

it("stops after four real executions and unlocks the session", async () => {
  const task = await turn();
  await markOutboxPublished(env.DB, task.id);
  for (let n = 1; n <= MAX_GENERATION_ATTEMPTS; n++) {
    expect((await leaseTask(env.DB, task.id, `owner-${n}`))?.attempt_count).toBe(n);
    await expire(task.id);
    await recoverGenerationTasks(env.DB);
  }
  expect(await leaseTask(env.DB, task.id, "fifth-owner")).toBeNull();
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(send).not.toHaveBeenCalled();
  expect(await getTask(env.DB, task.id)).toMatchObject({ status: "dead", error_code: "TASK_RETRY_EXHAUSTED" });
  expect(await getActiveTask(env.DB, "recovery", task.session_id)).toBeNull();
  expect((await listMessages(env.DB, task.session_id)).messages[0].content).toBe("keep my input");
  expect((await turn()).id).not.toBe(task.id);
});

it("rolls back the outbox reset if task recovery cannot commit", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "dead-owner");
  await markOutboxPublished(env.DB, task.id);
  await expire(task.id);
  await env.DB.prepare(
    `CREATE TRIGGER fail_recovery BEFORE UPDATE OF status ON generation_tasks
    WHEN NEW.session_id = 'recovery-session' AND NEW.status = 'pending'
    BEGIN SELECT RAISE(ABORT, 'simulated recovery failure'); END`,
  ).run();
  try {
    await expect(recoverGenerationTasks(env.DB)).rejects.toThrow("simulated recovery failure");
    expect(
      await env.DB.prepare(
        "SELECT published_at FROM outbox_events WHERE aggregate_id = ? AND event_type = 'generation.requested'",
      )
        .bind(task.id)
        .first("published_at"),
    ).not.toBeNull();
    expect(await getTask(env.DB, task.id)).toMatchObject({ status: "running", lease_owner: "dead-owner" });
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_recovery").run();
  }
});

it("writes nothing when flush finds no stale or unpublished work", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "healthy-owner");
  await markOutboxPublished(env.DB, task.id);
  const stamp = "2011-01-01T00:00:00.000Z";
  await env.DB.prepare("UPDATE generation_tasks SET updated_at = ? WHERE id = ?").bind(stamp, task.id).run();
  const publishedAt = await env.DB.prepare(
    "SELECT published_at FROM outbox_events WHERE aggregate_id = ? AND event_type = 'generation.requested'",
  )
    .bind(task.id)
    .first<string>("published_at");
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  await recoverGenerationTasks(env.DB);
  expect(send).not.toHaveBeenCalled();
  expect(await getTask(env.DB, task.id)).toMatchObject({
    status: "running",
    lease_owner: "healthy-owner",
    updated_at: stamp,
  });
  expect(
    await env.DB.prepare(
      "SELECT published_at FROM outbox_events WHERE aggregate_id = ? AND event_type = 'generation.requested'",
    )
      .bind(task.id)
      .first("published_at"),
  ).toBe(publishedAt);
});
