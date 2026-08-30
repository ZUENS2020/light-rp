ALTER TABLE generation_tasks ADD COLUMN nmem_sync_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE generation_tasks ADD COLUMN nmem_synced_at TEXT;
ALTER TABLE generation_tasks ADD COLUMN nmem_error TEXT;
ALTER TABLE generation_tasks ADD COLUMN nmem_memory_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_tasks ADD COLUMN nmem_recall_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memories ADD COLUMN external_id TEXT;
ALTER TABLE memories ADD COLUMN source_task_id TEXT;
ALTER TABLE memories ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memories ADD COLUMN last_recalled_at TEXT;
ALTER TABLE memories ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_memories_active_scope
  ON memories(workspace_id, scope, character_id, status, updated_at DESC);
CREATE INDEX idx_memories_external_id ON memories(external_id);

CREATE TABLE memory_recall_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES generation_tasks(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'nmem',
  space_id TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  recalled_count INTEGER NOT NULL DEFAULT 0,
  content_hashes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(content_hashes_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_recall_session ON memory_recall_events(session_id, created_at DESC);

CREATE TABLE memory_sync_runs (
  task_id TEXT PRIMARY KEY REFERENCES generation_tasks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'nmem',
  space_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  core_memory_count INTEGER NOT NULL DEFAULT 0,
  turn_external_id TEXT,
  thread_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_memory_sync_session ON memory_sync_runs(session_id, updated_at DESC);
