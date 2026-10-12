-- Preserve rowid exactly: branch_lineage.max_grant_rowid freezes inherited ACL.
-- No table references knowledge_grants by FK; retain its source/span/branch FKs
-- and the existing grants_scope index while widening only channel attribution.
CREATE TABLE knowledge_grants_v4 (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  source_id TEXT NOT NULL REFERENCES sources(id),
  span_id TEXT NOT NULL REFERENCES source_spans(id),
  character_id TEXT NOT NULL,
  recorded_seq INTEGER NOT NULL,
  acquired_seq INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('witnessed','told','rumor','inferred','author','persona','public')),
  status TEXT NOT NULL CHECK(status IN ('grant','revoke')),
  created_at TEXT NOT NULL
);
INSERT INTO knowledge_grants_v4(rowid,id,owner_id,branch_id,source_id,span_id,character_id,recorded_seq,acquired_seq,channel,status,created_at)
SELECT rowid,id,owner_id,branch_id,source_id,span_id,character_id,recorded_seq,acquired_seq,channel,status,created_at FROM knowledge_grants;
DROP TABLE knowledge_grants;
ALTER TABLE knowledge_grants_v4 RENAME TO knowledge_grants;
CREATE INDEX grants_scope ON knowledge_grants(owner_id,branch_id,source_id,character_id,recorded_seq);
