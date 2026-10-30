-- Durable at-least-once Telegram notification delivery for existing
-- founder_feedback rows. All data remains linked to account deletion.
ALTER TABLE founder_feedback
  ADD COLUMN IF NOT EXISTS telegram_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_last_error TEXT;

-- Existing iOS feedback already went through the old immediate notification
-- path; don't blast duplicate historical iOS alerts on first worker start.
-- Earlier Android submissions remain eligible for retry and recovery.
UPDATE founder_feedback
   SET telegram_sent_at = created_at
 WHERE client_platform IS DISTINCT FROM 'android';

CREATE INDEX IF NOT EXISTS idx_founder_feedback_telegram_pending
  ON founder_feedback (telegram_next_attempt_at, created_at)
  WHERE telegram_sent_at IS NULL
    AND telegram_attempts < 25;
