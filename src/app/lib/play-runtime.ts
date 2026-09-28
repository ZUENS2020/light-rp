import type { GenerationTask, PlayMessage } from "./api";

/** Raw SessionRuntime DO WebSocket frame (see src/server/session-runtime.ts). */
export type RuntimeFrame = {
  type?: string;
  taskId?: string | null;
  content?: string;
  error?: string;
  status?: string;
  partialContent?: string;
};

export type RuntimeAction =
  | { kind: "ignore" }
  | { kind: "running"; taskId: string; content?: string }
  | { kind: "completed"; taskId: string; content?: string }
  /** Ask D1 (REST) for the truth — WS said failed/idle/completed-without-body. */
  | { kind: "confirm"; taskId: string };

/**
 * Map a runtime frame to a UI action. D1 (REST /tasks/:id) stays the source of truth:
 * - `failed` from the DO can be a false stale alarm or a queue retry (D1 back to pending),
 *   so it only triggers a REST confirm instead of freezing the UI in an error state.
 * - A `status` snapshot saying completed/failed (sent on every (re)connect and ping reply)
 *   confirms the task we are waiting on; it used to be ignored, so a socket that dropped
 *   during a silent generation never learned the reply had landed.
 */
export function runtimeFrameAction(frame: RuntimeFrame, currentTaskId: string | null): RuntimeAction {
  const taskId = typeof frame.taskId === "string" && frame.taskId ? frame.taskId : null;
  if (!taskId) return { kind: "ignore" };
  if (frame.type === "partial" && typeof frame.content === "string") {
    return { kind: "running", taskId, content: frame.content };
  }
  if (frame.type === "completed") {
    return { kind: "completed", taskId, content: typeof frame.content === "string" ? frame.content : undefined };
  }
  if (frame.type === "failed") {
    return taskId === currentTaskId ? { kind: "confirm", taskId } : { kind: "ignore" };
  }
  if (frame.type === "status") {
    if (frame.status === "pending" || frame.status === "running") {
      return {
        kind: "running",
        taskId,
        content: typeof frame.partialContent === "string" && frame.partialContent ? frame.partialContent : undefined,
      };
    }
    // Snapshot for an older, already-finished task (e.g. ping reply while idle) — nothing to do.
    return taskId === currentTaskId ? { kind: "confirm", taskId } : { kind: "ignore" };
  }
  return { kind: "ignore" };
}

const TERMINAL = new Set(["completed", "failed", "dead"]);

/**
 * Status only moves forward: a late poll/WS frame saying `running` must never overwrite a
 * `completed` task (that re-opened the streaming bubble and could stop the completion flow).
 */
export function mergeTaskSnapshot(prev: GenerationTask | undefined, incoming: GenerationTask): GenerationTask {
  if (!prev || prev.id !== incoming.id) return incoming;
  if (prev.status === "completed" && !TERMINAL.has(incoming.status)) return prev;
  if ((incoming.status === "pending" || incoming.status === "running") && !incoming.content && prev.content) {
    return { ...incoming, content: prev.content };
  }
  return incoming;
}

/** Poll cadence while a task is in flight. WS is best-effort; D1 polling must always run. */
export function taskPollInterval(status: GenerationTask["status"] | undefined, wsLive: boolean): number | false {
  if (status && status !== "pending" && status !== "running") return false;
  return wsLive ? 5_000 : 2_000;
}

/**
 * The persisted assistant message for `taskId`, if the transcript already has it while the
 * task still looks in flight. Only a message tagged with the task id counts, so an earlier
 * reply with identical text cannot finalize a new turn.
 */
export function findLandedReply(
  messages: PlayMessage[] | undefined,
  taskId: string | null,
  status: GenerationTask["status"] | undefined,
): PlayMessage | null {
  if (!taskId || !messages?.length) return null;
  if (status && status !== "pending" && status !== "running") return null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && message.task_id === taskId && message.content.trim()) return message;
  }
  return null;
}
