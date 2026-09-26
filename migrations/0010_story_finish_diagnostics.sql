-- Persist how each story completion ended so truncation reports can be diagnosed from D1
-- (finish_reason was never stored; GLM can end streams with sensitive/network_error + usage).
ALTER TABLE generation_tasks ADD COLUMN finish_reason TEXT;
ALTER TABLE generation_tasks ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_tasks ADD COLUMN story_retry TEXT;
