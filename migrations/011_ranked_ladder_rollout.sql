-- 011_ranked_ladder_rollout.sql
-- Adds an independent rollout switch for post-placement Ranked ladder debates.
--
-- Placement testing can remain enabled while ladder starts stay disabled.
-- This migration does not enable the ladder and does not change Pro access.

ALTER TABLE ranked_system_configuration
    ADD COLUMN IF NOT EXISTS ladder_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ranked_system_configuration.ladder_enabled IS
    'Controls creation of post-placement Ranked ladder debates independently from placement trials.';
