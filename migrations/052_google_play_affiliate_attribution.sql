-- 052_google_play_affiliate_attribution.sql
-- Permanent Google Play affiliate ownership plus idempotent verified billing events.
--
-- The creator code is chosen only from the authenticated Agora account's locked
-- affiliate_account_referrals row. Google proves the subscription/offer/order.
-- Raw Play purchase tokens are never stored in affiliate tables.

CREATE TABLE IF NOT EXISTS affiliate_google_play_subscription_attributions (
    purchase_token_sha256 TEXT PRIMARY KEY
        REFERENCES google_play_subscription_entitlements(purchase_token_sha256)
        ON DELETE RESTRICT,

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    creator_code TEXT NOT NULL,
    normalized_creator_code TEXT NOT NULL,

    attribution_offer_id TEXT NOT NULL,
    attribution_source TEXT NOT NULL
        CHECK (
            attribution_source IN (
                'account_creator_code',
                'linked_google_play_purchase'
            )
        ),

    inherited_from_purchase_token_sha256 TEXT
        REFERENCES google_play_subscription_entitlements(purchase_token_sha256)
        ON DELETE RESTRICT,

    root_purchase_token_sha256 TEXT NOT NULL
        CHECK (root_purchase_token_sha256 ~ '^[0-9a-f]{64}    base_plan_id TEXT,

    attributed_at TIMESTAMPTZ NOT NULL,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_google_play_creator_code_chk
        CHECK (
            length(btrim(creator_code)) BETWEEN 2 AND 64
            AND normalized_creator_code = upper(btrim(creator_code))
        ),

    CONSTRAINT affiliate_google_play_inheritance_chk
        CHECK (
            attribution_source <> 'linked_google_play_purchase'
            OR inherited_from_purchase_token_sha256 IS NOT NULL
        )
);

CREATE INDEX IF NOT EXISTS affiliate_google_play_attribution_affiliate_idx
    ON affiliate_google_play_subscription_attributions (
        affiliate_id,
        attributed_at DESC
    );

CREATE INDEX IF NOT EXISTS affiliate_google_play_attribution_root_idx
    ON affiliate_google_play_subscription_attributions (
        root_purchase_token_sha256,
        last_observed_at DESC
    );

CREATE INDEX IF NOT EXISTS affiliate_google_play_attribution_account_idx
    ON affiliate_google_play_subscription_attributions (
        account_id,
        attributed_at DESC
    );

CREATE TABLE IF NOT EXISTS affiliate_google_play_billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    purchase_token_sha256 TEXT NOT NULL
        REFERENCES affiliate_google_play_subscription_attributions(purchase_token_sha256)
        ON DELETE RESTRICT,

    event_key TEXT NOT NULL UNIQUE,
    google_order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,

    event_type TEXT NOT NULL
        CHECK (event_type IN ('trial_start', 'paid_order', 'reversal')),

    event_at TIMESTAMPTZ NOT NULL,
    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,
    auto_renew_enabled BOOLEAN,
    normalized_status TEXT,

    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_google_play_event_key_nonempty
        CHECK (length(btrim(event_key)) BETWEEN 1 AND 300),

    CONSTRAINT affiliate_google_play_order_nonempty
        CHECK (length(btrim(google_order_id)) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS affiliate_google_play_billing_affiliate_event_idx
    ON affiliate_google_play_billing_events (
        affiliate_id,
        event_at DESC,
        event_type
    );

CREATE INDEX IF NOT EXISTS affiliate_google_play_billing_token_idx
    ON affiliate_google_play_billing_events (
        purchase_token_sha256,
        event_at DESC
    );

COMMENT ON TABLE affiliate_google_play_subscription_attributions IS
'Permanent affiliate ownership for verified Google Play subscription purchase tokens. Initial ownership requires the shared creator offer plus the authenticated account creator-code claim; linked replacement tokens inherit that ownership.';

COMMENT ON TABLE affiliate_google_play_billing_events IS
'Idempotent verified Google Play affiliate billing observations. paid_order rows are commissionable unless a reversal exists for the same Google order ID; trial_start rows are never commissionable.';
),

    product_id TEXT,
    base_plan_id TEXT,

    attributed_at TIMESTAMPTZ NOT NULL,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_google_play_creator_code_chk
        CHECK (
            length(btrim(creator_code)) BETWEEN 2 AND 64
            AND normalized_creator_code = upper(btrim(creator_code))
        ),

    CONSTRAINT affiliate_google_play_inheritance_chk
        CHECK (
            attribution_source <> 'linked_google_play_purchase'
            OR inherited_from_purchase_token_sha256 IS NOT NULL
        )
);

CREATE INDEX IF NOT EXISTS affiliate_google_play_attribution_affiliate_idx
    ON affiliate_google_play_subscription_attributions (
        affiliate_id,
        attributed_at DESC
    );

CREATE INDEX IF NOT EXISTS affiliate_google_play_attribution_account_idx
    ON affiliate_google_play_subscription_attributions (
        account_id,
        attributed_at DESC
    );

CREATE TABLE IF NOT EXISTS affiliate_google_play_billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    purchase_token_sha256 TEXT NOT NULL
        REFERENCES affiliate_google_play_subscription_attributions(purchase_token_sha256)
        ON DELETE RESTRICT,

    google_order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,

    event_type TEXT NOT NULL
        CHECK (event_type IN ('trial_start', 'paid_order')),

    event_at TIMESTAMPTZ NOT NULL,
    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,
    auto_renew_enabled BOOLEAN,
    normalized_status TEXT,

    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_google_play_billing_order_unique
        UNIQUE (google_order_id),

    CONSTRAINT affiliate_google_play_order_nonempty
        CHECK (length(btrim(google_order_id)) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS affiliate_google_play_billing_affiliate_event_idx
    ON affiliate_google_play_billing_events (
        affiliate_id,
        event_at DESC,
        event_type
    );

CREATE INDEX IF NOT EXISTS affiliate_google_play_billing_token_idx
    ON affiliate_google_play_billing_events (
        purchase_token_sha256,
        event_at DESC
    );

COMMENT ON TABLE affiliate_google_play_subscription_attributions IS
'Permanent affiliate ownership for verified Google Play subscription purchase tokens. Initial ownership requires the shared creator offer plus the authenticated account creator-code claim; linked replacement tokens inherit that ownership.';

COMMENT ON TABLE affiliate_google_play_billing_events IS
'Idempotent verified Google Play affiliate billing observations keyed by Google order ID. paid_order rows are eligible for base-price affiliate commission; free-trial rows are never commissionable.';
