-- 026_lifetime_pro_entitlement.sql
-- Make agora_pro_lifetime a permanent, non-recurring Agora Pro entitlement.
--
-- The existing App Store persistence path intentionally remains unchanged.
-- Apple ONE_TIME_CHARGE transactions flow through the same verified transaction
-- tables as subscriptions. This BEFORE trigger normalizes the canonical
-- entitlement row so the rest of the backend sees one clean Agora Pro model:
-- monthly, annual, or lifetime.

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

COMMENT ON FUNCTION normalize_agora_lifetime_pro_entitlement() IS
    'Normalizes agora_pro_lifetime as permanent non-recurring Pro access while preserving Apple refund/revocation authority.';
