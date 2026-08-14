-- 019_kierkegaard_release.sql
--
-- Activates Søren Kierkegaard in the server-controlled Expanded Agora release
-- schedule without changing Dostoevsky or any other philosopher.
--
-- Intended rollout:
--   * Kierkegaard is already available to the beta/testing build.
--   * Pro access is already active because pro_launch_at is in the past.
--   * The public App Store build does not expose Kierkegaard yet.
--   * When the Kierkegaard app version ships, Pro users can use him immediately.
--   * Free Open Access Weekend begins Friday, September 11, 2026 at
--     6:00 AM EDT (2026-09-11 10:00:00+00) and lasts 72 hours.
--   * The event therefore ends Monday, September 14, 2026 at
--     6:00 AM EDT (2026-09-14 10:00:00+00).
--   * Eligible users then receive the existing 7-day, 3-debate grace preview.
--
-- This migration is intentionally scoped ONLY to philosopher_id = 'kierkegaard'.
-- It does not update Dostoevsky and does not change global Ranked configuration.
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
    TIMESTAMPTZ '2026-08-12 04:00:00+00',
    TIMESTAMPTZ '2026-09-11 10:00:00+00',
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

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM expanded_philosopher_releases
        WHERE philosopher_id = 'kierkegaard'
          AND display_name = 'Søren Kierkegaard'
          AND pro_launch_at = TIMESTAMPTZ '2026-08-12 04:00:00+00'
          AND free_event_starts_at = TIMESTAMPTZ '2026-09-11 10:00:00+00'
          AND free_event_duration_hours = 72
          AND grace_duration_days = 7
          AND preview_debate_limit = 3
          AND official_time_zone = 'America/New_York'
          AND minimum_ios_version = '3.8'
          AND minimum_ios_build IS NULL
          AND minimum_legacy_ios_build IS NULL
          AND is_enabled = TRUE
    ) THEN
        RAISE EXCEPTION
            'Kierkegaard release configuration was not applied exactly as expected';
    END IF;
END
$$;

SELECT
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
FROM expanded_philosopher_releases
WHERE philosopher_id = 'kierkegaard';
