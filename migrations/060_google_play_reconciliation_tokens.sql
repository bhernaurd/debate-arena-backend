-- Encrypted, recoverable Google Play purchase tokens for missed RTDN reconciliation.
-- Never expose encrypted_purchase_token through owner dashboard APIs.
CREATE TABLE IF NOT EXISTS google_play_reconciliation_tokens (
  purchase_token_sha256 CHAR(64) PRIMARY KEY,
  encrypted_purchase_token TEXT NOT NULL,
  account_id UUID NOT NULL,
  product_id TEXT NOT NULL,
  test_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS google_play_reconciliation_tokens_account_idx
  ON google_play_reconciliation_tokens (account_id);
