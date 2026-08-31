const DEFAULT_API_BASE = 'https://api.frankfurter.dev/v2';
const DEFAULT_TIMEOUT_MS = 6_000;
const REPORTING_CURRENCY = 'USD';

function cleanCurrency(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function normalizeMonthKey(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  return `${match[1]}-${match[2]}`;
}

function monthBounds(monthKey) {
  const normalized = normalizeMonthKey(monthKey);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    month: normalized,
    from: `${normalized}-01`,
    to: `${normalized}-${String(lastDay).padStart(2, '0')}`,
  };
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function average(values) {
  const valid = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

async function fetchJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'TheAgoraSubscriptionDashboard/1.0',
      },
      signal: controller.signal,
    });

    if (!response?.ok) {
      const error = new Error(`FX provider returned HTTP ${response?.status || 'unknown'}.`);
      error.statusCode = response?.status || null;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function monthlyRateUrl(apiBase, currency, bounds) {
  const url = new URL(`${apiBase}/rates`);
  url.searchParams.set('base', currency);
  url.searchParams.set('quotes', REPORTING_CURRENCY);
  url.searchParams.set('from', bounds.from);
  url.searchParams.set('to', bounds.to);
  url.searchParams.set('group', 'month');
  return url.toString();
}

function latestRateUrl(apiBase, currency) {
  return `${apiBase}/rate/${encodeURIComponent(currency)}/${REPORTING_CURRENCY}`;
}

function rateFromMonthlyPayload(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rates)
      ? payload.rates
      : [];

  return average(
    rows
      .filter((row) => String(row?.quote || REPORTING_CURRENCY).toUpperCase() === REPORTING_CURRENCY)
      .map((row) => row?.rate)
  );
}

function rateFromSinglePayload(payload) {
  const rate = Number(payload?.rate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function createSubscriptionUsdConverter({
  fetchImpl = globalThis.fetch,
  apiBase = process.env.SUBSCRIPTION_FX_API_BASE || DEFAULT_API_BASE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for currency conversion.');
  }

  const normalizedApiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const rateCache = new Map();

  async function loadRate(currency, monthKey) {
    const code = cleanCurrency(currency);
    const bounds = monthBounds(monthKey);

    if (!code) {
      throw new Error(`Invalid transaction currency: ${currency}`);
    }

    if (code === REPORTING_CURRENCY) {
      return {
        rate: 1,
        source: 'native_usd',
        month: bounds?.month || normalizeMonthKey(monthKey),
      };
    }

    if (!bounds) {
      throw new Error(`Invalid FX month: ${monthKey}`);
    }

    const cacheKey = `${code}:${bounds.month}`;
    if (rateCache.has(cacheKey)) {
      return rateCache.get(cacheKey);
    }

    const promise = (async () => {
      try {
        const payload = await fetchJson(
          fetchImpl,
          monthlyRateUrl(normalizedApiBase, code, bounds),
          timeoutMs
        );
        const rate = rateFromMonthlyPayload(payload);
        if (rate) {
          return {
            rate,
            source: 'frankfurter_monthly',
            month: bounds.month,
          };
        }
        throw new Error('FX provider returned no monthly USD rate.');
      } catch (monthlyError) {
        try {
          const payload = await fetchJson(
            fetchImpl,
            latestRateUrl(normalizedApiBase, code),
            timeoutMs
          );
          const rate = rateFromSinglePayload(payload);
          if (!rate) {
            throw new Error('FX provider returned no latest USD rate.');
          }

          logger.warn?.(
            '[SubscriptionFX] Using latest USD rate as fallback.',
            {
              currency: code,
              month: bounds.month,
              error: monthlyError?.message || String(monthlyError),
            }
          );

          return {
            rate,
            source: 'frankfurter_latest_fallback',
            month: bounds.month,
          };
        } catch (latestError) {
          const error = new Error(
            `Unable to convert ${code} revenue to USD for ${bounds.month}.`
          );
          error.cause = latestError;
          throw error;
        }
      }
    })();

    rateCache.set(cacheKey, promise);

    try {
      return await promise;
    } catch (error) {
      rateCache.delete(cacheKey);
      throw error;
    }
  }

  async function convertBag(bag, monthKey) {
    const entries = Object.entries(bag || {})
      .map(([currency, amount]) => [cleanCurrency(currency), Number(amount)])
      .filter(([currency, amount]) => currency && Number.isFinite(amount));

    if (!entries.length) {
      return {
        bag: {},
        convertedCurrencies: [],
        fallbackCurrencies: [],
      };
    }

    let usdTotal = 0;
    const convertedCurrencies = new Set();
    const fallbackCurrencies = new Set();

    for (const [currency, amount] of entries) {
      if (currency === REPORTING_CURRENCY) {
        usdTotal += amount;
        continue;
      }

      const conversion = await loadRate(currency, monthKey);
      usdTotal += amount * conversion.rate;
      convertedCurrencies.add(currency);

      if (conversion.source === 'frankfurter_latest_fallback') {
        fallbackCurrencies.add(currency);
      }
    }

    return {
      bag: { USD: roundMoney(usdTotal) },
      convertedCurrencies: [...convertedCurrencies].sort(),
      fallbackCurrencies: [...fallbackCurrencies].sort(),
    };
  }

  return Object.freeze({
    reportingCurrency: REPORTING_CURRENCY,
    convertBag,
    loadRate,
  });
}

export default createSubscriptionUsdConverter;
