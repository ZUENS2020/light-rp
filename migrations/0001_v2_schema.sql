PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  player_name TEXT NOT NULL DEFAULT '你',
  nmem_space TEXT,
  default_model_config_id TEXT,
  primary_character_id TEXT,
  asset_prefix TEXT NOT NULL,
  source_version INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_model_configs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('cloudflare', 'gateway')),
  provider_slug TEXT,
  model_id TEXT NOT NULL,
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  supports_tools INTEGER NOT NULL DEFAULT 0 CHECK (supports_tools IN (0, 1)),
  supports_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (supports_reasoning IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  probe_status TEXT NOT NULL DEFAULT 'unprobed' CHECK (probe_status IN ('unprobed', 'passed', 'failed')),
  probe_error TEXT,
  last_probed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (transport, provider_slug, model_id)
);

CREATE TABLE app_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  default_model_config_id TEXT NOT NULL REFERENCES ai_model_configs(id),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  prompt_config_revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  card_r2_key TEXT NOT NULL,
  mini_r2_key TEXT,
  source_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE lorebooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_r2_key TEXT NOT NULL,
  source_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE lore_entries (
  id TEXT PRIMARY KEY,
  lorebook_id TEXT NOT NULL REFERENCES lorebooks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  keys_json TEXT NOT NULL CHECK (json_valid(keys_json)),
  secondary_keys_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(secondary_keys_json)),
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  constant INTEGER NOT NULL DEFAULT 0 CHECK (constant IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  content_hash TEXT NOT NULL,
  UNIQUE (lorebook_id, position)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  nmem_space TEXT,
  primary_character_id TEXT,
  model_config_id TEXT REFERENCES ai_model_configs(id),
  prompt_epoch INTEGER NOT NULL DEFAULT 1,
  prompt_epoch_reason TEXT NOT NULL DEFAULT 'session_created',
  affinity_key TEXT NOT NULL,
  next_message_sequence INTEGER NOT NULL DEFAULT 1,
  next_event_sequence INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_workspace_updated ON sessions(workspace_id, updated_at DESC, id DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  client_message_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, client_message_id)
);
CREATE INDEX idx_messages_cursor ON messages(session_id, sequence DESC);

CREATE TABLE llm_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('checkpoint', 'context', 'user', 'assistant', 'tool_call', 'tool_result', 'summary', 'memory')),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL,
  stable INTEGER NOT NULL DEFAULT 0 CHECK (stable IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (session_id, prompt_epoch, sequence)
);
CREATE INDEX idx_llm_events_epoch ON llm_events(session_id, prompt_epoch, sequence);
CREATE UNIQUE INDEX idx_llm_context_dedup
  ON llm_events(session_id, prompt_epoch, kind, content_hash)
  WHERE kind IN ('checkpoint', 'context', 'memory');

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  character_id TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('world', 'player', 'character', 'event', 'nmem')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, scope, character_id, content_hash)
);

CREATE TABLE generation_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'regenerate', 'rewrite', 'compact', 'summary', 'memory', 'probe')),
  idempotency_key TEXT NOT NULL,
  user_text TEXT,
  target_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
  model_snapshot_json TEXT NOT NULL CHECK (json_valid(model_snapshot_json)),
  request_hash TEXT,
  response_cache_status TEXT NOT NULL DEFAULT 'unknown' CHECK (response_cache_status IN ('HIT', 'MISS', 'BYPASS', 'unknown')),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  stable_prefix_tokens INTEGER NOT NULL DEFAULT 0,
  volatile_tokens INTEGER NOT NULL DEFAULT 0,
  output_contract_tokens INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_message_id TEXT,
  result_content TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, idempotency_key)
);
CREATE INDEX idx_generation_tasks_session ON generation_tasks(session_id, created_at DESC);
CREATE UNIQUE INDEX idx_one_active_generation_per_session
  ON generation_tasks(session_id)
  WHERE status IN ('pending', 'running');

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES generation_tasks(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (task_id, tool_call_id, arguments_hash)
);

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  published_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_outbox_pending ON outbox_events(published_at, created_at);

CREATE TABLE migration_runs (
  id TEXT PRIMARY KEY,
  source_version INTEGER NOT NULL,
  target_version INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('plan', 'apply', 'verify')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  manifest_r2_key TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(stats_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

INSERT INTO ai_model_configs (
  id, label, transport, provider_slug, model_id, context_window, max_output_tokens,
  supports_tools, supports_reasoning, enabled, sort_order, revision, probe_status, created_at, updated_at
) VALUES
  ('dsf0731-cheap-openrouter', 'DSF0731 Cheap · OpenRouter', 'gateway', 'openrouter', '@preset/dsf0731-cheap', 131072, 8192, 1, 1, 1, 10, 1, 'passed', datetime('now'), datetime('now')),
  ('kimi-k3-openrouter', 'Kimi K3', 'gateway', 'openrouter', 'moonshotai/kimi-k3', 1000000, 32768, 1, 1, 0, 15, 1, 'unprobed', datetime('now'), datetime('now')),
  ('kimi-k2-6-workers', 'Kimi K2.6 · Workers AI', 'cloudflare', NULL, '@cf/moonshotai/kimi-k2.6', 262144, 8192, 1, 1, 1, 20, 1, 'passed', datetime('now'), datetime('now')),
  ('gpt-oss-20b-workers', 'GPT OSS 20B · Workers AI', 'cloudflare', NULL, '@cf/openai/gpt-oss-20b', 131072, 8192, 1, 1, 1, 30, 1, 'passed', datetime('now'), datetime('now'));

INSERT INTO app_settings (id, default_model_config_id, settings_json, prompt_config_revision, updated_at)
VALUES ('default', 'dsf0731-cheap-openrouter', '{}', 1, datetime('now'));
