import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, env } from "cloudflare:test";
import { beforeEach, afterEach, expect, inject, it, vi } from "vitest";
import { ensureSessionProjection, ensureWorkspaceProjection } from "../../src/server/models";
import {
  beginCommit,
  cancelTask,
  completeTask,
  createTurnTask,
  getTask,
  flushGenerationOutbox,
  leaseTask,
  listMessages,
} from "../../src/server/tasks";
import { connectNmem, drainNmem, connectionStatus } from "../../src/server/nmem-service";
import { listNmemSpaces, searchNmem } from "../../src/adapters/nmem";
import { nmemConnection, takeNmemOffline } from "../../src/adapters/nmem-connection";
import { workspaceFs } from "../../src/adapters/r2";
import { createWorkspace } from "../../src/server/seed";
import { consumeGeneration } from "../../src/server/generation-service";
import worker from "../../src/server/index";
import { loadMemory, loadSession } from "../../src/core/domain";

const migrations = inject("D1_MIGRATIONS");
const testEnv = { ...env, NMEM_API_KEY: "test-key" };
beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
  await env.DB.prepare("DELETE FROM workspaces WHERE id = 'runtime'").run();
  await env.DB.prepare(
    "UPDATE nmem_connection SET status = 'offline', revision = revision + 1, sync_owner = NULL, sync_expires_at = NULL WHERE id = 'default'",
  ).run();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request in test");
    }),
  );
  await ensureWorkspaceProjection(env.DB, { id: "runtime", name: "Runtime", playerName: "你" });
  await ensureSessionProjection(env.DB, { id: "runtime-session", workspaceId: "runtime", title: "Test" });
  const fs = workspaceFs(env.BUCKET, "runtime");
  for (const path of await fs.list()) await fs.del(path);
  await createWorkspace(env.BUCKET, "runtime", "Runtime");
});
afterEach(() => vi.unstubAllGlobals());

async function turn(text = "约定") {
  return (
    await createTurnTask(env.DB, {
      workspaceId: "runtime",
      sessionId: "runtime-session",
      text,
      idempotencyKey: crypto.randomUUID(),
    })
  ).task;
}
function onlineFetcher() {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/spaces")) return Response.json([{ id: "rp-mem", name: "RP mem", key: "rp-mem" }]);
    if (url.endsWith("/memories")) return Response.json({ id: JSON.parse(String(init?.body)).id });
    if (url.endsWith("/threads")) return new Response("{}", { status: 409 });
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetcher);
  return { fetcher, requests };
}

it("starts offline and never probes during ordinary reads or queue delivery", async () => {
  const task = await turn();
  await completeTask(env.DB, task.id, { content: "回应" });
  expect((await listNmemSpaces(testEnv)).available).toBe(false);
  await drainNmem(testEnv);
  expect(fetch).not.toHaveBeenCalled();
  expect(await connectionStatus(testEnv)).toMatchObject({ status: "offline", pending: 1 });
  expect((await getTask(env.DB, task.id))?.status).toBe("completed");
});

it("only resumes after explicit connect and drains each turn once", async () => {
  const one = await turn("第一轮");
  await completeTask(env.DB, one.id, { content: "第一轮回应" });
  const two = await turn("第二轮");
  await completeTask(env.DB, two.id, { content: "第二轮回应" });
  const { fetcher } = onlineFetcher();
  expect((await connectNmem(testEnv)).status).toBe("online");
  await Promise.all([drainNmem(testEnv), drainNmem(testEnv)]);
  await drainNmem(testEnv);
  const writes = fetcher.mock.calls.filter(([url]) => url.endsWith("/memories"));
  expect(writes.map(([, init]) => JSON.parse(String(init?.body)).id)).toEqual([
    `lightrp-turn-${one.id}`,
    `lightrp-turn-${two.id}`,
  ]);
  expect(await connectionStatus(testEnv)).toMatchObject({ pending: 0 });
});

it("latches offline on failure, preserving pending work until manual recovery", async () => {
  const task = await turn();
  await completeTask(env.DB, task.id, { content: "回应" });
  onlineFetcher();
  await connectNmem(testEnv);
  const failure = vi.fn(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", failure);
  await drainNmem(testEnv);
  await drainNmem(testEnv);
  expect(failure).toHaveBeenCalledOnce();
  expect(await connectionStatus(testEnv)).toMatchObject({ status: "offline", pending: 1 });
  expect((await getTask(env.DB, task.id))?.nmem_sync_status).toBe("deferred");
  onlineFetcher();
  await connectNmem(testEnv);
  await drainNmem(testEnv);
  expect((await getTask(env.DB, task.id))?.nmem_sync_status).toBe("completed");
});

it("does not let a stale failed request override a newer connection revision", async () => {
  onlineFetcher();
  await connectNmem(testEnv);
  const old = await nmemConnection(env.DB);
  await connectNmem(testEnv);
  await takeNmemOffline(env.DB, old.revision);
  expect((await nmemConnection(env.DB)).status).toBe("online");
  await takeNmemOffline(env.DB);
  await expect(searchNmem(testEnv, "rp-mem", "约定")).rejects.toThrow("offline");
});

it("cancels idempotently and cannot commit an assistant or nmem job afterward", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "owner");
  expect((await cancelTask(env.DB, task.id))?.status).toBe("cancelled");
  expect((await cancelTask(env.DB, task.id))?.status).toBe("cancelled");
  expect(await beginCommit(env.DB, task.id, "{}", "owner")).toBe(false);
  await completeTask(env.DB, task.id, { content: "must not appear" });
  expect((await listMessages(env.DB, task.session_id)).messages.map((row) => row.role)).toEqual(["user"]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM nmem_jobs").first("n")).toBe(0);
});

it("lets a winning commit finish once instead of falsely reporting cancellation", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "owner");
  expect(await beginCommit(env.DB, task.id, "{}", "owner")).toBe(true);
  expect((await cancelTask(env.DB, task.id))?.status).toBe("committing");
  await Promise.all([
    completeTask(env.DB, task.id, { content: "saved" }),
    completeTask(env.DB, task.id, { content: "saved" }),
  ]);
  expect((await listMessages(env.DB, task.session_id)).messages).toHaveLength(2);
});

it("stages R2 mutations without touching live state and replays the journal idempotently", async () => {
  const fs = workspaceFs(env.BUCKET, "runtime");
  await fs.put("MEMORY.md", "old");
  const staged = fs.stage();
  await staged.put("MEMORY.md", "new");
  await staged.put("memories/npc.md", "fact");
  expect(await staged.get("MEMORY.md")).toBe("new");
  expect(await fs.get("MEMORY.md")).toBe("old");
  expect(await staged.list("memories/")).toContain("memories/npc.md");
  await fs.replay(staged.journal());
  await fs.replay(staged.journal());
  expect(await fs.get("MEMORY.md")).toBe("new");
});

function delivery(taskId: string): Message<{ taskId: string; sessionId: string }> {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body: { taskId, sessionId: "runtime-session" },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

it("cancels an in-flight provider request without committing its late reply or R2 changes", async () => {
  const task = await turn("/ooc explain");
  let finish!: (response: Response) => void;
  const run = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const aiEnv = { ...testEnv, AI: { gateway: () => ({ run }) } } as unknown as Env;
  const message = delivery(task.id);
  const ctx = createExecutionContext();
  const pending = consumeGeneration(aiEnv, message, ctx);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await cancelTask(env.DB, task.id);
  await pending;
  await waitOnExecutionContext(ctx);
  finish(Response.json({ choices: [{ message: { content: "late reply" } }] }));
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
  expect(await workspaceFs(env.BUCKET, "runtime").get("sessions/runtime-session/transcript.jsonl")).toBeNull();
  expect((await listMessages(env.DB, task.session_id)).messages.map((row) => row.role)).toEqual(["user"]);
  expect(fetch).not.toHaveBeenCalled();
});

it("replays an interrupted commit without invoking AI or duplicating the assistant", async () => {
  const task = await turn();
  await leaseTask(env.DB, task.id, "interrupted-owner");
  const fs = workspaceFs(env.BUCKET, "runtime");
  const staged = fs.stage();
  await staged.put("MEMORY.md", "a durable fact");
  const artifactKey = `v2/tasks/${task.id}/test-journal.json`;
  await env.BUCKET.put(artifactKey, JSON.stringify(staged.journal()));
  await beginCommit(
    env.DB,
    task.id,
    JSON.stringify({ artifactKey, completion: { content: "saved" } }),
    "interrupted-owner",
  );
  await env.DB.prepare("UPDATE generation_tasks SET lease_expires_at = ? WHERE id = ?")
    .bind("2000-01-01T00:00:00Z", task.id)
    .run();
  const message = delivery(task.id);
  const ctx = createExecutionContext();
  await consumeGeneration(testEnv, message, ctx);
  await consumeGeneration(testEnv, message, ctx);
  await waitOnExecutionContext(ctx);
  expect((await getTask(env.DB, task.id))?.status).toBe("completed");
  expect(await fs.get("MEMORY.md")).toBe("a durable fact");
  expect((await listMessages(env.DB, task.session_id)).messages).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps pre-delivery cancelled input visible and rejects retired edit/turn endpoints", async () => {
  const task = await turn("visible cancelled input");
  await cancelTask(env.DB, task.id);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request("http://local/api/v2/play/runtime/runtime-session"), testEnv, ctx);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ messages: [{ content: "visible cancelled input", role: "user" }] });
  for (const action of ["rewrite", "turn"]) {
    const removed = await worker.fetch(
      new Request(`http://local/api/v2/play/runtime/runtime-session/${action}`, { method: "POST" }),
      testEnv,
      ctx,
    );
    expect(removed.status).toBe(404);
  }
  await waitOnExecutionContext(ctx);
  expect(fetch).not.toHaveBeenCalled();
});

it("resumes after a partial nmem sync without writing the completed memory step twice", async () => {
  const task = await turn();
  await completeTask(env.DB, task.id, { content: "answer" });
  const { fetcher } = onlineFetcher();
  await connectNmem(testEnv);
  const healthy = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) =>
    url.endsWith("/threads") ? new Response("", { status: 503 }) : healthy(url, init),
  );
  await drainNmem(testEnv);
  expect((await connectionStatus(testEnv)).status).toBe("offline");
  fetcher.mockImplementation(healthy);
  await connectNmem(testEnv);
  await drainNmem(testEnv);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/memories"))).toHaveLength(1);
  expect((await connectionStatus(testEnv)).pending).toBe(0);
});

it("recovers unpublished generation work without waking cancelled tasks", async () => {
  const cancelled = await turn("cancelled");
  await cancelTask(env.DB, cancelled.id);
  const pending = await turn("queued");
  const send = vi.fn(async () => undefined);
  const queueEnv = { ...testEnv, GENERATE_QUEUE: { send } } as unknown as Env;
  await flushGenerationOutbox(queueEnv);
  await flushGenerationOutbox(queueEnv);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ taskId: pending.id }));
  expect(fetch).not.toHaveBeenCalled();
});

function storyResponse() {
  return Response.json({
    choices: [
      {
        message: { content: "你们抵达训练场，约好明天再一起晨练。", reasoning_content: "never persist this thought" },
        finish_reason: "stop",
      },
    ],
  });
}

it("commits narrative, scene, core memory and durable sync work together with no live nmem calls", async () => {
  const task = await turn("明天继续一起晨练");
  const run = vi
    .fn()
    .mockResolvedValueOnce(storyResponse())
    .mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "commit-1",
                  type: "function",
                  function: {
                    name: "commit_turn",
                    arguments: JSON.stringify({
                      state: {
                        time: "清晨",
                        season: "初秋",
                        weather: "晴",
                        location: "训练场",
                        present: [],
                        scene: "抵达训练场",
                        ongoing: ["晨练"],
                      },
                      events: ["抵达训练场"],
                      memory_ops: [
                        {
                          action: "add",
                          target: "player",
                          content: "约定明天一起晨练",
                          type: "promise",
                          importance: 0.9,
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  const aiEnv = { ...testEnv, AI: { gateway: () => ({ run }) } } as unknown as Env;
  const message = delivery(task.id);
  const ctx = createExecutionContext();
  await consumeGeneration(aiEnv, message, ctx);
  await waitOnExecutionContext(ctx);
  const fs = workspaceFs(env.BUCKET, "runtime");
  expect((await getTask(env.DB, task.id))?.status).toBe("completed");
  expect((await loadSession(fs, task.session_id)).messages).toHaveLength(2);
  expect(await fs.get(`sessions/${task.session_id}/state.yaml`)).toContain("训练场");
  expect((await loadMemory(fs)).player.join(" ")).toContain("约定明天一起晨练");
  expect((await connectionStatus(testEnv)).pending).toBe(1);
  const archive = await Promise.all((await fs.list()).map((path) => fs.get(path)));
  expect(JSON.stringify(archive)).not.toContain("never persist this thought");
  expect(run).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("stops during state extraction without leaking staged state or memory", async () => {
  const task = await turn("进入训练场");
  const run = vi
    .fn()
    .mockResolvedValueOnce(storyResponse())
    .mockImplementationOnce(() => new Promise<Response>(() => undefined));
  const aiEnv = { ...testEnv, AI: { gateway: () => ({ run }) } } as unknown as Env;
  const message = delivery(task.id);
  const ctx = createExecutionContext();
  const pending = consumeGeneration(aiEnv, message, ctx);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await cancelTask(env.DB, task.id);
  await pending;
  await waitOnExecutionContext(ctx);
  const fs = workspaceFs(env.BUCKET, "runtime");
  expect(await fs.get(`sessions/${task.session_id}/state.yaml`)).toBeNull();
  expect((await loadMemory(fs)).player).toEqual([]);
  expect((await listMessages(env.DB, task.session_id)).messages).toHaveLength(1);
  expect((await connectionStatus(testEnv)).pending).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
