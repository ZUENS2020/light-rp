-- Keep existing task statuses/history compatible; expose phase through the API.
ALTER TABLE generation_tasks ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'generating'
  CHECK (execution_phase IN ('generating', 'committing', 'cancelled'));
ALTER TABLE generation_tasks ADD COLUMN commit_payload_json TEXT CHECK (commit_payload_json IS NULL OR json_valid(commit_payload_json));

CREATE TABLE nmem_connection (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  status TEXT NOT NULL CHECK (status IN ('offline', 'probing', 'online')),
  revision INTEGER NOT NULL DEFAULT 0,
  sync_owner TEXT,
  sync_expires_at TEXT,
  spaces_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(spaces_json)),
  updated_at TEXT NOT NULL
);
INSERT INTO nmem_connection (id, status, updated_at) VALUES ('default', 'offline', datetime('now'));

CREATE TABLE nmem_jobs (
  task_id TEXT PRIMARY KEY REFERENCES generation_tasks(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'deferred' CHECK (status IN ('deferred', 'running', 'completed', 'failed')),
  steps_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(steps_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_nmem_jobs_pending ON nmem_jobs(status, created_at, task_id);

CREATE TABLE nmem_snapshot_requests (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);
