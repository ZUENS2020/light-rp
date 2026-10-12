ALTER TABLE worlds ADD COLUMN narrative_mode TEXT NOT NULL DEFAULT 'guided'
  CHECK(narrative_mode IN ('guided','freeform'));
ALTER TABLE worlds ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE world_policy_changes (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  command_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('guided','freeform')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(world_id,command_id),
  UNIQUE(world_id,revision)
);
