-- Permanent ranked milestone for any account that has reached The Alchemist,
-- including rank changes made by an authenticated administrator.
-- This backfills promotions recorded before the achievement was connected.
INSERT INTO account_achievement_unlocks (
  account_id, achievement_id, unlocked_at, origin_installation_id,
  last_synced_from_installation_id, source_schema_version
)
SELECT p.account_id, 'ranked_alchemist',
       COALESCE(p.peak_reached_at, p.updated_at, NOW()),
       'ranked-server', 'ranked-server', 1
FROM account_ranked_profiles p
WHERE p.peak_rank_key = 'alchemist' OR p.current_rank_key = 'alchemist'
ON CONFLICT (account_id, achievement_id) DO NOTHING;
