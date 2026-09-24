-- Raise GLM-5.3 Flash output ceiling: CoT and visible text share one max_tokens pool.
-- 32k gives room for long story beats when thinking burns several thousand tokens.
-- Assemble still reserves STORY_OUTPUT_TOKEN_FLOOR (~16k) inside the working window.
UPDATE ai_model_configs
SET max_output_tokens = CASE
      WHEN max_output_tokens < 32768 THEN 32768
      ELSE max_output_tokens
    END,
    revision = revision + 1,
    updated_at = datetime('now')
WHERE id = 'glm53-flash-cheap-openrouter';
