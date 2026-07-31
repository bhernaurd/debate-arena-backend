-- 012_ranked_demotion_protection_v2.sql
-- Version the corrected protection policy before deploying rankedRatingService v2.
--
-- Protected completed debates may lose RP inside their current division, but
-- cannot cross into a lower division or lower major rank. Deliberate forfeits
-- and invalid results still bypass protection.

UPDATE ranked_system_configuration
SET
    ranked_rules_version = 'ranked-rules-v2',
    rp_formula_version = 'ranked-rp-v2',
    updated_at = NOW()
WHERE configuration_key = 'global';
