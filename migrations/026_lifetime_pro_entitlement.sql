-- 026_lifetime_pro_entitlement.sql
-- Make agora_pro_lifetime a permanent, non-recurring Agora Pro entitlement.
--
-- The existing App Store persistence path intentionally remains unchanged.
-- Apple ONE_TIME_CHARGE transactions flow through the same verified transaction
-- tables as subscriptions. This migration gives the dashboard/reporting layer
-- explicit source/recurrence fields and normalizes Lifetime into the same
-- canonical Agora Pro entitlement table used by monthly and annual access.

ALTER TABLE subscription_entitlements
ADD COLUMN IF NOT EXISTS pro_access_source TEXT
GENERATED ALWAYS AS (
    CASE product_id
        WHEN 'agora_pro_monthly' THEN 'monthly'
        WHEN 'agora_pro_yearly' THEN 'annual'
        WHEN 'agora_pro_lifetime' THEN 'lifetime'
        ELSE 'unknown'
    END
) STORED;

ALTER TABLE subscription_entitlements
ADD COLUMN IF NOT EXISTS is_recurring_pro BOOLEAN
GENERATED ALWAYS AS (
    product_id IN (
        'agora_pro_monthly',
        'agora_pro_yearly'
    )
) STORED;

ALTER TABLE subscription_entitlements
ADD COLUMN IF NOT EXISTS is_lifetime_pro BOOLEAN
GENERATED ALWAYS AS (
    product_id = 'agora_pro_lifetime'
) STORED;

CREATE INDEX IF NOT EXISTS
    subscription_entitlements_pro_source_idx
ON subscription_entitlements (
    environment,
    pro_access_source,
    status,
    updated_at DESC
);

CREATE OR REPLACE FUNCTION normalize_agora_lifetime_pro_entitlement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.product_id <> 'agora_pro_lifetime' THEN
        RETURN NEW;
    END IF;

    -- Apple remains authoritative for refunds/revocations. A Lifetime grant
    -- otherwise stays active permanently and has no subscription lifecycle.
    IF NEW.revocation_date IS NOT NULL
       OR UPPER(COALESCE(NEW.last_notification_type, '')) IN (
            'REFUND',
            'REVOKE'
       ) THEN
        NEW.status := 'revoked';
    ELSE
        NEW.status := 'active';
    END IF;

    NEW.is_trial := FALSE;
    NEW.auto_renew_enabled := NULL;
    NEW.expires_date := NULL;
    NEW.grace_period_expires_date := NULL;
    NEW.expiration_intent := NULL;

    -- Lifetime Pro is intentionally outside recurring pricing cohorts.
    NEW.pricing_cohort := 'unknown';
    NEW.pricing_cohort_source := NULL;
    NEW.pricing_cohort_assigned_at := NULL;
    NEW.pricing_cohort_paywall_session_id := NULL;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
    subscription_entitlements_normalize_lifetime_pro
ON subscription_entitlements;

CREATE TRIGGER
    subscription_entitlements_normalize_lifetime_pro
BEFORE INSERT OR UPDATE
ON subscription_entitlements
FOR EACH ROW
EXECUTE FUNCTION normalize_agora_lifetime_pro_entitlement();

-- Normalize any Lifetime rows that may already exist from sandbox/manual
-- testing before this migration was installed. The no-op assignment fires the
-- trigger without altering unrelated subscription rows.
UPDATE subscription_entitlements
SET product_id = product_id
WHERE product_id = 'agora_pro_lifetime';

-- Lifetime codes are private access grants, never affiliate subscription
-- sales. This database constraint is a final accounting safety net: even if a
-- Lifetime Apple Offer reference name were accidentally configured to match an
-- affiliate campaign, no recurring affiliate attribution/commission record can
-- be created for the Lifetime product. The surrounding affiliate savepoint
-- keeps this guard isolated from the verified Apple entitlement transaction.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'affiliate_subscription_attributions_no_lifetime_pro'
    ) THEN
        ALTER TABLE affiliate_subscription_attributions
        ADD CONSTRAINT
            affiliate_subscription_attributions_no_lifetime_pro
        CHECK (
            product_id IS NULL
            OR product_id <> 'agora_pro_lifetime'
        );
    END IF;
END
$$;

COMMENT ON COLUMN subscription_entitlements.pro_access_source IS
    'Canonical Agora Pro source: monthly, annual, lifetime, or unknown.';

COMMENT ON COLUMN subscription_entitlements.is_recurring_pro IS
    'True only for monthly/annual auto-renewable Agora Pro products.';

COMMENT ON COLUMN subscription_entitlements.is_lifetime_pro IS
    'True only for the private permanent agora_pro_lifetime non-consumable.';

COMMENT ON FUNCTION normalize_agora_lifetime_pro_entitlement() IS
    'Normalizes agora_pro_lifetime as permanent non-recurring Pro access while preserving Apple refund/revocation authority.';
