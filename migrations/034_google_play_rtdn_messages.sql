-- Google Play Real-time Developer Notification deduplication.
--
-- Pub/Sub guarantees at-least-once delivery, so messageId must be treated as
-- idempotency data. This table intentionally stores only the Pub/Sub message ID
-- and a SHA-256 purchase-token fingerprint. Raw Google Play purchase tokens are
-- never persisted here.

CREATE TABLE IF NOT EXISTS google_play_rtdn_messages (
    message_id TEXT PRIMARY KEY,
    package_name TEXT,
    notification_type INTEGER,
    event_time_millis BIGINT,
    purchase_token_sha256 TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error_code TEXT,

    CONSTRAINT google_play_rtdn_messages_message_id_length
        CHECK (char_length(message_id) BETWEEN 1 AND 255),
    CONSTRAINT google_play_rtdn_messages_package_length
        CHECK (package_name IS NULL OR char_length(package_name) BETWEEN 1 AND 255),
    CONSTRAINT google_play_rtdn_messages_notification_type_range
        CHECK (notification_type IS NULL OR notification_type >= 0),
    CONSTRAINT google_play_rtdn_messages_event_time_nonnegative
        CHECK (event_time_millis IS NULL OR event_time_millis >= 0),
    CONSTRAINT google_play_rtdn_messages_token_hash_format
        CHECK (
            purchase_token_sha256 IS NULL OR
            purchase_token_sha256 ~ '^[0-9a-f]{64}$'
        ),
    CONSTRAINT google_play_rtdn_messages_status
        CHECK (status IN ('processing', 'processed', 'ignored', 'failed')),
    CONSTRAINT google_play_rtdn_messages_error_length
        CHECK (error_code IS NULL OR char_length(error_code) <= 128)
);

CREATE INDEX IF NOT EXISTS idx_google_play_rtdn_messages_status_updated
    ON google_play_rtdn_messages (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_google_play_rtdn_messages_processed_at
    ON google_play_rtdn_messages (processed_at DESC)
    WHERE processed_at IS NOT NULL;
