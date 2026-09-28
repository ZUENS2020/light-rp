-- Scene state as it was right before each story reply was generated, so a retry can
-- restore exactly the pre-reply state instead of clearing it.
ALTER TABLE generation_tasks ADD COLUMN scene_before_json TEXT;
