import { workspaceFs, type R2Fs } from "../adapters/r2";
import { loadMemory, loadPack, loadSession, saveSession } from "../core/domain";
import { isOocMessage } from "../core/commands";
import type { AiModelConfig } from "../core/ai";
import { runOoc, runTurn, type TurnOut } from "./engine";
import { loadSettings } from "./settings";
import { beginCommit, completeTask, getTask, leaseTask, markFailed, type TaskCompletion } from "./tasks";
import { watchTask, TaskCancelledError } from "./cancellation";
import { mirrorCoreMemorySnapshot } from "./memory";
import { sessionRuntime } from "./models";
import { wakeNmem } from "./nmem-service";
import { MAX_GENERATION_ATTEMPTS } from "./generation-recovery";

type Commit = { completion: TaskCompletion; artifactKey: string };

async function finishCommit(env: Env, taskId: string, workspaceId: string, sessionId: string, commit: Commit) {
  const fs = workspaceFs(env.BUCKET, workspaceId);
  const object = await env.BUCKET.get(commit.artifactKey);
  if (!object) throw new Error("Generation commit journal missing");
  await fs.replay(await object.json<ReturnType<R2Fs["journal"]>>());
  if (commit.completion.includeInPrompt !== false) {
    await mirrorCoreMemorySnapshot(env.DB, { workspaceId, sessionId, taskId, snapshot: await loadMemory(fs) });
  }
  await completeTask(env.DB, taskId, commit.completion);
}

export async function consumeGeneration(
  env: Env,
  msg: Message<{ taskId: string; sessionId: string }>,
  ctx: ExecutionContext,
) {
  const taskId = msg.body.taskId;
  const owner = crypto.randomUUID();
  let watcher: ReturnType<typeof watchTask> | undefined;
  let executionAttempt = 0;
  try {
    const existing = await getTask(env.DB, taskId);
    if (!existing || ["completed", "cancelled", "failed", "dead"].includes(existing.status)) {
      msg.ack();
      return;
    }
    const task = await leaseTask(env.DB, taskId, owner);
    if (!task) {
      // D1 owns recovery: retrying a duplicate while its lease is held only burns
      // the Queue delivery budget. The cron republishes work if that owner dies.
      msg.ack();
      return;
    }
    executionAttempt = task.attempt_count;
    // Use persisted task identity, never untrusted/stale queue workspace or session fields.
    const { workspace_id: workspaceId, session_id: sessionId } = task;
    watcher = watchTask(env.DB, taskId, owner);
    if (task.execution_phase === "committing" && task.commit_payload_json) {
      await finishCommit(env, taskId, workspaceId, sessionId, JSON.parse(task.commit_payload_json));
      ctx.waitUntil(wakeNmem(env));
      msg.ack();
      return;
    }
    const fs = workspaceFs(env.BUCKET, workspaceId);
    const staged = fs.stage();
    const pack = await loadPack(fs, workspaceId);
    const settings = await loadSettings(env.BUCKET);
    const loaded = await loadSession(fs, sessionId);
    watcher.signal.throwIfAborted();
    // D1 is authoritative for accepted input; R2 changes remain private until commit.
    if (!loaded.messages.some((message) => message.role === "user" && message.task_id === taskId)) {
      await saveSession(
        staged,
        sessionId,
        [...loaded.messages, { role: "user", content: task.user_text, ts: task.created_at, task_id: taskId }],
        loaded,
      );
    }
    const model: AiModelConfig = JSON.parse(task.model_snapshot_json);
    const ooc = isOocMessage(task.user_text);
    const overrides: Record<string, string> = {};
    for (const path of await fs.list("prompts/")) {
      if (path.endsWith("/")) continue;
      const text = await fs.get(path);
      if (text != null) overrides[path.slice("prompts/".length)] = text;
    }
    const result = ooc
      ? await runOoc(env, staged, pack, sessionId, task.user_text, settings, {
          model,
          signal: watcher.signal,
          taskId,
          affinityKey: (await sessionRuntime(env.DB, sessionId)).affinity_key,
        })
      : await runTurn(env, staged, pack, sessionId, task.user_text, settings, overrides, {
          persistUser: false,
          signal: watcher.signal,
          ai: { db: env.DB, taskId, model, requestKind: task.kind === "regenerate" ? "regenerate" : "story" },
        });
    watcher.signal.throwIfAborted();
    const rp = result as Partial<TurnOut>;
    const completion: TaskCompletion = {
      content: result.text,
      includeInPrompt: !ooc,
      requestHash: result.request_hash,
      cacheStatus: result.response_cache_status,
      usage: result.ai_usage,
      stablePrefixTokens: result.stable_prefix_tokens,
      volatileTokens: result.volatile_tokens,
      hiddenEvents: rp.hidden_prompt_events,
      rotatePromptEpochReason: rp.rotate_prompt_epoch_reason,
    };
    const artifactKey = `v2/tasks/${taskId}/commit-${owner}.json`;
    await env.BUCKET.put(artifactKey, JSON.stringify(staged.journal()));
    const commit: Commit = { completion, artifactKey };
    if (!(await beginCommit(env.DB, taskId, JSON.stringify(commit), owner))) {
      await env.BUCKET.delete(artifactKey);
      throw new TaskCancelledError();
    }
    await finishCommit(env, taskId, workspaceId, sessionId, commit);
    ctx.waitUntil(wakeNmem(env));
    msg.ack();
  } catch (error) {
    if (error instanceof TaskCancelledError || (await getTask(env.DB, taskId))?.status === "cancelled") {
      msg.ack();
      return;
    }
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    const dead = executionAttempt >= MAX_GENERATION_ATTEMPTS || code === "LLM_OUTPUT_CHANNEL_VIOLATION";
    await markFailed(env.DB, taskId, error instanceof Error ? error.message : String(error), { code, dead, owner });
    console.warn({ event: "generation.failed", taskId, executionAttempt, code: code || "GENERATION_ERROR", dead });
    if (code === "LLM_OUTPUT_CHANNEL_VIOLATION") msg.ack();
    // On the final infrastructure failure, let Cloudflare route this delivery to its DLQ.
    else msg.retry();
  } finally {
    await watcher?.stop();
  }
}
