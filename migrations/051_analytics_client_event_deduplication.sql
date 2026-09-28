-- 051_analytics_client_event_deduplication.sql
-- Makes the iOS durable analytics outbox safe to retry. Each queued event keeps
-- one stable clientEventId, and duplicate deliveries of that same event are
-- ignored without affecting older clients that do not send the id.

CREATE UNIQUE INDEX IF NOT EXISTS user_events_client_event_id_uidx
    ON user_events (
        user_id,
        (metadata->>'clientEventId')
    )
    WHERE NULLIF(BTRIM(metadata->>'clientEventId'), '') IS NOT NULL;
