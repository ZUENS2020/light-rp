import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, inject, it, vi } from "vitest";
import { ensureSessionProjection, ensureWorkspaceProjection } from "../../src/server/models";
import {
  beginCommit,
  cancelTask,
  completeTask,
  createTurnTask,
  flushGenerationOutbox,
  getActiveTask,
  getTask,
  leaseTask,
  listMessages,
  markOutboxPublished,
} from "../../src/server/tasks";
import { MAX_GENERATION_ATTEMPTS, recoverGenerationTasks } from "../../src/server/generation-recovery";
import { consumeGeneration } from "../../src/server/generation-service";
import { workspaceFs } from "../../src/adapters/r2";
import { createWorkspace } from "../../src/server/seed";

const migrations = inject("D1_MIGRATIONS");
const old = "2000-01-01T00:00:00.000Z";
beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.prepare("DELETE FROM workspaces WHERE id = 'recovery'").run();
  await env.DB.prepare("UPDATE nmem_connection SET status = 'offline' WHERE id = 'default'").run();
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
function delivery(taskId: string, attempts = 1): Message<{ taskId: string; sessionId: string }> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body: { taskId, sessionId: "recovery-session" },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
function queueEnv() {
  const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
  return { send, runtime: { ...env, GENERATE_QUEUE: { ...env.GENERATE_QUEUE, send } } };
}

it("recovers a published task after its consumer died, even when the Queue is empty", async () => {
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
  expect(await beginCommit(env.DB, task.id, "{}", "dead-owner")).toBe(false);
  expect((await listMessages(env.DB, task.session_id)).messages).toHaveLength(1);
});

it("acknowledges duplicate deliveries without burning retries or stealing a healthy lease", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "healthy-owner");
  await markOutboxPublished(env.DB, task.id);
  await env.DB.prepare("UPDATE generation_tasks SET updated_at = ? WHERE id = ?").bind(old, task.id).run();
  const ctx = createExecutionContext();
  const msg = delivery(task.id, 4);
  await consumeGeneration(env, msg, ctx);
  await waitOnExecutionContext(ctx);
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(msg.ack).toHaveBeenCalledOnce();
  expect(msg.retry).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(await getTask(env.DB, task.id)).toMatchObject({
    status: "running",
    lease_owner: "healthy-owner",
    attempt_count: 1,
  });
});

it("recovers lost pending deliveries while leaving new pending deliveries alone", async () => {
  const task = await turn();
  await markOutboxPublished(env.DB, task.id);
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(send).not.toHaveBeenCalled();
  await env.DB.prepare("UPDATE generation_tasks SET updated_at = ? WHERE id = ?").bind(old, task.id).run();
  await flushGenerationOutbox(runtime);
  expect(send).toHaveBeenCalledOnce();
});

it("stops after four real executions and unlocks the session without deleting input", async () => {
  const task = await turn();
  await markOutboxPublished(env.DB, task.id);
  for (let n = 1; n <= MAX_GENERATION_ATTEMPTS; n++) {
    expect((await leaseTask(env.DB, task.id, `owner-${n}`))?.attempt_count).toBe(n);
    await expire(task.id);
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

it("does not resurrect cancelled or completed tasks", async () => {
  const cancelled = await turn();
  await cancelTask(env.DB, cancelled.id);
  await expire(cancelled.id);
  const completed = await turn();
  await completeTask(env.DB, completed.id, { content: "existing reply" });
  await expire(completed.id);
  const { runtime, send } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(send).not.toHaveBeenCalled();
  expect((await getTask(env.DB, cancelled.id))?.status).toBe("cancelled");
  expect((await getTask(env.DB, completed.id))?.status).toBe("completed");
});

it("recovers a committing task by replaying the original journal, without a model call", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "dead-owner");
  await markOutboxPublished(env.DB, task.id);
  const fs = workspaceFs(env.BUCKET, "recovery");
  const staged = fs.stage();
  await staged.put("recovery-proof.txt", "saved once");
  const artifactKey = `v2/tasks/${task.id}/test.json`;
  await env.BUCKET.put(artifactKey, JSON.stringify(staged.journal()));
  const payload = JSON.stringify({ artifactKey, completion: { content: "original reply", includeInPrompt: false } });
  await beginCommit(env.DB, task.id, payload, "dead-owner");
  await expire(task.id);
  const { runtime } = queueEnv();
  await flushGenerationOutbox(runtime);
  expect(await getTask(env.DB, task.id)).toMatchObject({ execution_phase: "committing", commit_payload_json: payload });
  const gateway = vi.fn(() => {
    throw new Error("Recovery must not call AI");
  });
  const ctx = createExecutionContext();
  const msg = delivery(task.id);
  const ai = new Proxy(env.AI, {
    get: (target, key) => (key === "gateway" ? gateway : Reflect.get(target, key, target)),
  });
  await consumeGeneration({ ...env, AI: ai }, msg, ctx);
  await consumeGeneration(env, msg, ctx);
  await waitOnExecutionContext(ctx);
  expect(gateway).not.toHaveBeenCalled();
  expect(await fs.get("recovery-proof.txt")).toBe("saved once");
  expect((await getTask(env.DB, task.id))?.status).toBe("completed");
  expect((await listMessages(env.DB, task.session_id)).messages.filter((m) => m.role === "assistant")).toHaveLength(1);
});

it("uses persisted execution count for failure limits, independent of redelivery count", async () => {
  await createWorkspace(env.BUCKET, "recovery", "Recovery");
  const task = await turn("/ooc test retry accounting");
  const run = vi.fn(async () => new Response("", { status: 503 }));
  const gateway = env.AI.gateway("test");
  const mockedGateway = new Proxy(gateway, {
    get: (target, key) => (key === "run" ? run : Reflect.get(target, key, target)),
  });
  const ai = new Proxy(env.AI, {
    get: (target, key) => (key === "gateway" ? () => mockedGateway : Reflect.get(target, key, target)),
  });
  const ctx = createExecutionContext();
  await consumeGeneration({ ...env, AI: ai }, delivery(task.id, 4), ctx);
  expect(await getTask(env.DB, task.id)).toMatchObject({ status: "pending", attempt_count: 1 });
  await env.DB.prepare("UPDATE generation_tasks SET attempt_count = 3 WHERE id = ?").bind(task.id).run();
  await consumeGeneration({ ...env, AI: ai }, delivery(task.id, 1), ctx);
  await waitOnExecutionContext(ctx);
  expect(await getTask(env.DB, task.id)).toMatchObject({ status: "dead", attempt_count: 4 });
  expect(run).toHaveBeenCalledTimes(2);
});

it("rolls back the outbox reset if the matching task recovery cannot commit", async () => {
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
