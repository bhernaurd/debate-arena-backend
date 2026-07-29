-- 005_account_daily_challenge_progress.sql
-- Account-owned unfinished Daily Challenge snapshots and completion tombstones.
--
-- Completed Daily Challenges remain stored in account_debate_history. This
-- table exists only so an unfinished challenge can resume across devices and
-- so a completion/clear event cannot be resurrected by a stale device.

CREATE TABLE account_daily_challenge_progress (
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    challenge_id TEXT NOT NULL,
    challenge_date DATE NOT NULL,

    status TEXT NOT NULL
        CHECK (status IN ('active', 'cleared')),

    challenge_title TEXT,
    challenge_question TEXT,

    philosopher_id TEXT,
    philosopher_name TEXT,

    analytics_debate_id TEXT,

    user_opening_answer TEXT,
    messages JSONB,
    current_score TEXT,
    round_count INTEGER,

    session_created_at TIMESTAMPTZ,
    mutation_updated_at TIMESTAMPTZ NOT NULL,

    origin_installation_id TEXT NOT NULL,
    last_synced_from_installation_id TEXT NOT NULL,

    source_schema_version INTEGER NOT NULL DEFAULT 1,

    first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_count INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (account_id, challenge_id),

    CHECK (length(challenge_id) BETWEEN 1 AND 128),
    CHECK (round_count IS NULL OR round_count BETWEEN 0 AND 1000),
    CHECK (source_schema_version > 0),
    CHECK (sync_count > 0),

    CHECK (
        origin_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        last_synced_from_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        (
            status = 'active'
            AND challenge_title IS NOT NULL
            AND challenge_question IS NOT NULL
            AND philosopher_id IS NOT NULL
            AND philosopher_name IS NOT NULL
            AND user_opening_answer IS NOT NULL
            AND messages IS NOT NULL
            AND jsonb_typeof(messages) = 'array'
            AND round_count IS NOT NULL
            AND session_created_at IS NOT NULL
            AND mutation_updated_at >= session_created_at
        )
        OR
        (
            status = 'cleared'
            AND challenge_title IS NULL
            AND challenge_question IS NULL
            AND philosopher_id IS NULL
            AND philosopher_name IS NULL
            AND analytics_debate_id IS NULL
            AND user_opening_answer IS NULL
            AND messages IS NULL
            AND current_score IS NULL
            AND round_count IS NULL
            AND session_created_at IS NULL
        )
    )
);

CREATE INDEX account_daily_challenge_progress_current_idx
    ON account_daily_challenge_progress (
        account_id,
        status,
        challenge_date DESC,
        mutation_updated_at DESC
    );

COMMENT ON TABLE account_daily_challenge_progress IS
    'Account-owned unfinished Daily Challenge snapshots plus permanent per-challenge clear tombstones.';
