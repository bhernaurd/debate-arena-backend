BEGIN;

-- Permanent deletion tombstones for account-owned Debate History.
--
-- The tombstone is intentionally stored separately from account_debate_history:
-- 1. deleting a History row does not require keeping the conversation content;
-- 2. an older/offline device cannot re-upload the same SavedDebate ID later;
-- 3. deletion remains idempotent even when the History row is already absent.
CREATE TABLE IF NOT EXISTS account_debate_history_deletions (
    account_id UUID NOT NULL,
    saved_debate_id UUID NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (account_id, saved_debate_id)
);

CREATE INDEX IF NOT EXISTS idx_account_debate_history_deletions_account_time
    ON account_debate_history_deletions (
        account_id,
        deleted_at DESC
    );

COMMIT;
