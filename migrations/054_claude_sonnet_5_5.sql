-- 054_claude_sonnet_5_5.sql
-- Move newly created Ranked debates from the retiring Sonnet 4.5 model
-- to Claude Sonnet 5.5. Existing debate rows retain the model recorded
-- when they were created.

UPDATE ranked_system_configuration
SET
    debate_model_name = 'claude-sonnet-5-5',
    updated_at = NOW()
WHERE configuration_key = 'global'
  AND debate_model_provider = 'anthropic'
  AND debate_model_name IN (
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-6'
  );
