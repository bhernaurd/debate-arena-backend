BEGIN;

ALTER TABLE ai_generation_jobs
    ADD COLUMN IF NOT EXISTS account_id UUID NULL
        REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_account_id
    ON ai_generation_jobs (account_id, id);

CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_account_client_request
    ON ai_generation_jobs (account_id, client_request_id);

COMMIT;
