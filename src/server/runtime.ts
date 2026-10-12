import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { Store } from './store';
export class BranchRuntime extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS stream_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT,attempt INTEGER,kind TEXT,data TEXT,at TEXT)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS stream_revocations(task TEXT PRIMARY KEY)',
    );
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS stream_heads(task TEXT PRIMARY KEY,attempt INTEGER,text TEXT)',
    );
  }
  async publish(task: string, attempt: number, kind: string, data: unknown) {
    if (
      this.ctx.storage.sql.exec('SELECT task FROM stream_revocations WHERE task=?', task).toArray()
        .length
    )
      return;
    const current = await this.env.DB.prepare(
      'SELECT status,attempt,draft_text FROM tasks WHERE id=?',
    )
      .bind(task)
      .first<{ status: string; attempt: number; draft_text: string }>();
    if (
      !current ||
      current.attempt !== attempt ||
      (['cancelled', 'failed'].includes(current.status) && kind !== 'terminal')
    )
      return;
    if (['reset', 'delta'].includes(kind) && current.status !== 'running') return;
    if (
      this.ctx.storage.sql.exec('SELECT task FROM stream_revocations WHERE task=?', task).toArray()
        .length
    )
      return;
    if (kind === 'terminal')
      data = { ...(data as object), status: current.status, text: current.draft_text };
    const body = data as { text?: string };
    const existing = this.ctx.storage.sql
      .exec<{ attempt: number }>('SELECT attempt FROM stream_heads WHERE task=?', task)
      .toArray()[0];
    if (existing && existing.attempt > attempt) return;
    if (kind === 'reset')
      this.ctx.storage.sql.exec(
        'INSERT INTO stream_heads VALUES(?,?,?) ON CONFLICT(task)DO UPDATE SET attempt=excluded.attempt,text=excluded.text',
        task,
        attempt,
        '',
      );
    if (kind === 'delta')
      this.ctx.storage.sql.exec(
        'UPDATE stream_heads SET text=text||? WHERE task=? AND attempt=?',
        body.text ?? '',
        task,
        attempt,
      );
    this.ctx.storage.sql.exec(
      'INSERT INTO stream_events(task,attempt,kind,data,at)VALUES(?,?,?,?,?)',
      task,
      attempt,
      kind,
      JSON.stringify(data),
      new Date().toISOString(),
    );
    this.ctx.storage.sql.exec(
      'DELETE FROM stream_events WHERE seq < (SELECT COALESCE(MAX(seq),0)-2000 FROM stream_events)',
    );
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/commit') {
      const p = (await request.json()) as {
        ownerId: string;
        turn: Parameters<Store['appendTurn']>[0];
      };
      try {
        return Response.json(await new Store(this.env.DB, p.ownerId).appendTurn(p.turn));
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 409 },
        );
      }
    }
    if (url.pathname === '/publish') {
      const p = (await request.json()) as {
        taskId: string;
        attempt: number;
        kind: string;
        data: unknown;
      };
      await this.publish(p.taskId, p.attempt, p.kind, p.data);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/clear') {
      const { taskIds } = (await request.json()) as { taskIds: string[] };
      for (const id of taskIds) {
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO stream_revocations(task)VALUES(?)', id);
        this.ctx.storage.sql.exec('DELETE FROM stream_events WHERE task=?', id);
        this.ctx.storage.sql.exec('DELETE FROM stream_heads WHERE task=?', id);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/cancel') {
      const { taskId } = (await request.json()) as { taskId: string };
      await this.ctx.storage.put(`cancel:${taskId}`, true);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/cancelled')
      return Response.json({
        cancelled: !!(await this.ctx.storage.get(`cancel:${url.searchParams.get('task')}`)),
      });
    if (url.pathname !== '/events') return new Response('Not found', { status: 404 });
    const taskId = url.searchParams.get('task') ?? '',
      dbTask = await this.env.DB.prepare('SELECT attempt,status,draft_text FROM tasks WHERE id=?')
        .bind(taskId)
        .first<{ attempt: number; status: string; draft_text: string }>();
    if (!dbTask) return new Response('Not found', { status: 404 });
    const encoder = new TextEncoder();
    let cursor = this.ctx.storage.sql
        .exec<{ seq: number }>(
          'SELECT COALESCE(MAX(seq),0) AS seq FROM stream_events WHERE task=?',
          taskId,
        )
        .one().seq,
      closed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (kind: string, data: unknown, seq?: number) => {
          if (!closed)
            controller.enqueue(
              encoder.encode(
                `${seq ? `id: ${seq}\n` : ''}event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
        };
        const revoked =
          this.ctx.storage.sql
            .exec('SELECT task FROM stream_revocations WHERE task=?', taskId)
            .toArray().length > 0;
        const head = this.ctx.storage.sql
          .exec<{ attempt: number; text: string }>(
            'SELECT attempt,text FROM stream_heads WHERE task=?',
            taskId,
          )
          .toArray()[0];
        send('snapshot', {
          attempt: dbTask.attempt,
          status: dbTask.status,
          text: revoked ? '' : head?.attempt === dbTask.attempt ? head.text : dbTask.draft_text,
        });
        const tick = async () => {
          try {
            const rows = this.ctx.storage.sql
              .exec<{ seq: number; attempt: number; kind: string; data: string }>(
                'SELECT seq,attempt,kind,data FROM stream_events WHERE task=? AND seq>? ORDER BY seq LIMIT 100',
                taskId,
                cursor,
              )
              .toArray();
            for (const row of rows) {
              cursor = row.seq;
              if (
                this.ctx.storage.sql
                  .exec('SELECT task FROM stream_revocations WHERE task=?', taskId)
                  .toArray().length
              )
                continue;
              send(row.kind, { ...JSON.parse(row.data), attempt: row.attempt }, row.seq);
            }
            const state = await this.env.DB.prepare(
              'SELECT status,attempt,draft_text,error_json FROM tasks WHERE id=?',
            )
              .bind(taskId)
              .first<{
                status: string;
                attempt: number;
                draft_text: string;
                error_json: string | null;
              }>();
            if (!state || ['completed', 'failed', 'cancelled'].includes(state.status)) {
              send('terminal', {
                status: state?.status ?? 'deleted',
                attempt: state?.attempt,
                text: this.ctx.storage.sql
                  .exec('SELECT task FROM stream_revocations WHERE task=?', taskId)
                  .toArray().length
                  ? ''
                  : state?.draft_text,
                error: state?.error_json ? JSON.parse(state.error_json) : null,
              });
              closed = true;
              controller.close();
              return;
            }
            send('heartbeat', { status: state.status });
            if (!closed)
              timer = setTimeout(() => {
                void tick();
              }, 750);
          } catch {
            if (!closed) {
              closed = true;
              controller.close();
            }
          }
        };
        void tick();
      },
      cancel() {
        closed = true;
        if (timer) clearTimeout(timer);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      },
    });
  }
}
export async function publish(
  env: Env,
  branchId: string,
  taskId: string,
  attempt: number,
  kind: string,
  data: unknown,
) {
  const stub = env.BRANCH_RUNTIME.get(env.BRANCH_RUNTIME.idFromName(branchId));
  await stub.fetch('https://runtime/publish', {
    method: 'POST',
    body: JSON.stringify({ taskId, attempt, kind, data }),
  });
}
