import https from 'https';
import pg from 'pg';

const { Pool } = pg;
const INSTALL_SYMBOL = Symbol.for('theAgora.anthropicUsageTrackingInstalled');
const PRICING_VERSION = 'anthropic-public-2026-09-14';
const MILLION = 1_000_000;

const MODEL_PRICING = Object.freeze([
  { match: 'claude-haiku-4-5', input: 1, cache5m: 1.25, cache1h: 2, cacheRead: 0.10, output: 5 },
  { match: 'claude-sonnet-4-5', input: 3, cache5m: 3.75, cache1h: 6, cacheRead: 0.30, output: 15 },
  { match: 'claude-sonnet-4-6', input: 3, cache5m: 3.75, cache1h: 6, cacheRead: 0.30, output: 15 },
  { match: 'claude-sonnet-5', input: 2, cache5m: 2.50, cache1h: 4, cacheRead: 0.20, output: 10 },
  { match: 'claude-opus-4-5', input: 5, cache5m: 6.25, cache1h: 10, cacheRead: 0.50, output: 25 },
  { match: 'claude-opus-4-6', input: 5, cache5m: 6.25, cache1h: 10, cacheRead: 0.50, output: 25 },
  { match: 'claude-opus-4-7', input: 5, cache5m: 6.25, cache1h: 10, cacheRead: 0.50, output: 25 },
  { match: 'claude-opus-4-8', input: 5, cache5m: 6.25, cache1h: 10, cacheRead: 0.50, output: 25 },
  { match: 'claude-opus-5', input: 2.5, cache5m: 3.125, cache1h: 5, cacheRead: 0.25, output: 12.5 },
]);

let usagePool = null;

function safeInteger(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function normalizeAnthropicUsage(usage = {}) {
  const nested = usage?.cache_creation || {};
  const cache5m = safeInteger(nested.ephemeral_5m_input_tokens);
  const cache1h = safeInteger(nested.ephemeral_1h_input_tokens);
  const aggregateCacheCreation = safeInteger(usage?.cache_creation_input_tokens);
  const nestedTotal = cache5m + cache1h;

  return {
    inputTokens: safeInteger(usage?.input_tokens ?? usage?.uncached_input_tokens),
    outputTokens: safeInteger(usage?.output_tokens),
    cacheCreationInputTokens: aggregateCacheCreation || nestedTotal,
    cacheCreation5mInputTokens: nestedTotal > 0 ? cache5m : aggregateCacheCreation,
    cacheCreation1hInputTokens: cache1h,
    cacheReadInputTokens: safeInteger(usage?.cache_read_input_tokens),
    cacheCreationPricingAssumption:
      nestedTotal > 0 || aggregateCacheCreation === 0 ? null : 'aggregate_cache_creation_priced_as_5m',
  };
}

export function pricingForAnthropicModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  const row = MODEL_PRICING.find((candidate) => normalized.includes(candidate.match));
  if (!row) return null;
  return { ...row, pricingVersion: PRICING_VERSION };
}

export function calculateAnthropicEstimatedCost(model, rawUsage = {}) {
  const pricing = pricingForAnthropicModel(model);
  const usage = normalizeAnthropicUsage(rawUsage);
  if (!pricing) {
    return { estimatedCostUsd: null, pricing: null, usage };
  }

  const estimatedCostUsd =
    (usage.inputTokens * pricing.input +
      usage.outputTokens * pricing.output +
      usage.cacheCreation5mInputTokens * pricing.cache5m +
      usage.cacheCreation1hInputTokens * pricing.cache1h +
      usage.cacheReadInputTokens * pricing.cacheRead) / MILLION;

  return { estimatedCostUsd, pricing, usage };
}

function inferFeature(stack = '') {
  if (stack.includes('dailyChallengeLocalizationService.js')) return 'daily_challenge_localization';
  if (stack.includes('rankedTopicGeneratorService.js')) return 'ranked_topic_generation';
  if (stack.includes('rankedDebateEngineService.js')) return 'ranked_debate';
  if (stack.includes('questions.js')) return 'question_generation';
  if (stack.includes('dailyChallenge.js')) return 'daily_challenge_generation';
  if (stack.includes('aiJobs.js')) return 'ai_job';
  if (stack.includes('summarizeMessages') || stack.includes('manageHistory')) return 'debate_history_summary';
  if (stack.includes('server.js')) return 'debate_turn_legacy';
  return 'unknown';
}

function getUsagePool() {
  if (usagePool) return usagePool;
  if (!process.env.DATABASE_URL) return null;
  usagePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway.internal')
      ? false
      : { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  usagePool.on('error', (error) => {
    console.error('[AnthropicUsage] Postgres pool error:', error?.message || error);
  });
  return usagePool;
}

function isAnthropicMessagesTarget(input) {
  try {
    let url;
    if (typeof input === 'string' || input instanceof URL) {
      url = new URL(input.toString());
    } else if (input?.url) {
      url = new URL(input.url);
    } else if (input && typeof input === 'object') {
      const host = input.hostname || input.host;
      const path = input.path || input.pathname || '';
      if (!host) return false;
      url = new URL(`https://${host}${path}`);
    }
    return url?.hostname === 'api.anthropic.com' && url?.pathname === '/v1/messages';
  } catch {
    return false;
  }
}

function requestedModelFromFetch(args) {
  try {
    const init = args[1] || {};
    if (typeof init.body !== 'string') return null;
    return JSON.parse(init.body)?.model || null;
  } catch {
    return null;
  }
}

function fireAndForgetLog({ parsed, statusCode, headers, transport, stack, requestedModel }) {
  try {
    const rawUsage = parsed?.usage;
    if (!rawUsage || typeof rawUsage !== 'object') return;

    const model = String(parsed?.model || requestedModel || '').trim();
    if (!model) return;

    const { estimatedCostUsd, pricing, usage } = calculateAnthropicEstimatedCost(model, rawUsage);
    const requestId =
      headers?.get?.('request-id') ||
      headers?.get?.('x-request-id') ||
      headers?.['request-id'] ||
      headers?.['x-request-id'] ||
      null;
    const workspaceId = headers?.get?.('anthropic-workspace-id') || headers?.['anthropic-workspace-id'] || null;
    const pool = getUsagePool();
    if (!pool) return;

    const metadata = {
      railwayService: process.env.RAILWAY_SERVICE_NAME || null,
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || null,
      workspaceId,
      requestedModel: requestedModel || null,
      cacheCreationPricingAssumption: usage.cacheCreationPricingAssumption,
    };

    void pool.query(
      `
      INSERT INTO api_usage_logs (
        model, feature, endpoint, transport, status_code, success,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
        cache_read_input_tokens, estimated_cost_usd, pricing_version,
        input_usd_per_mtok, output_usd_per_mtok,
        cache_write_5m_usd_per_mtok, cache_write_1h_usd_per_mtok,
        cache_read_usd_per_mtok, anthropic_request_id, raw_usage, metadata
      ) VALUES (
        $1,$2,'/v1/messages',$3,$4,true,
        $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb
      )
      ON CONFLICT (anthropic_request_id) WHERE anthropic_request_id IS NOT NULL DO NOTHING
      `,
      [
        model,
        inferFeature(stack),
        transport,
        Number(statusCode || 200),
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationInputTokens,
        usage.cacheCreation5mInputTokens,
        usage.cacheCreation1hInputTokens,
        usage.cacheReadInputTokens,
        estimatedCostUsd,
        pricing?.pricingVersion || null,
        pricing?.input ?? null,
        pricing?.output ?? null,
        pricing?.cache5m ?? null,
        pricing?.cache1h ?? null,
        pricing?.cacheRead ?? null,
        requestId,
        JSON.stringify(rawUsage),
        JSON.stringify(metadata),
      ]
    ).catch((error) => {
      console.error('[AnthropicUsage] Failed to persist usage:', error?.message || error);
    });
  } catch (error) {
    console.error('[AnthropicUsage] Failed to prepare usage log:', error?.message || error);
  }
}

function installFetchTracking() {
  if (typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (...args) => {
    const shouldTrack = isAnthropicMessagesTarget(args[0]);
    const stack = shouldTrack ? new Error().stack || '' : '';
    const requestedModel = shouldTrack ? requestedModelFromFetch(args) : null;
    const response = await originalFetch(...args);

    if (shouldTrack) {
      try {
        const clone = response.clone();
        void clone.json().then((parsed) => {
          fireAndForgetLog({
            parsed,
            statusCode: response.status,
            headers: response.headers,
            transport: 'fetch',
            stack,
            requestedModel,
          });
        }).catch(() => {});
      } catch {
        // Tracking must never affect the Anthropic response.
      }
    }

    return response;
  };
}

function installHttpsTracking() {
  const originalRequest = https.request;

  https.request = function patchedHttpsRequest(...args) {
    const options = args[0];
    if (!isAnthropicMessagesTarget(options)) {
      return originalRequest.apply(this, args);
    }

    const callbackIndex = args.findIndex((arg, index) => index > 0 && typeof arg === 'function');
    if (callbackIndex < 0) {
      return originalRequest.apply(this, args);
    }

    const originalCallback = args[callbackIndex];
    const stack = new Error().stack || '';

    args[callbackIndex] = (res) => {
      const chunks = [];
      const originalEmit = res.emit;

      res.emit = function trackedEmit(eventName, ...eventArgs) {
        if (eventName === 'data' && eventArgs[0] != null) {
          const chunk = eventArgs[0];
          chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
        }

        const result = originalEmit.call(this, eventName, ...eventArgs);

        if (eventName === 'end') {
          queueMicrotask(() => {
            try {
              const parsed = JSON.parse(chunks.join(''));
              fireAndForgetLog({
                parsed,
                statusCode: res.statusCode,
                headers: res.headers,
                transport: 'https',
                stack,
                requestedModel: null,
              });
            } catch {
              // Failed or non-JSON responses have no billable usage object to persist.
            }
          });
        }

        return result;
      };

      return originalCallback(res);
    };

    return originalRequest.apply(this, args);
  };
}

export function installAnthropicUsageTracking() {
  if (globalThis[INSTALL_SYMBOL]) return;
  globalThis[INSTALL_SYMBOL] = true;
  installFetchTracking();
  installHttpsTracking();
  console.log('[AnthropicUsage] Claude usage tracking installed.');
}
