-- 025_subscription_admin_notifications.sql
-- Durable owner/admin notification outbox for subscription lifecycle events.
--
-- The App Store notification is committed first. Delivery to APNs/Telegram is
-- retried independently so a temporary messaging failure never causes Apple
-- subscription processing to fail or creates duplicate subscription records.

CREATE TABLE subscription_admin_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    dedupe_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,

    notification_uuid TEXT,
    notification_type TEXT NOT NULL,
    subtype TEXT,
    environment TEXT NOT NULL
        CHECK (environment IN ('Production', 'Sandbox')),

    account_id UUID
        REFERENCES accounts(id)
        ON DELETE SET NULL,

    original_transaction_id TEXT,
    transaction_id TEXT,
    product_id TEXT,

    event_kind TEXT NOT NULL,

    title TEXT NOT NULL,
    body TEXT NOT NULL,
    telegram_text TEXT NOT NULL,

    payload JSONB NOT NULL DEFAULT '{}'::jsonb,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'sending',
                'delivered',
                'failed',
                'skipped'
            )
        ),

    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,

    apns_status TEXT,
    apns_error TEXT,

    telegram_status TEXT,
    telegram_error TEXT,

    delivered_via TEXT,
    delivered_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        notification_uuid IS NULL OR
        CHAR_LENGTH(BTRIM(notification_uuid)) BETWEEN 1 AND 128
    ),

    CHECK (
        original_transaction_id IS NULL OR
        CHAR_LENGTH(BTRIM(original_transaction_id)) BETWEEN 1 AND 128
    ),

    CHECK (
        transaction_id IS NULL OR
        CHAR_LENGTH(BTRIM(transaction_id)) BETWEEN 1 AND 128
    )
);

CREATE INDEX subscription_admin_notifications_delivery_idx
    ON subscription_admin_notifications (
        status,
        next_attempt_at,
        created_at
    )
    WHERE status IN ('pending', 'sending');

CREATE INDEX subscription_admin_notifications_event_idx
    ON subscription_admin_notifications (
        event_kind,
        environment,
        created_at DESC
    );

CREATE INDEX subscription_admin_notifications_account_idx
    ON subscription_admin_notifications (
        account_id,
        created_at DESC
    )
    WHERE account_id IS NOT NULL;

CREATE INDEX subscription_admin_notifications_transaction_idx
    ON subscription_admin_notifications (
        original_transaction_id,
        environment,
        created_at DESC
    )
    WHERE original_transaction_id IS NOT NULL;

COMMENT ON TABLE subscription_admin_notifications IS
    'Durable APNs/Telegram delivery outbox for owner-facing subscription lifecycle alerts.';


-- Cursor state starts at migration time so enabling the worker never replays
-- historical App Store events as fresh owner alerts. The cursor advances after
-- each persisted Apple event is examined, whether or not that event is alertable.
CREATE TABLE subscription_admin_notification_state (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    started_at TIMESTAMPTZ NOT NULL,
    last_scanned_event_at TIMESTAMPTZ NOT NULL,
    last_scanned_event_key TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO subscription_admin_notification_state (
    id,
    started_at,
    last_scanned_event_at,
    last_scanned_event_key
)
VALUES (1, NOW(), NOW(), '')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE subscription_admin_notification_state IS
    'Singleton cursor for scanning newly persisted Apple subscription_events into the admin alert outbox without replaying historical events.';
