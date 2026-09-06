-- Production default is GLM 5.3 Flash Cheap (@preset/glm53-flash-cheap).
-- Seed it for fresh D1, and raise any OpenRouter cap still below 16384 so
-- story max_tokens is not clipped below ~2000 汉字 + GLM reasoning.
INSERT INTO ai_model_configs (
  id, label, transport, provider_slug, model_id, context_window, max_output_tokens,
  supports_tools, supports_reasoning, enabled, sort_order, revision, probe_status, created_at, updated_at
)
SELECT
  'glm53-flash-cheap-openrouter',
  'GLM 5.3 Flash Cheap · OpenRouter',
  'gateway',
  'openrouter',
  '@preset/glm53-flash-cheap',
  1048576,
  32768,
  1, 1, 1, 12, 1, 'passed', datetime('now'), datetime('now')
WHERE NOT EXISTS (
  SELECT 1 FROM ai_model_configs WHERE id = 'glm53-flash-cheap-openrouter'
);

UPDATE ai_model_configs
SET max_output_tokens = 16384,
    revision = revision + 1,
    updated_at = datetime('now')
WHERE provider_slug = 'openrouter'
  AND max_output_tokens < 16384;
