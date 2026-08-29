CREATE TABLE IF NOT EXISTS generation_tasks (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  content TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_session ON generation_tasks(world_id, session_id, created_at);
