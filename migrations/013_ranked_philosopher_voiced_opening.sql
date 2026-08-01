-- 013_ranked_philosopher_voiced_opening.sql
--
-- Adds an auditable philosopher-voiced opening question while preserving a
-- neutral canonical topic for scoring, duplicate detection, analytics, and
-- reports. New placement and ladder debates seed the voiced question directly
-- into messages as the completed assistant opening, so the user can
-- respond immediately without waiting for a second AI opening request.
--
-- Existing debates remain valid and unchanged.

BEGIN;

ALTER TABLE account_ranked_start_requests
    ADD COLUMN IF NOT EXISTS opening_question TEXT;

ALTER TABLE account_ranked_debates
    ADD COLUMN IF NOT EXISTS opening_question TEXT;

ALTER TABLE account_ranked_start_requests
    DROP CONSTRAINT IF EXISTS account_ranked_start_requests_opening_question_chk;

ALTER TABLE account_ranked_start_requests
    ADD CONSTRAINT account_ranked_start_requests_opening_question_chk
    CHECK (
        opening_question IS NULL
        OR (
            char_length(btrim(opening_question)) BETWEEN 20 AND 280
            AND right(btrim(opening_question), 1) = '?'
            AND position(E'\n' IN opening_question) = 0
        )
    );

ALTER TABLE account_ranked_debates
    DROP CONSTRAINT IF EXISTS account_ranked_debates_opening_question_chk;

ALTER TABLE account_ranked_debates
    ADD CONSTRAINT account_ranked_debates_opening_question_chk
    CHECK (
        opening_question IS NULL
        OR (
            char_length(btrim(opening_question)) BETWEEN 20 AND 280
            AND right(btrim(opening_question), 1) = '?'
            AND position(E'\n' IN opening_question) = 0
        )
    );

ALTER TABLE account_ranked_start_requests
    DROP CONSTRAINT IF EXISTS account_ranked_start_requests_voiced_topic_version_chk;

ALTER TABLE account_ranked_start_requests
    ADD CONSTRAINT account_ranked_start_requests_voiced_topic_version_chk
    CHECK (
        topic_generator_version IS DISTINCT FROM
            'ranked-topic-v2-philosopher-voiced'
        OR opening_question IS NOT NULL
    );

ALTER TABLE account_ranked_debates
    DROP CONSTRAINT IF EXISTS account_ranked_debates_voiced_topic_version_chk;

ALTER TABLE account_ranked_debates
    ADD CONSTRAINT account_ranked_debates_voiced_topic_version_chk
    CHECK (
        topic_generator_version IS DISTINCT FROM
            'ranked-topic-v2-philosopher-voiced'
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
    ranked_rules_version =
        'ranked-rules-v2-philosopher-question-opening',
    topic_generator_version =
        'ranked-topic-v2-philosopher-voiced',
    updated_at = CURRENT_TIMESTAMP
WHERE configuration_key = 'global';

COMMIT;

SELECT
    configuration_key,
    ranked_rules_version,
    philosopher_prompt_version,
    scoring_prompt_version,
    topic_generator_version,
    ladder_enabled
FROM ranked_system_configuration
WHERE configuration_key = 'global';
