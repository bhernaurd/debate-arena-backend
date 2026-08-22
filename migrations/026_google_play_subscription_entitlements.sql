-- 026_google_play_subscription_entitlements.sql
-- Server-verified Google Play subscription state for Android Agora Pro access.
-- Purchase tokens are never stored in plaintext. The application stores a
-- SHA-256 lookup hash plus an AES-GCM encrypted token so the backend can
-- periodically re-check the entitlement with Google Play.

CREATE TABLE google_play_subscription_entitlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id),

    package_name TEXT NOT NULL,
    purchase_token_hash TEXT NOT NULL UNIQUE,
    purchase_token_encrypted TEXT NOT NULL,

    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,
    pricing_cohort_hint TEXT NOT NULL DEFAULT 'unknown',
    paywall_session_id TEXT,

    subscription_state TEXT NOT NULL,
    entitlement_status TEXT NOT NULL,
    is_pro BOOLEAN NOT NULL DEFAULT FALSE,
    in_free_trial BOOLEAN,
    expiry_time TIMESTAMPTZ,

    acknowledgement_state TEXT,
    acknowledged_at TIMESTAMPTZ,

    latest_order_id TEXT,
    linked_purchase_token_hash TEXT,

    first_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (CHAR_LENGTH(BTRIM(package_name)) BETWEEN 3 AND 255),
    CHECK (purchase_token_hash ~ '^[0-9a-f]{64}$'),
    CHECK (CHAR_LENGTH(BTRIM(purchase_token_encrypted)) BETWEEN 20 AND 32768),
    CHECK (CHAR_LENGTH(BTRIM(product_id)) BETWEEN 1 AND 200),
    CHECK (
        base_plan_id IS NULL
        OR CHAR_LENGTH(BTRIM(base_plan_id)) BETWEEN 1 AND 200
    ),
    CHECK (
        offer_id IS NULL
        OR CHAR_LENGTH(BTRIM(offer_id)) BETWEEN 1 AND 200
    ),
    CHECK (
        pricing_cohort_hint IN ('unknown', 'founding_2026', 'standard')
    ),
    CHECK (
        paywall_session_id IS NULL
        OR CHAR_LENGTH(BTRIM(paywall_session_id)) BETWEEN 1 AND 255
    ),
    CHECK (CHAR_LENGTH(BTRIM(subscription_state)) BETWEEN 1 AND 100),
    CHECK (
        entitlement_status IN (
            'active',
            'grace_period',
            'canceled_active',
            'pending',
            'paused',
            'on_hold',
            'expired',
            'pending_purchase_canceled',
            'unknown'
        )
    ),
    CHECK (
        acknowledgement_state IS NULL
        OR CHAR_LENGTH(BTRIM(acknowledgement_state)) BETWEEN 1 AND 100
    ),
    CHECK (
        latest_order_id IS NULL
        OR CHAR_LENGTH(BTRIM(latest_order_id)) BETWEEN 1 AND 255
    ),
    CHECK (
        linked_purchase_token_hash IS NULL
        OR linked_purchase_token_hash ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX google_play_subscription_entitlements_account_current_idx
    ON google_play_subscription_entitlements (
        account_id,
        is_pro,
        expiry_time DESC,
        last_verified_at DESC
    );

CREATE INDEX google_play_subscription_entitlements_product_idx
    ON google_play_subscription_entitlements (
        package_name,
        product_id,
        last_verified_at DESC
    );

COMMENT ON TABLE google_play_subscription_entitlements IS
'Server-verified Android subscription entitlements. Raw Google Play purchase tokens are AES-GCM encrypted at rest and are never returned to clients.';

-- Account deletion keeps an accounts tombstone instead of deleting the parent
-- row, so ON DELETE CASCADE cannot clean these encrypted purchase tokens. This
-- trigger erases every stored Google Play entitlement in the same transaction
-- that transitions the account to its final deleted state. It covers both the
-- Apple and Google deletion paths without coupling either service to migration 026.
CREATE OR REPLACE FUNCTION purge_google_play_entitlements_for_deleted_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
        DELETE FROM google_play_subscription_entitlements
        WHERE account_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_purge_google_play_entitlements_after_delete_state
AFTER UPDATE OF status ON accounts
FOR EACH ROW
WHEN (NEW.status = 'deleted')
EXECUTE FUNCTION purge_google_play_entitlements_for_deleted_account();
