-- 023_affiliate_referral_handoffs.sql
-- Deterministic affiliate handoff evidence for App Clip / full-app redemption flows.
--
-- This migration is additive. It does not edit migrations 020-022, does not
-- rewrite existing affiliate attribution, and does not alter payout history.
--
-- Attribution contract:
--   * A referral click creates a random opaque handoff token. Only its SHA-256
--     hash is stored server-side.
--   * Opening an App Clip never earns commission and never chooses ownership.
--   * A successful redeem-start marks the exact promo flow the customer chose.
--   * The full app claims that handoff with its stable installation ID and,
--     when available, its authenticated Agora account.
--   * A verified Apple offer-code transaction for the configured shared Apple
--     campaign may then use the claimed handoff as exact creator-code evidence.
--   * original_transaction_id + environment remains the permanent ownership key.
--
-- The migration runner wraps this file in a transaction. Do not add BEGIN/COMMIT.

CREATE TABLE affiliate_referral_handoffs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    creator_code TEXT NOT NULL,
    normalized_code TEXT NOT NULL,

    -- Never store the bearer token itself. The App Clip/full app carries the
    -- raw token; the backend resolves it by SHA-256 hash.
    token_hash TEXT NOT NULL UNIQUE,

    environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'sandbox', 'test')),

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'redemption_started',
                'claimed',
                'attributed',
                'superseded',
                'expired'
            )
        ),

    referral_click_id UUID
        REFERENCES affiliate_referral_clicks(id)
        ON DELETE SET NULL,

    referrer_host TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    first_opened_at TIMESTAMPTZ,
    last_opened_at TIMESTAMPTZ,
    open_count INTEGER NOT NULL DEFAULT 0 CHECK (open_count >= 0),

    redemption_started_at TIMESTAMPTZ,
    last_redemption_started_at TIMESTAMPTZ,
    redemption_start_count INTEGER NOT NULL DEFAULT 0
        CHECK (redemption_start_count >= 0),

    installation_id TEXT,
    account_id UUID
        REFERENCES accounts(id)
        ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ,

    superseded_at TIMESTAMPTZ,
    superseded_by_handoff_id UUID
        REFERENCES affiliate_referral_handoffs(id)
        ON DELETE SET NULL,

    attributed_original_transaction_id TEXT,
    attributed_environment TEXT,
    attributed_at TIMESTAMPTZ,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_referral_handoffs_code_chk
        CHECK (
            length(btrim(creator_code)) BETWEEN 2 AND 64
            AND normalized_code = upper(btrim(creator_code))
        ),

    CONSTRAINT affiliate_referral_handoffs_token_hash_chk
        CHECK (token_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT affiliate_referral_handoffs_expiration_chk
        CHECK (expires_at > created_at),

    CONSTRAINT affiliate_referral_handoffs_installation_chk
        CHECK (
            installation_id IS NULL
            OR installation_id ~ '^[A-Za-z0-9-]{8,128}$'
        ),

    CONSTRAINT affiliate_referral_handoffs_open_order_chk
        CHECK (
            (first_opened_at IS NULL AND last_opened_at IS NULL AND open_count = 0)
            OR (
                first_opened_at IS NOT NULL
                AND last_opened_at IS NOT NULL
                AND last_opened_at >= first_opened_at
                AND open_count > 0
            )
        ),

    CONSTRAINT affiliate_referral_handoffs_redemption_order_chk
        CHECK (
            (
                redemption_started_at IS NULL
                AND last_redemption_started_at IS NULL
                AND redemption_start_count = 0
            )
            OR (
                redemption_started_at IS NOT NULL
                AND last_redemption_started_at IS NOT NULL
                AND last_redemption_started_at >= redemption_started_at
                AND redemption_start_count > 0
            )
        ),

    CONSTRAINT affiliate_referral_handoffs_claim_chk
        CHECK (
            (claimed_at IS NULL AND installation_id IS NULL AND account_id IS NULL)
            OR (claimed_at IS NOT NULL AND installation_id IS NOT NULL)
        ),

    CONSTRAINT affiliate_referral_handoffs_superseded_chk
        CHECK (
            (status = 'superseded' AND superseded_at IS NOT NULL)
            OR (status <> 'superseded' AND superseded_at IS NULL)
        ),

    CONSTRAINT affiliate_referral_handoffs_attribution_pair_chk
        CHECK (
            (
                attributed_original_transaction_id IS NULL
                AND attributed_environment IS NULL
                AND attributed_at IS NULL
            )
            OR (
                attributed_original_transaction_id IS NOT NULL
                AND attributed_environment IN ('Production', 'Sandbox')
                AND attributed_at IS NOT NULL
            )
        )
);

CREATE INDEX affiliate_referral_handoffs_affiliate_time_idx
    ON affiliate_referral_handoffs (affiliate_id, created_at DESC);

CREATE INDEX affiliate_referral_handoffs_installation_active_idx
    ON affiliate_referral_handoffs (installation_id, redemption_started_at DESC)
    WHERE installation_id IS NOT NULL
      AND status IN ('redemption_started', 'claimed');

CREATE INDEX affiliate_referral_handoffs_account_active_idx
    ON affiliate_referral_handoffs (account_id, redemption_started_at DESC)
    WHERE account_id IS NOT NULL
      AND status IN ('redemption_started', 'claimed');

CREATE INDEX affiliate_referral_handoffs_expiration_idx
    ON affiliate_referral_handoffs (expires_at)
    WHERE status IN ('pending', 'redemption_started', 'claimed');

ALTER TABLE affiliate_subscription_attributions
    ADD COLUMN referral_handoff_id UUID
        REFERENCES affiliate_referral_handoffs(id)
        ON DELETE SET NULL,
    ADD COLUMN attribution_installation_id TEXT;

ALTER TABLE affiliate_subscription_attributions
    ADD CONSTRAINT affiliate_subscription_attributions_installation_chk
    CHECK (
        attribution_installation_id IS NULL
        OR attribution_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    );

CREATE INDEX affiliate_subscription_attributions_handoff_idx
    ON affiliate_subscription_attributions (referral_handoff_id)
    WHERE referral_handoff_id IS NOT NULL;

ALTER TABLE affiliate_subscription_attributions
    DROP CONSTRAINT IF EXISTS affiliate_subscription_attributions_attribution_source_chk;

ALTER TABLE affiliate_subscription_attributions
    ADD CONSTRAINT affiliate_subscription_attributions_attribution_source_chk
    CHECK (
        attribution_source IN (
            'apple_offer_identifier',
            'account_creator_code',
            'referral_handoff',
            'manual_support'
        )
    );

ALTER TABLE affiliate_subscription_attributions
    DROP CONSTRAINT IF EXISTS affiliate_subscription_attributions_apple_offer_type_chk;

ALTER TABLE affiliate_subscription_attributions
    ADD CONSTRAINT affiliate_subscription_attributions_apple_offer_type_chk
    CHECK (
        attribution_source NOT IN (
            'apple_offer_identifier',
            'account_creator_code',
            'referral_handoff'
        )
        OR offer_type = '3'
    );

COMMENT ON TABLE affiliate_referral_handoffs IS
'Auditable, non-commission-bearing referral handoffs. A claimed redeem-start handoff supplies exact affiliate creator-code evidence for a later verified Apple shared-offer transaction.';

COMMENT ON COLUMN affiliate_subscription_attributions.referral_handoff_id IS
'Automatic App Clip/full-app referral handoff used as exact creator-code evidence for this permanent subscription-chain attribution.';
