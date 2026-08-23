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
-- account_id once account-AI ownership support is installed. When an account is
-- permanently deleted, remove both kinds of account-bound rows so the deleted
-- account retains neither purchase ownership nor persistent AI transcript data.
--
-- This trigger is safe to deploy before either Android migration: both tables
-- and the AI-job account_id column are resolved dynamically at deletion time.
-- Cleanup simply becomes a no-op until the corresponding support is installed.
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
    'Removes account-bound Google Play subscription rows and authenticated Android AI-job transcript rows when an Agora account is permanently deleted, when those Android support tables/columns are installed.';
