-- 038_account_storefront_country.sql
-- Stores the latest App Store storefront country observed for an authenticated installation.
-- This is intentionally coarse storefront metadata, not GPS or precise physical location.

ALTER TABLE account_installations
    ADD COLUMN IF NOT EXISTS app_store_country_code TEXT,
    ADD COLUMN IF NOT EXISTS app_store_country_observed_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'account_installations_app_store_country_code_chk'
    ) THEN
        ALTER TABLE account_installations
            ADD CONSTRAINT account_installations_app_store_country_code_chk
            CHECK (
                app_store_country_code IS NULL
                OR app_store_country_code ~ '^[A-Z]{3}$'
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS account_installations_storefront_country_idx
    ON account_installations (app_store_country_code, app_store_country_observed_at DESC)
    WHERE app_store_country_code IS NOT NULL;

COMMENT ON COLUMN account_installations.app_store_country_code IS
    'Latest three-letter App Store storefront country code reported by the iOS client. This is storefront/account-market metadata, not precise device location.';

COMMENT ON COLUMN account_installations.app_store_country_observed_at IS
    'When the App Store storefront country was most recently observed for this installation.';
