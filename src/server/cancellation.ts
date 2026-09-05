import { getTask } from "./tasks";

export class TaskCancelledError extends Error {
  readonly code = "TASK_CANCELLED";
  constructor() {
    super("生成已停止");
    this.name = "TaskCancelledError";
  }
}

/** Request-scoped watcher; never share controllers across Worker invocations. */
export function watchTask(db: D1Database, id: string, owner: string) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let pending = Promise.resolve();
  const check = async () => {
    try {
      const task = await getTask(db, id);
      if (!task || task.status === "cancelled" || task.lease_owner !== owner)
        controller.abort(new TaskCancelledError());
      else if (task.status === "running" || task.status === "committing") {
        await db
          .prepare(
            `UPDATE generation_tasks SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`,
          )
          .bind(new Date(Date.now() + 180_000).toISOString(), id, owner)
          .run();
      }
    } catch (error) {
      controller.abort(error);
    }
    if (!stopped && !controller.signal.aborted)
      timer = setTimeout(() => {
        pending = check();
      }, 1000);
  };
  pending = check();
  return {
    signal: controller.signal,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      clearTimeout(timer);
    },
  };
}
