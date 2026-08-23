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
-- part of the verified record. If Play support is present when an account is
-- permanently deleted, remove those account-bound rows so the deleted account
-- no longer retains purchase ownership and a still-valid Play subscription can
-- be verified against a newly created Agora account later.
--
-- This trigger is safe to deploy before the Google Play migration: the table is
-- resolved dynamically at deletion time and the cleanup simply becomes a no-op
-- until that table exists.
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
    'Releases account-bound Google Play subscription verification rows when an Agora account is permanently deleted, if Google Play support is installed.';
