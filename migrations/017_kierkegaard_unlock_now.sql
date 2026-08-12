-- 017_kierkegaard_unlock_now.sql
--
-- Unlocks Søren Kierkegaard for Agora Pro immediately while preserving the
-- already-approved September 11-13, 2026 Open Access Weekend and the existing
-- post-event grace-preview rules.
--
-- Official timezone: America/New_York
-- Pro access begins: Wednesday, August 12, 2026 at 12:00 AM EDT
--                    (2026-08-12 04:00:00+00)
-- Open Access remains: September 11, 2026 at 12:00 AM EDT for 72 hours
--
-- The migration runner wraps this file in a transaction. Do not add BEGIN or
-- COMMIT statements here.

UPDATE expanded_philosopher_releases
SET
    pro_launch_at = TIMESTAMPTZ '2026-08-12 04:00:00+00',
    updated_at = CURRENT_TIMESTAMP
WHERE philosopher_id = 'kierkegaard';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM expanded_philosopher_releases
        WHERE philosopher_id = 'kierkegaard'
          AND pro_launch_at = TIMESTAMPTZ '2026-08-12 04:00:00+00'
          AND free_event_starts_at = TIMESTAMPTZ '2026-09-11 04:00:00+00'
          AND free_event_duration_hours = 72
          AND is_enabled = TRUE
    ) THEN
        RAISE EXCEPTION
            'Kierkegaard immediate unlock failed or release schedule is not the approved configuration';
    END IF;
END
$$;

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
    is_enabled
FROM expanded_philosopher_release_schedule
WHERE philosopher_id = 'kierkegaard';
