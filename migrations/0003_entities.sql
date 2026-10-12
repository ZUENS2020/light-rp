-- Entity IDs identify a story referent. Registrations and aliases retain branch/source provenance.
CREATE TABLE entities (
  registration_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  story_id TEXT NOT NULL REFERENCES stories(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_version INTEGER NOT NULL,
  source_generation INTEGER NOT NULL,
  recorded_seq INTEGER NOT NULL CHECK(recorded_seq >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,branch_id,id)
);
CREATE INDEX entities_scope ON entities(owner_id,story_id,branch_id,recorded_seq,id);
CREATE INDEX entities_source ON entities(source_id,status);
CREATE TABLE entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  story_id TEXT NOT NULL REFERENCES stories(id),
  branch_id TEXT NOT NULL REFERENCES branches(id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 10,
  source_id TEXT NOT NULL REFERENCES sources(id),
  source_version INTEGER NOT NULL,
  source_generation INTEGER NOT NULL,
  recorded_seq INTEGER NOT NULL CHECK(recorded_seq >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,branch_id,entity_id,normalized_alias,source_id)
);
CREATE INDEX entity_alias_lookup ON entity_aliases(owner_id,story_id,normalized_alias,branch_id,recorded_seq);
CREATE INDEX entity_alias_source ON entity_aliases(source_id,entity_id);
-- Source deletion must erase names as well as hide an index hit. Other tables are untouched.
CREATE TRIGGER entity_source_erased AFTER UPDATE OF status ON sources
WHEN NEW.status='deleted' AND OLD.status<>'deleted' BEGIN
  DELETE FROM entity_aliases WHERE owner_id=NEW.owner_id AND (source_id=NEW.id OR entity_id IN
    (SELECT id FROM entities WHERE source_id=NEW.id AND owner_id=NEW.owner_id));
  UPDATE entities SET name='',normalized_name='',status='deleted'
    WHERE source_id=NEW.id AND owner_id=NEW.owner_id;
END;
