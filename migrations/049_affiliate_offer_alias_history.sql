-- 049_affiliate_offer_alias_history.sql
-- Preserve historical Apple offer identifiers when an affiliate creator code
-- moves between App Store Connect offer campaigns.

CREATE TABLE IF NOT EXISTS affiliate_apple_offer_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
    offer_identifier TEXT NOT NULL,
    normalized_offer_identifier TEXT NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL DEFAULT 'affiliate_mapping',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT affiliate_apple_offer_alias_identifier_chk
        CHECK (
            length(btrim(offer_identifier)) BETWEEN 1 AND 200
            AND normalized_offer_identifier = upper(btrim(offer_identifier))
        ),

    CONSTRAINT affiliate_apple_offer_alias_unique
        UNIQUE (affiliate_id, normalized_offer_identifier)
);

CREATE INDEX IF NOT EXISTS affiliate_apple_offer_alias_lookup_idx
    ON affiliate_apple_offer_aliases (normalized_offer_identifier);

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_apple_offer_alias_current_idx
    ON affiliate_apple_offer_aliases (affiliate_id)
    WHERE is_current = TRUE;

-- Seed the current mapping for every existing affiliate before changing the
-- two creator codes that moved to the 7-day campaign.
INSERT INTO affiliate_apple_offer_aliases (
    affiliate_id,
    offer_identifier,
    normalized_offer_identifier,
    is_current,
    source
)
SELECT
    id,
    apple_offer_identifier,
    normalized_apple_offer_identifier,
    TRUE,
    'migration_seed'
FROM affiliates
WHERE apple_offer_identifier IS NOT NULL
  AND normalized_apple_offer_identifier IS NOT NULL
ON CONFLICT (affiliate_id, normalized_offer_identifier)
DO UPDATE SET
    offer_identifier = EXCLUDED.offer_identifier,
    is_current = TRUE,
    updated_at = NOW();

-- BASEDCHIMPANZEE and ENZO were intentionally moved from the historical
-- $0.99 first-month offer to the new 7-day free creator offer.
UPDATE affiliate_apple_offer_aliases
SET is_current = FALSE,
    updated_at = NOW()
WHERE affiliate_id IN (
    SELECT id
    FROM affiliates
    WHERE normalized_code IN ('BASEDCHIMPANZEE', 'ENZO')
);

UPDATE affiliates
SET apple_offer_identifier = 'Affiliate 7 Day Free Promo',
    normalized_apple_offer_identifier = 'AFFILIATE 7 DAY FREE PROMO',
    updated_at = NOW()
WHERE normalized_code IN ('BASEDCHIMPANZEE', 'ENZO');

INSERT INTO affiliate_apple_offer_aliases (
    affiliate_id,
    offer_identifier,
    normalized_offer_identifier,
    is_current,
    source
)
SELECT
    id,
    apple_offer_identifier,
    normalized_apple_offer_identifier,
    TRUE,
    'creator_offer_migration_2026_09_26'
FROM affiliates
WHERE normalized_code IN ('BASEDCHIMPANZEE', 'ENZO')
ON CONFLICT (affiliate_id, normalized_offer_identifier)
DO UPDATE SET
    offer_identifier = EXCLUDED.offer_identifier,
    is_current = TRUE,
    source = EXCLUDED.source,
    updated_at = NOW();

COMMENT ON TABLE affiliate_apple_offer_aliases IS
'Historical and current App Store Connect offer-reference names accepted for an affiliate. This preserves attribution when a creator code moves to a new Apple offer campaign.';

COMMENT ON COLUMN affiliate_apple_offer_aliases.is_current IS
'True only for the affiliate current App Store Connect offer mapping. Historical aliases remain accepted for late-arriving verified transactions.';
