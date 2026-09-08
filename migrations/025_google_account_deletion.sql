-- 025_google_account_deletion.sql
-- Adds Android as an explicit account-deletion request source. Google deletion
-- uses fresh Google reauthentication and therefore does not require Apple token
-- revocation; apple_revocation_status is recorded as 'not_required'.
--
-- This migration is additive. The existing iOS/Apple deletion path is unchanged.

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

COMMENT ON COLUMN account_deletion_requests.request_source IS
'Origin of an account deletion request. iOS uses Apple reauthentication; Android uses Google reauthentication.';
