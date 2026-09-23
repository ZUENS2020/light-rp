-- Cap advertised model window at 128k so nothing budgets against the 1M provider limit.
UPDATE ai_model_configs
SET context_window = MIN(context_window, 128000)
WHERE context_window > 128000;
