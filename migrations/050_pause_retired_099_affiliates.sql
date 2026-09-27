-- 050_pause_retired_099_affiliates.sql
-- The old Affiliate First Month $0.99 offer was retired in App Store Connect.
-- Affiliates still mapped to that retired campaign should no longer appear
-- operationally active inside The Agora, while all historical attribution and
-- payout data remains preserved.

UPDATE affiliates
SET status = 'inactive',
    code_status = 'disabled',
    updated_at = NOW()
WHERE is_test = FALSE
  AND normalized_apple_offer_identifier = 'AFFILIATE FIRST MONTH $0.99'
  AND status IN ('active', 'inactive');

COMMENT ON COLUMN affiliates.status IS
'Operational affiliate status. Retired App Store Connect creator offers should not remain active after their creator codes are no longer redeemable.';
