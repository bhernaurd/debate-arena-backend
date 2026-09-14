CREATE TABLE IF NOT EXISTS api_usage_logs (
    id BIGSERIAL PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    provider TEXT NOT NULL DEFAULT 'anthropic',
    model TEXT NOT NULL,
    feature TEXT NOT NULL DEFAULT 'unknown',
    endpoint TEXT NOT NULL DEFAULT '/v1/messages',
    transport TEXT,
    status_code INTEGER,
    success BOOLEAN NOT NULL DEFAULT TRUE,

    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_creation_input_tokens >= 0),
    cache_creation_5m_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_creation_5m_input_tokens >= 0),
    cache_creation_1h_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_creation_1h_input_tokens >= 0),
    cache_read_input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_input_tokens >= 0),

    estimated_cost_usd NUMERIC(16, 8),
    pricing_version TEXT,
    input_usd_per_mtok NUMERIC(12, 6),
    output_usd_per_mtok NUMERIC(12, 6),
    cache_write_5m_usd_per_mtok NUMERIC(12, 6),
    cache_write_1h_usd_per_mtok NUMERIC(12, 6),
    cache_read_usd_per_mtok NUMERIC(12, 6),

    account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
    installation_id TEXT,
    entity_type TEXT,
    entity_id TEXT,

    anthropic_request_id TEXT,
    raw_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_usage_logs_occurred_at_idx
    ON api_usage_logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_logs_feature_idx
    ON api_usage_logs (feature, occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_logs_model_idx
    ON api_usage_logs (model, occurred_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_logs_account_idx
    ON api_usage_logs (account_id, occurred_at DESC)
    WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS api_usage_logs_anthropic_request_id_uidx
    ON api_usage_logs (anthropic_request_id)
    WHERE anthropic_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS anthropic_cost_reconciliations (
    report_date DATE PRIMARY KEY,
    period_start_utc TIMESTAMPTZ NOT NULL,
    period_end_utc TIMESTAMPTZ NOT NULL,

    local_call_count BIGINT NOT NULL DEFAULT 0,
    local_input_tokens BIGINT NOT NULL DEFAULT 0,
    local_output_tokens BIGINT NOT NULL DEFAULT 0,
    local_cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
    local_cache_read_input_tokens BIGINT NOT NULL DEFAULT 0,
    local_estimated_cost_usd NUMERIC(16, 8) NOT NULL DEFAULT 0,

    anthropic_api_key_id TEXT,
    anthropic_workspace_id TEXT,
    anthropic_usage_input_tokens BIGINT NOT NULL DEFAULT 0,
    anthropic_usage_output_tokens BIGINT NOT NULL DEFAULT 0,
    anthropic_usage_cache_creation_input_tokens BIGINT NOT NULL DEFAULT 0,
    anthropic_usage_cache_read_input_tokens BIGINT NOT NULL DEFAULT 0,
    anthropic_usage_estimated_cost_usd NUMERIC(16, 8),
    anthropic_reported_cost_usd NUMERIC(16, 8),

    difference_usd NUMERIC(16, 8),
    difference_percent NUMERIC(12, 4),
    token_usage_matches BOOLEAN,
    local_tracking_complete BOOLEAN NOT NULL DEFAULT TRUE,
    cost_scope TEXT,

    raw_usage_report JSONB,
    raw_cost_report JSONB,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS anthropic_cost_reconciliations_fetched_at_idx
    ON anthropic_cost_reconciliations (fetched_at DESC);
