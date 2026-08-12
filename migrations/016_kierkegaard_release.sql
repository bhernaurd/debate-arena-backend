-- 016_kierkegaard_release.sql
--
-- Adds Søren Kierkegaard as the next scheduled Expanded Agora philosopher.
--
-- Release plan (official time zone: America/New_York):
--   Pro launch:          Friday, August 21, 2026 at 12:00 AM EDT
--   Open Access Weekend: Friday, September 11, 2026 at 12:00 AM EDT
--                        through Sunday, September 13, 2026
--                        (72 hours, ending Monday September 14 at 12:00 AM EDT)
--   Grace preview:       7 days after the event, 3 debates for eligible users
--
-- The shared Expanded Agora access engine derives the event end, grace start,
-- grace end, and eligibility cutoff from this row. Pro users may start debates
-- as soon as pro_launch_at is reached. Free users receive unlimited access only
-- during the 72-hour event, followed by the existing three-debate grace preview.
--
-- The migration runner wraps this file in a transaction. Do not add BEGIN or
-- COMMIT statements here.

INSERT INTO expanded_philosopher_releases (
    philosopher_id,
    display_name,
    pro_launch_at,
    free_event_starts_at,
    free_event_duration_hours,
    grace_duration_days,
    preview_debate_limit,
    official_time_zone,
    minimum_ios_version,
    minimum_ios_build,
    minimum_legacy_ios_build,
    is_enabled
)
VALUES (
    'kierkegaard',
    'Søren Kierkegaard',
    TIMESTAMPTZ '2026-08-21 04:00:00+00',
    TIMESTAMPTZ '2026-09-11 04:00:00+00',
    72,
    7,
    3,
    'America/New_York',
    '3.8',
    NULL,
    NULL,
    TRUE
)
ON CONFLICT (philosopher_id)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    pro_launch_at = EXCLUDED.pro_launch_at,
    free_event_starts_at = EXCLUDED.free_event_starts_at,
    free_event_duration_hours = EXCLUDED.free_event_duration_hours,
    grace_duration_days = EXCLUDED.grace_duration_days,
    preview_debate_limit = EXCLUDED.preview_debate_limit,
    official_time_zone = EXCLUDED.official_time_zone,
    minimum_ios_version = EXCLUDED.minimum_ios_version,
    minimum_ios_build = EXCLUDED.minimum_ios_build,
    minimum_legacy_ios_build = EXCLUDED.minimum_legacy_ios_build,
    is_enabled = EXCLUDED.is_enabled,
    updated_at = CURRENT_TIMESTAMP;

-- Both the existing philosopher-voiced topic version and the Kierkegaard
-- bundle require the server-generated philosopher opening question. Migration
-- 013 only named the original version, so extend that invariant before the
-- global configuration moves to the new bundle.
ALTER TABLE account_ranked_start_requests
    DROP CONSTRAINT IF EXISTS account_ranked_start_requests_voiced_topic_version_chk;

ALTER TABLE account_ranked_start_requests
    ADD CONSTRAINT account_ranked_start_requests_voiced_topic_version_chk
    CHECK (
        (
            topic_generator_version IS DISTINCT FROM
                'ranked-topic-v2-philosopher-voiced'
            AND topic_generator_version IS DISTINCT FROM
                'ranked-topic-v2-kierkegaard'
        )
        OR opening_question IS NOT NULL
    );

ALTER TABLE account_ranked_debates
    DROP CONSTRAINT IF EXISTS account_ranked_debates_voiced_topic_version_chk;

ALTER TABLE account_ranked_debates
    ADD CONSTRAINT account_ranked_debates_voiced_topic_version_chk
    CHECK (
        (
            topic_generator_version IS DISTINCT FROM
                'ranked-topic-v2-philosopher-voiced'
            AND topic_generator_version IS DISTINCT FROM
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

-- New Ranked debates should record the prompt/topic bundle that includes
-- Kierkegaard. Existing Ranked debates retain the versions saved at creation.
UPDATE ranked_system_configuration
SET
    philosopher_prompt_version = 'philosopher-prompts-v2-kierkegaard',
    topic_generator_version = 'ranked-topic-v2-kierkegaard',
    updated_at = CURRENT_TIMESTAMP
WHERE configuration_key = 'global';

SELECT
    philosopher_id,
    display_name,
    pro_launch_at,
    free_event_starts_at,
    free_event_ends_at,
    grace_starts_at,
    grace_ends_at,
    preview_debate_limit,
    official_time_zone,
    required_minimum_ios_version,
    minimum_ios_build,
    is_enabled
FROM expanded_philosopher_release_schedule
WHERE philosopher_id = 'kierkegaard';
