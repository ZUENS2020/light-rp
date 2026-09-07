import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { chat } from "../adapters/ai-gateway";
import { sha256, stableStringify, type AiModelConfig, type ResponseCacheStatus } from "../core/ai";
import { createPromptEpoch } from "./prompt-state";
import {
  ensureSessionProjection,
  ensureWorkspaceProjection,
  getApplicationDefaultModel,
  getModel,
  listModels,
  recordProbe,
  resolveSessionModel,
  sessionRuntime,
  setApplicationDefaultModel,
  setSessionModel,
  upsertModel,
} from "./models";
import { ActiveTaskConflict, createTurnTask, getActiveTask, getTask, getTaskByIdempotency, insertPending, listMessages, publishTask, replaceSessionTranscriptProjection } from "./tasks";
import { memoryStatus, mirrorCoreMemorySnapshot } from "./memory";
import {
  loadLorebookText,
  loadMemory,
  loadPack,
  loadSession,
  saveSession,
  type WorldPack,
} from "../core/domain";
import { workspaceFs } from "../adapters/r2";
import { isUnknownSlashCommand, parseSystemCommand } from "../core/commands";

type App = Hono<{ Bindings: Env }>;

const turnSchema = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();
const modelSelectionSchema = z.object({ model_config_id: z.string().min(1).max(120).nullable() }).strict();
const applicationModelSchema = z.object({ model_config_id: z.string().min(1).max(120) }).strict();
const memorySyncSchema = z.object({ space_id: z.string().trim().min(1).max(120).optional() }).strict();
const modelSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
    label: z.string().trim().min(1).max(100),
    transport: z.enum(["cloudflare", "gateway"]),
    provider_slug: z.string().trim().min(1).max(80).nullable(),
    model_id: z.string().trim().min(1).max(200),
    context_window: z.number().int().positive().max(10_000_000),
    max_output_tokens: z.number().int().positive().max(1_000_000),
    supports_tools: z.boolean(),
    supports_reasoning: z.boolean(),
    sort_order: z.number().int().min(0).max(10_000).default(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === "gateway" && !value.provider_slug) {
      ctx.addIssue({ code: "custom", path: ["provider_slug"], message: "gateway transport requires provider_slug" });
    }
    if (value.transport === "cloudflare" && !value.model_id.startsWith("@cf/")) {
      ctx.addIssue({ code: "custom", path: ["model_id"], message: "Cloudflare model id must start with @cf/" });
    }
  });

async function body<T>(c: Context<{ Bindings: Env }>, schema: z.ZodType<T>): Promise<T> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HTTPException(400, {
      message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("；"),
    });
  }
  return parsed.data;
}

function publicTask(task: NonNullable<Awaited<ReturnType<typeof getTask>>>) {
  return {
    id: task.id,
    workspace_id: task.workspace_id,
    session_id: task.session_id,
    kind: task.kind,
    status: task.status,
    content: task.result_content,
    error: task.error_message,
    error_code: task.error_code,
    response_cache_status: task.response_cache_status,
    prompt_tokens: task.prompt_tokens,
    cached_input_tokens: task.cached_input_tokens,
    stable_prefix_tokens: task.stable_prefix_tokens,
    volatile_tokens: task.volatile_tokens,
    output_contract_tokens: task.output_contract_tokens,
    nmem_sync_status: task.nmem_sync_status,
    nmem_synced_at: task.nmem_synced_at,
    nmem_error: task.nmem_error,
    nmem_memory_count: task.nmem_memory_count,
    nmem_recall_count: task.nmem_recall_count,
    prefix_cache_ratio: task.prompt_tokens > 0 ? task.cached_input_tokens / task.prompt_tokens : 0,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

export function registerV2Routes(app: App): void {
  app.get("/api/v2/models", async (c) => c.json({ models: await listModels(c.env.DB) }));

  app.get("/api/v2/settings/default-model", async (c) => c.json({ model: await getApplicationDefaultModel(c.env.DB) }));

  app.put("/api/v2/settings/default-model", async (c) => {
    const input = await body(c, applicationModelSchema);
    try {
      return c.json({ model: await setApplicationDefaultModel(c.env.DB, input.model_config_id) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("生成期间")) return c.json({ detail: message }, 409);
      throw error;
    }
  });

  app.post("/api/v2/models", async (c) => {
    const input = await body(c, modelSchema);
    const model = await upsertModel(c.env.DB, {
      ...input,
      provider_slug: input.transport === "cloudflare" ? null : input.provider_slug,
      enabled: false,
    });
    return c.json({ model, probe_required: true }, 201);
  });

  app.post("/api/v2/models/:id/probe", async (c) => {
    const model = await getModel(c.env.DB, c.req.param("id"));
    if (!model) throw new HTTPException(404, { message: "model not found" });
    const base = `model-probe:${model.id}:${model.revision}`;
    try {
      const text = await chat(
        c.env,
        [
          { role: "system", content: "你是模型连通性探测器。" },
          { role: "user", content: "只回复 OK。" },
        ],
        null,
        0,
        32,
        30,
        { model, requestKind: "probe", cacheKey: `${base}:text`, cacheTtl: 86_400 },
      );
      if (!text.text.trim()) throw new Error("text probe returned empty content");
      let toolCache: ResponseCacheStatus | null = null;
      if (model.supports_tools) {
        const tool = {
          type: "function",
          function: {
            name: "probe_echo",
            description: "Connectivity probe",
            parameters: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        };
        const result = await chat(
          c.env,
          [
            { role: "system", content: "你是工具能力探测器。" },
            { role: "user", content: "调用 probe_echo，参数 ok=true。" },
          ],
          [tool],
          0,
          64,
          30,
          { model, requestKind: "probe", cacheKey: `${base}:tool`, cacheTtl: 86_400 },
        );
        if (!result.tool_calls.some((call) => call.name === "probe_echo"))
          throw new Error("tool probe returned no valid tool call");
        toolCache = result.response_cache_status;
      }
      await recordProbe(c.env.DB, model.id, true);
      return c.json({
        model: await getModel(c.env.DB, model.id),
        status: "passed",
        cache: { text: text.response_cache_status, tool: toolCache },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordProbe(c.env.DB, model.id, false, message);
      return c.json({ model: await getModel(c.env.DB, model.id), status: "failed", error: message }, 422);
    }
  });

  app.get("/api/v2/sessions/:sid/model", async (c) => {
    const model = await resolveSessionModel(c.env.DB, c.req.param("sid"));
    const runtime = await sessionRuntime(c.env.DB, c.req.param("sid"));
    return c.json({ model, prompt_epoch: runtime.prompt_epoch, affinity_key: runtime.affinity_key });
  });

  app.put("/api/v2/sessions/:sid/model", async (c) => {
    const sid = c.req.param("sid");
    const runtime = await sessionRuntime(c.env.DB, sid);
    const active = await getActiveTask(c.env.DB, runtime.workspace_id, sid);
    if (active) return c.json({ detail: "生成期间不能切换模型", task_id: active.id }, 409);
    const input = await body(c, modelSelectionSchema);
    const model = await setSessionModel(c.env.DB, sid, input.model_config_id);
    const next = await sessionRuntime(c.env.DB, sid);
    return c.json({ model, prompt_epoch: next.prompt_epoch, affinity_key: next.affinity_key });
  });

  app.post("/api/v2/sessions/:sid/turn", async (c) => {
    const sid = c.req.param("sid");
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new HTTPException(400, { message: "Idempotency-Key is required and must be at most 200 characters" });
    }
    const input = await body(c, turnSchema);
    const command = parseSystemCommand(input.text);
    if (isUnknownSlashCommand(input.text)) {
      throw new HTTPException(400, { message: "未知系统命令；输入 /help 查看可用命令" });
    }
    if (command && command.name !== "ooc") {
      throw new HTTPException(400, { message: `/${command.name} 是本地系统命令，请从对话输入框执行` });
    }
    if (command?.name === "ooc" && !command.argument) {
      throw new HTTPException(400, { message: "/ooc 后需要填写问题" });
    }
    const runtime = await sessionRuntime(c.env.DB, sid);
    try {
      const created = await createTurnTask(c.env.DB, {
        workspaceId: runtime.workspace_id,
        sessionId: sid,
        text: input.text,
        idempotencyKey,
      });
      if (created.task.status === "pending" || created.task.status === "running")
        await publishTask(c.env, created.task);
      return c.json({ task_id: created.task.id, status: created.task.status, duplicate: created.duplicate }, 202);
    } catch (error) {
      if (error instanceof ActiveTaskConflict) {
        return c.json({ detail: error.message, task_id: error.task.id, task_status: error.task.status }, 409);
      }
      throw error;
    }
  });

  app.post("/api/v2/sessions/:sid/regenerate", async (c) => {
    const sid = c.req.param("sid");
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) throw new HTTPException(400, { message: "Idempotency-Key is required" });
    const runtime = await sessionRuntime(c.env.DB, sid);
    const duplicate = await getTaskByIdempotency(c.env.DB, sid, idempotencyKey);
    if (duplicate) return c.json({ task_id: duplicate.id, status: duplicate.status }, 202);
    const active = await getActiveTask(c.env.DB, runtime.workspace_id, sid);
    if (active) {
      return c.json({ detail: "已有生成任务进行中", task_id: active.id, task_status: active.status }, 409);
    }
    const fs = workspaceFs(c.env.BUCKET, runtime.workspace_id);
    const loaded = await loadSession(fs, sid);
    let lastUserIdx = -1;
    for (let i = loaded.messages.length - 1; i >= 0; i -= 1) {
      if (loaded.messages[i]?.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) throw new HTTPException(409, { message: "session has no user message to regenerate" });
    const truncated = loaded.messages.slice(0, lastUserIdx + 1);
    if (truncated.length < loaded.messages.length) {
      await saveSession(fs, sid, truncated, {
        thread_id: loaded.thread_id,
        nmem_space: loaded.nmem_space,
        primary_character: loaded.primary_character,
        title: loaded.title,
      });
    }
    await replaceSessionTranscriptProjection(c.env.DB, sid, truncated, "regenerated");
    const taskId = crypto.randomUUID();
    await insertPending(c.env.DB, {
      id: taskId,
      worldId: runtime.workspace_id,
      sessionId: sid,
      userText: truncated[lastUserIdx]!.content,
      idempotencyKey,
    });
    await c.env.DB.prepare(`UPDATE generation_tasks SET kind = 'regenerate' WHERE id = ?`).bind(taskId).run();
    const task = await getTask(c.env.DB, taskId);
    if (!task) throw new Error("regenerate task insert did not commit");
    await publishTask(c.env, task);
    return c.json({ task_id: task.id, status: task.status }, 202);
  });

  app.get("/api/v2/sessions/:sid/messages", async (c) => {
    const cursorRaw = c.req.query("cursor");
    const limitRaw = c.req.query("limit");
    const cursor = cursorRaw ? Number(cursorRaw) : undefined;
    const limit = limitRaw ? Number(limitRaw) : 50;
    if ((cursorRaw && !Number.isInteger(cursor)) || !Number.isInteger(limit))
      throw new HTTPException(400, { message: "invalid cursor or limit" });
    return c.json(await listMessages(c.env.DB, c.req.param("sid"), cursor, limit));
  });

  app.get("/api/v2/sessions/:sid/tasks/active", async (c) => {
    const runtime = await sessionRuntime(c.env.DB, c.req.param("sid"));
    const task = await getActiveTask(c.env.DB, runtime.workspace_id, c.req.param("sid"));
    return c.json({ task: task ? publicTask(task) : null });
  });

  app.get("/api/v2/tasks/:id", async (c) => {
    const task = await getTask(c.env.DB, c.req.param("id"));
    if (!task) throw new HTTPException(404, { message: "task not found" });
    return c.json(publicTask(task));
  });

  app.get("/api/v2/sessions/:sid/cache", async (c) => {
    const sid = c.req.param("sid");
    const runtime = await sessionRuntime(c.env.DB, sid);
    const model = await resolveSessionModel(c.env.DB, sid);
    const latest = await c.env.DB.prepare(
      `SELECT ${[
        "id",
        "response_cache_status",
        "prompt_tokens",
        "cached_input_tokens",
        "stable_prefix_tokens",
        "volatile_tokens",
        "output_contract_tokens",
        "created_at",
      ].join(
        ", ",
      )} FROM generation_tasks WHERE session_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`,
    )
      .bind(sid)
      .first<Record<string, number | string>>();
    const promptTokens = Number(latest?.prompt_tokens || 0);
    const cachedTokens = Number(latest?.cached_input_tokens || 0);
    return c.json({
      model,
      prompt_epoch: runtime.prompt_epoch,
      stable_prefix_tokens: Number(latest?.stable_prefix_tokens || 0),
      volatile_tokens: Number(latest?.volatile_tokens || 0),
      output_contract_tokens: Number(latest?.output_contract_tokens || 0),
      prompt_tokens: promptTokens,
      cached_input_tokens: cachedTokens,
      prefix_cache_ratio: promptTokens > 0 ? cachedTokens / promptTokens : 0,
      response_cache_status: latest?.response_cache_status || "unknown",
    });
  });

  app.get("/api/v2/sessions/:sid/memory", async (c) => c.json(await memoryStatus(c.env.DB, c.req.param("sid"))));

  app.post("/api/v2/worlds/:id/memory/sync", async (c) => {
    await body(c, memorySyncSchema);
    const workspaceId = c.req.param("id");
    const fs = workspaceFs(c.env.BUCKET, workspaceId);
    const pack = await loadPack(fs, workspaceId);
    const memory = await loadMemory(fs);
    const mirrored = await mirrorCoreMemorySnapshot(c.env.DB, { workspaceId, snapshot: memory });
    return c.json({
      ok: true,
      workspace_id: workspaceId,
      space_id: pack.nmem_space,
      core_memory_count: mirrored,
    });
  });

  app.post("/api/v2/sessions/:sid/prompt-epoch", async (c) => {
    const payload = await body(
      c,
      z.object({ reason: z.enum(["context_compacted", "prompt_override_changed", "tool_schema_changed"]) }).strict(),
    );
    const epoch = await createPromptEpoch(c.env.DB, c.req.param("sid"), payload.reason);
    return c.json({ prompt_epoch: epoch });
  });
}

export async function projectWorkspaceAndSession(
  env: Env,
  input: {
    workspace: {
      id: string;
      name: string;
      playerName: string;
      nmemSpace?: string | null;
      primaryCharacterId?: string | null;
    };
    session?: { id: string; title: string; nmemSpace?: string | null; primaryCharacterId?: string | null };
  },
): Promise<void> {
  await ensureWorkspaceProjection(env.DB, input.workspace);
  if (input.session) {
    await ensureSessionProjection(env.DB, {
      ...input.session,
      workspaceId: input.workspace.id,
    });
  }
}

export async function projectWorkspaceContent(env: Env, pack: WorldPack): Promise<void> {
  await ensureWorkspaceProjection(env.DB, {
    id: pack.id,
    name: pack.name,
    playerName: pack.player_name,
    nmemSpace: pack.nmem_space || null,
    primaryCharacterId: pack.primary,
  });
  const fs = workspaceFs(env.BUCKET, pack.id);
  const ts = new Date().toISOString();
  await env.DB.prepare(`DELETE FROM characters WHERE workspace_id = ?`).bind(pack.id).run();
  for (const member of pack.cast) {
    const cardText = (await fs.get(member.card)) || "";
    await env.DB.prepare(
      `INSERT INTO characters (
         id, workspace_id, name, card_r2_key, mini_r2_key, source_hash, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        member.id,
        pack.id,
        member.name,
        `v2/workspaces/${pack.id}/${member.card}`,
        `v2/workspaces/${pack.id}/characters/${member.id}.mini.yaml`,
        cardText ? await sha256(cardText) : null,
        stableStringify({ blurb: member.blurb, present: member.present, aliases: member.aliases }),
        ts,
        ts,
      )
      .run();
  }
  await env.DB.prepare(`DELETE FROM lorebooks WHERE workspace_id = ?`).bind(pack.id).run();
  const loreFiles = (await fs.list("lorebooks/")).filter((key) => /\.(json|ya?ml)$/i.test(key)).sort();
  for (const file of loreFiles) {
    const text = (await fs.get(file)) || "";
    const name = file.replace(/^lorebooks\//, "");
    const lorebookId = `${pack.id}:${name}`;
    await env.DB.prepare(
      `INSERT INTO lorebooks (id, workspace_id, name, source_r2_key, source_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(lorebookId, pack.id, name, `v2/workspaces/${pack.id}/${file}`, await sha256(text), ts, ts)
      .run();
    const entries = loadLorebookText(text, name);
    for (let position = 0; position < entries.length; position += 1) {
      const lore = entries[position];
      await env.DB.prepare(
        `INSERT INTO lore_entries (
           id, lorebook_id, position, keys_json, secondary_keys_json, content,
           enabled, constant, metadata_json, content_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `${lorebookId}:${position}`,
          lorebookId,
          position,
          stableStringify(lore.keys),
          stableStringify(lore.secondary_keys),
          lore.content,
          Number(lore.enabled),
          Number(lore.constant),
          stableStringify({ comment: lore.comment, source: lore.source, char_name: lore.char_name }),
          await sha256(lore.content),
        )
        .run();
    }
  }
}

export function modelSnapshot(model: AiModelConfig): string {
  return stableStringify(model);
}
