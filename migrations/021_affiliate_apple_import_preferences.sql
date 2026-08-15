-- 021_affiliate_apple_import_preferences.sql
-- Additive owner preferences for App Store Connect affiliate imports.
--
-- One creator code can have multiple historical Apple custom-code resources.
-- This table lets the owner choose the current/canonical Apple configuration
-- and hide non-affiliate codes without deleting Apple or Agora history.

CREATE TABLE IF NOT EXISTS affiliate_apple_import_preferences (
    normalized_code TEXT PRIMARY KEY,
    disposition TEXT NOT NULL DEFAULT 'pending'
        CHECK (disposition IN ('pending', 'ignored')),
    canonical_offer_id TEXT,
    canonical_custom_code_id TEXT,
    note TEXT,
    updated_by TEXT NOT NULL DEFAULT 'owner_admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_apple_import_preferences_code_nonempty
        CHECK (length(trim(normalized_code)) > 0),
    CONSTRAINT affiliate_apple_import_preferences_code_uppercase
        CHECK (normalized_code = UPPER(normalized_code)),
    CONSTRAINT affiliate_apple_import_preferences_canonical_pair
        CHECK (
            (canonical_offer_id IS NULL AND canonical_custom_code_id IS NULL)
            OR
            (canonical_offer_id IS NOT NULL AND canonical_custom_code_id IS NOT NULL)
        )
);

CREATE INDEX IF NOT EXISTS affiliate_apple_import_preferences_disposition_idx
    ON affiliate_apple_import_preferences (disposition, updated_at DESC);

COMMENT ON TABLE affiliate_apple_import_preferences IS
'Owner-only preferences for App Store Connect affiliate imports. Stores ignored creator codes and the selected canonical Apple custom-code resource when a creator code has multiple historical configurations. Does not alter Apple subscription or payout history.';
