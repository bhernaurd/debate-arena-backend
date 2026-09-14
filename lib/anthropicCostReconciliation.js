import { calculateAnthropicEstimatedCost } from './anthropicUsageTracking.js';

const ADMIN_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function keyMatchesHint(secret, hint) {
  if (!secret || !hint || !hint.includes('...')) return false;
  const [prefix, suffix] = hint.split('...');
  return secret.startsWith(prefix) && secret.endsWith(suffix);
}

async function adminGet(path, params = {}) {
  const adminKey = process.env.ANTHROPIC_ADMIN_KEY;
  if (!adminKey) throw new Error('Missing ANTHROPIC_ADMIN_KEY');

  const url = new URL(path, ADMIN_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': adminKey,
      'user-agent': 'TheAgora/1.0 cost-audit',
      accept: 'application/json',
    },
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Anthropic Admin API returned non-JSON (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(parsed?.error?.message || parsed?.message || `Anthropic Admin API failed (${response.status}).`);
  }
  return parsed;
}

async function fetchPaged(path, params = {}) {
  const data = [];
  let page = null;
  const rawPages = [];

  do {
    const response = await adminGet(path, { ...params, ...(page ? { page } : {}) });
    rawPages.push(response);
    data.push(...(Array.isArray(response.data) ? response.data : []));
    page = response.has_more && response.next_page ? response.next_page : null;
  } while (page);

  return { data, rawPages };
}

async function findAppApiKey() {
  const appSecret = process.env.ANTHROPIC_API_KEY;
  if (!appSecret) throw new Error('Missing ANTHROPIC_API_KEY for cost reconciliation.');

  let afterId = null;
  for (let pageCount = 0; pageCount < 50; pageCount++) {
    const response = await adminGet('/v1/organizations/api_keys', {
      limit: 100,
      status: 'active',
      ...(afterId ? { after_id: afterId } : {}),
    });
    const keys = Array.isArray(response.data) ? response.data : [];
    const match = keys.find((key) => keyMatchesHint(appSecret, key.partial_key_hint));
    if (match) return match;
    if (!response.has_more || !response.last_id) break;
    afterId = response.last_id;
  }

  return null;
}

function aggregateUsageBuckets(buckets) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    estimatedCostUsd: 0,
    hasUnsupportedModel: false,
  };

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      const usage = {
        uncached_input_tokens: toNumber(result.uncached_input_tokens),
        output_tokens: toNumber(result.output_tokens),
        cache_read_input_tokens: toNumber(result.cache_read_input_tokens),
        cache_creation: {
          ephemeral_5m_input_tokens: toNumber(result.cache_creation?.ephemeral_5m_input_tokens),
          ephemeral_1h_input_tokens: toNumber(result.cache_creation?.ephemeral_1h_input_tokens),
        },
      };
      const calculated = calculateAnthropicEstimatedCost(result.model, usage);
      totals.inputTokens += usage.uncached_input_tokens;
      totals.outputTokens += usage.output_tokens;
      totals.cacheCreationInputTokens +=
        usage.cache_creation.ephemeral_5m_input_tokens + usage.cache_creation.ephemeral_1h_input_tokens;
      totals.cacheReadInputTokens += usage.cache_read_input_tokens;
      if (calculated.estimatedCostUsd == null) {
        totals.hasUnsupportedModel = true;
      } else {
        totals.estimatedCostUsd += calculated.estimatedCostUsd;
      }
    }
  }

  return totals;
}

function aggregateCostBuckets(buckets, expectedWorkspaceId, isDefaultWorkspace) {
  let amountCents = 0;
  let matchedRows = 0;

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      const workspaceMatches = isDefaultWorkspace
        ? result.workspace_id == null
        : result.workspace_id === expectedWorkspaceId;
      if (!workspaceMatches) continue;
      amountCents += toNumber(result.amount);
      matchedRows += 1;
    }
  }

  return { costUsd: amountCents / 100, matchedRows };
}

export async function reconcileAnthropicCostForUtcDay(pool, dateString) {
  const start = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid UTC report date: ${dateString}`);
  const end = new Date(start.getTime() + 86_400_000);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const localResult = await pool.query(
    `SELECT
       COUNT(*)::bigint AS call_count,
       COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
       COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
       COALESCE(SUM(cache_creation_input_tokens),0)::bigint AS cache_creation_tokens,
       COALESCE(SUM(cache_read_input_tokens),0)::bigint AS cache_read_tokens,
       COALESCE(SUM(estimated_cost_usd),0)::numeric AS estimated_cost_usd,
       MIN(occurred_at) AS first_log
     FROM api_usage_logs
     WHERE occurred_at >= $1 AND occurred_at < $2`,
    [startIso, endIso]
  );
  const local = localResult.rows[0] || {};

  const appApiKey = await findAppApiKey();
  const apiKeyId = appApiKey?.id || null;
  const workspaceId = appApiKey?.scope?.type === 'workspace'
    ? appApiKey.scope.workspace_id
    : null;
  const isDefaultWorkspace = appApiKey?.workspace_id == null && appApiKey?.scope?.type === 'workspace';

  const usageReport = await fetchPaged('/v1/organizations/usage_report/messages', {
    starting_at: startIso,
    ending_at: endIso,
    bucket_width: '1d',
    limit: 1,
    'group_by[]': ['model'],
    ...(apiKeyId ? { 'api_key_ids[]': [apiKeyId] } : {}),
  });
  const usageTotals = aggregateUsageBuckets(usageReport.data);

  const costReport = await fetchPaged('/v1/organizations/cost_report', {
    starting_at: startIso,
    ending_at: endIso,
    bucket_width: '1d',
    limit: 1,
    'group_by[]': ['workspace_id', 'description'],
  });
  const costTotals = aggregateCostBuckets(costReport.data, workspaceId, isDefaultWorkspace);

  const localCallCount = toNumber(local.call_count);
  const localEstimated = toNumber(local.estimated_cost_usd);
  const actualCost = costTotals.costUsd;
  const differenceUsd = actualCost - localEstimated;
  const differencePercent = localEstimated > 0 ? (differenceUsd / localEstimated) * 100 : null;

  const localTokenSum =
    toNumber(local.input_tokens) + toNumber(local.output_tokens) +
    toNumber(local.cache_creation_tokens) + toNumber(local.cache_read_tokens);
  const anthropicTokenSum =
    usageTotals.inputTokens + usageTotals.outputTokens +
    usageTotals.cacheCreationInputTokens + usageTotals.cacheReadInputTokens;
  const tokenUsageMatches = localTokenSum === anthropicTokenSum;

  const trackingStartedAtResult = await pool.query('SELECT MIN(occurred_at) AS first_ever_log FROM api_usage_logs');
  const firstEverLog = trackingStartedAtResult.rows[0]?.first_ever_log
    ? new Date(trackingStartedAtResult.rows[0].first_ever_log)
    : null;
  const localTrackingComplete = firstEverLog != null && firstEverLog <= start;

  const costScope = !appApiKey
    ? 'organization_unmatched_api_key'
    : isDefaultWorkspace
      ? 'default_workspace'
      : workspaceId
        ? `workspace:${workspaceId}`
        : 'organization';

  await pool.query(
    `INSERT INTO anthropic_cost_reconciliations (
       report_date, period_start_utc, period_end_utc,
       local_call_count, local_input_tokens, local_output_tokens,
       local_cache_creation_input_tokens, local_cache_read_input_tokens,
       local_estimated_cost_usd, anthropic_api_key_id, anthropic_workspace_id,
       anthropic_usage_input_tokens, anthropic_usage_output_tokens,
       anthropic_usage_cache_creation_input_tokens, anthropic_usage_cache_read_input_tokens,
       anthropic_usage_estimated_cost_usd, anthropic_reported_cost_usd,
       difference_usd, difference_percent, token_usage_matches,
       local_tracking_complete, cost_scope, raw_usage_report, raw_cost_report,
       fetched_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,$24::jsonb,NOW(),NOW()
     )
     ON CONFLICT (report_date) DO UPDATE SET
       period_start_utc=EXCLUDED.period_start_utc,
       period_end_utc=EXCLUDED.period_end_utc,
       local_call_count=EXCLUDED.local_call_count,
       local_input_tokens=EXCLUDED.local_input_tokens,
       local_output_tokens=EXCLUDED.local_output_tokens,
       local_cache_creation_input_tokens=EXCLUDED.local_cache_creation_input_tokens,
       local_cache_read_input_tokens=EXCLUDED.local_cache_read_input_tokens,
       local_estimated_cost_usd=EXCLUDED.local_estimated_cost_usd,
       anthropic_api_key_id=EXCLUDED.anthropic_api_key_id,
       anthropic_workspace_id=EXCLUDED.anthropic_workspace_id,
       anthropic_usage_input_tokens=EXCLUDED.anthropic_usage_input_tokens,
       anthropic_usage_output_tokens=EXCLUDED.anthropic_usage_output_tokens,
       anthropic_usage_cache_creation_input_tokens=EXCLUDED.anthropic_usage_cache_creation_input_tokens,
       anthropic_usage_cache_read_input_tokens=EXCLUDED.anthropic_usage_cache_read_input_tokens,
       anthropic_usage_estimated_cost_usd=EXCLUDED.anthropic_usage_estimated_cost_usd,
       anthropic_reported_cost_usd=EXCLUDED.anthropic_reported_cost_usd,
       difference_usd=EXCLUDED.difference_usd,
       difference_percent=EXCLUDED.difference_percent,
       token_usage_matches=EXCLUDED.token_usage_matches,
       local_tracking_complete=EXCLUDED.local_tracking_complete,
       cost_scope=EXCLUDED.cost_scope,
       raw_usage_report=EXCLUDED.raw_usage_report,
       raw_cost_report=EXCLUDED.raw_cost_report,
       fetched_at=NOW(), updated_at=NOW()`,
    [
      dateString, startIso, endIso,
      localCallCount, toNumber(local.input_tokens), toNumber(local.output_tokens),
      toNumber(local.cache_creation_tokens), toNumber(local.cache_read_tokens), localEstimated,
      apiKeyId, workspaceId,
      usageTotals.inputTokens, usageTotals.outputTokens,
      usageTotals.cacheCreationInputTokens, usageTotals.cacheReadInputTokens,
      usageTotals.hasUnsupportedModel ? null : usageTotals.estimatedCostUsd,
      actualCost, differenceUsd, differencePercent, tokenUsageMatches,
      localTrackingComplete, costScope,
      JSON.stringify(usageReport.rawPages), JSON.stringify(costReport.rawPages),
    ]
  );

  return {
    reportDate: dateString,
    localCallCount,
    localEstimatedCostUsd: localEstimated,
    anthropicUsageEstimatedCostUsd: usageTotals.hasUnsupportedModel ? null : usageTotals.estimatedCostUsd,
    anthropicReportedCostUsd: actualCost,
    differenceUsd,
    differencePercent,
    tokenUsageMatches,
    localTrackingComplete,
    appApiKeyMatched: Boolean(appApiKey),
    costScope,
    isDefaultWorkspace,
  };
}

export { keyMatchesHint };
