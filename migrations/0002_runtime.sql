CREATE TABLE embedding_cache (
 memory_id TEXT PRIMARY KEY REFERENCES memory_versions(id), owner_id TEXT NOT NULL,
 model TEXT NOT NULL, values_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE vector_manifest (
 vector_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, branch_id TEXT NOT NULL,
 memory_id TEXT NOT NULL REFERENCES memory_versions(id), viewer TEXT NOT NULL,
 scope TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX vector_manifest_branch ON vector_manifest(owner_id, branch_id, viewer);
CREATE INDEX vector_manifest_memory ON vector_manifest(owner_id, memory_id);
