-- 022_affiliate_shared_offer_account_attribution.sql
-- The Agora affiliate attribution correction for shared Apple Offer Code campaigns.
--
-- Production decision:
--   * Many affiliates may share one App Store Connect Offer Code campaign.
--   * The human-facing Apple custom creator code (AM99, LEVI99, MAXAGORA, ...)
--     identifies the affiliate in Agora.
--   * A verified StoreKit transaction proves the purchase used the shared Apple
--     offer, but Apple does not expose the exact custom creator code on that
--     transaction.
--   * Exact subscription-chain ownership therefore comes from the authenticated
--     Agora account's locked creator-code claim plus the verified Apple offer-code
--     transaction. original_transaction_id + environment remains the permanent
--     subscription-chain key.
--
-- This migration is additive/corrective. It does NOT edit migration 020, does
-- not delete existing attribution rows, and does not rewrite payout history.
-- The migration runner wraps this file in a transaction.

-- Migration 020 made Apple offer references one-to-one with affiliates. Shared
-- campaigns intentionally make this many-to-one, so replace the unique lookup
-- with a normal lookup index.
DROP INDEX IF EXISTS affiliates_offer_identifier_unique_idx;

CREATE INDEX IF NOT EXISTS affiliates_offer_identifier_lookup_idx
    ON affiliates (normalized_apple_offer_identifier)
    WHERE normalized_apple_offer_identifier IS NOT NULL;

-- One authenticated Agora account can have one locked affiliate creator-code
-- claim. A later conflicting code is reviewable and must never silently replace
-- this row. Existing chain ownership remains the stronger historical record.
CREATE TABLE affiliate_account_referrals (
    account_id UUID PRIMARY KEY
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    creator_code TEXT NOT NULL,
    normalized_code TEXT NOT NULL,

    claim_source TEXT NOT NULL
        CHECK (
            claim_source IN (
                'creator_code_entry',
                'referral_link',
                'manual_support'
            )
        ),

    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_account_referrals_code_nonempty
        CHECK (
            length(btrim(creator_code)) BETWEEN 2 AND 64
            AND normalized_code = upper(btrim(creator_code))
        )
);

CREATE INDEX affiliate_account_referrals_affiliate_idx
    ON affiliate_account_referrals (affiliate_id, claimed_at DESC);

-- Preserve the original 020 evidence while recording the account/custom-code
-- evidence used by the scalable shared-offer architecture.
ALTER TABLE affiliate_subscription_attributions
    ADD COLUMN account_id UUID
        REFERENCES accounts(id)
        ON DELETE SET NULL,
    ADD COLUMN creator_code TEXT,
    ADD COLUMN normalized_creator_code TEXT;

ALTER TABLE affiliate_subscription_attributions
    ADD CONSTRAINT affiliate_subscription_attributions_creator_code_pair_chk
    CHECK (
        (
            creator_code IS NULL
            AND normalized_creator_code IS NULL
        )
        OR
        (
            creator_code IS NOT NULL
            AND normalized_creator_code IS NOT NULL
            AND length(btrim(creator_code)) BETWEEN 2 AND 64
            AND normalized_creator_code = upper(btrim(creator_code))
        )
    );

CREATE INDEX affiliate_subscription_attributions_account_idx
    ON affiliate_subscription_attributions (
        account_id,
        environment,
        attributed_at DESC
    )
    WHERE account_id IS NOT NULL;

CREATE INDEX affiliate_subscription_attributions_creator_code_idx
    ON affiliate_subscription_attributions (
        normalized_creator_code,
        environment,
        attributed_at DESC
    )
    WHERE normalized_creator_code IS NOT NULL;

-- 020 used an inline CHECK, whose PostgreSQL-generated name is this value.
ALTER TABLE affiliate_subscription_attributions
    DROP CONSTRAINT IF EXISTS affiliate_subscription_attributions_attribution_source_check;

ALTER TABLE affiliate_subscription_attributions
    ADD CONSTRAINT affiliate_subscription_attributions_attribution_source_chk
    CHECK (
        attribution_source IN (
            'apple_offer_identifier',
            'account_creator_code',
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
            'account_creator_code'
        )
        OR offer_type = '3'
    );

COMMENT ON TABLE affiliate_account_referrals IS
'Locked authenticated-account affiliate creator-code claims. Shared Apple Offer Code campaigns are supported; this row supplies the exact custom creator-code identity that StoreKit transactions do not expose.';

COMMENT ON COLUMN affiliates.apple_offer_identifier IS
'App Store Connect offer reference/campaign name. Multiple affiliates may intentionally share this value; exact affiliate identity comes from the affiliate custom creator code.';

COMMENT ON TABLE affiliate_subscription_attributions IS
'Permanent affiliate ownership for an Apple subscription chain. New shared-offer ownership is assigned from an authenticated Agora account creator-code claim plus a verified Apple offer-code transaction, then inherited by future activity on original_transaction_id + environment.';
