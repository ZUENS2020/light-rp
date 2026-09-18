-- Switch production GLM row off OpenRouter @preset/... to a direct latest slug.
-- Keep config id glm53-flash-cheap-openrouter so sessions / app_settings keep resolving.
-- Parent may have already patched live D1; this migration is idempotent.
UPDATE ai_model_configs
SET model_id = '~z-ai/glm-flash-latest',
    label = 'GLM Flash Latest · OpenRouter',
    revision = revision + 1,
    updated_at = datetime('now')
WHERE id = 'glm53-flash-cheap-openrouter'
  AND (model_id != '~z-ai/glm-flash-latest' OR label != 'GLM Flash Latest · OpenRouter');
