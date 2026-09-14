import https from 'https';

const INSTALL_SYMBOL = Symbol.for('theAgora.anthropicCostOptimizerInstalled');
const EPHEMERAL_CACHE_CONTROL = Object.freeze({ type: 'ephemeral' });

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

function normalizedScoreTimingText(value) {
  if (typeof value !== 'string' || !value) return value;

  // After the second visible response, the exact numeric round count does not
  // change the scoring contract. Normalizing it lets the otherwise-identical
  // system prefix remain cacheable across later turns while preserving the
  // requirement that every reply from that point onward includes a score.
  return value.replace(
    /The user has now sent\s+\d+\s+visible debate responses\./gi,
    'The user has now sent at least 2 visible debate responses.'
  );
}

function splitSystemForStablePrefixCaching(system) {
  if (typeof system !== 'string' || !system) return system;

  const normalized = normalizedScoreTimingText(system);
  const markerIndex = normalized.search(/\n\nSCORE TIMING:/i);

  if (markerIndex <= 0) {
    return normalized;
  }

  const stablePrefix = normalized.slice(0, markerIndex);
  const dynamicSuffix = normalized.slice(markerIndex);

  if (!stablePrefix.trim() || !dynamicSuffix.trim()) {
    return normalized;
  }

  return [
    {
      type: 'text',
      text: stablePrefix,
      cache_control: { ...EPHEMERAL_CACHE_CONTROL },
    },
    {
      type: 'text',
      text: dynamicSuffix,
    },
  ];
}

function classifyConversationRequest(payload, stack = '') {
  const source = String(stack || '');

  if (source.includes('rankedDebateEngine')) {
    return 'ranked';
  }

  if (source.includes('aiJobs.js')) {
    const temperature = Number(payload?.temperature);
    const maxTokens = Number(payload?.max_tokens);

    // Standard/Daily conversational jobs currently use temperature 0.7 and
    // <= 900 output tokens. Reports/insights use temperature 0.25, so they are
    // intentionally excluded because one-off caching would only add cache-write
    // cost without a likely read.
    if (temperature === 0.7 && Number.isFinite(maxTokens) && maxTokens <= 900) {
      return 'ai_job_conversation';
    }

    return null;
  }

  if (source.includes('server.js')) {
    const model = String(payload?.model || '').toLowerCase();
    if (model.includes('sonnet')) {
      return 'legacy_debate';
    }
  }

  return null;
}

export function optimizeAnthropicPayloadForStack(payload, stack = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const kind = classifyConversationRequest(payload, stack);
  if (!kind) return payload;

  const optimized = { ...payload };

  if (typeof optimized.system === 'string') {
    optimized.system = splitSystemForStablePrefixCaching(optimized.system);
  }

  // Automatic caching puts a breakpoint on the last cacheable block. Once a
  // conversation's scoring phase is stable, Anthropic can reuse the growing
  // system + transcript prefix and process only the newly appended turns.
  optimized.cache_control = { ...EPHEMERAL_CACHE_CONTROL };

  return optimized;
}

function transformSerializedBody(rawBody, stack) {
  const source = Buffer.isBuffer(rawBody)
    ? rawBody.toString('utf8')
    : typeof rawBody === 'string'
      ? rawBody
      : null;

  if (source == null) return rawBody;

  try {
    const parsed = JSON.parse(source);
    const optimized = optimizeAnthropicPayloadForStack(parsed, stack);

    if (optimized === parsed) return rawBody;

    return JSON.stringify(optimized);
  } catch {
    // Cost optimization must never make a valid Anthropic request fail.
    return rawBody;
  }
}

function installFetchOptimization() {
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (...args) => {
    if (!isAnthropicMessagesTarget(args[0])) {
      return originalFetch(...args);
    }

    const stack = new Error().stack || '';
    const init = args[1] || {};

    if (typeof init.body === 'string' || Buffer.isBuffer(init.body)) {
      const optimizedBody = transformSerializedBody(init.body, stack);

      if (optimizedBody !== init.body) {
        args[1] = {
          ...init,
          body: optimizedBody,
        };
      }
    }

    return originalFetch(...args);
  };
}

function installHttpsOptimization() {
  const originalRequest = https.request;

  https.request = function optimizedHttpsRequest(...args) {
    const options = args[0];

    if (!isAnthropicMessagesTarget(options)) {
      return originalRequest.apply(this, args);
    }

    const stack = new Error().stack || '';
    const request = originalRequest.apply(this, args);
    const originalWrite = request.write.bind(request);
    const originalEnd = request.end.bind(request);
    let transformed = false;

    function transformChunk(chunk) {
      if (transformed || chunk == null) return chunk;
      transformed = true;

      const optimized = transformSerializedBody(chunk, stack);
      if (optimized === chunk) return chunk;

      try {
        request.setHeader('Content-Length', Buffer.byteLength(optimized));
      } catch {
        // If headers have already been sent, leave the original body untouched.
        return chunk;
      }

      return optimized;
    }

    request.write = function optimizedWrite(chunk, ...rest) {
      return originalWrite(transformChunk(chunk), ...rest);
    };

    request.end = function optimizedEnd(chunk, ...rest) {
      if (chunk == null) {
        return originalEnd(chunk, ...rest);
      }

      return originalEnd(transformChunk(chunk), ...rest);
    };

    return request;
  };
}

export function installAnthropicCostOptimization() {
  if (globalThis[INSTALL_SYMBOL]) return;
  globalThis[INSTALL_SYMBOL] = true;

  installFetchOptimization();
  installHttpsOptimization();

  console.log('[AnthropicCostOptimizer] Prompt caching optimizer installed.');
}

export const anthropicCostOptimizerInternals = Object.freeze({
  classifyConversationRequest,
  normalizedScoreTimingText,
  splitSystemForStablePrefixCaching,
});
