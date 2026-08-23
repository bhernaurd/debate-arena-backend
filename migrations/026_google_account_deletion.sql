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

COMMENT ON TABLE account_deletion_requests IS
    'Account-deletion workflow for iOS, Android, support, and Apple notification initiated requests.';
