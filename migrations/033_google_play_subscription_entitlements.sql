-- 033_google_play_subscription_entitlements.sql
-- Server-authoritative Google Play subscription ownership and entitlement state.
--
-- Important security properties:
-- - raw Google Play purchase tokens are never stored; only SHA-256 fingerprints
-- - each purchase token is permanently bound to one Agora account unless support
--   explicitly changes database state outside the normal client sync path
-- - Google Play and App Store data remain separate at rest, while the shared
--   AccountProAccessService presents one cross-platform Agora Pro entitlement

CREATE TABLE IF NOT EXISTS google_play_subscription_entitlements (
    purchase_token_sha256 TEXT PRIMARY KEY
        CHECK (purchase_token_sha256 ~ '^[0-9a-f]{64}$'),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    package_name TEXT NOT NULL,
    product_id TEXT NOT NULL
        CHECK (
            product_id IN (
                'agora_pro_monthly',
                'agora_pro_yearly'
            )
        ),

    base_plan_id TEXT,
    offer_id TEXT,

    -- Raw Google state is retained for diagnostics. normalized_status is the
    -- app-facing access interpretation used by AccountProAccessService.
    subscription_state TEXT NOT NULL,
    normalized_status TEXT NOT NULL
        CHECK (
            normalized_status IN (
                'trial',
                'active',
                'grace_period',
                'pending',
                'paused',
                'on_hold',
                'expired',
                'replaced'
            )
        ),

    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    auto_renew_enabled BOOLEAN,
    acknowledgement_state TEXT,
    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,

    -- BillingFlowParams.setObfuscatedAccountId() supplies SHA-256(account_id).
    -- This is verified against Google's SubscriptionPurchaseV2 before writes.
    obfuscated_external_account_id TEXT NOT NULL
        CHECK (
            obfuscated_external_account_id ~ '^[0-9a-f]{64}$'
        ),

    linked_purchase_token_sha256 TEXT
        CHECK (
            linked_purchase_token_sha256 IS NULL
            OR linked_purchase_token_sha256 ~ '^[0-9a-f]{64}$'
        ),

    latest_order_id TEXT,
    region_code TEXT,
    start_time TIMESTAMPTZ,
    expires_date TIMESTAMPTZ,

    pricing_cohort TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
            pricing_cohort IN (
                'unknown',
                'founding_2026',
                'standard'
            )
        ),
    pricing_cohort_source TEXT,
    pricing_cohort_paywall_session_id TEXT,

    verification_source TEXT NOT NULL DEFAULT 'google_play_subscriptions_v2'
        CHECK (
            verification_source = 'google_play_subscriptions_v2'
        ),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (CHAR_LENGTH(BTRIM(package_name)) BETWEEN 1 AND 255),
    CHECK (CHAR_LENGTH(BTRIM(product_id)) BETWEEN 1 AND 200),
    CHECK (
        base_plan_id IS NULL
        OR CHAR_LENGTH(BTRIM(base_plan_id)) BETWEEN 1 AND 255
    ),
    CHECK (
        offer_id IS NULL
        OR CHAR_LENGTH(BTRIM(offer_id)) BETWEEN 1 AND 255
    ),
    CHECK (
        latest_order_id IS NULL
        OR CHAR_LENGTH(BTRIM(latest_order_id)) BETWEEN 1 AND 255
    ),
    CHECK (
        region_code IS NULL
        OR CHAR_LENGTH(BTRIM(region_code)) BETWEEN 2 AND 16
    ),
    CHECK (
        pricing_cohort_paywall_session_id IS NULL
        OR CHAR_LENGTH(BTRIM(pricing_cohort_paywall_session_id)) BETWEEN 1 AND 128
    )
);

CREATE INDEX IF NOT EXISTS
    google_play_subscription_entitlements_account_current_idx
ON google_play_subscription_entitlements (
    account_id,
    normalized_status,
    expires_date DESC,
    last_verified_at DESC
);

CREATE INDEX IF NOT EXISTS
    google_play_subscription_entitlements_linked_token_idx
ON google_play_subscription_entitlements (
    linked_purchase_token_sha256
)
WHERE linked_purchase_token_sha256 IS NOT NULL;

COMMENT ON TABLE google_play_subscription_entitlements IS
    'Server-verified Google Play recurring Agora Pro entitlements. Raw purchase tokens are never stored.';

COMMENT ON COLUMN google_play_subscription_entitlements.purchase_token_sha256 IS
    'SHA-256 fingerprint of the Google Play purchase token; the raw token remains request-only.';

COMMENT ON COLUMN google_play_subscription_entitlements.obfuscated_external_account_id IS
    'Google-returned BillingFlowParams obfuscated account ID, required to equal SHA-256 of the authenticated Agora account UUID.';
