import { DEFAULT_MODEL, affinityKey, type AiModelConfig } from "../core/ai";
import { nowIso } from "../core/util";

type ModelRow = Omit<AiModelConfig, "supports_tools" | "supports_reasoning" | "enabled" | "source"> & {
  supports_tools: number;
  supports_reasoning: number;
  enabled: number;
  source?: AiModelConfig["source"];
};

export type ModelWithMetrics = AiModelConfig & {
  metrics: {
    requests: number;
    cache_hits: number;
    cold_starts: number;
    prompt_tokens: number;
    cached_input_tokens: number;
    estimated_saved_tokens: number;
    prefix_cache_ratio: number;
  };
};

function fromRow(row: ModelRow): AiModelConfig {
  return {
    ...row,
    provider_slug: row.provider_slug || null,
    supports_tools: Boolean(row.supports_tools),
    supports_reasoning: Boolean(row.supports_reasoning),
    enabled: Boolean(row.enabled),
  };
}

const MODEL_COLUMNS = `id, label, transport, provider_slug, model_id, context_window, max_output_tokens,
  supports_tools, supports_reasoning, enabled, sort_order, revision`;

export async function listModels(db: D1Database): Promise<ModelWithMetrics[]> {
  const result = await db
    .prepare(
      `SELECT m.${MODEL_COLUMNS.split(", ").join(", m.")},
        COUNT(t.id) AS requests,
        SUM(CASE WHEN t.response_cache_status = 'HIT' THEN 1 ELSE 0 END) AS cache_hits,
        SUM(CASE WHEN t.cached_input_tokens = 0 AND t.prompt_tokens > 0 THEN 1 ELSE 0 END) AS cold_starts,
        COALESCE(SUM(t.prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(t.cached_input_tokens), 0) AS cached_input_tokens
       FROM ai_model_configs m
       LEFT JOIN generation_tasks t ON json_extract(t.model_snapshot_json, '$.id') = m.id
       GROUP BY m.id
       ORDER BY m.sort_order, m.label`,
    )
    .all<ModelRow & Record<string, number>>();
  return (result.results || []).map((row) => {
    const model = fromRow(row);
    const promptTokens = Number(row.prompt_tokens || 0);
    const cachedTokens = Number(row.cached_input_tokens || 0);
    return {
      ...model,
      metrics: {
        requests: Number(row.requests || 0),
        cache_hits: Number(row.cache_hits || 0),
        cold_starts: Number(row.cold_starts || 0),
        prompt_tokens: promptTokens,
        cached_input_tokens: cachedTokens,
        estimated_saved_tokens: cachedTokens,
        prefix_cache_ratio: promptTokens > 0 ? cachedTokens / promptTokens : 0,
      },
    };
  });
}

export async function getModel(db: D1Database, id: string): Promise<AiModelConfig | null> {
  const row = await db.prepare(`SELECT ${MODEL_COLUMNS} FROM ai_model_configs WHERE id = ?`).bind(id).first<ModelRow>();
  return row ? fromRow(row) : null;
}

export async function getApplicationDefaultModel(db: D1Database): Promise<AiModelConfig> {
  const row = await db
    .prepare(
      `SELECT m.${MODEL_COLUMNS.split(", ").join(", m.")}
       FROM app_settings a
       JOIN ai_model_configs m ON m.id = a.default_model_config_id
       WHERE a.id = 'default'`,
    )
    .first<ModelRow>();
  if (!row) throw new Error("application default model is not configured");
  return { ...fromRow(row), source: "application" };
}

export async function setApplicationDefaultModel(db: D1Database, modelId: string): Promise<AiModelConfig> {
  const model = await getModel(db, modelId);
  if (!model) throw new Error(`model '${modelId}' not found`);
  if (!model.enabled) throw new Error(`model '${model.label}' is disabled`);
  const current = await getApplicationDefaultModel(db);
  if (current.id === modelId) return { ...model, source: "application" };

  const affected = await db
    .prepare(
      `SELECT s.id, s.prompt_epoch
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.model_config_id IS NULL AND w.default_model_config_id IS NULL`,
    )
    .all<{ id: string; prompt_epoch: number }>();
  const ids = (affected.results || []).map((row) => row.id);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    const active = await db
      .prepare(
        `SELECT id FROM generation_tasks
         WHERE session_id IN (${placeholders}) AND status IN ('pending', 'running') LIMIT 1`,
      )
      .bind(...ids)
      .first<{ id: string }>();
    if (active) throw new Error("生成期间不能切换应用默认模型");
  }

  const ts = nowIso();
  const sessionUpdates = await Promise.all(
    (affected.results || []).map(async (row) => {
      const epoch = row.prompt_epoch + 1;
      const affinity = await affinityKey(row.id, model, epoch);
      return db
        .prepare(
          `UPDATE sessions
           SET prompt_epoch = ?, prompt_epoch_reason = 'model_changed', affinity_key = ?,
               next_event_sequence = 1, updated_at = ?
           WHERE id = ?`,
        )
        .bind(epoch, affinity, ts, row.id);
    }),
  );
  await db.batch([
    db
      .prepare(`UPDATE app_settings SET default_model_config_id = ?, updated_at = ? WHERE id = 'default'`)
      .bind(modelId, ts),
    ...sessionUpdates,
  ]);
  return { ...model, source: "application" };
}

export async function ensureWorkspaceProjection(
  db: D1Database,
  workspace: {
    id: string;
    name: string;
    playerName: string;
    nmemSpace?: string | null;
    primaryCharacterId?: string | null;
  },
): Promise<void> {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO workspaces (id, name, player_name, nmem_space, primary_character_id, asset_prefix, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         player_name = excluded.player_name,
         nmem_space = excluded.nmem_space,
         primary_character_id = excluded.primary_character_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      workspace.id,
      workspace.name,
      workspace.playerName,
      workspace.nmemSpace || null,
      workspace.primaryCharacterId || null,
      `v2/workspaces/${workspace.id}`,
      ts,
      ts,
    )
    .run();
}

export async function ensureSessionProjection(
  db: D1Database,
  session: {
    id: string;
    workspaceId: string;
    title: string;
    nmemSpace?: string | null;
    primaryCharacterId?: string | null;
  },
): Promise<void> {
  const ts = nowIso();
  const affinity = await affinityKey(session.id, DEFAULT_MODEL, 1);
  await db
    .prepare(
      `INSERT INTO sessions (
         id, workspace_id, title, nmem_space, primary_character_id, prompt_epoch, prompt_epoch_reason,
         affinity_key, next_message_sequence, next_event_sequence, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 'session_created', ?, 1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         nmem_space = excluded.nmem_space,
         primary_character_id = excluded.primary_character_id,
         updated_at = excluded.updated_at`,
    )
    .bind(
      session.id,
      session.workspaceId,
      session.title,
      session.nmemSpace || null,
      session.primaryCharacterId || null,
      affinity,
      ts,
      ts,
    )
    .run();
}

export async function resolveSessionModel(db: D1Database, sessionId: string): Promise<AiModelConfig> {
  const row = await db
    .prepare(
      `SELECT m.${MODEL_COLUMNS.split(", ").join(", m.")},
        CASE
          WHEN s.model_config_id IS NOT NULL THEN 'session'
          WHEN w.default_model_config_id IS NOT NULL THEN 'workspace'
          ELSE 'application'
        END AS source
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN app_settings a ON a.id = 'default'
       JOIN ai_model_configs m ON m.id = COALESCE(s.model_config_id, w.default_model_config_id, a.default_model_config_id)
       WHERE s.id = ?`,
    )
    .bind(sessionId)
    .first<ModelRow>();
  if (!row) throw new Error(`session '${sessionId}' has no model configuration`);
  return fromRow(row);
}

export async function sessionRuntime(
  db: D1Database,
  sessionId: string,
): Promise<{
  workspace_id: string;
  prompt_epoch: number;
  affinity_key: string;
  model_config_id: string | null;
}> {
  const row = await db
    .prepare(`SELECT workspace_id, prompt_epoch, affinity_key, model_config_id FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ workspace_id: string; prompt_epoch: number; affinity_key: string; model_config_id: string | null }>();
  if (!row) throw new Error(`session '${sessionId}' not found`);
  return row;
}

export async function setSessionModel(
  db: D1Database,
  sessionId: string,
  modelId: string | null,
): Promise<AiModelConfig> {
  if (modelId) {
    const selected = await getModel(db, modelId);
    if (!selected) throw new Error(`model '${modelId}' not found`);
    if (!selected.enabled) throw new Error(`model '${selected.label}' is disabled`);
  }
  const current = await sessionRuntime(db, sessionId);
  if (current.model_config_id === modelId) return resolveSessionModel(db, sessionId);
  await db
    .prepare(
      `UPDATE sessions
       SET model_config_id = ?, prompt_epoch = prompt_epoch + 1, prompt_epoch_reason = 'model_changed', updated_at = ?
       WHERE id = ?`,
    )
    .bind(modelId, nowIso(), sessionId)
    .run();
  const model = await resolveSessionModel(db, sessionId);
  const next = await sessionRuntime(db, sessionId);
  const affinity = await affinityKey(sessionId, model, next.prompt_epoch);
  await db.prepare(`UPDATE sessions SET affinity_key = ? WHERE id = ?`).bind(affinity, sessionId).run();
  return { ...model, source: modelId ? "session" : model.source };
}

export async function upsertModel(
  db: D1Database,
  input: Omit<AiModelConfig, "revision" | "source"> & { revision?: number },
): Promise<AiModelConfig> {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO ai_model_configs (
        id, label, transport, provider_slug, model_id, context_window, max_output_tokens,
        supports_tools, supports_reasoning, enabled, sort_order, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        transport = excluded.transport,
        provider_slug = excluded.provider_slug,
        model_id = excluded.model_id,
        context_window = excluded.context_window,
        max_output_tokens = excluded.max_output_tokens,
        supports_tools = excluded.supports_tools,
        supports_reasoning = excluded.supports_reasoning,
        enabled = excluded.enabled,
        sort_order = excluded.sort_order,
        revision = ai_model_configs.revision + 1,
        probe_status = 'unprobed',
        probe_error = NULL,
        updated_at = excluded.updated_at`,
    )
    .bind(
      input.id,
      input.label,
      input.transport,
      input.provider_slug,
      input.model_id,
      input.context_window,
      input.max_output_tokens,
      Number(input.supports_tools),
      Number(input.supports_reasoning),
      Number(input.enabled),
      input.sort_order,
      input.revision || 1,
      ts,
      ts,
    )
    .run();
  const model = await getModel(db, input.id);
  if (!model) throw new Error("model update failed");
  return model;
}

export async function recordProbe(db: D1Database, id: string, ok: boolean, error?: string): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_model_configs SET probe_status = ?, probe_error = ?, enabled = ?, last_probed_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(ok ? "passed" : "failed", error || null, Number(ok), nowIso(), nowIso(), id)
    .run();
}
