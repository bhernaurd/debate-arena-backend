-- 036_account_manual_pro_grants.sql
-- Server-side manual Agora Pro grants for non-store access such as Google Play
-- reviewer accounts and support cases.
--
-- Manual grants are intentionally separate from Apple/Google transaction tables,
-- affiliate attribution, and recurring subscription metrics. They are tied
-- directly to an authenticated Agora account and disappear with account deletion.

CREATE TABLE account_manual_pro_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    reason TEXT NOT NULL
        CHECK (
            reason IN (
                'play_review',
                'support',
                'internal'
            )
        ),

    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        revoked_at IS NULL
        OR revoked_at >= granted_at
    )
);

CREATE UNIQUE INDEX account_manual_pro_grants_one_active_idx
    ON account_manual_pro_grants (account_id)
    WHERE revoked_at IS NULL;

CREATE INDEX account_manual_pro_grants_account_history_idx
    ON account_manual_pro_grants (
        account_id,
        granted_at DESC
    );

CREATE INDEX account_manual_pro_grants_active_reason_idx
    ON account_manual_pro_grants (
        reason,
        granted_at DESC
    )
    WHERE revoked_at IS NULL;

COMMENT ON TABLE account_manual_pro_grants IS
    'Server-side permanent Agora Pro grants for review/support/internal access. Separate from store purchases and subscription revenue.';

COMMENT ON COLUMN account_manual_pro_grants.reason IS
    'Operational reason for the manual Pro grant: play_review, support, or internal.';
