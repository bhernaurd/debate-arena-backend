-- 002_accounts_auth.sql
-- Foundational Agora account and authentication schema.
--
-- This migration is additive. Existing user_id columns continue to represent
-- legacy installation identifiers unless a later migration explicitly adds a
-- separate account_id column.

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            status IN (
                'active',
                'locked',
                'deletion_pending',
                'deleted'
            )
        ),

    auth_version INTEGER NOT NULL DEFAULT 1
        CHECK (auth_version > 0),

    display_name TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_authenticated_at TIMESTAMPTZ,
    deletion_requested_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,

    CHECK (
        display_name IS NULL
        OR CHAR_LENGTH(BTRIM(display_name)) BETWEEN 1 AND 100
    ),

    CHECK (
        status NOT IN ('deletion_pending', 'deleted')
        OR deletion_requested_at IS NOT NULL
    ),

    CHECK (
        (status = 'deleted' AND deleted_at IS NOT NULL)
        OR (status <> 'deleted' AND deleted_at IS NULL)
    )
);

CREATE INDEX accounts_status_created_at_idx
    ON accounts (status, created_at DESC);

CREATE TABLE account_auth_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    installation_id TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'sign_in_with_apple'
        CHECK (
            purpose IN (
                'sign_in_with_apple',
                'reauthenticate',
                'delete_account'
            )
        ),

    nonce_sha256 TEXT NOT NULL UNIQUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,

    failed_attempts INTEGER NOT NULL DEFAULT 0
        CHECK (failed_attempts >= 0 AND failed_attempts <= 20),

    CHECK (
        installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        nonce_sha256 ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        expires_at > created_at
    ),

    CHECK (
        consumed_at IS NULL
        OR consumed_at >= created_at
    )
);

CREATE INDEX account_auth_challenges_installation_idx
    ON account_auth_challenges (
        installation_id,
        created_at DESC
    );

CREATE INDEX account_auth_challenges_expiration_idx
    ON account_auth_challenges (expires_at)
    WHERE consumed_at IS NULL;

CREATE TABLE account_apple_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    issuer TEXT NOT NULL DEFAULT 'https://appleid.apple.com',
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,

    email TEXT,
    email_verified BOOLEAN,
    is_private_email BOOLEAN,

    authorization_status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            authorization_status IN (
                'active',
                'revoked',
                'transfer_pending'
            )
        ),

    apple_refresh_token_encrypted TEXT,
    apple_refresh_token_hash TEXT,
    token_encryption_key_version INTEGER,

    refresh_token_received_at TIMESTAMPTZ,
    refresh_token_last_validated_at TIMESTAMPTZ,
    credential_revoked_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (issuer, audience, subject),
    UNIQUE (account_id, issuer, audience),

    CHECK (CHAR_LENGTH(BTRIM(issuer)) BETWEEN 1 AND 255),
    CHECK (CHAR_LENGTH(BTRIM(audience)) BETWEEN 1 AND 255),
    CHECK (CHAR_LENGTH(BTRIM(subject)) BETWEEN 1 AND 255),

    CHECK (
        email IS NULL
        OR CHAR_LENGTH(BTRIM(email)) BETWEEN 3 AND 320
    ),

    CHECK (
        apple_refresh_token_hash IS NULL
        OR apple_refresh_token_hash ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        (
            apple_refresh_token_encrypted IS NULL
            AND apple_refresh_token_hash IS NULL
            AND token_encryption_key_version IS NULL
            AND refresh_token_received_at IS NULL
        )
        OR (
            apple_refresh_token_encrypted IS NOT NULL
            AND apple_refresh_token_hash IS NOT NULL
            AND token_encryption_key_version IS NOT NULL
            AND token_encryption_key_version > 0
            AND refresh_token_received_at IS NOT NULL
        )
    ),

    CHECK (
        (authorization_status = 'revoked' AND credential_revoked_at IS NOT NULL)
        OR (
            authorization_status <> 'revoked'
            AND credential_revoked_at IS NULL
        )
    )
);

CREATE INDEX account_apple_identities_account_idx
    ON account_apple_identities (
        account_id,
        authorization_status
    );

CREATE INDEX account_apple_identities_refresh_validation_idx
    ON account_apple_identities (
        refresh_token_last_validated_at
    )
    WHERE authorization_status = 'active'
      AND apple_refresh_token_encrypted IS NOT NULL;

CREATE TABLE account_installations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    installation_id TEXT NOT NULL,

    link_source TEXT NOT NULL
        CHECK (
            link_source IN (
                'sign_in_with_apple',
                'existing_user_migration',
                'subscription_migration',
                'session_refresh',
                'manual_support'
            )
        ),

    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unlinked_at TIMESTAMPTZ,

    last_ios_version TEXT,
    last_ios_build INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        last_ios_version IS NULL
        OR last_ios_version ~ '^[0-9]+(\.[0-9]+){0,3}$'
    ),

    CHECK (
        last_ios_build IS NULL
        OR last_ios_build > 0
    ),

    CHECK (
        unlinked_at IS NULL
        OR unlinked_at >= linked_at
    )
);

CREATE UNIQUE INDEX account_installations_one_active_account_idx
    ON account_installations (installation_id)
    WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX account_installations_active_pair_idx
    ON account_installations (account_id, installation_id)
    WHERE unlinked_at IS NULL;

CREATE INDEX account_installations_account_last_seen_idx
    ON account_installations (
        account_id,
        last_seen_at DESC
    );

CREATE TABLE account_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    account_installation_id UUID NOT NULL
        REFERENCES account_installations(id)
        ON DELETE CASCADE,

    token_family_id UUID NOT NULL DEFAULT gen_random_uuid(),
    refresh_token_hash TEXT NOT NULL UNIQUE,

    rotated_from_session_id UUID UNIQUE
        REFERENCES account_sessions(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,

    revoked_at TIMESTAMPTZ,
    revocation_reason TEXT,

    ip_address_hash TEXT,
    user_agent_hash TEXT,

    CHECK (
        refresh_token_hash ~ '^[0-9a-f]{64}$'
    ),

    CHECK (expires_at > created_at),

    CHECK (
        last_used_at >= created_at
    ),

    CHECK (
        revoked_at IS NULL
        OR revoked_at >= created_at
    ),

    CHECK (
        revocation_reason IS NULL
        OR CHAR_LENGTH(BTRIM(revocation_reason)) BETWEEN 1 AND 100
    ),

    CHECK (
        ip_address_hash IS NULL
        OR ip_address_hash ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        user_agent_hash IS NULL
        OR user_agent_hash ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX account_sessions_one_active_per_installation_idx
    ON account_sessions (account_installation_id)
    WHERE revoked_at IS NULL;

CREATE INDEX account_sessions_account_active_idx
    ON account_sessions (
        account_id,
        expires_at DESC
    )
    WHERE revoked_at IS NULL;

CREATE INDEX account_sessions_family_idx
    ON account_sessions (
        token_family_id,
        created_at ASC
    );

CREATE INDEX account_sessions_expiration_idx
    ON account_sessions (expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE account_subscription_ownership (
    original_transaction_id TEXT NOT NULL,
    environment TEXT NOT NULL,

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    ownership_status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            ownership_status IN (
                'active',
                'released',
                'disputed'
            )
        ),

    claim_source TEXT NOT NULL
        CHECK (
            claim_source IN (
                'authenticated_sync',
                'existing_installation_migration',
                'app_store_notification',
                'manual_support'
            )
        ),

    claimed_from_installation_id TEXT,
    verified_transaction_id TEXT,
    observed_app_account_token UUID,

    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
        original_transaction_id,
        environment
    ),

    FOREIGN KEY (
        original_transaction_id,
        environment
    )
        REFERENCES subscription_entitlements(
            original_transaction_id,
            environment
        )
        ON DELETE RESTRICT,

    CHECK (
        CHAR_LENGTH(BTRIM(original_transaction_id)) BETWEEN 1 AND 255
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(environment)) BETWEEN 1 AND 64
    ),

    CHECK (
        claimed_from_installation_id IS NULL
        OR claimed_from_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        verified_transaction_id IS NULL
        OR CHAR_LENGTH(BTRIM(verified_transaction_id)) BETWEEN 1 AND 255
    ),

    CHECK (
        (ownership_status = 'released' AND released_at IS NOT NULL)
        OR (
            ownership_status <> 'released'
            AND released_at IS NULL
        )
    )
);

CREATE INDEX account_subscription_ownership_account_idx
    ON account_subscription_ownership (
        account_id,
        ownership_status,
        updated_at DESC
    );

CREATE TABLE account_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'processing',
                'completed',
                'cancelled',
                'failed'
            )
        ),

    request_source TEXT NOT NULL
        CHECK (
            request_source IN (
                'ios_app',
                'manual_support',
                'apple_notification'
            )
        ),

    apple_revocation_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            apple_revocation_status IN (
                'pending',
                'succeeded',
                'failed',
                'manual_required',
                'not_required'
            )
        ),

    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    last_error_code TEXT,
    last_error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (jsonb_typeof(metadata) = 'object'),

    CHECK (
        status <> 'processing'
        OR processing_started_at IS NOT NULL
    ),

    CHECK (
        status <> 'completed'
        OR completed_at IS NOT NULL
    ),

    CHECK (
        status <> 'cancelled'
        OR cancelled_at IS NOT NULL
    ),

    CHECK (
        last_error_code IS NULL
        OR CHAR_LENGTH(BTRIM(last_error_code)) BETWEEN 1 AND 100
    ),

    CHECK (
        last_error_message IS NULL
        OR CHAR_LENGTH(last_error_message) BETWEEN 1 AND 2000
    )
);

CREATE UNIQUE INDEX account_deletion_requests_one_active_idx
    ON account_deletion_requests (account_id)
    WHERE status IN ('pending', 'processing');

CREATE INDEX account_deletion_requests_status_idx
    ON account_deletion_requests (
        status,
        requested_at ASC
    );

COMMENT ON TABLE accounts IS
    'Authenticated Agora accounts. Existing legacy user_id columns remain installation identifiers.';

COMMENT ON TABLE account_auth_challenges IS
    'Short-lived, single-use Sign in with Apple nonce challenges issued by the backend.';

COMMENT ON TABLE account_apple_identities IS
    'Sign in with Apple identities and encrypted Apple refresh-token material. Never store raw authorization codes.';

COMMENT ON TABLE account_installations IS
    'Historical and active links between authenticated accounts and installation identifiers.';

COMMENT ON TABLE account_sessions IS
    'Agora refresh-session records. Only SHA-256 hashes of Agora refresh tokens are stored.';

COMMENT ON TABLE account_subscription_ownership IS
    'Canonical authenticated account owner for each verified App Store original transaction chain.';

COMMENT ON TABLE account_deletion_requests IS
    'Account-deletion workflow, including Sign in with Apple token-revocation status.';
