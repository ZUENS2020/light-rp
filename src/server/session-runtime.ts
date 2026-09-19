/**
 * Per-session Durable Object: generation ownership snapshot + WebSocket streaming.
 *
 * Queue consumer still runs the LLM; this DO owns live status for the Play UI.
 * Partials are broadcast as **full content** (not deltas) for MVP simplicity.
 *
 * Events (JSON over WebSocket):
 *   { type: "partial", taskId, content }
 *   { type: "completed", taskId, content }
 *   { type: "failed", taskId, error }
 *   { type: "status", taskId, status, partialContent, leaseExpiresAt, lastActivityAt, abort }
 */
import { DurableObject } from "cloudflare:workers";
import { STALE_RUNNING_GRACE_MS } from "./generation-recovery";

export type SessionRuntimeStatus = "idle" | "running" | "completed" | "failed";

export type SessionRuntimeSnapshot = {
  activeTaskId: string | null;
  status: SessionRuntimeStatus;
  partialContent: string;
  leaseExpiresAt: string | null;
  lastActivityAt: string | null;
  abort: boolean;
};

export type RuntimeWsEvent =
  | { type: "partial"; taskId: string; content: string }
  | { type: "completed"; taskId: string; content: string }
  | { type: "failed"; taskId: string; error: string }
  | {
      type: "status";
      taskId: string | null;
      status: SessionRuntimeStatus;
      partialContent: string;
      leaseExpiresAt: string | null;
      lastActivityAt: string | null;
      abort: boolean;
    };

/** Align with LEASE_HEARTBEAT_INTERVAL_MS — keep DO alarm cadence near worker heartbeat. */
export const RUNTIME_ALARM_INTERVAL_MS = 45_000;

const STORAGE_KEY = "snapshot";

const IDLE_SNAPSHOT: SessionRuntimeSnapshot = {
  activeTaskId: null,
  status: "idle",
  partialContent: "",
  leaseExpiresAt: null,
  lastActivityAt: null,
  abort: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function getSessionRuntimeStub(env: Env, sessionId: string): DurableObjectStub<SessionRuntime> {
  return env.SESSION_RUNTIME.getByName(sessionId);
}

export class SessionRuntime extends DurableObject<Env> {
  private async load(): Promise<SessionRuntimeSnapshot> {
    const stored = await this.ctx.storage.get<SessionRuntimeSnapshot>(STORAGE_KEY);
    return stored ? { ...IDLE_SNAPSHOT, ...stored } : { ...IDLE_SNAPSHOT };
  }

  private async save(snapshot: SessionRuntimeSnapshot): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, snapshot);
  }

  private broadcast(event: RuntimeWsEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Drop broken sockets; close handler cleans them up.
      }
    }
  }

  private statusEvent(snapshot: SessionRuntimeSnapshot): RuntimeWsEvent {
    return {
      type: "status",
      taskId: snapshot.activeTaskId,
      status: snapshot.status,
      partialContent: snapshot.partialContent,
      leaseExpiresAt: snapshot.leaseExpiresAt,
      lastActivityAt: snapshot.lastActivityAt,
      abort: snapshot.abort,
    };
  }

  private async scheduleAlarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + RUNTIME_ALARM_INTERVAL_MS);
  }

  /** Claim generation ownership for this session and start liveness alarms. */
  async attachGeneration(input: { taskId: string; sessionKey?: string }): Promise<SessionRuntimeSnapshot> {
    const now = nowIso();
    const snapshot: SessionRuntimeSnapshot = {
      activeTaskId: input.taskId,
      status: "running",
      partialContent: "",
      leaseExpiresAt: new Date(Date.now() + STALE_RUNNING_GRACE_MS * 2).toISOString(),
      lastActivityAt: now,
      abort: false,
    };
    await this.save(snapshot);
    await this.scheduleAlarm();
    this.broadcast(this.statusEvent(snapshot));
    return snapshot;
  }

  /** Progressive assistant text — full content each time (MVP). */
  async onPartial(input: { taskId: string; content: string }): Promise<SessionRuntimeSnapshot | null> {
    const snapshot = await this.load();
    if (snapshot.activeTaskId !== input.taskId || snapshot.status !== "running") return null;
    if (snapshot.abort) return snapshot;
    const next: SessionRuntimeSnapshot = {
      ...snapshot,
      partialContent: input.content,
      lastActivityAt: nowIso(),
      leaseExpiresAt: new Date(Date.now() + STALE_RUNNING_GRACE_MS * 2).toISOString(),
    };
    await this.save(next);
    this.broadcast({ type: "partial", taskId: input.taskId, content: input.content });
    return next;
  }

  /**
   * Lease/LLM heartbeat without new tokens — keeps DO alarm from marking a healthy
   * reasoning/TTFT wait as stalled (partials only arrive after first visible token).
   */
  async touchActivity(input: { taskId: string }): Promise<SessionRuntimeSnapshot | null> {
    const snapshot = await this.load();
    if (snapshot.activeTaskId !== input.taskId || snapshot.status !== "running") return null;
    if (snapshot.abort) return snapshot;
    const next: SessionRuntimeSnapshot = {
      ...snapshot,
      lastActivityAt: nowIso(),
      leaseExpiresAt: new Date(Date.now() + STALE_RUNNING_GRACE_MS * 2).toISOString(),
    };
    await this.save(next);
    return next;
  }

  async onComplete(input: { taskId: string; content: string }): Promise<SessionRuntimeSnapshot | null> {
    const snapshot = await this.load();
    if (snapshot.activeTaskId !== input.taskId) return null;
    const next: SessionRuntimeSnapshot = {
      activeTaskId: input.taskId,
      status: "completed",
      partialContent: input.content,
      leaseExpiresAt: null,
      lastActivityAt: nowIso(),
      abort: false,
    };
    await this.save(next);
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: "completed", taskId: input.taskId, content: input.content });
    this.broadcast(this.statusEvent(next));
    return next;
  }

  async onFail(input: { taskId: string; error: string }): Promise<SessionRuntimeSnapshot | null> {
    const snapshot = await this.load();
    if (snapshot.activeTaskId && snapshot.activeTaskId !== input.taskId) return null;
    const next: SessionRuntimeSnapshot = {
      activeTaskId: input.taskId,
      status: "failed",
      partialContent: snapshot.partialContent,
      leaseExpiresAt: null,
      lastActivityAt: nowIso(),
      abort: snapshot.abort,
    };
    await this.save(next);
    await this.ctx.storage.deleteAlarm();
    this.broadcast({ type: "failed", taskId: input.taskId, error: input.error });
    this.broadcast(this.statusEvent(next));
    return next;
  }

  async getSnapshot(): Promise<SessionRuntimeSnapshot> {
    return this.load();
  }

  async cancel(input?: { taskId?: string }): Promise<SessionRuntimeSnapshot> {
    const snapshot = await this.load();
    if (input?.taskId && snapshot.activeTaskId && snapshot.activeTaskId !== input.taskId) {
      return snapshot;
    }
    if (snapshot.status !== "running") return snapshot;
    const next: SessionRuntimeSnapshot = { ...snapshot, abort: true, lastActivityAt: nowIso() };
    await this.save(next);
    this.broadcast(this.statusEvent(next));
    return next;
  }

  async alarm(): Promise<void> {
    const snapshot = await this.load();
    if (snapshot.status !== "running" || !snapshot.activeTaskId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const last = snapshot.lastActivityAt ? Date.parse(snapshot.lastActivityAt) : 0;
    const stalled = !last || Date.now() - last > STALE_RUNNING_GRACE_MS;
    if (stalled) {
      const next: SessionRuntimeSnapshot = {
        ...snapshot,
        status: "failed",
        leaseExpiresAt: null,
        lastActivityAt: nowIso(),
      };
      await this.save(next);
      this.broadcast({
        type: "failed",
        taskId: snapshot.activeTaskId,
        error: "生成超时未更新，会话运行时已标记失败（D1 回收仍会重试）。",
      });
      this.broadcast(this.statusEvent(next));
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Healthy: bump soft lease marker and reschedule.
    const next: SessionRuntimeSnapshot = {
      ...snapshot,
      leaseExpiresAt: new Date(Date.now() + STALE_RUNNING_GRACE_MS * 2).toISOString(),
    };
    await this.save(next);
    await this.scheduleAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      const snapshot = await this.load();
      try {
        server.send(JSON.stringify(this.statusEvent(snapshot)));
      } catch {
        // Client may not be ready yet; first poll/snapshot covers it.
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET") {
      return Response.json(await this.load());
    }

    return new Response("Expected WebSocket upgrade or GET", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let text = typeof message === "string" ? message : new TextDecoder().decode(message);
    text = text.trim();
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { type?: string; taskId?: string };
      if (parsed.type === "ping" || parsed.type === "snapshot") {
        ws.send(JSON.stringify(this.statusEvent(await this.load())));
        return;
      }
      if (parsed.type === "cancel") {
        await this.cancel({ taskId: parsed.taskId });
      }
    } catch {
      // Ignore malformed client frames.
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Hibernation API: ensure close completes so the runtime can reclaim the socket.
    try {
      ws.close(code, reason);
    } catch {
      void wasClean;
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // ignore
    }
  }
}
