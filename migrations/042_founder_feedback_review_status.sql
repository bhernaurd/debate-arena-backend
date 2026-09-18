ALTER TABLE founder_feedback
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_founder_feedback_new_created_at
  ON founder_feedback (created_at DESC)
  WHERE reviewed_at IS NULL;
