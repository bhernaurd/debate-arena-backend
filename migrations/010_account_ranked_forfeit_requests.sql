-- 010_account_ranked_forfeit_requests.sql
-- Adds durable idempotency metadata for explicit Ranked placement forfeits.
--
-- This migration is intentionally defensive:
-- - It repairs completion_request_id if migration 009 was recorded without
--   applying the column in a particular environment.
-- - It adds forfeit_request_id and its account-scoped unique index.
-- - It prevents completion and forfeit request IDs from coexisting.
--
-- This migration does not enable Ranked and does not change Pro access.

ALTER TABLE account_ranked_debates
    ADD COLUMN IF NOT EXISTS completion_request_id UUID;

ALTER TABLE account_ranked_debates
    ADD COLUMN IF NOT EXISTS forfeit_request_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS
    account_ranked_debates_completion_request_idx
ON account_ranked_debates (
    account_id,
    completion_request_id
)
WHERE completion_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    account_ranked_debates_forfeit_request_idx
ON account_ranked_debates (
    account_id,
    forfeit_request_id
)
WHERE forfeit_request_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid =
            'public.account_ranked_debates'::regclass
          AND conname =
            'account_ranked_debates_completion_request_status_check'
    ) THEN
        ALTER TABLE account_ranked_debates
            ADD CONSTRAINT
                account_ranked_debates_completion_request_status_check
            CHECK (
                completion_request_id IS NULL
                OR status = 'completed'
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid =
            'public.account_ranked_debates'::regclass
          AND conname =
            'account_ranked_debates_forfeit_request_status_check'
    ) THEN
        ALTER TABLE account_ranked_debates
            ADD CONSTRAINT
                account_ranked_debates_forfeit_request_status_check
            CHECK (
                forfeit_request_id IS NULL
                OR status = 'forfeited'
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid =
            'public.account_ranked_debates'::regclass
          AND conname =
            'account_ranked_debates_resolution_request_exclusive_check'
    ) THEN
        ALTER TABLE account_ranked_debates
            ADD CONSTRAINT
                account_ranked_debates_resolution_request_exclusive_check
            CHECK (
                NOT (
                    completion_request_id IS NOT NULL
                    AND forfeit_request_id IS NOT NULL
                )
            );
    END IF;
END
$$;

COMMENT ON COLUMN
    account_ranked_debates.completion_request_id
IS
    'Client-generated UUID that makes successful Ranked debate completion idempotent for an account.';

COMMENT ON COLUMN
    account_ranked_debates.forfeit_request_id
IS
    'Client-generated UUID that makes an explicit Ranked debate forfeit idempotent for an account.';
