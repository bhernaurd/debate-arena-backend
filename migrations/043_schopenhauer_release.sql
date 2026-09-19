-- 043_schopenhauer_release.sql
--
-- Activates Arthur Schopenhauer in the server-controlled Expanded Agora release
-- schedule without changing any existing philosopher.
--
-- Rollout:
--   * Schopenhauer is available to Agora Pro as soon as the app build exposing
--     him ships. pro_launch_at is intentionally in the past relative to that build.
--   * Free Open Access Weekend begins Friday, October 16, 2026 at
--     6:00 AM EDT (2026-10-16 10:00:00+00) and lasts 72 hours.
--   * The event ends Monday, October 19, 2026 at
--     6:00 AM EDT (2026-10-19 10:00:00+00).
--   * Eligible free users then receive the existing 7-day, 3-debate grace preview.
--
-- This migration is intentionally scoped ONLY to philosopher_id = 'schopenhauer'.
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
    'schopenhauer',
    'Arthur Schopenhauer',
    TIMESTAMPTZ '2026-09-19 10:00:00+00',
    TIMESTAMPTZ '2026-10-16 10:00:00+00',
    72,
    7,
    3,
    'America/New_York',
    '4.5',
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
        WHERE philosopher_id = 'schopenhauer'
          AND display_name = 'Arthur Schopenhauer'
          AND pro_launch_at = TIMESTAMPTZ '2026-09-19 10:00:00+00'
          AND free_event_starts_at = TIMESTAMPTZ '2026-10-16 10:00:00+00'
          AND free_event_duration_hours = 72
          AND grace_duration_days = 7
          AND preview_debate_limit = 3
          AND official_time_zone = 'America/New_York'
          AND minimum_ios_version = '4.5'
          AND minimum_ios_build IS NULL
          AND minimum_legacy_ios_build IS NULL
          AND is_enabled = TRUE
    ) THEN
        RAISE EXCEPTION
            'Schopenhauer release configuration was not applied exactly as expected';
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
WHERE philosopher_id = 'schopenhauer';
