-- Switch the live GLM flash row onto Command Code GOAT Provider (OpenAI-compatible).
-- Keep transport='gateway' so we do not rebuild ai_model_configs (D1 enforces FKs and
-- cannot DROP a referenced parent). Runtime routes provider_slug=commandcode via direct
-- fetch (see ai-gateway openai_compatible / commandcode path), not AI Gateway BYOK.
-- Keep config id so app_settings / sessions keep resolving.
UPDATE ai_model_configs
SET provider_slug = 'commandcode',
    model_id = 'z-ai/glm-5.3-flash',
    label = 'GLM 5.3 Flash · Command Code GOAT',
    context_window = 1000000,
    max_output_tokens = CASE WHEN max_output_tokens < 16384 THEN 16384 ELSE max_output_tokens END,
    supports_tools = 1,
    supports_reasoning = 1,
    enabled = 1,
    revision = revision + 1,
    probe_status = 'unprobed',
    probe_error = NULL,
    updated_at = datetime('now')
WHERE id = 'glm53-flash-cheap-openrouter';
