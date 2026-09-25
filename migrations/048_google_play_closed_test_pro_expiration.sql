-- 048_google_play_closed_test_pro_expiration.sql
-- Temporary Google Play closed-test Pro grants.
--
-- Existing manual grants remain permanent because expires_at is nullable.
-- Closed-test activation writes a finite expiration so tester access ends
-- automatically even if no cleanup job runs.

ALTER TABLE account_manual_pro_grants
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'account_manual_pro_grants_expiration_check'
          AND conrelid = 'account_manual_pro_grants'::regclass
    ) THEN
        ALTER TABLE account_manual_pro_grants
            ADD CONSTRAINT account_manual_pro_grants_expiration_check
            CHECK (
                expires_at IS NULL
                OR expires_at > granted_at
            );
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS account_manual_pro_grants_active_expiration_idx
    ON account_manual_pro_grants (
        account_id,
        expires_at
    )
    WHERE revoked_at IS NULL;

COMMENT ON COLUMN account_manual_pro_grants.expires_at IS
    'Optional automatic expiration for temporary manual access such as Google Play closed testing. NULL means the manual grant does not expire automatically.';
