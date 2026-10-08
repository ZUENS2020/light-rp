CREATE TABLE observation_progress (
  branch_id TEXT NOT NULL REFERENCES branches(id),
  scope TEXT NOT NULL,
  observation_id TEXT REFERENCES memory_versions(id),
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(branch_id,scope)
);
