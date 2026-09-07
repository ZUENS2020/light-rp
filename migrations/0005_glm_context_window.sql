-- OpenRouter reports ~1310720 context for z-ai/glm-5.3-flash / @preset/glm53-flash-cheap.
-- Migration 0004 seeded 1048576; align live + fresh rows without rewriting 0004.
UPDATE ai_model_configs
SET context_window = 1310720,
    revision = revision + 1,
    updated_at = datetime('now')
WHERE id = 'glm53-flash-cheap-openrouter'
  AND context_window < 1310720;
