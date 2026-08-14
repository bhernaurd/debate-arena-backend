-- 020_affiliate_subscription_chain_attribution.sql
-- The Agora verified Apple offer-code subscription-chain attribution.
--
-- This migration is additive. It does not change subscription entitlement
-- access, affiliate compensation terms, payout math, or any existing affiliate
-- financial history. Apple remains authoritative for subscription status.
--
-- Attribution rule:
--   1. A verified Apple offer-code transaction (offerType = 3) exposes the
--      App Store Connect offerCodeRefName in offerIdentifier.
--   2. That identifier maps to exactly one affiliate.
--   3. The affiliate is stored against original_transaction_id + Apple's
--      verified environment.
--   4. Later activity on the same Apple subscription chain inherits the
--      original affiliate ownership.
--   5. A later conflicting offer never silently reassigns ownership.
--
-- IMPORTANT ENVIRONMENT CONTRACT:
-- The existing App Store verification/storage path uses Apple's canonical
-- environment strings: 'Production' and 'Sandbox'. Keep those exact values here
-- so attribution rows join directly to existing subscription-chain records.
--
-- The migration runner wraps this file in a transaction. Do not add BEGIN or
-- COMMIT statements here.

ALTER TABLE affiliates
    ADD COLUMN apple_offer_identifier TEXT,
    ADD COLUMN normalized_apple_offer_identifier TEXT;

ALTER TABLE affiliates
    ADD CONSTRAINT affiliates_offer_identifier_pair_chk
    CHECK (
        (
            apple_offer_identifier IS NULL
            AND normalized_apple_offer_identifier IS NULL
        )
        OR
        (
            apple_offer_identifier IS NOT NULL
            AND normalized_apple_offer_identifier IS NOT NULL
            AND length(btrim(apple_offer_identifier)) BETWEEN 1 AND 200
            AND normalized_apple_offer_identifier = upper(btrim(apple_offer_identifier))
        )
    );

CREATE UNIQUE INDEX affiliates_offer_identifier_unique_idx
    ON affiliates (normalized_apple_offer_identifier)
    WHERE normalized_apple_offer_identifier IS NOT NULL;

CREATE TABLE affiliate_subscription_attributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    affiliate_id UUID NOT NULL
        REFERENCES affiliates(id)
        ON DELETE RESTRICT,

    original_transaction_id TEXT NOT NULL,

    -- Match the exact values stored by the verified Apple transaction path.
    environment TEXT NOT NULL
        CHECK (environment IN ('Production', 'Sandbox')),

    attribution_transaction_id TEXT NOT NULL,

    offer_identifier TEXT NOT NULL,
    normalized_offer_identifier TEXT NOT NULL,
    offer_type TEXT NOT NULL,

    product_id TEXT,
    attributed_at TIMESTAMPTZ NOT NULL,

    attribution_source TEXT NOT NULL DEFAULT 'apple_offer_identifier'
        CHECK (
            attribution_source IN (
                'apple_offer_identifier',
                'manual_support'
            )
        ),

    initial_price_milliunits BIGINT,
    initial_currency TEXT,

    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_transaction_id TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_subscription_attributions_chain_unique
        UNIQUE (original_transaction_id, environment),

    CONSTRAINT affiliate_subscription_attributions_original_tx_nonempty
        CHECK (length(btrim(original_transaction_id)) > 0),

    CONSTRAINT affiliate_subscription_attributions_attribution_tx_nonempty
        CHECK (length(btrim(attribution_transaction_id)) > 0),

    CONSTRAINT affiliate_subscription_attributions_offer_nonempty
        CHECK (
            length(btrim(offer_identifier)) BETWEEN 1 AND 200
            AND normalized_offer_identifier = upper(btrim(offer_identifier))
        ),

    CONSTRAINT affiliate_subscription_attributions_offer_type_nonempty
        CHECK (length(btrim(offer_type)) > 0),

    CONSTRAINT affiliate_subscription_attributions_apple_offer_type_chk
        CHECK (
            attribution_source <> 'apple_offer_identifier'
            OR offer_type = '3'
        ),

    CONSTRAINT affiliate_subscription_attributions_observation_order_chk
        CHECK (last_observed_at >= first_observed_at)
);

CREATE UNIQUE INDEX affiliate_subscription_attributions_transaction_unique_idx
    ON affiliate_subscription_attributions (
        attribution_transaction_id,
        environment
    );

CREATE INDEX affiliate_subscription_attributions_affiliate_idx
    ON affiliate_subscription_attributions (
        affiliate_id,
        environment,
        attributed_at DESC
    );

CREATE INDEX affiliate_subscription_attributions_offer_idx
    ON affiliate_subscription_attributions (
        normalized_offer_identifier,
        environment,
        attributed_at DESC
    );

COMMENT ON TABLE affiliate_subscription_attributions IS
'Authoritative affiliate ownership for an Apple subscription chain. One affiliate per original_transaction_id + verified Apple environment. Ownership is created from a verified Apple offer-code transaction and is not silently reassigned by later transactions.';

COMMENT ON COLUMN affiliates.apple_offer_identifier IS
'App Store Connect offerCodeRefName returned in verified Apple offer-code transactions for this affiliate. This can differ from the human-facing custom code.';
