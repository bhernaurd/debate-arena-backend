-- 003_account_debate_history.sql
-- Account-owned debate-history records migrated from local iOS SavedDebate data.
--
-- This first stage is upload-only and non-destructive. Local history remains the
-- source displayed by the current app until a later account-history download and
-- conflict-resolution stage is explicitly implemented.

CREATE TABLE account_debate_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    saved_debate_id UUID NOT NULL,

    -- The first installation that uploaded this SavedDebate UUID is retained for
    -- provenance. Later syncs may come from another installation on the account.
    origin_installation_id TEXT NOT NULL,
    last_synced_from_installation_id TEXT NOT NULL,

    analytics_debate_id TEXT,

    philosopher_name TEXT NOT NULL,
    philosopher_initials TEXT NOT NULL,
    philosopher_color_hex TEXT NOT NULL,
    topic TEXT NOT NULL,

    debate_date TIMESTAMPTZ NOT NULL,
    debate_mode_raw_value TEXT,

    is_daily_challenge BOOLEAN NOT NULL DEFAULT FALSE,
    daily_challenge_id TEXT,
    daily_challenge_date DATE,

    final_score_text TEXT,
    final_score_value DOUBLE PRECISION,
    has_been_analyzed BOOLEAN NOT NULL DEFAULT FALSE,

    -- Messages and the generated report are validated by the service before
    -- persistence. Keeping them as JSONB preserves their complete versioned
    -- structure without coupling account history to AI prompt/report revisions.
    messages JSONB NOT NULL,
    report JSONB,
    message_count INTEGER NOT NULL,

    source_schema_version INTEGER NOT NULL DEFAULT 1,

    -- Stable source time derived by iOS from the debate, latest message, and
    -- report timestamps. It prevents an older device snapshot from replacing a
    -- newer report for the same account + SavedDebate UUID.
    content_updated_at TIMESTAMPTZ NOT NULL,
    content_sha256 TEXT NOT NULL,

    first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_count INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, saved_debate_id),

    CHECK (
        origin_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        last_synced_from_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        analytics_debate_id IS NULL
        OR CHAR_LENGTH(BTRIM(analytics_debate_id)) BETWEEN 1 AND 128
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_name)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_initials)) BETWEEN 1 AND 20
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_color_hex)) BETWEEN 1 AND 32
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(topic)) BETWEEN 1 AND 2000
    ),

    CHECK (
        debate_mode_raw_value IS NULL
        OR CHAR_LENGTH(BTRIM(debate_mode_raw_value)) BETWEEN 1 AND 50
    ),

    CHECK (
        daily_challenge_id IS NULL
        OR CHAR_LENGTH(BTRIM(daily_challenge_id)) BETWEEN 1 AND 128
    ),

    CHECK (
        final_score_text IS NULL
        OR CHAR_LENGTH(BTRIM(final_score_text)) BETWEEN 1 AND 50
    ),

    CHECK (
        final_score_value IS NULL
        OR (
            final_score_value >= 0
            AND final_score_value <= 10
        )
    ),

    CHECK (jsonb_typeof(messages) = 'array'),

    CHECK (
        report IS NULL
        OR jsonb_typeof(report) = 'object'
    ),

    CHECK (
        message_count >= 0
        AND message_count <= 200
    ),

    CHECK (
        jsonb_array_length(messages) = message_count
    ),

    CHECK (source_schema_version > 0),

    CHECK (
        content_sha256 ~ '^[0-9a-f]{64}$'
    ),

    CHECK (sync_count > 0),

    CHECK (last_synced_at >= first_synced_at)
);

CREATE INDEX account_debate_history_account_date_idx
    ON account_debate_history (
        account_id,
        debate_date DESC,
        saved_debate_id
    );

CREATE INDEX account_debate_history_account_philosopher_idx
    ON account_debate_history (
        account_id,
        philosopher_name,
        debate_date DESC
    );

CREATE INDEX account_debate_history_analytics_id_idx
    ON account_debate_history (
        account_id,
        analytics_debate_id
    )
    WHERE analytics_debate_id IS NOT NULL;

CREATE INDEX account_debate_history_daily_challenge_idx
    ON account_debate_history (
        account_id,
        daily_challenge_date DESC
    )
    WHERE is_daily_challenge = TRUE;

CREATE INDEX account_debate_history_content_update_idx
    ON account_debate_history (
        account_id,
        content_updated_at DESC
    );

COMMENT ON TABLE account_debate_history IS
    'Account-owned SavedDebate snapshots. Initial implementation is authenticated upload-only and preserves local iOS history.';
