-- 039_ranked_free_daily_access.sql
--
-- Tracks the single daily Ranked ladder start available to non-Pro accounts.
-- Placement trials remain outside this limit. The row is reserved before topic
-- generation so repeated requests, forfeits, and multi-device starts cannot
-- create more than one free ladder debate in the same Daily Challenge window.
--
-- A reserved row is reusable only when its lease has expired and no Ranked
-- debate was actually created for that request. Successful debate creation is
-- detected by start_request_id, so a transient failure to mark the row complete
-- cannot accidentally grant another free start.

CREATE TABLE IF NOT EXISTS account_ranked_free_daily_starts (
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    challenge_date DATE NOT NULL,
    request_id UUID NOT NULL,
    philosopher_id TEXT NOT NULL,
    timezone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'completed')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,

    PRIMARY KEY (account_id, challenge_date),

    CHECK (char_length(philosopher_id) BETWEEN 1 AND 100),
    CHECK (char_length(timezone) BETWEEN 1 AND 100),
    CHECK (
        (status = 'reserved' AND completed_at IS NULL)
        OR
        (status = 'completed' AND completed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS account_ranked_free_daily_starts_request_idx
    ON account_ranked_free_daily_starts (
        account_id,
        request_id
    );

CREATE INDEX IF NOT EXISTS account_ranked_free_daily_starts_recent_idx
    ON account_ranked_free_daily_starts (
        account_id,
        reserved_at DESC
    );
