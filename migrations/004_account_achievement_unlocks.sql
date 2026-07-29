-- 004_account_achievement_unlocks.sql
-- Account-owned achievement unlock timestamps.
--
-- Achievement progress remains derived from account-owned debate history.
-- This table preserves only the first unlock timestamp for each achievement.

CREATE TABLE account_achievement_unlocks (
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    achievement_id TEXT NOT NULL,

    -- Earliest known unlock time across every installation on the account.
    unlocked_at TIMESTAMPTZ NOT NULL,

    origin_installation_id TEXT NOT NULL,
    last_synced_from_installation_id TEXT NOT NULL,

    source_schema_version INTEGER NOT NULL DEFAULT 1,

    first_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sync_count INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (account_id, achievement_id),

    CHECK (
        achievement_id ~ '^[a-z0-9][a-z0-9_]{0,99}$'
    ),

    CHECK (
        origin_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        last_synced_from_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (source_schema_version > 0),

    CHECK (sync_count > 0),

    CHECK (last_synced_at >= first_synced_at)
);

CREATE INDEX account_achievement_unlocks_account_time_idx
    ON account_achievement_unlocks (
        account_id,
        unlocked_at ASC,
        achievement_id ASC
    );

COMMENT ON TABLE account_achievement_unlocks IS
    'Account-owned achievement unlock timestamps. Progress is derived from account debate history.';
