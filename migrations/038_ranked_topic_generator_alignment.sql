-- 038_ranked_topic_generator_alignment.sql
--
-- Permanently aligns the database's active Ranked topic-generator version with
-- the Kierkegaard-capable generator shipped by the backend. The server now
-- performs a fail-fast readiness check at startup, so future version drift is
-- caught during deployment instead of when a user starts a Ranked debate.
--
-- Existing Ranked debates keep the version stored when they were created.
-- Only newly created debates use the active configuration below.
--
-- The migration runner wraps this file in a transaction. Do not add BEGIN or
-- COMMIT statements here.

ALTER TABLE account_ranked_start_requests
    DROP CONSTRAINT IF EXISTS account_ranked_start_requests_voiced_topic_version_chk;

ALTER TABLE account_ranked_start_requests
    ADD CONSTRAINT account_ranked_start_requests_voiced_topic_version_chk
    CHECK (
        topic_generator_version NOT IN (
            'ranked-topic-v2-philosopher-voiced',
            'ranked-topic-v2-kierkegaard'
        )
        OR opening_question IS NOT NULL
    );

ALTER TABLE account_ranked_debates
    DROP CONSTRAINT IF EXISTS account_ranked_debates_voiced_topic_version_chk;

ALTER TABLE account_ranked_debates
    ADD CONSTRAINT account_ranked_debates_voiced_topic_version_chk
    CHECK (
        topic_generator_version NOT IN (
            'ranked-topic-v2-philosopher-voiced',
            'ranked-topic-v2-kierkegaard'
        )
        OR (
            opening_question IS NOT NULL
            AND CASE
                WHEN jsonb_typeof(messages) = 'array'
                THEN jsonb_array_length(messages) >= 1
                ELSE FALSE
            END
        )
    );

UPDATE ranked_system_configuration
SET
    topic_generator_version = 'ranked-topic-v2-kierkegaard',
    updated_at = CURRENT_TIMESTAMP
WHERE configuration_key = 'global';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM ranked_system_configuration
        WHERE configuration_key = 'global'
          AND topic_generator_version = 'ranked-topic-v2-kierkegaard'
    ) THEN
        RAISE EXCEPTION
            'Ranked topic generator configuration was not aligned';
    END IF;
END
$$;

SELECT
    configuration_key,
    ranked_rules_version,
    philosopher_prompt_version,
    scoring_prompt_version,
    report_prompt_version,
    topic_generator_version,
    rp_formula_version,
    debate_model_provider,
    debate_model_name
FROM ranked_system_configuration
WHERE configuration_key = 'global';
