-- 024_google_account_identities.sql
-- Android account authentication stays intentionally separate from Apple's
-- identity namespace. No email-based linking or provider merging is performed.

CREATE TABLE account_google_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    issuer TEXT NOT NULL DEFAULT 'https://accounts.google.com',
    audience TEXT NOT NULL,
    subject TEXT NOT NULL,

    email TEXT,
    email_verified BOOLEAN,
    display_name TEXT,
    picture_url TEXT,

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
        display_name IS NULL
        OR CHAR_LENGTH(BTRIM(display_name)) BETWEEN 1 AND 100
    ),
    CHECK (
        picture_url IS NULL
        OR CHAR_LENGTH(BTRIM(picture_url)) BETWEEN 1 AND 2048
    )
);

CREATE INDEX account_google_identities_account_idx
    ON account_google_identities (account_id, last_authenticated_at DESC);

-- Existing iOS rows keep their original values. Android installations can now
-- be linked through Google without changing Apple's sign-in path.
ALTER TABLE account_installations
    DROP CONSTRAINT IF EXISTS account_installations_link_source_check;

ALTER TABLE account_installations
    ADD CONSTRAINT account_installations_link_source_check
    CHECK (
        link_source IN (
            'sign_in_with_apple',
            'sign_in_with_google',
            'existing_user_migration',
            'subscription_migration',
            'session_refresh',
            'manual_support'
        )
    );
