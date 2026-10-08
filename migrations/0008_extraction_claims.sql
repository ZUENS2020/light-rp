-- Existing markers were recorded after consumption; new online commits claim
-- ownership before the asynchronous consumers have finished.
ALTER TABLE narrative_extractions ADD COLUMN stage TEXT NOT NULL DEFAULT 'applied'
  CHECK(stage IN ('claimed','applied'));
