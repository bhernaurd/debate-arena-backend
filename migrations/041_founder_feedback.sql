CREATE TABLE IF NOT EXISTS founder_feedback (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN ('general', 'feature_idea', 'bug', 'other')
  ),
  message TEXT NOT NULL CHECK (
    char_length(message) BETWEEN 1 AND 2000
  ),
  client_platform TEXT,
  app_version TEXT,
  app_build INTEGER CHECK (app_build IS NULL OR app_build > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_founder_feedback_created_at
  ON founder_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_founder_feedback_account_created_at
  ON founder_feedback (account_id, created_at DESC);
