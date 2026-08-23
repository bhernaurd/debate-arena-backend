-- 025_google_play_subscriptions.sql
-- Account-owned Google Play subscription verification state for Android.
-- Raw Google Play purchase tokens are never persisted; only SHA-256 hashes are stored.

CREATE TABLE google_play_subscription_entitlements (
    purchase_token_hash TEXT PRIMARY KEY
        CHECK (purchase_token_hash ~ '^[0-9a-f]{64}$'),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    ownership_status TEXT NOT NULL DEFAULT 'active'
        CHECK (ownership_status IN ('active', 'released')),
    released_at TIMESTAMPTZ,

    package_name TEXT NOT NULL,
    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,

    subscription_state TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (
            status IN (
                'pending',
                'trial',
                'active',
                'grace_period',
                'on_hold',
                'paused',
                'canceled',
                'expired',
                'unknown'
            )
        ),

    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    start_time TIMESTAMPTZ,
    expiry_time TIMESTAMPTZ,
    acknowledgement_state TEXT,
    auto_renew_enabled BOOLEAN,
    latest_order_id TEXT,

    linked_purchase_token_hash TEXT
        CHECK (
            linked_purchase_token_hash IS NULL
            OR linked_purchase_token_hash ~ '^[0-9a-f]{64}$'
        ),

    pricing_cohort TEXT NOT NULL DEFAULT 'unknown'
        CHECK (
            pricing_cohort IN (
                'unknown',
                'founding_2026',
                'standard'
            )
        ),

    paywall_session_id TEXT,
    obfuscated_external_account_id TEXT,
    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,

    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        (ownership_status = 'active' AND released_at IS NULL)
        OR ownership_status = 'released'
    ),
    CHECK (CHAR_LENGTH(BTRIM(package_name)) BETWEEN 1 AND 255),
    CHECK (CHAR_LENGTH(BTRIM(product_id)) BETWEEN 1 AND 200),
    CHECK (base_plan_id IS NULL OR CHAR_LENGTH(BTRIM(base_plan_id)) BETWEEN 1 AND 200),
    CHECK (offer_id IS NULL OR CHAR_LENGTH(BTRIM(offer_id)) BETWEEN 1 AND 200),
    CHECK (CHAR_LENGTH(BTRIM(subscription_state)) BETWEEN 1 AND 100),
    CHECK (acknowledgement_state IS NULL OR CHAR_LENGTH(BTRIM(acknowledgement_state)) BETWEEN 1 AND 100),
    CHECK (latest_order_id IS NULL OR CHAR_LENGTH(BTRIM(latest_order_id)) BETWEEN 1 AND 255),
    CHECK (paywall_session_id IS NULL OR CHAR_LENGTH(BTRIM(paywall_session_id)) BETWEEN 1 AND 255),
    CHECK (obfuscated_external_account_id IS NULL OR CHAR_LENGTH(BTRIM(obfuscated_external_account_id)) BETWEEN 1 AND 255)
);

CREATE INDEX google_play_subscription_entitlements_account_idx
    ON google_play_subscription_entitlements (
        account_id,
        ownership_status,
        status,
        expiry_time DESC
    );

CREATE INDEX google_play_subscription_entitlements_active_idx
    ON google_play_subscription_entitlements (
        account_id,
        expiry_time DESC
    )
    WHERE ownership_status = 'active'
      AND status IN ('trial', 'active', 'grace_period');

CREATE INDEX google_play_subscription_entitlements_product_idx
    ON google_play_subscription_entitlements (
        product_id,
        ownership_status,
        status,
        updated_at DESC
    );

COMMENT ON TABLE google_play_subscription_entitlements IS
    'Verified Google Play subscription state mapped to an authenticated Agora account. Ownership can be released on account deletion so a valid Play subscription can later be reclaimed. Purchase tokens are represented only by SHA-256 hashes.';
