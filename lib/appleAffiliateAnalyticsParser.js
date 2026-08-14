import zlib from 'zlib';

const STATE_METRIC_MAP = new Map([
  ['free trials', 'free_trials'],
  ['paid offers', 'paid_offers'],
  ['full price', 'full_price'],
  ['preserved price', 'preserved_price'],
  ['contingent price', 'contingent_price'],
  ['grace period', 'grace_period'],
  ['billing retry', 'billing_retry'],
  ['suspended', 'suspended'],
  ['voluntarily churned', 'voluntary_churn'],
  ['involuntarily churned', 'involuntary_churn'],
]);

const EVENT_METRIC_MAP = new Map([
  ['paid offer starts', 'paid_offer_start'],
  ['paid offer renewals', 'paid_offer_renewals'],
  ['full price from paid offer', 'full_price_from_paid_offer'],
  ['contingent price from paid offer', 'contingent_price_from_paid_offer'],
  ['full price subscription starts', 'full_price_subscription_starts'],
  ['contingent price subscription starts', 'contingent_price_subscription_starts'],
  ['full price renewals', 'full_price_renewals'],
  ['preserved price renewals', 'preserved_price_renewals'],
  ['contingent price renewals', 'contingent_price_renewals'],
  ['contingent price renewal from full price', 'contingent_price_renewal_from_full_price'],
  ['contingent price renewal from preserved price', 'contingent_price_renewal_from_preserved_price'],
  ['full price renewal from contingent price', 'full_price_renewal_from_contingent_price'],
  ['preserved price renewal from contingent price', 'preserved_price_renewal_from_contingent_price'],
  ['preserved price renewal from full price', 'preserved_price_renewal_from_full_price'],
  ['full price renewal from preserved price', 'full_price_renewal_from_preserved_price'],
  ['full price commitment-based payments', 'full_price_commitment_based_payments'],
  ['preserved price commitment-based payments', 'preserved_price_commitment_based_payments'],
  ['contingent price commitment-based payments', 'contingent_price_commitment_based_payments'],
  ['full price recoveries from grace period', 'full_price_recoveries_from_grace_period'],
  ['preserved price recoveries from grace period', 'preserved_price_recoveries_from_grace_period'],
  ['contingent price recoveries from grace period', 'contingent_price_recoveries_from_grace_period'],
  ['paid offer recoveries from grace period', 'paid_offer_recoveries_from_grace_period'],
  ['full price recoveries from billing retry', 'full_price_recoveries_from_billing_retry'],
  ['preserved price recoveries from billing retry', 'preserved_price_recoveries_from_billing_retry'],
  ['contingent price recoveries from billing retry', 'contingent_price_recoveries_from_billing_retry'],
  ['paid offer recoveries from billing retry', 'paid_offer_recoveries_from_billing_retry'],
  ['involuntary churn from paid offers', 'involuntary_churns_from_paid_offers'],
  ['voluntary churn from paid offers', 'voluntary_churns_from_paid_offers'],
  ['involuntary churn from full price', 'involuntary_churn_from_full_price'],
  ['involuntary churn from preserved price', 'involuntary_churn_from_preserved_price'],
  ['voluntary churn from full price', 'voluntary_churn_from_full_price'],
  ['voluntary churn from preserved price', 'voluntary_churn_from_preserved_price'],
  ['refunds from paid offers', 'refunds_from_paid_offers'],
  ['refunds from full price', 'refunds_from_full_price'],
  ['refunds from preserved price', 'refunds_from_preserved_price'],
  ['refunds from contingent price', 'refunds_from_contingent_price'],
  ['plan changes', 'plan_changes'],
  ['offer to offer', 'offer_to_offer'],
  ['offers from paid', 'offers_from_paid'],
]);

const ACTIVE_STATE_KEYS = new Set([
  'free_trials',
  'paid_offers',
  'full_price',
  'preserved_price',
  'contingent_price',
]);

const PAID_PLAN_KEYS = new Set([
  'full_price',
  'preserved_price',
  'contingent_price',
]);

const CHURN_KEYS = new Set(['voluntary_churn', 'involuntary_churn']);

function normalizeWhitespace(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedLookup(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeCode(value) {
  return normalizeWhitespace(value).toUpperCase();
}

function parseCount(value) {
  const cleaned = normalizeWhitespace(value).replace(/,/g, '');
  // Apple's Subscription State/Event `Counts` fields are nonnegative integer
  // aggregates. Reject anything else instead of allowing malformed report
  // data to enter payout calculations.
  if (!/^\d+$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isSafeInteger(number) ? number : null;
}

// RFC4180-style quote handling adapted for Apple's tab-delimited analytics
// files. This correctly handles quoted tabs, embedded newlines and doubled
// quotes instead of splitting raw lines on "\t".
export function parseAppleTsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (!source) return [];

  const matrix = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === '\t' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.length > 0)) matrix.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  if (inQuotes) {
    throw new Error('Malformed Apple TSV: unterminated quoted field.');
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) matrix.push(row);
  }

  if (!matrix.length) return [];
  const headers = matrix[0];

  return matrix.slice(1).map((cells) => headers.reduce((record, header, index) => {
    record[header] = cells[index] ?? '';
    return record;
  }, {}));
}

export function decodeAppleAnalyticsBuffer(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  try {
    return zlib.gunzipSync(raw).toString('utf8');
  } catch {
    return raw.toString('utf8');
  }
}

function firstField(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) {
      const value = normalizeWhitespace(row[name]);
      if (value) return value;
    }
  }
  return '';
}

function inferSubscriptionPricing(metricLabel) {
  const value = normalizedLookup(metricLabel);
  if (value.includes('preserved price')) return 'Preserved Price';
  if (value.includes('contingent price')) return 'Contingent Price';
  if (value.includes('full price')) return 'Full Price';
  return '';
}

function makeDimensions(row) {
  const dimensions = {};
  for (const [key, raw] of Object.entries(row)) {
    if (key === 'Counts') continue;
    const value = normalizeWhitespace(raw);
    if (value) dimensions[key] = value;
  }
  return dimensions;
}

function baseNormalizedRow({
  row,
  customCode,
  metricKey,
  metricValue,
  reportKind,
  date,
  environment,
  metricLabel,
}) {
  return {
    customCode,
    normalizedCode: normalizeCode(customCode),
    reportKind,
    metricKey,
    metricValue,
    periodStart: date,
    periodEnd: date,
    granularity: 'daily',
    subscriptionName: firstField(row, ['Subscription Name']),
    subscriptionAdamId: firstField(row, ['Subscription Identifier', 'Subscription Adam ID']),
    subscriptionDuration: firstField(row, ['Subscription Duration']),
    subscriptionPricing: inferSubscriptionPricing(metricLabel),
    offerType: firstField(row, ['Offer Type']),
    offerPricing: firstField(row, ['Offer Pricing']),
    offerDuration: firstField(row, ['Offer Duration']),
    environment,
    rawDimensions: makeDimensions(row),
  };
}

export function normalizeAppleSubscriptionStateRows(
  input,
  { environment = 'production' } = {}
) {
  const rows = typeof input === 'string' ? parseAppleTsv(input) : input;
  if (!Array.isArray(rows)) throw new Error('State report input must be TSV text or parsed rows.');

  const result = [];
  for (const row of rows) {
    const customCode = firstField(row, ['Vanity Code', 'Custom Code']);
    if (!customCode) continue;

    const metricLabel = firstField(row, ['State Metric']);
    const metricKey = STATE_METRIC_MAP.get(normalizedLookup(metricLabel));
    if (!metricKey) continue;

    const metricValue = parseCount(row.Counts);
    const date = firstField(row, ['Date']);
    if (metricValue == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const primary = baseNormalizedRow({
      row,
      customCode,
      metricKey,
      metricValue,
      reportKind: 'state',
      date,
      environment,
      metricLabel,
    });
    result.push(primary);

    if (ACTIVE_STATE_KEYS.has(metricKey)) {
      result.push({ ...primary, metricKey: 'active_plans' });
      result.push({ ...primary, metricKey: 'active_access' });
    }
    if (metricKey === 'grace_period') {
      // Apple lists grace-period subscriptions separately from Active Plans,
      // but they still have entitlement access while in grace.
      result.push({ ...primary, metricKey: 'active_access' });
    }
    if (PAID_PLAN_KEYS.has(metricKey)) {
      result.push({ ...primary, metricKey: 'paid_plans' });
    }
    if (CHURN_KEYS.has(metricKey)) {
      result.push({ ...primary, metricKey: 'churned' });
    }

    const cancellationReason = normalizedLookup(firstField(row, ['Cancellation Reason']));
    if ((ACTIVE_STATE_KEYS.has(metricKey) || metricKey === 'grace_period') && cancellationReason === 'turned off auto-renew') {
      result.push({ ...primary, metricKey: 'canceling_active' });
    }
  }
  return result;
}

export function normalizeAppleSubscriptionEventRows(
  input,
  { environment = 'production' } = {}
) {
  const rows = typeof input === 'string' ? parseAppleTsv(input) : input;
  if (!Array.isArray(rows)) throw new Error('Event report input must be TSV text or parsed rows.');

  const result = [];
  for (const row of rows) {
    const customCode = firstField(row, ['Vanity Code', 'Custom Code']);
    if (!customCode) continue;

    const metricLabel = firstField(row, ['Event Sub Type']);
    const metricKey = EVENT_METRIC_MAP.get(normalizedLookup(metricLabel));
    if (!metricKey) continue;

    const metricValue = parseCount(row.Counts);
    const date = firstField(row, ['Event Date', 'Date']);
    if (metricValue == null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const primary = baseNormalizedRow({
      row,
      customCode,
      metricKey,
      metricValue,
      reportKind: 'event',
      date,
      environment,
      metricLabel,
    });
    result.push(primary);

    if (['full_price_from_paid_offer', 'contingent_price_from_paid_offer'].includes(metricKey)) {
      result.push({ ...primary, metricKey: 'paid_subscriptions_from_offers_all' });
    }

    if (
      metricKey.endsWith('_renewals')
      || metricKey.includes('_renewal_from_')
      || metricKey.endsWith('_commitment_based_payments')
    ) {
      if (!metricKey.startsWith('paid_offer_')) {
        result.push({ ...primary, metricKey: 'renewals_all' });
      }
    }

    if (metricKey.includes('_recoveries_from_grace_period') || metricKey.includes('_recoveries_from_billing_retry')) {
      result.push({ ...primary, metricKey: 'recoveries_from_billing_issue_all' });
    }
  }
  return result;
}

export function knownAppleAffiliateEventMetricKeys() {
  return new Set(EVENT_METRIC_MAP.values());
}

export function knownAppleAffiliateStateMetricKeys() {
  return new Set(STATE_METRIC_MAP.values());
}
