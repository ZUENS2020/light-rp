import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { sha256, stableStringify } from "../../src/core/ai";
import {
  ensureSessionProjection,
  ensureWorkspaceProjection,
  listModels,
  resolveSessionModel,
  setApplicationDefaultModel,
  setSessionModel,
} from "../../src/server/models";
import {
  ActiveTaskConflict,
  completeTask,
  createTurnTask,
  getActiveTask,
  getCachedToolExecution,
  getTask,
  listMessages,
  recordToolExecution,
  replaceSessionTranscriptProjection,
} from "../../src/server/tasks";
import { memoryStatus, mirrorCoreMemorySnapshot } from "../../src/server/memory";
import { appendToolCallEvent, preparePrompt } from "../../src/server/prompt-state";

const migrations = inject("D1_MIGRATIONS");

beforeEach(async () => {
  await applyD1Migrations(env.DB, migrations);
});

async function seedSession(id = crypto.randomUUID()) {
  await ensureWorkspaceProjection(env.DB, { id: "world-1", name: "World", playerName: "你" });
  await ensureSessionProjection(env.DB, { id, workspaceId: "world-1", title: "Session" });
  return id;
}

describe("D1 task and model integration", () => {
  it("seeds the five model configs", async () => expect(await listModels(env.DB)).toHaveLength(5));

  it("resolves the OpenRouter preset as the application default", async () => {
    const id = await seedSession();
    const model = await resolveSessionModel(env.DB, id);
    expect(model.model_id).toBe("@preset/dsf0731-cheap");
    expect(model.source).toBe("application");
    expect(model.max_output_tokens).toBe(16_384);
  });

  it("seeds GLM 5.3 Flash on Command Code GOAT provider", async () => {
    const models = await listModels(env.DB);
    const glm = models.find((item) => item.id === "glm53-flash-cheap-openrouter");
    // transport stays gateway (CHECK); runtime routes commandcode via direct fetch
    expect(glm?.transport).toBe("gateway");
    expect(glm?.provider_slug).toBe("commandcode");
    expect(glm?.model_id).toBe("z-ai/glm-5.3-flash");
    expect(glm?.label).toBe("GLM 5.3 Flash · Command Code GOAT");
    expect(glm?.context_window).toBe(1_000_000);
    expect(glm?.max_output_tokens).toBeGreaterThanOrEqual(16_384);
    expect(glm?.enabled).toBe(true);
  });

  it("switches model and rotates epoch", async () => {
    const id = await seedSession();
    const model = await setSessionModel(env.DB, id, "kimi-k2-6-workers");
    const session = await env.DB.prepare(`SELECT prompt_epoch, affinity_key FROM sessions WHERE id = ?`)
      .bind(id)
      .first<{ prompt_epoch: number; affinity_key: string }>();
    expect(model.model_id).toBe("@cf/moonshotai/kimi-k2.6");
    expect(session?.prompt_epoch).toBe(2);
    expect(session?.affinity_key).toMatch(/^lrp-/);
  });

  it("switches the application default and rotates inheriting sessions", async () => {
    const id = await seedSession();
    const model = await setApplicationDefaultModel(env.DB, "kimi-k2-6-workers");
    const resolved = await resolveSessionModel(env.DB, id);
    const session = await env.DB.prepare(
      `SELECT prompt_epoch, prompt_epoch_reason, affinity_key FROM sessions WHERE id = ?`,
    )
      .bind(id)
      .first<{ prompt_epoch: number; prompt_epoch_reason: string; affinity_key: string }>();
    expect(model.id).toBe("kimi-k2-6-workers");
    expect(resolved.id).toBe("kimi-k2-6-workers");
    expect(resolved.source).toBe("application");
    expect(session).toMatchObject({ prompt_epoch: 2, prompt_epoch_reason: "model_changed" });
    expect(session?.affinity_key).toMatch(/^lrp-/);
  });

  it("returns the same task for an idempotency replay", async () => {
    const id = await seedSession();
    const first = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "hello",
      idempotencyKey: "same",
    });
    const second = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "hello",
      idempotencyKey: "same",
    });
    expect(second.task.id).toBe(first.task.id);
    expect(second.duplicate).toBe(true);
  });

  it("enforces one active generation per session", async () => {
    const id = await seedSession();
    await createTurnTask(env.DB, { workspaceId: "world-1", sessionId: id, text: "one", idempotencyKey: "one" });
    await expect(
      createTurnTask(env.DB, { workspaceId: "world-1", sessionId: id, text: "two", idempotencyKey: "two" }),
    ).rejects.toBeInstanceOf(ActiveTaskConflict);
    expect((await getActiveTask(env.DB, "world-1", id))?.status).toBe("pending");
  });

  it("commits assistant message and cache metrics atomically", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "hello",
      idempotencyKey: "one",
    });
    await completeTask(env.DB, created.task.id, {
      content: "world",
      cacheStatus: "HIT",
      usage: { prompt_tokens: 1_000, completion_tokens: 20, reasoning_tokens: 0, cached_input_tokens: 700 },
      stablePrefixTokens: 800,
      volatileTokens: 200,
    });
    const task = await getTask(env.DB, created.task.id);
    const page = await listMessages(env.DB, id);
    expect(task).toMatchObject({ status: "completed", response_cache_status: "HIT", cached_input_tokens: 700 });
    expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("replaceSessionTranscriptProjection replaces messages and reseeds tip llm_events", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "hello",
      idempotencyKey: "proj-1",
    });
    await completeTask(env.DB, created.task.id, { content: "old assistant reply" });
    const before = await listMessages(env.DB, id);
    expect(before.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const epochBefore = await env.DB.prepare(`SELECT prompt_epoch FROM sessions WHERE id = ?`)
      .bind(id)
      .first<{ prompt_epoch: number }>();

    // Trailing-only user: nothing to reseed into llm_events (preparePrompt adds task user).
    await replaceSessionTranscriptProjection(env.DB, id, [{ role: "user", content: "hello edited" }], "message_edited");

    const after = await listMessages(env.DB, id);
    expect(after.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: "user", content: "hello edited" },
    ]);
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM llm_events WHERE session_id = ?`)
      .bind(id)
      .first<{ n: number }>();
    expect(Number(events?.n || 0)).toBe(0);
    const session = await env.DB.prepare(
      `SELECT prompt_epoch, prompt_epoch_reason, next_message_sequence, next_event_sequence FROM sessions WHERE id = ?`,
    )
      .bind(id)
      .first<{
        prompt_epoch: number;
        prompt_epoch_reason: string;
        next_message_sequence: number;
        next_event_sequence: number;
      }>();
    expect(session?.prompt_epoch).toBe((epochBefore?.prompt_epoch || 1) + 1);
    expect(session?.prompt_epoch_reason).toBe("message_edited");
    expect(session?.next_message_sequence).toBe(2);
    expect(session?.next_event_sequence).toBe(1);

    // Tip with prior turns: reseed user+assistant, omit trailing user for preparePrompt.
    await replaceSessionTranscriptProjection(
      env.DB,
      id,
      [
        { role: "user", content: "我回到宿舍" },
        { role: "assistant", content: "宿舍台灯亮着，窗外操场很远。" },
        { role: "user", content: "继续" },
      ],
      "regenerated",
    );
    const seeded = await env.DB.prepare(
      `SELECT sequence, kind, role, payload_json FROM llm_events WHERE session_id = ? ORDER BY sequence`,
    )
      .bind(id)
      .all<{ sequence: number; kind: string; role: string; payload_json: string }>();
    expect((seeded.results || []).map((row) => ({ sequence: row.sequence, kind: row.kind, role: row.role }))).toEqual([
      { sequence: 1, kind: "user", role: "user" },
      { sequence: 2, kind: "assistant", role: "assistant" },
    ]);
    expect(seeded.results?.[0]?.payload_json).toContain("我回到宿舍");
    expect(seeded.results?.[1]?.payload_json).toContain("宿舍台灯亮着");
    const afterSeed = await env.DB.prepare(
      `SELECT prompt_epoch, next_message_sequence, next_event_sequence FROM sessions WHERE id = ?`,
    )
      .bind(id)
      .first<{ prompt_epoch: number; next_message_sequence: number; next_event_sequence: number }>();
    expect(afterSeed?.next_message_sequence).toBe(4);
    expect(afterSeed?.next_event_sequence).toBe(3);
    expect(afterSeed?.prompt_epoch).toBe((epochBefore?.prompt_epoch || 1) + 2);
  });

  it("commits assistant, state, and memory deltas in append-only prompt order", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "以后每周一一起晨练",
      idempotencyKey: "hidden-deltas",
    });
    await preparePrompt(env.DB, {
      sessionId: id,
      taskId: created.task.id,
      systemParts: ["稳定规则"],
      checkpoint: "初始状态与核心记忆",
      dynamicContext: "本轮世界书",
      userContent: "以后每周一一起晨练",
      tools: null,
    });
    await completeTask(env.DB, created.task.id, {
      content: "铃鹿认真地点了点头。",
      hiddenEvents: [
        { kind: "context", content: "## 场景状态变化\nscene: 晨练约定" },
        { kind: "memory", content: "## 核心记忆变更\n每周一一起晨练" },
      ],
    });

    const rows = await env.DB.prepare(
      `SELECT sequence, kind, role, payload_json FROM llm_events WHERE session_id = ? ORDER BY sequence`,
    )
      .bind(id)
      .all<{ sequence: number; kind: string; role: string; payload_json: string }>();
    expect(rows.results?.map((row) => row.kind)).toEqual([
      "checkpoint",
      "context",
      "user",
      "assistant",
      "context",
      "memory",
    ]);
    expect(rows.results?.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.parse(rows.results?.[5]?.payload_json || "{}").content).toContain("每周一一起晨练");
  });

  it("rotates to a fresh prompt epoch only after a compacted turn is committed", async () => {
    const id = await seedSession();
    const first = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "第一轮",
      idempotencyKey: "compact-first",
    });
    await preparePrompt(env.DB, {
      sessionId: id,
      taskId: first.task.id,
      systemParts: ["稳定规则"],
      checkpoint: "旧 epoch 检查点",
      dynamicContext: "旧上下文",
      userContent: "第一轮",
      tools: null,
    });
    await completeTask(env.DB, first.task.id, {
      content: "第一轮完成",
      hiddenEvents: [{ kind: "memory", content: "旧 epoch 的最后一条记忆" }],
      rotatePromptEpochReason: "context_compacted",
    });

    const rotated = await env.DB.prepare(
      `SELECT prompt_epoch, prompt_epoch_reason, next_event_sequence FROM sessions WHERE id = ?`,
    )
      .bind(id)
      .first<{ prompt_epoch: number; prompt_epoch_reason: string; next_event_sequence: number }>();
    expect(rotated).toMatchObject({
      prompt_epoch: 2,
      prompt_epoch_reason: "context_compacted",
      next_event_sequence: 1,
    });

    const second = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "第二轮",
      idempotencyKey: "compact-second",
    });
    await preparePrompt(env.DB, {
      sessionId: id,
      taskId: second.task.id,
      systemParts: ["稳定规则"],
      checkpoint: "压缩后的新检查点",
      dynamicContext: "新上下文",
      userContent: "第二轮",
      tools: null,
    });
    const epochTwo = await env.DB.prepare(
      `SELECT sequence, kind FROM llm_events WHERE session_id = ? AND prompt_epoch = 2 ORDER BY sequence`,
    )
      .bind(id)
      .all<{ sequence: number; kind: string }>();
    expect(epochTwo.results).toEqual([
      { sequence: 1, kind: "checkpoint" },
      { sequence: 2, kind: "context" },
      { sequence: 3, kind: "user" },
    ]);
  });

  it("replays the recent tail after a new epoch checkpoint and dedupes per-epoch parts", async () => {
    const id = await seedSession();
    const first = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "第三轮",
      idempotencyKey: "seed-first",
    });
    const common = {
      sessionId: id,
      systemParts: ["稳定规则"],
      checkpoint: "新检查点",
      dynamicContext: "## 当前状态\npresent: [suzuka]",
      tools: null,
      seedHistory: [
        { role: "user", content: "第一轮" },
        { role: "assistant", content: "铃鹿回答第一轮" },
      ],
      contextParts: [{ key: "mini:vodka", content: "## Mini 卡\n伏特加" }],
      memoryParts: [{ key: "charmem:suzuka", content: "## 角色记忆\n铃鹿记得晨练约定" }],
    };
    const prepared = await preparePrompt(env.DB, { ...common, taskId: first.task.id, userContent: "第三轮" });
    const firstContents = prepared.messages.map((m) => `${m.role}:${m.content}`);
    expect(firstContents).toEqual([
      "system:稳定规则",
      "user:## Epoch 初始上下文检查点\n新检查点",
      "user:第一轮",
      "assistant:铃鹿回答第一轮",
      "user:## 角色记忆\n铃鹿记得晨练约定",
      "user:## Mini 卡\n伏特加",
      "user:## 隐藏上下文增量\n## 当前状态\npresent: [suzuka]",
      "user:第三轮",
    ]);
    await completeTask(env.DB, first.task.id, { content: "第三轮完成" });

    const second = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "第四轮",
      idempotencyKey: "seed-second",
    });
    const secondPrepared = await preparePrompt(env.DB, {
      ...common,
      taskId: second.task.id,
      userContent: "第四轮",
      // Changed character memory is NOT re-sent (deltas cover it); unchanged mini is deduped.
      memoryParts: [{ key: "charmem:suzuka", content: "## 角色记忆\n铃鹿记得晨练约定+新事实" }],
    });
    const kinds = await env.DB.prepare(
      `SELECT kind, COUNT(*) AS n FROM llm_events WHERE session_id = ? GROUP BY kind ORDER BY kind`,
    )
      .bind(id)
      .all<{ kind: string; n: number }>();
    expect(Object.fromEntries((kinds.results || []).map((row) => [row.kind, Number(row.n)]))).toEqual({
      assistant: 2,
      checkpoint: 1,
      // mini (deduped) + one dynamic state copy per turn
      context: 3,
      memory: 1,
      user: 3,
    });
    // Only the newest state snapshot is replayed, right before the new user message.
    const secondContents = secondPrepared.messages.map((m) => `${m.role}:${m.content}`);
    expect(secondContents.filter((c) => c.includes("## 隐藏上下文增量"))).toHaveLength(1);
    expect(secondContents.slice(-2)).toEqual(["user:## 隐藏上下文增量\n## 当前状态\npresent: [suzuka]", "user:第四轮"]);
  });

  it("does not re-seed history into an epoch that already has reseeded transcript turns", async () => {
    const id = await seedSession();
    const runtime = await env.DB.prepare(`SELECT prompt_epoch FROM sessions WHERE id = ?`)
      .bind(id)
      .first<{ prompt_epoch: number }>();
    const epoch = runtime!.prompt_epoch;
    // Simulates replaceSessionTranscriptProjection: UA turns reseeded, no checkpoint yet.
    for (const [index, [kind, content]] of [
      ["user", "旧一"],
      ["assistant", "旧答一"],
    ].entries()) {
      await env.DB.prepare(
        `INSERT INTO llm_events (id, session_id, prompt_epoch, sequence, kind, role, payload_json, content_hash, stable, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`,
      )
        .bind(crypto.randomUUID(), id, epoch, index + 1, kind, kind, JSON.stringify({ content }), `h${index}`)
        .run();
    }
    await env.DB.prepare(`UPDATE sessions SET next_event_sequence = 3 WHERE id = ?`).bind(id).run();
    const task = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "新一轮",
      idempotencyKey: "reseeded-epoch",
    });
    const prepared = await preparePrompt(env.DB, {
      sessionId: id,
      taskId: task.task.id,
      systemParts: ["稳定规则"],
      checkpoint: "检查点",
      dynamicContext: "",
      userContent: "新一轮",
      tools: null,
      seedHistory: [
        { role: "user", content: "旧一" },
        { role: "assistant", content: "旧答一" },
      ],
    });
    const contents = prepared.messages.map((m) => m.content);
    expect(contents.filter((c) => c === "旧答一")).toHaveLength(1);
    expect(contents.filter((c) => c === "旧一")).toHaveLength(1);
  });

  it("persists story finish forensics on the completed task", async () => {
    const id = await seedSession();
    const task = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "测试",
      idempotencyKey: "finish-forensics",
    });
    await completeTask(env.DB, task.task.id, {
      content: "完成。",
      usage: { prompt_tokens: 100, completion_tokens: 42, reasoning_tokens: 0, cached_input_tokens: 0 },
      storyFinish: {
        finish_reason: "stop",
        first_finish_reason: "sensitive",
        completion_tokens: 42,
        retry: "abnormal:sensitive",
      },
    });
    const row = await env.DB.prepare(
      `SELECT finish_reason, completion_tokens, story_retry FROM generation_tasks WHERE id = ?`,
    )
      .bind(task.task.id)
      .first();
    expect(row).toEqual({ finish_reason: "stop", completion_tokens: 42, story_retry: "abnormal:sensitive" });
  });

  it("keeps OOC visible without adding it to the RP prompt", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "/ooc 解释一下当前关系",
      idempotencyKey: "ooc-one",
    });
    await completeTask(env.DB, created.task.id, {
      content: "这是 OOC 回答。",
      includeInPrompt: false,
    });
    const task = await getTask(env.DB, created.task.id);
    const eventCount = await env.DB.prepare(`SELECT COUNT(*) AS value FROM llm_events WHERE session_id = ?`)
      .bind(id)
      .first<{ value: number }>();
    const page = await listMessages(env.DB, id);
    expect(page.messages.map((message) => message.content)).toEqual(["/ooc 解释一下当前关系", "这是 OOC 回答。"]);
    expect(eventCount?.value).toBe(0);
    expect(task?.nmem_sync_status).toBe("not_requested");
  });

  it("persists omitted stable flags as zero for prompt and tool events", async () => {
    const id = await seedSession();
    await preparePrompt(env.DB, {
      sessionId: id,
      taskId: "prompt-task",
      systemParts: ["稳定系统规则"],
      checkpoint: "初始状态",
      dynamicContext: "天气变化",
      userContent: "继续训练",
      tools: null,
    });
    await appendToolCallEvent(env.DB, id, "prompt-task", "", [
      { id: "call-1", name: "memory", arguments: { action: "add", content: "约定晨练" } },
    ]);

    const rows = await env.DB.prepare(`SELECT kind, stable FROM llm_events WHERE session_id = ? ORDER BY sequence`)
      .bind(id)
      .all<{ kind: string; stable: number }>();
    expect(rows.results).toEqual([
      { kind: "checkpoint", stable: 1 },
      { kind: "context", stable: 0 },
      { kind: "user", stable: 0 },
      { kind: "tool_call", stable: 0 },
    ]);
  });

  it("paginates visible messages by cursor", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "hello",
      idempotencyKey: "one",
    });
    await completeTask(env.DB, created.task.id, { content: "world" });
    const page = await listMessages(env.DB, id, undefined, 1);
    expect(page.messages).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
  });

  it("deduplicates tool side effects", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "remember",
      idempotencyKey: "one",
    });
    const input = {
      taskId: created.task.id,
      toolCallId: "call-1",
      toolName: "memory",
      arguments: { action: "add", content: "x" },
      result: '{"success":true}',
    };
    await recordToolExecution(env.DB, input);
    await recordToolExecution(env.DB, input);
    const hash = await sha256(stableStringify(input.arguments));
    expect(await getCachedToolExecution(env.DB, input.taskId, input.toolCallId, hash)).toBe(input.result);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS value FROM tool_executions`).first<{ value: number }>();
    expect(count?.value).toBe(1);
  });

  it("mirrors Hermes core memory into D1 without nmem lifecycle writes", async () => {
    const id = await seedSession();
    const created = await createTurnTask(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      text: "还记得约定吗",
      idempotencyKey: "memory-turn",
    });
    const count = await mirrorCoreMemorySnapshot(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      taskId: created.task.id,
      snapshot: { world: ["港口仍封锁"], player: ["玩家不喝酒"], characters: { mei: ["记得周末约定"] } },
    });
    expect(count).toBe(3);
    expect(await memoryStatus(env.DB, id)).toMatchObject({
      core: { world: 1, player: 1, character: 1 },
      recall: null,
      sync: null,
    });
    expect(await getTask(env.DB, created.task.id)).toMatchObject({
      nmem_sync_status: "not_requested",
    });
  });

  it("mirrors core memory incrementally without mass-forget", async () => {
    const id = await seedSession();
    const snapshot = {
      world: ["港口仍封锁"],
      player: ["玩家不喝酒"],
      characters: { mei: ["记得周末约定"] },
    };
    await mirrorCoreMemorySnapshot(env.DB, { workspaceId: "world-1", sessionId: id, snapshot });
    const before = await env.DB.prepare(
      `SELECT id, content, status, updated_at FROM memories
       WHERE workspace_id = 'world-1' AND scope IN ('world', 'player', 'character')
       ORDER BY id`,
    ).all<{ id: string; content: string; status: string; updated_at: string }>();
    expect(before.results).toHaveLength(3);
    expect(before.results.every((row) => row.status === "active")).toBe(true);
    expect(before.results.every((row) => row.id.startsWith("core:"))).toBe(true);

    await mirrorCoreMemorySnapshot(env.DB, { workspaceId: "world-1", sessionId: id, snapshot });
    const unchanged = await env.DB.prepare(
      `SELECT id, status, updated_at FROM memories
       WHERE workspace_id = 'world-1' AND scope IN ('world', 'player', 'character')
       ORDER BY id`,
    ).all<{ id: string; status: string; updated_at: string }>();
    expect(unchanged.results).toEqual(before.results.map(({ id, status, updated_at }) => ({ id, status, updated_at })));

    await mirrorCoreMemorySnapshot(env.DB, {
      workspaceId: "world-1",
      sessionId: id,
      snapshot: {
        world: ["港口仍封锁"],
        player: ["玩家改喝茶"],
        characters: { mei: ["记得周末约定"] },
      },
    });
    const after = await env.DB.prepare(
      `SELECT id, content, status FROM memories
       WHERE workspace_id = 'world-1' AND scope IN ('world', 'player', 'character')
       ORDER BY content`,
    ).all<{ id: string; content: string; status: string }>();
    const byContent = Object.fromEntries(after.results.map((row) => [row.content, row.status]));
    expect(byContent["港口仍封锁"]).toBe("active");
    expect(byContent["记得周末约定"]).toBe("active");
    expect(byContent["玩家不喝酒"]).toBe("forgotten");
    expect(byContent["玩家改喝茶"]).toBe("active");
    const kept = after.results.filter((row) => row.content === "港口仍封锁" || row.content === "记得周末约定");
    const beforeById = Object.fromEntries(before.results.map((row) => [row.id, row.updated_at]));
    for (const row of kept) {
      const stamped = await env.DB.prepare(`SELECT updated_at FROM memories WHERE id = ?`)
        .bind(row.id)
        .first<{ updated_at: string }>();
      expect(stamped?.updated_at).toBe(beforeById[row.id]);
    }
  });

  it("never creates a reasoning column or persisted reasoning payload", async () => {
    const columns = await env.DB.prepare(`PRAGMA table_info(llm_events)`).all<{ name: string }>();
    expect((columns.results || []).map((column: { name: string }) => column.name)).not.toContain("reasoning_content");
    const leaks = await env.DB.prepare(
      `SELECT COUNT(*) AS value FROM llm_events WHERE payload_json LIKE '%reasoning_content%'`,
    ).first<{ value: number }>();
    expect(leaks?.value).toBe(0);
  });
});
