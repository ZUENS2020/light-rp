import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { workspaceFs } from "../../src/adapters/r2";
import { parseScene, type SceneState } from "../../src/core/domain";
import { ensureSessionProjection, ensureWorkspaceProjection } from "../../src/server/models";
import { recordSceneBefore, resolveRetryBaseScene } from "../../src/server/retry-state";
import { completeTask, createTurnTask, recordToolExecution } from "../../src/server/tasks";

const migrations = inject("D1_MIGRATIONS");
beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

const scene = (label: string): SceneState => ({
  ...parseScene(`time: 夜\nlocation: ${label}\nscene: ${label}\nongoing:\n  - ${label}-item\n`),
});

async function seed() {
  const id = crypto.randomUUID();
  await ensureWorkspaceProjection(env.DB, { id: "world-r", name: "World", playerName: "你" });
  await ensureSessionProjection(env.DB, { id, workspaceId: "world-r", title: "Session" });
  return id;
}

async function turn(sessionId: string, text: string) {
  const created = await createTurnTask(env.DB, {
    workspaceId: "world-r",
    sessionId,
    text,
    idempotencyKey: `${sessionId}-${text}`,
  });
  return created.task.id;
}

async function commit(taskId: string, state: SceneState) {
  await recordToolExecution(env.DB, {
    taskId,
    toolCallId: `call-${taskId}`,
    toolName: "commit_turn",
    arguments: {},
    result: JSON.stringify({ state, events: [], memory_ops: [] }),
  });
}

describe("retry base scene", () => {
  it("restores the retried reply's own pre-reply snapshot (first write wins)", async () => {
    const sid = await seed();
    const fs = workspaceFs(env.BUCKET, "world-r");
    const t1 = await turn(sid, "一");
    await recordSceneBefore(env.DB, t1, scene("before"));
    await recordSceneBefore(env.DB, t1, scene("later"));
    await commit(t1, scene("after"));
    const out = await resolveRetryBaseScene(env.DB, fs, sid, {
      taskId: t1,
      messages: [
        { role: "user", task_id: t1 },
        { role: "assistant", task_id: t1 },
      ],
      retriedUserIndex: 0,
    });
    expect(out.source).toBe("task_snapshot");
    expect(out.scene?.location).toBe("before");
  });

  it("keeps the current state when the retried reply never committed", async () => {
    const sid = await seed();
    const fs = workspaceFs(env.BUCKET, "world-r");
    const t1 = await turn(sid, "一");
    await completeTask(env.DB, t1, { content: "答一" });
    const out = await resolveRetryBaseScene(env.DB, fs, sid, {
      taskId: t1,
      messages: [{ role: "user", task_id: t1 }],
      retriedUserIndex: 0,
    });
    expect(out).toEqual({ scene: null, source: "retried_reply_never_committed" });
  });

  it("falls back to the previous turn's committed state for legacy replies, else keeps current", async () => {
    const sid = await seed();
    const fs = workspaceFs(env.BUCKET, "world-r");
    const t1 = await turn(sid, "一");
    await commit(t1, scene("prev"));
    await completeTask(env.DB, t1, { content: "答一" });
    const t2 = await turn(sid, "二");
    await commit(t2, scene("latest"));
    const messages = [
      { role: "user", task_id: t1 },
      { role: "assistant", task_id: t1 },
      { role: "user", task_id: t2 },
      { role: "assistant", task_id: t2 },
    ];
    const out = await resolveRetryBaseScene(env.DB, fs, sid, { taskId: t2, messages, retriedUserIndex: 2 });
    expect(out.source).toBe("previous_turn_commit");
    expect(out.scene?.location).toBe("prev");
    const none = await resolveRetryBaseScene(env.DB, fs, sid, {
      taskId: t2,
      messages: messages.slice(2),
      retriedUserIndex: 0,
    });
    expect(none).toEqual({ scene: null, source: "kept_current" });
  });
});
