-- 014_ranked_mode_contracts.sql
--
-- Versions the unified Guided, Balanced, and Relentless contracts used by
-- Ranked philosopher replies. The philosopher prompt remains authoritative
-- for identity, worldview, method, and scoring lens. The selected mode is now
-- authoritative for accessibility, intensity, response-body length, density,
-- paragraph structure, and the number of pressure points pursued.
--
-- No debate rows, scores, RP values, placement results, or transcripts are
-- rewritten by this migration. New model generations use the updated versions.

BEGIN;

UPDATE ranked_system_configuration
SET
    ranked_rules_version =
        'ranked-rules-v3-mode-contracts',
    scoring_prompt_version =
        'ranked-scoring-v3-mode-contracts',
    updated_at = CURRENT_TIMESTAMP
WHERE configuration_key = 'global';

COMMIT;

SELECT
    configuration_key,
    is_enabled,
    allow_new_debates,
    placements_enabled,
    ladder_enabled,
    ranked_rules_version,
    philosopher_prompt_version,
    scoring_prompt_version,
    topic_generator_version,
    rp_formula_version
FROM ranked_system_configuration
WHERE configuration_key = 'global';
