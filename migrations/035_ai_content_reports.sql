-- In-app user reports for AI-generated philosopher responses.
--
-- Reports are account-owned and are deleted with the account. Store only the
-- specific response the user chose to report plus bounded debate metadata that
-- is useful for moderation/review. Authentication credentials, full unrelated
-- conversation history, raw IP addresses, and raw user-agent strings are not
-- stored here.

CREATE TABLE IF NOT EXISTS ai_content_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    installation_id TEXT NOT NULL,
    debate_id UUID NOT NULL,
    message_id UUID NOT NULL,
    philosopher_id TEXT NOT NULL,
    debate_kind TEXT NOT NULL,
    challenge_id TEXT,
    reason TEXT NOT NULL,
    response_text TEXT NOT NULL,

    client_platform TEXT NOT NULL DEFAULT 'android',
    app_version TEXT,
    app_build TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT ai_content_reports_installation_format
        CHECK (installation_id ~ '^[A-Za-z0-9-]{8,128}$'),
    CONSTRAINT ai_content_reports_philosopher_length
        CHECK (CHAR_LENGTH(philosopher_id) BETWEEN 1 AND 64),
    CONSTRAINT ai_content_reports_debate_kind
        CHECK (debate_kind IN ('standard', 'daily_challenge', 'ranked')),
    CONSTRAINT ai_content_reports_challenge_length
        CHECK (challenge_id IS NULL OR CHAR_LENGTH(challenge_id) BETWEEN 1 AND 128),
    CONSTRAINT ai_content_reports_reason
        CHECK (
            reason IN (
                'offensive_or_harmful',
                'inaccurate_or_misleading',
                'misrepresents_philosopher',
                'other'
            )
        ),
    CONSTRAINT ai_content_reports_response_length
        CHECK (CHAR_LENGTH(response_text) BETWEEN 1 AND 12000),
    CONSTRAINT ai_content_reports_platform
        CHECK (client_platform IN ('android', 'ios')),
    CONSTRAINT ai_content_reports_app_version_length
        CHECK (app_version IS NULL OR CHAR_LENGTH(app_version) BETWEEN 1 AND 64),
    CONSTRAINT ai_content_reports_app_build_length
        CHECK (app_build IS NULL OR CHAR_LENGTH(app_build) BETWEEN 1 AND 64),

    CONSTRAINT ai_content_reports_account_message_unique
        UNIQUE (account_id, message_id)
);

CREATE INDEX IF NOT EXISTS ai_content_reports_created_at_idx
    ON ai_content_reports (created_at DESC);

CREATE INDEX IF NOT EXISTS ai_content_reports_reason_created_idx
    ON ai_content_reports (reason, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_content_reports_philosopher_created_idx
    ON ai_content_reports (philosopher_id, created_at DESC);
