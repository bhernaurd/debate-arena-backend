-- 026_google_account_deletion.sql
-- Android uses the same account-deletion audit table as iOS, but Google
-- reauthentication does not require Apple token revocation.

ALTER TABLE account_deletion_requests
    DROP CONSTRAINT IF EXISTS account_deletion_requests_request_source_check;

ALTER TABLE account_deletion_requests
    ADD CONSTRAINT account_deletion_requests_request_source_check
    CHECK (
        request_source IN (
            'ios_app',
            'android_app',
            'manual_support',
            'apple_notification'
        )
    );

-- Google Play subscription rows intentionally contain account ownership as
-- part of the verified record. Authenticated Android AI jobs also gain an
-- account_id once account-AI ownership support is installed. Push registrations
-- may carry the Agora account in user_id while retaining installation/token
-- state independently. When an account is permanently deleted, release each
-- account-bound surface without deleting device-level push configuration.
--
-- This trigger is migration-order safe: optional Android tables/columns are
-- resolved dynamically at deletion time. Cleanup becomes a no-op until the
-- corresponding support exists.
CREATE OR REPLACE FUNCTION release_google_play_on_account_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF to_regclass('public.google_play_subscription_entitlements') IS NOT NULL THEN
        EXECUTE
            'DELETE FROM public.google_play_subscription_entitlements WHERE account_id = $1'
            USING NEW.id;
    END IF;

    IF
        to_regclass('public.ai_generation_jobs') IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM pg_attribute
            WHERE attrelid = to_regclass('public.ai_generation_jobs')
              AND attname = 'account_id'
              AND NOT attisdropped
        )
    THEN
        EXECUTE
            'DELETE FROM public.ai_generation_jobs WHERE account_id = $1'
            USING NEW.id;
    END IF;

    IF
        to_regclass('public.push_tokens') IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM pg_attribute
            WHERE attrelid = to_regclass('public.push_tokens')
              AND attname = 'user_id'
              AND NOT attisdropped
        )
    THEN
        IF
            EXISTS (
                SELECT 1
                FROM pg_attribute
                WHERE attrelid = to_regclass('public.push_tokens')
                  AND attname = 'last_completed_challenge_id'
                  AND NOT attisdropped
            )
            AND EXISTS (
                SELECT 1
                FROM pg_attribute
                WHERE attrelid = to_regclass('public.push_tokens')
                  AND attname = 'last_completed_challenge_date'
                  AND NOT attisdropped
            )
        THEN
            EXECUTE
                'UPDATE public.push_tokens
                 SET user_id = NULL,
                     last_completed_challenge_id = NULL,
                     last_completed_challenge_date = NULL
                 WHERE user_id = $1'
                USING NEW.id;
        ELSE
            EXECUTE
                'UPDATE public.push_tokens SET user_id = NULL WHERE user_id = $1'
                USING NEW.id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_release_google_play_after_deletion ON accounts;

CREATE TRIGGER accounts_release_google_play_after_deletion
AFTER UPDATE OF status ON accounts
FOR EACH ROW
WHEN (
    OLD.status IS DISTINCT FROM NEW.status
    AND NEW.status = 'deleted'
)
EXECUTE FUNCTION release_google_play_on_account_deletion();

COMMENT ON TABLE account_deletion_requests IS
    'Account-deletion workflow for iOS, Android, support, and Apple notification initiated requests.';

COMMENT ON FUNCTION release_google_play_on_account_deletion() IS
    'Removes account-bound Google Play subscription and authenticated Android AI-job rows, and detaches push ownership/completion state, when an Agora account is permanently deleted. Optional Android tables/columns are handled dynamically.';
