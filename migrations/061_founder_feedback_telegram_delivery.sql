-- Durable at-least-once Telegram notification delivery for existing
-- founder_feedback rows. All data remains linked to account deletion.
ALTER TABLE founder_feedback
  ADD COLUMN IF NOT EXISTS telegram_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS telegram_last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_founder_feedback_telegram_pending
  ON founder_feedback (telegram_next_attempt_at, created_at)
  WHERE telegram_sent_at IS NULL
    AND telegram_attempts < 25;
