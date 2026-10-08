-- Additive migration: existing sources, revision IDs, rolling roots and APIs remain valid.
CREATE TABLE narrative_units (
  memory_id TEXT PRIMARY KEY REFERENCES memory_versions(id),
  unit_id TEXT NOT NULL,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  viewer TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('segment','scene','arc','chapter')),
  start_seq INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  closed INTEGER NOT NULL CHECK(closed IN (0,1))
);
CREATE INDEX narrative_directory ON narrative_units(branch_id,viewer,level,start_seq,unit_id);
CREATE TABLE plot_threads (
  memory_id TEXT PRIMARY KEY REFERENCES memory_versions(id),
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL REFERENCES branches(id),
  viewer TEXT NOT NULL,
  thread_type TEXT NOT NULL,
  thread_status TEXT NOT NULL
);
CREATE INDEX plot_directory ON plot_threads(branch_id,viewer,thread_status,thread_id);
CREATE TABLE vector_index_progress (
  branch_id TEXT NOT NULL REFERENCES branches(id),
  viewer TEXT NOT NULL,
  after_version INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL DEFAULT '',
  cleanup_after TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(branch_id,viewer)
);
CREATE VIRTUAL TABLE memory_fts_v2 USING fts5(memory_id UNINDEXED,names,title,keywords,body,tokenize='unicode61');
INSERT INTO memory_fts_v2(memory_id,names,title,keywords,body)
SELECT id,subject,'',predicate,search_text FROM memory_versions WHERE status NOT IN ('invalidated','forgotten');
CREATE TRIGGER memory_fts_v2_insert AFTER INSERT ON memory_versions BEGIN
  INSERT INTO memory_fts_v2(memory_id,names,title,keywords,body)
  VALUES(NEW.id,NEW.subject,COALESCE(json_extract(NEW.data_json,'$.title'),''),NEW.predicate,NEW.search_text);
END;
CREATE TRIGGER memory_fts_v2_scrub AFTER UPDATE OF text,status ON memory_versions
WHEN NEW.status IN ('invalidated','forgotten') OR NEW.text='' BEGIN
  DELETE FROM memory_fts_v2 WHERE memory_id=NEW.id;
END;
CREATE TABLE memory_policies (
  branch_id TEXT PRIMARY KEY REFERENCES branches(id),
  strategy TEXT NOT NULL CHECK(strategy IN ('rolling-v1','unified-v1')),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('active','building')),
  target_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER narrative_directory_insert AFTER INSERT ON memory_versions
WHEN json_extract(NEW.data_json,'$.recordType') IN ('narrative-segment','narrative-unit') BEGIN
  INSERT INTO narrative_units VALUES(NEW.id,json_extract(NEW.data_json,'$.unitId'),NEW.branch_id,NEW.subject,json_extract(NEW.data_json,'$.level'),json_extract(NEW.data_json,'$.startSeq'),COALESCE(json_extract(NEW.data_json,'$.startOffset'),0),json_extract(NEW.data_json,'$.endSeq'),COALESCE(json_extract(NEW.data_json,'$.endOffset'),0),COALESCE(json_extract(NEW.data_json,'$.closed'),0));
END;
CREATE TRIGGER plot_directory_insert AFTER INSERT ON memory_versions
WHEN json_extract(NEW.data_json,'$.recordType')='plot-thread' BEGIN
  INSERT INTO plot_threads VALUES(NEW.id,json_extract(NEW.data_json,'$.threadId'),NEW.branch_id,NEW.subject,json_extract(NEW.data_json,'$.threadType'),json_extract(NEW.data_json,'$.threadState'));
END;
-- A late pre-cutover task cannot install another state owner, even if its JS snapshot is old.
CREATE TRIGGER reject_legacy_observation BEFORE INSERT ON memory_versions
WHEN NEW.kind='observation' AND json_extract(NEW.data_json,'$.version')='rolling-v1'
 AND EXISTS(SELECT 1 FROM memory_policies WHERE branch_id=NEW.branch_id AND strategy='unified-v1' AND status='active') BEGIN
 SELECT RAISE(ABORT,'STALE_WRITE');
END;
CREATE INDEX memory_subject_lookup ON memory_versions(owner_id,subject,recorded_seq);
CREATE TABLE narrative_extractions (
 branch_id TEXT NOT NULL REFERENCES branches(id),
 source_id TEXT NOT NULL REFERENCES sources(id),
 PRIMARY KEY(branch_id,source_id)
);
CREATE TABLE narrative_boundary_checks (
 branch_id TEXT NOT NULL REFERENCES branches(id), viewer TEXT NOT NULL, level TEXT NOT NULL,
 input_hash TEXT NOT NULL, closed INTEGER NOT NULL CHECK(closed IN (0,1)),
 PRIMARY KEY(branch_id,viewer,level,input_hash)
);
CREATE INDEX memories_key_history ON memory_versions(owner_id,memory_key,recorded_seq);
CREATE INDEX memories_supersedes ON memory_versions(supersedes_id);
