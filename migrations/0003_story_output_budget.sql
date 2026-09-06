-- Story RP needs ~2000 汉字 of visible body. GLM/OpenRouter reasoning
-- tokens share the same max_tokens budget, so the OpenRouter preset cap
-- must sit well above 4k or the story floor is clipped.
UPDATE ai_model_configs
SET max_output_tokens = 16384,
    revision = revision + 1,
    updated_at = datetime('now')
WHERE id = 'dsf0731-cheap-openrouter'
  AND max_output_tokens < 16384;
