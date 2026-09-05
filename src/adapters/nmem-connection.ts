import { abortable, readResponseText } from "./http";

export type NmemEnv = {
  NMEM_API_URL?: string;
  NMEM_API_KEY?: string;
  DB?: D1Database;
  nmemDeadline?: number;
  nmemProbeRevision?: number;
  nmemSyncOwner?: string;
};
export type NmemConnection = {
  status: "offline" | "probing" | "online";
  revision: number;
  spaces_json: string;
};
export class NmemOfflineError extends Error {
  constructor() {
    super("nmem offline");
    this.name = "NmemOfflineError";
  }
}

export async function nmemConnection(db: D1Database): Promise<NmemConnection> {
  return (
    (await db
      .prepare("SELECT status, revision, spaces_json FROM nmem_connection WHERE id = 'default'")
      .first<NmemConnection>()) ?? { status: "offline", revision: 0, spaces_json: "[]" }
  );
}

export async function takeNmemOffline(db: D1Database, revision?: number): Promise<void> {
  await db
    .prepare(
      `UPDATE nmem_connection SET status = 'offline', revision = revision + 1, updated_at = ?
    WHERE id = 'default' AND (? IS NULL OR revision = ?)`,
    )
    .bind(new Date().toISOString(), revision ?? null, revision ?? null)
    .run();
}

/** No network retries. Only an explicit probe may leave the offline state. */
export async function nmemRequest(env: NmemEnv, url: string, init: RequestInit, timeoutMs = 3000): Promise<Response> {
  const state = env.DB ? await nmemConnection(env.DB) : null;
  if (
    state &&
    !(state.status === "online" || (state.status === "probing" && state.revision === env.nmemProbeRevision))
  ) {
    throw new NmemOfflineError();
  }
  if (env.DB && env.nmemSyncOwner) {
    const lease = await env.DB.prepare(
      `UPDATE nmem_connection SET sync_expires_at = ? WHERE id = 'default'
      AND sync_owner = ? AND status = 'online' RETURNING id`,
    )
      .bind(new Date(Date.now() + 180_000).toISOString(), env.nmemSyncOwner)
      .first();
    if (!lease) throw new NmemOfflineError();
  }
  const remaining = Math.min(timeoutMs, (env.nmemDeadline ?? Infinity) - Date.now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NmemOfflineError()), Math.max(0, remaining));
  try {
    if (remaining <= 0) throw new NmemOfflineError();
    const response = await abortable(fetch(url, { ...init, signal: controller.signal }), controller.signal);
    if ([401, 403, 408, 429].includes(response.status) || response.status >= 500) {
      void response.body?.cancel().catch(() => undefined);
      throw new NmemOfflineError();
    }
    const text = await abortable(readResponseText(response, controller.signal, 2 * 1024 * 1024), controller.signal);
    // nmem endpoints return JSON; an HTML login/error page is not a healthy connection.
    if (response.ok && text) JSON.parse(text);
    return new Response(response.status === 204 ? null : text, { status: response.status, headers: response.headers });
  } catch {
    if (env.DB && state) await takeNmemOffline(env.DB, state.revision);
    throw new NmemOfflineError();
  } finally {
    clearTimeout(timer);
  }
}
