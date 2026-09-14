-- Daily app-side usage and estimated spend.
SELECT
    occurred_at::date AS utc_date,
    COUNT(*) AS calls,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
    SUM(cache_read_input_tokens) AS cache_read_input_tokens,
    ROUND(SUM(estimated_cost_usd), 4) AS estimated_cost_usd
FROM api_usage_logs
GROUP BY occurred_at::date
ORDER BY utc_date DESC;

-- Spend by feature.
SELECT
    feature,
    COUNT(*) AS calls,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    ROUND(SUM(estimated_cost_usd), 4) AS estimated_cost_usd
FROM api_usage_logs
GROUP BY feature
ORDER BY estimated_cost_usd DESC NULLS LAST;

-- Ten most expensive individual Claude calls.
SELECT
    occurred_at,
    model,
    feature,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    cache_read_input_tokens,
    estimated_cost_usd,
    anthropic_request_id
FROM api_usage_logs
ORDER BY estimated_cost_usd DESC NULLS LAST
LIMIT 10;

-- Daily reconciliation: internal estimate vs Anthropic-reported workspace cost.
SELECT
    report_date,
    local_call_count,
    local_estimated_cost_usd,
    anthropic_usage_estimated_cost_usd,
    anthropic_reported_cost_usd,
    difference_usd,
    difference_percent,
    token_usage_matches,
    local_tracking_complete,
    cost_scope
FROM anthropic_cost_reconciliations
ORDER BY report_date DESC;
