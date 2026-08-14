import crypto from 'crypto';
import { DateTime } from 'luxon';

export const AFFILIATE_ACCOUNTING_TIMEZONE = 'America/Chicago';

export const APPLE_METRIC_KEYS = Object.freeze(new Set([
  'redemptions',
  'paid_offer_start',
  'active_plans',
  'active_access',
  'paid_offers',
  'paid_plans',
  'full_price',
  'preserved_price',
  'billing_retry',
  'churned',
  'voluntary_churn',
  'involuntary_churn',
  'paid_subscriptions_from_offers_all',
  'paid_offer_renewals',
  'full_price_from_paid_offer',
  'contingent_price_from_paid_offer',
  'full_price_subscription_starts',
  'contingent_price_subscription_starts',
  'full_price_renewals',
  'preserved_price_renewals',
  'contingent_price_renewals',
  'contingent_price_renewal_from_full_price',
  'contingent_price_renewal_from_preserved_price',
  'full_price_renewal_from_contingent_price',
  'preserved_price_renewal_from_contingent_price',
  'preserved_price_renewal_from_full_price',
  'full_price_renewal_from_preserved_price',
  'full_price_commitment_based_payments',
  'preserved_price_commitment_based_payments',
  'contingent_price_commitment_based_payments',
  'renewals_all',
  'full_price_recoveries_from_grace_period',
  'preserved_price_recoveries_from_grace_period',
  'contingent_price_recoveries_from_grace_period',
  'paid_offer_recoveries_from_grace_period',
  'full_price_recoveries_from_billing_retry',
  'preserved_price_recoveries_from_billing_retry',
  'contingent_price_recoveries_from_billing_retry',
  'paid_offer_recoveries_from_billing_retry',
  'recoveries_from_billing_issue_all',
  'refunds_from_paid_offers',
  'refunds_from_full_price',
  'refunds_from_preserved_price',
  'refunds_from_contingent_price',
  'voluntary_churns_from_paid_offers',
  'involuntary_churns_from_paid_offers',
  'voluntary_churn_from_full_price',
  'voluntary_churn_from_preserved_price',
  'involuntary_churn_from_full_price',
  'involuntary_churn_from_preserved_price',
  'plan_changes',
  'offer_to_offer',
  'offers_from_paid',
  'free_trials',
  'grace_period',
  'contingent_price',
  'suspended',
  'canceling_active',
]));

const CODE_RE = /^[A-Z0-9]{2,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_BASE_PRICE_PAYMENT_METRICS = Object.freeze(new Map([
  ['full_price_renewals', 'Full Price'],
  ['preserved_price_renewals', 'Preserved Price'],
  ['full_price_renewal_from_contingent_price', 'Full Price'],
  ['preserved_price_renewal_from_contingent_price', 'Preserved Price'],
  ['preserved_price_renewal_from_full_price', 'Preserved Price'],
  ['full_price_renewal_from_preserved_price', 'Full Price'],
  ['full_price_recoveries_from_grace_period', 'Full Price'],
  ['preserved_price_recoveries_from_grace_period', 'Preserved Price'],
  ['full_price_recoveries_from_billing_retry', 'Full Price'],
  ['preserved_price_recoveries_from_billing_retry', 'Preserved Price'],
  ['full_price_commitment_based_payments', 'Full Price'],
  ['preserved_price_commitment_based_payments', 'Preserved Price'],
]));

// These Apple aggregate events can affect money, but cannot be priced safely
// from the Standard custom-code report alone in every case. They block payout
// finalization until resolved rather than being silently omitted or guessed.
const REVIEW_REQUIRED_PAYMENT_METRICS = Object.freeze(new Set([
  'full_price_from_paid_offer',
  'contingent_price_from_paid_offer',
  'full_price_subscription_starts',
  'contingent_price_subscription_starts',
  'contingent_price_renewals',
  'contingent_price_renewal_from_full_price',
  'contingent_price_renewal_from_preserved_price',
  'contingent_price_recoveries_from_grace_period',
  'contingent_price_recoveries_from_billing_retry',
  'refunds_from_full_price',
  'refunds_from_preserved_price',
  'refunds_from_contingent_price',
  'plan_changes',
]));

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,160}$/;

function cleanBoolean(value, fieldName, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  if (value === true || value === false) return value;
  throw statusError(400, `${fieldName} must be a JSON boolean.`, 'invalid_boolean');
}


export function classifyAppleMetricForBasePrice(metricKey) {
  const key = String(metricKey || '').trim().toLowerCase();
  if (SAFE_BASE_PRICE_PAYMENT_METRICS.has(key)) {
    return {
      action: 'commissionable',
      subscriptionPricing: SAFE_BASE_PRICE_PAYMENT_METRICS.get(key),
    };
  }
  if (REVIEW_REQUIRED_PAYMENT_METRICS.has(key)) {
    return { action: 'needs_review', subscriptionPricing: null, blocking: true };
  }
  if (key === 'refunds_from_paid_offers' || key === 'paid_offer_start' || key === 'paid_offer_renewals') {
    return { action: 'noncommissionable_promo', subscriptionPricing: null };
  }
  return { action: 'ignore', subscriptionPricing: null };
}

function cleanPayoutPeriod(value) {
  const clean = cleanDate(value, 'payoutPeriod');
  if (!/^\d{4}-\d{2}-01$/.test(clean)) {
    throw statusError(400, 'payoutPeriod must be the first day of a month.', 'invalid_payout_period');
  }
  return clean;
}

function moneyFromExactParts(commissionExact, adjustmentsExact = '0') {
  const commissionMicros = decimalStringToMicros(commissionExact);
  const adjustmentMicros = decimalStringToMicros(adjustmentsExact);
  const netMicros = commissionMicros + adjustmentMicros;
  const cents = roundMicrosToCents(netMicros);
  return {
    netExact: microsToDecimalString(netMicros, 6),
    amountDue: centsToMoneyString(cents < 0n ? 0n : cents),
    negativeBalanceExact: netMicros < 0n ? microsToDecimalString(netMicros, 6) : '0.000000',
  };
}

function cleanProcessingDate(value, { required = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (required) {
      throw statusError(400, 'Apple Analytics processingDate is required for this import.', 'missing_processing_date');
    }
    return null;
  }
  return cleanDate(value, 'processingDate');
}

function cleanIdempotencyKey(value) {
  const clean = String(value || '').trim();
  if (!IDEMPOTENCY_KEY_RE.test(clean)) {
    throw statusError(400, 'A valid Idempotency-Key is required.', 'invalid_idempotency_key');
  }
  return clean;
}

export function compareProcessingDates(left, right) {
  if (left === right) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  return String(left).localeCompare(String(right));
}

function statusError(statusCode, message, code = 'affiliate_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function normalizeAffiliateCode(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : '';

  if (!CODE_RE.test(normalized)) {
    throw statusError(
      400,
      'Affiliate code must contain only letters and numbers.',
      'invalid_affiliate_code'
    );
  }

  return normalized;
}

export function buildAppleOfferRedemptionUrl({
  appAppleId,
  customCode,
} = {}) {
  const cleanAppAppleId = String(appAppleId || '').trim();

  if (!/^\d{5,20}$/.test(cleanAppAppleId)) {
    throw statusError(
      500,
      'AFFILIATE_APPLE_APP_ID is not configured correctly.',
      'affiliate_apple_app_id_invalid'
    );
  }

  const normalizedCode = normalizeAffiliateCode(customCode);

  return `https://apps.apple.com/redeem?ctx=offercodes&id=${encodeURIComponent(cleanAppAppleId)}&code=${encodeURIComponent(normalizedCode)}`;
}

export function hashPartnerToken(token) {
  if (typeof token !== 'string' || token.length < 32) {
    throw statusError(400, 'Invalid partner dashboard token.', 'invalid_partner_token');
  }

  return crypto
    .createHash('sha256')
    .update(token, 'utf8')
    .digest('hex');
}

export function createPartnerToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function readEncryptionKey(rawValue) {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';

  if (!raw) {
    return null;
  }

  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // Fall through to a configuration error below.
  }

  throw statusError(
    500,
    'AFFILIATE_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64.',
    'affiliate_token_encryption_key_invalid'
  );
}

function encryptPartnerToken(token, rawKey) {
  const key = readEncryptionKey(rawKey);

  if (!key) {
    return {
      ciphertext: null,
      iv: null,
      authTag: null,
    };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptPartnerToken({ ciphertext, iv, authTag }, rawKey) {
  const key = readEncryptionKey(rawKey);
  if (!key) {
    throw statusError(
      503,
      'Affiliate dashboard token encryption is not configured.',
      'affiliate_token_encryption_not_configured'
    );
  }

  if (!ciphertext || !iv || !authTag) {
    throw statusError(
      409,
      'This dashboard token was created without recoverable encrypted storage. Regenerate the dashboard link once.',
      'affiliate_dashboard_token_not_recoverable'
    );
  }

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    // Treat decrypted storage as untrusted until it passes the same token
    // shape/hash validation used by the public partner route.
    hashPartnerToken(plaintext);
    return plaintext;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw statusError(
      500,
      'Unable to decrypt the affiliate dashboard token.',
      'affiliate_dashboard_token_decryption_failed'
    );
  }
}

function cleanText(value, maxLength = 500) {
  if (value == null) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.slice(0, maxLength);
}

function cleanRequiredText(value, field, maxLength = 200) {
  const clean = cleanText(value, maxLength);
  if (!clean) {
    throw statusError(400, `${field} is required.`, `missing_${field}`);
  }
  return clean;
}

function cleanDate(value, field) {
  const date = DateTime.fromISO(String(value || ''), { zone: 'utc' });

  if (!date.isValid || !/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw statusError(400, `${field} must be YYYY-MM-DD.`, `invalid_${field}`);
  }

  return date.toISODate();
}

function cleanCommissionRate(value) {
  const stringValue = String(value ?? '0.5').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(stringValue)) {
    throw statusError(400, 'Invalid commission rate.', 'invalid_commission_rate');
  }

  const numeric = Number(stringValue);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw statusError(400, 'Commission rate must be between 0 and 1.', 'invalid_commission_rate');
  }

  return stringValue;
}

function cleanCommissionBasis(value) {
  const clean = String(value || 'base_price').trim().toLowerCase();
  if (!['base_price', 'net_proceeds'].includes(clean)) {
    throw statusError(400, 'Invalid commission basis.', 'invalid_commission_basis');
  }
  return clean;
}

function cleanCodeStatus(value) {
  const clean = String(value || 'unverified').trim().toLowerCase();
  if (!['active', 'disabled', 'unverified', 'mismatch'].includes(clean)) {
    throw statusError(400, 'Invalid affiliate code status.', 'invalid_affiliate_code_status');
  }
  return clean;
}

function cleanCurrency(value) {
  const clean = String(value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(clean)) {
    throw statusError(400, 'Invalid payout currency.', 'invalid_payout_currency');
  }
  return clean;
}

function parseRange(range, now = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE)) {
  const key = String(range || 'this_month').trim().toLowerCase();
  const currentMonthStart = now.startOf('month');

  switch (key) {
    case 'this_month':
      return {
        key,
        start: currentMonthStart.toISODate(),
        endExclusive: currentMonthStart.plus({ months: 1 }).toISODate(),
        label: 'This Month',
      };
    case 'last_month': {
      const start = currentMonthStart.minus({ months: 1 });
      return {
        key,
        start: start.toISODate(),
        endExclusive: currentMonthStart.toISODate(),
        label: 'Last Month',
      };
    }
    case 'last_3_months': {
      const start = currentMonthStart.minus({ months: 2 });
      return {
        key,
        start: start.toISODate(),
        endExclusive: currentMonthStart.plus({ months: 1 }).toISODate(),
        label: 'Last 3 Months',
      };
    }
    case 'ytd': {
      const start = now.startOf('year');
      return {
        key,
        start: start.toISODate(),
        endExclusive: currentMonthStart.plus({ months: 1 }).toISODate(),
        label: 'Year to Date',
      };
    }
    case 'lifetime':
      return {
        key,
        start: '2000-01-01',
        endExclusive: currentMonthStart.plus({ months: 1 }).toISODate(),
        label: 'Lifetime',
      };
    default:
      throw statusError(400, 'Invalid dashboard range.', 'invalid_dashboard_range');
  }
}

function decimalStringToMicros(value) {
  const raw = String(value ?? '0').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid decimal: ${raw}`);
  }

  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(6, '0'));
  return sign * ((whole * 1_000_000n) + fraction);
}

function microsToDecimalString(micros, decimals = 6) {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .slice(0, decimals);

  return `${negative ? '-' : ''}${whole.toString()}${decimals > 0 ? `.${fraction}` : ''}`;
}

function roundMicrosToCents(micros) {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const cents = (absolute + 5_000n) / 10_000n;
  return negative ? -cents : cents;
}

function centsToMoneyString(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function calculateBasePriceCommission({
  lines,
  commissionRate = '0.5',
} = {}) {
  if (!Array.isArray(lines)) {
    throw new Error('lines must be an array');
  }

  const rateMicros = decimalStringToMicros(commissionRate);
  let eligibleRevenueMicros = 0n;

  const normalizedLines = lines.map((line) => {
    const count = BigInt(line?.count ?? 0);
    if (count < 0n) throw new Error('count must be nonnegative');

    const unitPriceMicros = decimalStringToMicros(line?.unitPrice ?? '0');
    const lineRevenueMicros = unitPriceMicros * count;
    eligibleRevenueMicros += lineRevenueMicros;

    return {
      label: String(line?.label || ''),
      count: Number(count),
      unitPrice: microsToDecimalString(unitPriceMicros, 2),
      revenue: microsToDecimalString(lineRevenueMicros, 2),
    };
  });

  const commissionMicros =
    (eligibleRevenueMicros * rateMicros) / 1_000_000n;
  const finalCommissionCents = roundMicrosToCents(commissionMicros);

  return {
    lines: normalizedLines,
    eligibleRevenue: microsToDecimalString(eligibleRevenueMicros, 2),
    commissionExact: microsToDecimalString(commissionMicros, 6),
    commissionRate: microsToDecimalString(rateMicros, 6),
    finalCommission: centsToMoneyString(finalCommissionCents),
  };
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalizeJson(value[key]);
        return result;
      }, {});
  }

  return value;
}

function hashCanonicalObject(value) {
  const stable = JSON.stringify(canonicalizeJson(value));
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function metricRowKeys(row, source = {}) {
  const logical = {
    normalizedCode: row.normalizedCode,
    reportKind: row.reportKind,
    metricKey: row.metricKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    granularity: row.granularity,
    subscriptionName: row.subscriptionName || '',
    subscriptionAdamId: row.subscriptionAdamId || '',
    subscriptionDuration: row.subscriptionDuration || '',
    subscriptionPricing: row.subscriptionPricing || '',
    offerType: row.offerType || '',
    offerPricing: row.offerPricing || '',
    environment: row.environment,
    rawDimensions: row.rawDimensions || {},
  };

  const sourceSpecific = {
    ...logical,
    sourceReportName: source.reportName || '',
    sourceRequestId: source.requestId || '',
    sourceInstanceId: source.instanceId || '',
    sourceSegmentId: source.segmentId || '',
    sourceProcessingDate: source.processingDate || '',
  };

  return {
    logicalKey: hashCanonicalObject(logical),
    sourceRowKey: hashCanonicalObject(sourceSpecific),
  };
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createAffiliateProgramService({
  pool,
  appAppleId,
  tokenEncryptionKey,
  partnerBaseUrl = 'https://partners.theagora.app',
  referralBaseUrl = 'https://theagora.app',
  allowAnalyticsEstimatePayouts = String(process.env.AFFILIATE_ALLOW_ANALYTICS_ESTIMATE_PAYOUTS || '').trim().toLowerCase() === 'true',
} = {}) {
  if (!pool) {
    throw new Error('Affiliate program service requires a PostgreSQL pool.');
  }

  function buildPartnerUrl(token) {
    return `${String(partnerBaseUrl).replace(/\/$/, '')}/${encodeURIComponent(token)}`;
  }

  function buildReferralUrl(code) {
    return `${String(referralBaseUrl).replace(/\/$/, '')}/r/${encodeURIComponent(code)}`;
  }

  async function createAffiliate(input = {}, actor = 'admin') {
    const internalName = cleanRequiredText(input.internalName, 'internalName', 200);
    const displayName = cleanRequiredText(input.displayName || input.internalName, 'displayName', 200);
    const normalizedCode = normalizeAffiliateCode(input.customCode);
    const affiliateSince = cleanDate(input.affiliateSince, 'affiliateSince');
    const commissionRate = cleanCommissionRate(input.commissionRate ?? '0.5');
    const commissionBasis = cleanCommissionBasis(input.commissionBasis);
    const codeStatus = cleanCodeStatus(input.codeStatus);
    const payoutCurrency = cleanCurrency(input.payoutCurrency);
    const isTest = cleanBoolean(input.isTest, 'isTest', false);

    // A production partner URL is a bearer credential. Require encrypted
    // recoverable storage before creating one so the owner can later use the
    // approved "Copy Private Dashboard Link" control without regenerating it.
    if (!isTest && !readEncryptionKey(tokenEncryptionKey)) {
      throw statusError(
        503,
        'AFFILIATE_TOKEN_ENCRYPTION_KEY is required before creating a production affiliate.',
        'affiliate_token_encryption_not_configured'
      );
    }

    const token = createPartnerToken();
    const tokenHash = hashPartnerToken(token);
    const encryptedToken = encryptPartnerToken(token, tokenEncryptionKey);

    return withTransaction(pool, async (client) => {
      const affiliateResult = await client.query(
        `
        INSERT INTO affiliates (
          internal_name,
          display_name,
          custom_code,
          normalized_code,
          affiliate_since,
          status,
          code_status,
          is_test,
          payout_currency,
          payout_method,
          contact_email,
          internal_notes
        )
        VALUES ($1, $2, $3, $3, $4, 'active', $5, $6, $7, $8, $9, $10)
        RETURNING *
        `,
        [
          internalName,
          displayName,
          normalizedCode,
          affiliateSince,
          codeStatus,
          isTest,
          payoutCurrency,
          cleanText(input.payoutMethod, 120),
          cleanText(input.contactEmail, 320),
          cleanText(input.internalNotes, 2000),
        ]
      );

      const affiliate = affiliateResult.rows[0];

      // If Apple analytics arrived before the affiliate was created, safely
      // attach those already-imported aggregate rows now that the code exists.
      await client.query(
        `UPDATE affiliate_apple_metric_snapshots SET affiliate_id = $1 WHERE normalized_code = $2 AND affiliate_id IS NULL`,
        [affiliate.id, affiliate.normalized_code]
      );
      await client.query(
        `UPDATE affiliate_alerts SET status = 'resolved', resolved_at = NOW(), resolved_by = $2, resolution_note = 'Affiliate code was created and existing Apple metrics were attached.' WHERE dedupe_key = $1 AND status = 'open'`,
        [`unknown_apple_affiliate_code:${affiliate.normalized_code}`, actor]
      );

      const termResult = await client.query(
        `
        INSERT INTO affiliate_compensation_terms (
          affiliate_id,
          commission_basis,
          commission_rate,
          promo_commissionable,
          effective_from,
          created_by
        )
        VALUES ($1, $2, $3, FALSE, $4, $5)
        RETURNING *
        `,
        [
          affiliate.id,
          commissionBasis,
          commissionRate,
          affiliateSince,
          actor,
        ]
      );

      await client.query(
        `
        INSERT INTO affiliate_dashboard_tokens (
          affiliate_id,
          token_hash,
          token_ciphertext,
          token_iv,
          token_auth_tag,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
        `,
        [
          affiliate.id,
          tokenHash,
          encryptedToken.ciphertext,
          encryptedToken.iv,
          encryptedToken.authTag,
          actor,
        ]
      );

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor,
          action_type,
          affiliate_id,
          related_record_type,
          related_record_id,
          after_value
        )
        VALUES ($1, 'affiliate_created', $2, 'affiliate', $2::text, $3::jsonb)
        `,
        [
          actor,
          affiliate.id,
          JSON.stringify({
            displayName: affiliate.display_name,
            customCode: affiliate.normalized_code,
            commissionBasis,
            commissionRate,
            isTest,
          }),
        ]
      );

      return {
        affiliate,
        compensationTerm: termResult.rows[0],
        dashboardToken: token,
        dashboardUrl: buildPartnerUrl(token),
        referralUrl: buildReferralUrl(normalizedCode),
        appleRedemptionUrl: buildAppleOfferRedemptionUrl({
          appAppleId,
          customCode: normalizedCode,
        }),
      };
    });
  }

  async function listAffiliates() {
    const result = await pool.query(
      `
      SELECT
        a.*,
        terms.commission_basis,
        terms.commission_rate,
        COALESCE(fin.currently_owed, 0)::text AS currently_owed,
        COALESCE(fin.lifetime_paid, 0)::text AS lifetime_paid
      FROM affiliates a
      LEFT JOIN LATERAL (
        SELECT
          t.commission_basis,
          t.commission_rate
        FROM affiliate_compensation_terms t
        WHERE t.affiliate_id = a.id
          AND t.effective_from <= CURRENT_DATE
          AND (t.effective_through IS NULL OR t.effective_through >= CURRENT_DATE)
        ORDER BY t.effective_from DESC
        LIMIT 1
      ) terms ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COALESCE(SUM(
            CASE
              WHEN p.status IN ('ready_to_pay', 'partially_paid')
                THEN GREATEST(p.amount_due - p.amount_paid, 0)
              ELSE 0
            END
          ), 0) AS currently_owed,
          COALESCE((
            SELECT SUM(pp.amount)
            FROM affiliate_payout_payments pp
            WHERE pp.affiliate_id = a.id
          ), 0) AS lifetime_paid
        FROM affiliate_monthly_payouts p
        WHERE p.affiliate_id = a.id
          AND p.environment = 'production'
      ) fin ON TRUE
      ORDER BY
        CASE WHEN a.status = 'active' THEN 0 ELSE 1 END,
        a.affiliate_since DESC,
        a.display_name ASC
      `
    );

    return result.rows;
  }

  async function findAffiliateByCode(code) {
    const normalizedCode = normalizeAffiliateCode(code);
    const result = await pool.query(
      `
      SELECT *
      FROM affiliates
      WHERE normalized_code = $1
      LIMIT 1
      `,
      [normalizedCode]
    );

    return result.rows[0] || null;
  }

  async function recordReferralClick({ code, referrerHost = null } = {}) {
    const affiliate = await findAffiliateByCode(code);

    if (!affiliate || affiliate.status !== 'active' || affiliate.code_status !== 'active') {
      throw statusError(404, 'Referral link is not active.', 'affiliate_referral_not_active');
    }

    await pool.query(
      `
      INSERT INTO affiliate_referral_clicks (
        affiliate_id,
        normalized_code,
        environment,
        referrer_host
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        affiliate.id,
        affiliate.normalized_code,
        affiliate.is_test ? 'test' : 'production',
        cleanText(referrerHost, 255),
      ]
    );

    return {
      affiliate,
      redirectUrl: buildAppleOfferRedemptionUrl({
        appAppleId,
        customCode: affiliate.normalized_code,
      }),
    };
  }

  async function resolvePartnerToken(token, { touch = true } = {}) {
    const tokenHash = hashPartnerToken(token);
    const result = await pool.query(
      `
      SELECT
        t.id AS token_id,
        t.status AS token_status,
        t.expires_at,
        a.*
      FROM affiliate_dashboard_tokens t
      JOIN affiliates a ON a.id = t.affiliate_id
      WHERE t.token_hash = $1
        AND t.status = 'active'
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
      LIMIT 1
      `,
      [tokenHash]
    );

    const row = result.rows[0];
    if (!row) {
      throw statusError(404, 'Partner dashboard link is not active.', 'partner_dashboard_not_found');
    }

    if (touch) {
      await pool.query(
        `UPDATE affiliate_dashboard_tokens SET last_accessed_at = NOW() WHERE id = $1`,
        [row.token_id]
      );
    }

    return row;
  }

  async function latestStateMetric(affiliateId, metricKey, environment, beforeExclusive = null) {
    const result = await pool.query(
      `
      WITH latest AS (
        SELECT MAX(report_period_end) AS report_date
        FROM affiliate_apple_metric_snapshots
        WHERE affiliate_id = $1
          AND report_kind = 'state'
          AND metric_key = $2
          AND environment = $3
          AND ($4::date IS NULL OR report_period_end < $4::date)
      )
      SELECT
        latest.report_date,
        COALESCE(SUM(m.metric_value), 0)::text AS value
      FROM latest
      LEFT JOIN affiliate_apple_metric_snapshots m
        ON m.affiliate_id = $1
       AND m.report_kind = 'state'
       AND m.metric_key = $2
       AND m.environment = $3
       AND m.report_period_end = latest.report_date
      GROUP BY latest.report_date
      `,
      [affiliateId, metricKey, environment, beforeExclusive]
    );

    const row = result.rows[0];
    return {
      date: row?.report_date || null,
      value: row?.report_date ? Number(row.value || 0) : null,
    };
  }

  async function sumMetric(affiliateId, metricKey, environment, start, endExclusive) {
    const result = await pool.query(
      `
      SELECT COALESCE(SUM(metric_value), 0)::text AS value,
             COUNT(*)::int AS rows
      FROM affiliate_apple_metric_snapshots
      WHERE affiliate_id = $1
        AND metric_key = $2
        AND environment = $3
        AND report_period_start >= $4::date
        AND report_period_start < $5::date
      `,
      [affiliateId, metricKey, environment, start, endExclusive]
    );

    return {
      value: Number(result.rows[0]?.value || 0),
      rows: Number(result.rows[0]?.rows || 0),
    };
  }

  async function payoutSummary(affiliateId, now, environment = 'production') {
    const currentPeriod = now.startOf('month').toISODate();

    const summaryResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(
          CASE
            WHEN status IN ('ready_to_pay', 'partially_paid')
              THEN GREATEST(amount_due - amount_paid, 0)
            ELSE 0
          END
        ), 0)::text AS currently_owed,
        COALESCE(SUM(
          CASE WHEN status <> 'open' THEN amount_due ELSE 0 END
        ), 0)::text AS lifetime_commission_earned
      FROM affiliate_monthly_payouts
      WHERE affiliate_id = $1
        AND environment = $2
      `,
      [affiliateId, environment]
    );

    const currentResult = await pool.query(
      `
      SELECT *
      FROM affiliate_monthly_payouts
      WHERE affiliate_id = $1
        AND payout_period = $2::date
        AND environment = $3
      LIMIT 1
      `,
      [affiliateId, currentPeriod, environment]
    );

    const paidResult = await pool.query(
      `
      SELECT COALESCE(SUM(pp.amount), 0)::text AS lifetime_paid
      FROM affiliate_payout_payments pp
      JOIN affiliate_monthly_payouts p ON p.id = pp.monthly_payout_id
      WHERE pp.affiliate_id = $1
        AND p.environment = $2
      `,
      [affiliateId, environment]
    );

    const historyResult = await pool.query(
      `
      SELECT
        payout_period,
        eligible_revenue::text,
        commission_rate::text,
        commission_basis,
        commission_earned_exact::text,
        adjustments_total::text,
        amount_due::text,
        amount_paid::text,
        GREATEST(amount_due - amount_paid, 0)::text AS outstanding,
        status,
        data_status,
        calculation_details,
        finalized_at
      FROM affiliate_monthly_payouts
      WHERE affiliate_id = $1
        AND environment = $2
      ORDER BY payout_period DESC
      LIMIT 36
      `,
      [affiliateId, environment]
    );

    const lastPaymentResult = await pool.query(
      `
      SELECT pp.amount::text, pp.currency, pp.payment_date, pp.payment_method
      FROM affiliate_payout_payments pp
      JOIN affiliate_monthly_payouts p ON p.id = pp.monthly_payout_id
      WHERE pp.affiliate_id = $1
        AND p.environment = $2
        AND pp.entry_type = 'payment'
      ORDER BY pp.payment_date DESC, pp.created_at DESC
      LIMIT 1
      `,
      [affiliateId, environment]
    );

    const summary = summaryResult.rows[0] || {};
    const current = currentResult.rows[0] || null;

    return {
      estimatedThisMonth: current ? current.amount_due : null,
      currentMonthDataStatus: current?.data_status || 'awaiting_apple_data',
      currentlyOwed: summary.currently_owed || '0.00',
      lifetimeCommissionEarned: summary.lifetime_commission_earned || '0.00',
      lifetimePaid: paidResult.rows[0]?.lifetime_paid || '0.00',
      lastPayment: lastPaymentResult.rows[0] || null,
      history: historyResult.rows,
    };
  }

  async function getDashboardData(token, rangeValue = 'this_month') {
    const affiliate = await resolvePartnerToken(token);
    const now = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE);
    const range = parseRange(rangeValue, now);
    const environment = affiliate.is_test ? 'test' : 'production';
    const lifetimeEndExclusive = now.startOf('month').plus({ months: 1 }).toISODate();

    const [
      lifetimeRedemptions,
      lifetimePaidOfferStarts,
      lifetimeConversions,
      lifetimePromoVoluntaryChurn,
      lifetimePromoInvoluntaryChurn,
      currentActiveAccess,
      currentPaidOffers,
      currentPaidPlans,
      currentBillingRetry,
      currentCancelingActive,
      rangePaidOfferStarts,
      rangeActiveAccess,
      rangePaidOffers,
      rangePaidPlans,
      rangeBillingRetry,
      rangeCancelingActive,
      rangeConversions,
      rangePromoVoluntaryChurn,
      rangePromoInvoluntaryChurn,
      payout,
      clickCount,
      termResult,
    ] = await Promise.all([
      sumMetric(affiliate.id, 'redemptions', environment, '2000-01-01', lifetimeEndExclusive),
      sumMetric(affiliate.id, 'paid_offer_start', environment, '2000-01-01', lifetimeEndExclusive),
      sumMetric(affiliate.id, 'paid_subscriptions_from_offers_all', environment, '2000-01-01', lifetimeEndExclusive),
      sumMetric(affiliate.id, 'voluntary_churns_from_paid_offers', environment, '2000-01-01', lifetimeEndExclusive),
      sumMetric(affiliate.id, 'involuntary_churns_from_paid_offers', environment, '2000-01-01', lifetimeEndExclusive),
      latestStateMetric(affiliate.id, 'active_access', environment),
      latestStateMetric(affiliate.id, 'paid_offers', environment),
      latestStateMetric(affiliate.id, 'paid_plans', environment),
      latestStateMetric(affiliate.id, 'billing_retry', environment),
      latestStateMetric(affiliate.id, 'canceling_active', environment),
      sumMetric(affiliate.id, 'paid_offer_start', environment, range.start, range.endExclusive),
      latestStateMetric(affiliate.id, 'active_access', environment, range.endExclusive),
      latestStateMetric(affiliate.id, 'paid_offers', environment, range.endExclusive),
      latestStateMetric(affiliate.id, 'paid_plans', environment, range.endExclusive),
      latestStateMetric(affiliate.id, 'billing_retry', environment, range.endExclusive),
      latestStateMetric(affiliate.id, 'canceling_active', environment, range.endExclusive),
      sumMetric(affiliate.id, 'paid_subscriptions_from_offers_all', environment, range.start, range.endExclusive),
      sumMetric(affiliate.id, 'voluntary_churns_from_paid_offers', environment, range.start, range.endExclusive),
      sumMetric(affiliate.id, 'involuntary_churns_from_paid_offers', environment, range.start, range.endExclusive),
      payoutSummary(affiliate.id, now, environment),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM affiliate_referral_clicks WHERE affiliate_id = $1`,
        [affiliate.id]
      ),
      pool.query(
        `
        SELECT *
        FROM affiliate_compensation_terms
        WHERE affiliate_id = $1
          AND effective_from <= $2::date
          AND (effective_through IS NULL OR effective_through >= $2::date)
        ORDER BY effective_from DESC
        LIMIT 1
        `,
        [affiliate.id, now.toISODate()]
      ),
    ]);

    // Paid Offer Starts are the cleanest code-level acquisition metric for the
    // actual $0.99 subscription start. Offer-redemption counts remain a useful
    // reconciliation cross-check when imported, but do not replace starts.
    const totalReferrals = lifetimePaidOfferStarts.rows > 0
      ? lifetimePaidOfferStarts.value
      : (lifetimeRedemptions.rows > 0 ? lifetimeRedemptions.value : null);

    const lifetimePromoNonRenewals = lifetimePromoVoluntaryChurn.value + lifetimePromoInvoluntaryChurn.value;
    const lifetimeCompletedPromos = lifetimeConversions.value + lifetimePromoNonRenewals;
    const overviewPromoRenewalRate = lifetimeCompletedPromos > 0
      ? (lifetimeConversions.value / lifetimeCompletedPromos) * 100
      : null;

    const rangePromoNonRenewals = rangePromoVoluntaryChurn.value + rangePromoInvoluntaryChurn.value;
    const rangeCompletedPromos = rangeConversions.value + rangePromoNonRenewals;
    const promoRenewalRate = rangeCompletedPromos > 0
      ? (rangeConversions.value / rangeCompletedPromos) * 100
      : null;
    const promoNonRenewalRate = rangeCompletedPromos > 0
      ? (rangePromoNonRenewals / rangeCompletedPromos) * 100
      : null;

    const freshestDates = [
      currentActiveAccess.date,
      currentPaidOffers.date,
      currentPaidPlans.date,
      currentBillingRetry.date,
      currentCancelingActive.date,
    ].filter(Boolean).sort();

    const currentTerm = termResult.rows[0] || null;

    return {
      affiliate: {
        displayName: affiliate.display_name,
        customCode: affiliate.normalized_code,
        affiliateSince: affiliate.affiliate_since,
        status: affiliate.status,
        codeStatus: affiliate.code_status,
        isTest: affiliate.is_test,
        referralUrl: buildReferralUrl(affiliate.normalized_code),
      },
      range,
      dataFreshness: {
        latestAppleStateDate: freshestDates.length
          ? freshestDates[freshestDates.length - 1]
          : null,
        status: freshestDates.length ? 'apple_data_available' : 'awaiting_apple_data',
      },
      // Overview is deliberately independent of the Breakdown date filter. A
      // partner who switches Breakdown to Last Month must still see today's
      // Overview when they return to that tab.
      overview: {
        totalReferrals,
        activeSubscribers: currentActiveAccess.value,
        estimatedThisMonth: payout.estimatedThisMonth,
        currentlyOwed: payout.currentlyOwed,
        promoSubscribers: currentPaidOffers.value,
        activePaidSubscribers: currentPaidPlans.value,
        canceling: currentCancelingActive.value,
        promoNonRenewals: (lifetimePromoVoluntaryChurn.rows + lifetimePromoInvoluntaryChurn.rows) > 0
          ? lifetimePromoNonRenewals
          : null,
        billingRetry: currentBillingRetry.value,
        promoRenewalRate: overviewPromoRenewalRate,
        activeRetention: null,
        lastPayment: payout.lastPayment,
      },
      breakdown: {
        subscriberMetrics: {
          totalReferrals,
          newReferrals: rangePaidOfferStarts.rows > 0 ? rangePaidOfferStarts.value : null,
          activeSubscribers: rangeActiveAccess.value,
          promoSubscribers: rangePaidOffers.value,
          activePaidSubscribers: rangePaidPlans.value,
          promoNonRenewals: (rangePromoVoluntaryChurn.rows + rangePromoInvoluntaryChurn.rows) > 0
            ? rangePromoNonRenewals
            : null,
          canceling: rangeCancelingActive.value,
          expired: null,
          billingRetry: rangeBillingRetry.value,
        },
        performance: {
          promoRenewalRate,
          promoNonRenewalRate,
          activeRetention: null,
          cancellationRate: null,
        },
        payouts: payout,
      },
      compensation: currentTerm ? {
        basis: currentTerm.commission_basis,
        rate: currentTerm.commission_rate,
        promoCommissionable: currentTerm.promo_commissionable,
        effectiveFrom: currentTerm.effective_from,
      } : null,
      referralClicks: Number(clickCount.rows[0]?.count || 0),
      reconciliation: {
        appleOfferRedemptions: lifetimeRedemptions.rows > 0 ? lifetimeRedemptions.value : null,
        paidOfferStarts: lifetimePaidOfferStarts.rows > 0 ? lifetimePaidOfferStarts.value : null,
      },
    };
  }

  async function regeneratePartnerToken(affiliateId, actor = 'admin') {
    if (!UUID_RE.test(String(affiliateId || ''))) {
      throw statusError(400, 'Invalid affiliate ID.', 'invalid_affiliate_id');
    }

    return withTransaction(pool, async (client) => {
      const affiliateResult = await client.query(
        `SELECT * FROM affiliates WHERE id = $1 LIMIT 1`,
        [affiliateId]
      );

      if (!affiliateResult.rows[0]) {
        throw statusError(404, 'Affiliate not found.', 'affiliate_not_found');
      }

      const affiliate = affiliateResult.rows[0];
      if (!affiliate.is_test && !readEncryptionKey(tokenEncryptionKey)) {
        throw statusError(
          503,
          'AFFILIATE_TOKEN_ENCRYPTION_KEY is required before regenerating a production affiliate dashboard link.',
          'affiliate_token_encryption_not_configured'
        );
      }

      const token = createPartnerToken();
      const hash = hashPartnerToken(token);
      const encrypted = encryptPartnerToken(token, tokenEncryptionKey);

      await client.query(
        `
        UPDATE affiliate_dashboard_tokens
        SET status = 'revoked', revoked_at = NOW()
        WHERE affiliate_id = $1
          AND status = 'active'
        `,
        [affiliateId]
      );

      await client.query(
        `
        INSERT INTO affiliate_dashboard_tokens (
          affiliate_id,
          token_hash,
          token_ciphertext,
          token_iv,
          token_auth_tag,
          status,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, 'active', $6)
        `,
        [affiliateId, hash, encrypted.ciphertext, encrypted.iv, encrypted.authTag, actor]
      );

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor,
          action_type,
          affiliate_id,
          related_record_type,
          related_record_id
        )
        VALUES ($1, 'affiliate_dashboard_token_regenerated', $2, 'affiliate', $2::text)
        `,
        [actor, affiliateId]
      );

      return {
        dashboardToken: token,
        dashboardUrl: buildPartnerUrl(token),
      };
    });
  }

  async function getPartnerDashboardLink(affiliateId) {
    if (!UUID_RE.test(String(affiliateId || ''))) {
      throw statusError(400, 'Invalid affiliate ID.', 'invalid_affiliate_id');
    }

    const result = await pool.query(
      `
      SELECT
        a.id AS affiliate_id,
        a.display_name,
        t.token_hash,
        t.token_ciphertext,
        t.token_iv,
        t.token_auth_tag,
        t.expires_at
      FROM affiliates a
      JOIN affiliate_dashboard_tokens t ON t.affiliate_id = a.id
      WHERE a.id = $1
        AND t.status = 'active'
        AND (t.expires_at IS NULL OR t.expires_at > NOW())
      LIMIT 1
      `,
      [affiliateId]
    );

    const row = result.rows[0];
    if (!row) {
      throw statusError(404, 'Active affiliate dashboard link not found.', 'affiliate_dashboard_link_not_found');
    }

    const token = decryptPartnerToken({
      ciphertext: row.token_ciphertext,
      iv: row.token_iv,
      authTag: row.token_auth_tag,
    }, tokenEncryptionKey);

    if (hashPartnerToken(token) !== row.token_hash) {
      throw statusError(
        500,
        'Stored affiliate dashboard token failed integrity validation.',
        'affiliate_dashboard_token_integrity_failed'
      );
    }

    return {
      affiliateId: row.affiliate_id,
      displayName: row.display_name,
      dashboardUrl: buildPartnerUrl(token),
    };
  }

  async function importNormalizedAppleMetrics({
    rows,
    source = {},
    actor = 'system_apple_analytics',
  } = {}) {
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 50_000) {
      throw statusError(
        400,
        'rows must contain between 1 and 50000 normalized Apple metric rows.',
        'invalid_apple_metric_rows'
      );
    }

    const sourceType = String(source.type || 'manual_normalized').trim();
    if (!['analytics_state', 'analytics_event', 'offer_redemption', 'sales', 'manual_normalized'].includes(sourceType)) {
      throw statusError(400, 'Invalid Apple metric source type.', 'invalid_apple_metric_source');
    }

    const sourceEnvironment = String(source.environment || 'production').trim().toLowerCase();
    if (!['production', 'sandbox', 'test'].includes(sourceEnvironment)) {
      throw statusError(400, 'Invalid Apple metric environment.', 'invalid_apple_metric_environment');
    }

    const analyticsSource = ['analytics_state', 'analytics_event'].includes(sourceType);
    const processingDate = cleanProcessingDate(source.processingDate, {
      required: analyticsSource && sourceEnvironment === 'production',
    });
    const completeInstance = cleanBoolean(source.completeInstance, 'source.completeInstance', false);
    const normalizedSource = {
      type: sourceType,
      reportName: cleanText(source.reportName, 300),
      requestId: cleanText(source.requestId, 200),
      instanceId: cleanText(source.instanceId, 200),
      segmentId: cleanText(source.segmentId, 200),
      processingDate,
      environment: sourceEnvironment,
      completeInstance,
    };

    // Normalize the full input before opening the transaction. That keeps a
    // malformed row from creating a partially imported Apple instance.
    const normalizedRows = rows.map((rawRow) => {
      const normalizedCode = normalizeAffiliateCode(rawRow.customCode);
      const reportKind = String(rawRow.reportKind || '').trim().toLowerCase();
      if (!['state', 'event', 'redemption', 'sales'].includes(reportKind)) {
        throw statusError(400, 'Invalid reportKind in Apple metric row.', 'invalid_metric_report_kind');
      }

      const metricKey = String(rawRow.metricKey || '').trim().toLowerCase();
      if (!APPLE_METRIC_KEYS.has(metricKey)) {
        throw statusError(400, `Unsupported metricKey: ${metricKey}`, 'unsupported_metric_key');
      }

      const metricValue = String(rawRow.metricValue ?? '').trim();
      // State/Event/Redemption affiliate metrics are aggregate counts. Never
      // accept negative/fractional values through the normalized ingestion
      // boundary because they can corrupt dashboard and payout math.
      if (!/^\d+$/.test(metricValue)) {
        throw statusError(400, 'Apple affiliate metricValue must be a nonnegative integer count.', 'invalid_metric_value');
      }

      const periodStart = cleanDate(rawRow.periodStart, 'periodStart');
      const periodEnd = cleanDate(rawRow.periodEnd || rawRow.periodStart, 'periodEnd');
      if (periodEnd < periodStart) {
        throw statusError(400, 'Apple metric periodEnd cannot precede periodStart.', 'invalid_metric_period');
      }

      const granularity = String(rawRow.granularity || 'daily').trim().toLowerCase();
      if (!['daily', 'weekly', 'monthly', 'period'].includes(granularity)) {
        throw statusError(400, 'Invalid granularity in Apple metric row.', 'invalid_metric_granularity');
      }

      const environment = String(rawRow.environment || sourceEnvironment).trim().toLowerCase();
      if (!['production', 'sandbox', 'test'].includes(environment)) {
        throw statusError(400, 'Invalid environment in Apple metric row.', 'invalid_metric_environment');
      }
      if (environment !== sourceEnvironment) {
        throw statusError(400, 'Apple metric row environment must match the import environment.', 'metric_environment_mismatch');
      }

      return {
        normalizedCode,
        reportKind,
        metricKey,
        metricValue,
        periodStart,
        periodEnd,
        granularity,
        subscriptionName: cleanText(rawRow.subscriptionName, 300),
        subscriptionAdamId: cleanText(rawRow.subscriptionAdamId, 100),
        subscriptionDuration: cleanText(rawRow.subscriptionDuration, 100),
        subscriptionPricing: cleanText(rawRow.subscriptionPricing, 100),
        offerType: cleanText(rawRow.offerType, 100),
        offerPricing: cleanText(rawRow.offerPricing, 100),
        environment,
        rawDimensions: rawRow.rawDimensions && typeof rawRow.rawDimensions === 'object'
          ? rawRow.rawDimensions
          : {},
      };
    });

    const rowDigest = hashCanonicalObject(normalizedRows.map((row) => ({
      ...row,
      rawDimensions: row.rawDimensions || {},
    })));
    const sourceFingerprint = hashCanonicalObject({
      ...normalizedSource,
      // Apple request/instance identifiers are preferred. The row digest is a
      // final replay guard for manual or incomplete source metadata.
      rowDigest,
    });

    const importResult = await withTransaction(pool, async (client) => {
      const importInsert = await client.query(
        `
        INSERT INTO affiliate_apple_report_imports (
          source_type,
          source_report_name,
          source_request_id,
          source_instance_id,
          source_segment_id,
          source_processing_date,
          source_fingerprint,
          environment,
          complete_instance,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing')
        ON CONFLICT (source_fingerprint) DO NOTHING
        RETURNING *
        `,
        [
          sourceType,
          normalizedSource.reportName,
          normalizedSource.requestId,
          normalizedSource.instanceId,
          normalizedSource.segmentId,
          processingDate,
          sourceFingerprint,
          sourceEnvironment,
          completeInstance,
        ]
      );

      if (!importInsert.rows[0]) {
        const existing = await client.query(
          `SELECT * FROM affiliate_apple_report_imports WHERE source_fingerprint = $1 LIMIT 1`,
          [sourceFingerprint]
        );
        return {
          duplicate: true,
          importId: existing.rows[0]?.id || null,
          rows: normalizedRows.length,
          inserted: 0,
          updated: 0,
          stale: 0,
          unresolvedCodes: 0,
        };
      }

      const importRow = importInsert.rows[0];
      const affiliateResult = await client.query(
        `SELECT id, normalized_code FROM affiliates`
      );
      const affiliateByCode = new Map(
        affiliateResult.rows.map((row) => [row.normalized_code, row.id])
      );

      let inserted = 0;
      let updated = 0;
      let stale = 0;
      let duplicateRows = 0;
      const unresolvedCodeSet = new Set();
      const incomingLogicalByPartition = new Map();
      const touchedPayoutMap = new Map();
      const touchPayoutPeriod = (affiliateId, reportKind, periodStart, environment) => {
        if (!affiliateId || reportKind !== 'event') return;
        const month = DateTime.fromISO(String(periodStart), { zone: AFFILIATE_ACCOUNTING_TIMEZONE })
          .startOf('month')
          .toISODate();
        touchedPayoutMap.set(`${affiliateId}:${environment}:${month}`, {
          affiliateId,
          payoutPeriod: month,
          environment,
        });
      };

      const archiveSnapshot = async (snapshotId, reason) => {
        await client.query(
          `
          INSERT INTO affiliate_apple_metric_revisions (
            snapshot_id,
            affiliate_id,
            prior_import_id,
            replacement_import_id,
            custom_code,
            normalized_code,
            report_kind,
            metric_key,
            metric_value,
            report_period_start,
            report_period_end,
            granularity,
            subscription_name,
            subscription_adam_id,
            subscription_duration,
            subscription_pricing,
            offer_type,
            offer_pricing,
            environment,
            source_report_name,
            source_request_id,
            source_instance_id,
            source_segment_id,
            source_processing_date,
            logical_key,
            source_row_key,
            raw_dimensions,
            prior_imported_at,
            revision_reason
          )
          SELECT
            id,
            affiliate_id,
            import_id,
            $2,
            custom_code,
            normalized_code,
            report_kind,
            metric_key,
            metric_value,
            report_period_start,
            report_period_end,
            granularity,
            subscription_name,
            subscription_adam_id,
            subscription_duration,
            subscription_pricing,
            offer_type,
            offer_pricing,
            environment,
            source_report_name,
            source_request_id,
            source_instance_id,
            source_segment_id,
            source_processing_date,
            logical_key,
            source_row_key,
            raw_dimensions,
            imported_at,
            $3
          FROM affiliate_apple_metric_snapshots
          WHERE id = $1
          `,
          [snapshotId, importRow.id, reason]
        );
      };

      for (const normalizedRow of normalizedRows) {
        const affiliateId = affiliateByCode.get(normalizedRow.normalizedCode) || null;
        if (!affiliateId) unresolvedCodeSet.add(normalizedRow.normalizedCode);
        touchPayoutPeriod(affiliateId, normalizedRow.reportKind, normalizedRow.periodStart, normalizedRow.environment);

        const keys = metricRowKeys(normalizedRow, normalizedSource);
        const sourceReceipt = await client.query(
          `
          INSERT INTO affiliate_apple_metric_source_rows (
            source_row_key,
            import_id,
            logical_key
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (source_row_key) DO NOTHING
          RETURNING source_row_key
          `,
          [keys.sourceRowKey, importRow.id, keys.logicalKey]
        );

        if (!sourceReceipt.rows[0]) {
          duplicateRows += 1;
          continue;
        }

        const partitionKey = hashCanonicalObject({
          reportKind: normalizedRow.reportKind,
          environment: normalizedRow.environment,
          periodStart: normalizedRow.periodStart,
          sourceReportName: normalizedSource.reportName || '',
        });
        if (!incomingLogicalByPartition.has(partitionKey)) {
          incomingLogicalByPartition.set(partitionKey, {
            reportKind: normalizedRow.reportKind,
            environment: normalizedRow.environment,
            periodStart: normalizedRow.periodStart,
            sourceReportName: normalizedSource.reportName || null,
            logicalKeys: new Set(),
          });
        }
        incomingLogicalByPartition.get(partitionKey).logicalKeys.add(keys.logicalKey);

        const existingResult = await client.query(
          `SELECT * FROM affiliate_apple_metric_snapshots WHERE logical_key = $1 FOR UPDATE`,
          [keys.logicalKey]
        );
        const existing = existingResult.rows[0] || null;

        if (existing && compareProcessingDates(processingDate, existing.source_processing_date) < 0) {
          stale += 1;
          continue;
        }

        if (existing) {
          await archiveSnapshot(existing.id, 'superseded');
          await client.query(
            `
            UPDATE affiliate_apple_metric_snapshots
            SET affiliate_id = $2,
                import_id = $3,
                custom_code = $4,
                normalized_code = $4,
                metric_value = $5,
                source_report_name = $6,
                source_request_id = $7,
                source_instance_id = $8,
                source_segment_id = $9,
                source_processing_date = $10,
                source_row_key = $11,
                raw_dimensions = $12::jsonb,
                imported_at = NOW()
            WHERE id = $1
            `,
            [
              existing.id,
              affiliateId,
              importRow.id,
              normalizedRow.normalizedCode,
              normalizedRow.metricValue,
              normalizedSource.reportName,
              normalizedSource.requestId,
              normalizedSource.instanceId,
              normalizedSource.segmentId,
              processingDate,
              keys.sourceRowKey,
              JSON.stringify(normalizedRow.rawDimensions),
            ]
          );
          updated += 1;
        } else {
          await client.query(
            `
            INSERT INTO affiliate_apple_metric_snapshots (
              affiliate_id,
              import_id,
              custom_code,
              normalized_code,
              report_kind,
              metric_key,
              metric_value,
              report_period_start,
              report_period_end,
              granularity,
              subscription_name,
              subscription_adam_id,
              subscription_duration,
              subscription_pricing,
              offer_type,
              offer_pricing,
              environment,
              source_report_name,
              source_request_id,
              source_instance_id,
              source_segment_id,
              source_processing_date,
              logical_key,
              source_row_key,
              raw_dimensions,
              imported_at
            )
            VALUES (
              $1, $2, $3, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16,
              $17, $18, $19, $20, $21, $22, $23, $24::jsonb, NOW()
            )
            `,
            [
              affiliateId,
              importRow.id,
              normalizedRow.normalizedCode,
              normalizedRow.reportKind,
              normalizedRow.metricKey,
              normalizedRow.metricValue,
              normalizedRow.periodStart,
              normalizedRow.periodEnd,
              normalizedRow.granularity,
              normalizedRow.subscriptionName,
              normalizedRow.subscriptionAdamId,
              normalizedRow.subscriptionDuration,
              normalizedRow.subscriptionPricing,
              normalizedRow.offerType,
              normalizedRow.offerPricing,
              normalizedRow.environment,
              normalizedSource.reportName,
              normalizedSource.requestId,
              normalizedSource.instanceId,
              normalizedSource.segmentId,
              processingDate,
              keys.logicalKey,
              keys.sourceRowKey,
              JSON.stringify(normalizedRow.rawDimensions),
            ]
          );
          inserted += 1;
        }
      }

      // Apple documents that a newer processingDate replaces the full set for
      // a Date. This removal pass is intentionally enabled only when the caller
      // certifies that every segment for the instance has been combined.
      if (completeInstance && processingDate) {
        for (const partition of incomingLogicalByPartition.values()) {
          const currentRows = await client.query(
            `
            SELECT id, affiliate_id, report_kind, report_period_start, environment, logical_key, source_processing_date
            FROM affiliate_apple_metric_snapshots
            WHERE report_kind = $1
              AND environment = $2
              AND report_period_start = $3::date
              AND COALESCE(source_report_name, '') = COALESCE($4, '')
              AND (source_processing_date IS NULL OR source_processing_date <= $5::date)
            FOR UPDATE
            `,
            [
              partition.reportKind,
              partition.environment,
              partition.periodStart,
              partition.sourceReportName,
              processingDate,
            ]
          );

          for (const oldRow of currentRows.rows) {
            if (partition.logicalKeys.has(oldRow.logical_key)) continue;
            touchPayoutPeriod(oldRow.affiliate_id, oldRow.report_kind, oldRow.report_period_start, oldRow.environment);
            await archiveSnapshot(oldRow.id, 'removed_by_newer_instance');
            await client.query(
              `DELETE FROM affiliate_apple_metric_snapshots WHERE id = $1`,
              [oldRow.id]
            );
            stale += 1;
          }
        }
      }

      for (const unresolvedCode of unresolvedCodeSet) {
        await client.query(
          `
          INSERT INTO affiliate_alerts (
            alert_type,
            severity,
            status,
            title,
            message,
            dedupe_key
          )
          VALUES (
            'affiliate_code_issue',
            'warning',
            'open',
            'Unknown Apple affiliate code',
            $1,
            $2
          )
          ON CONFLICT (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL
          DO NOTHING
          `,
          [
            `Apple analytics contained custom code ${unresolvedCode}, but no affiliate record matches it.`,
            `unknown_apple_affiliate_code:${unresolvedCode}`,
          ]
        );
      }

      await client.query(
        `
        UPDATE affiliate_apple_report_imports
        SET status = 'completed',
            row_count = $2,
            inserted_count = $3,
            updated_count = $4,
            stale_count = $5,
            completed_at = NOW()
        WHERE id = $1
        `,
        [importRow.id, normalizedRows.length, inserted, updated, stale]
      );

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor,
          action_type,
          related_record_type,
          related_record_id,
          after_value
        )
        VALUES (
          $1,
          'apple_affiliate_metrics_imported',
          'affiliate_apple_report_import',
          $2,
          $3::jsonb
        )
        `,
        [
          actor,
          importRow.id,
          JSON.stringify({
            rows: normalizedRows.length,
            inserted,
            updated,
            stale,
            duplicateRows,
            unresolvedCodes: unresolvedCodeSet.size,
            sourceType,
            processingDate,
            completeInstance,
            environment: sourceEnvironment,
          }),
        ]
      );

      return {
        duplicate: false,
        importId: importRow.id,
        rows: normalizedRows.length,
        inserted,
        updated,
        stale,
        duplicateRows,
        unresolvedCodes: unresolvedCodeSet.size,
        touchedPayouts: [...touchedPayoutMap.values()],
      };
    });

    // Keep open estimates current and automatically reconcile already-locked
    // payouts when late/corrected Apple event data is imported. Import success
    // is never rolled back merely because a downstream payout refresh fails.
    const payoutRefreshes = [];
    const payoutRefreshFailures = [];
    for (const touched of importResult.touchedPayouts || []) {
      try {
        const refreshed = await refreshMonthlyPayout({
          affiliateId: touched.affiliateId,
          payoutPeriod: touched.payoutPeriod,
          finalize: false,
          actor: 'system_apple_analytics_refresh',
        });
        payoutRefreshes.push({
          affiliateId: touched.affiliateId,
          payoutPeriod: touched.payoutPeriod,
          status: refreshed?.payout?.status || 'refreshed',
        });
        await pool.query(
          `
          UPDATE affiliate_alerts
          SET status = 'resolved', resolved_at = NOW(), resolved_by = $2,
              resolution_note = 'Payout refresh succeeded after Apple analytics import.'
          WHERE dedupe_key = $1 AND status = 'open'
          `,
          [`apple_import_payout_refresh:${touched.affiliateId}:${touched.payoutPeriod}`, actor]
        );
      } catch (error) {
        payoutRefreshFailures.push({
          affiliateId: touched.affiliateId,
          payoutPeriod: touched.payoutPeriod,
          code: error?.code || 'payout_refresh_failed',
        });
        await pool.query(
          `
          INSERT INTO affiliate_alerts (
            affiliate_id, alert_type, severity, status, title, message, dedupe_key
          )
          VALUES ($1, 'commission_processing_error', 'warning', 'open',
                  'Apple import payout refresh failed', $2, $3)
          ON CONFLICT (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL
          DO UPDATE SET message = EXCLUDED.message, triggered_at = NOW()
          `,
          [
            touched.affiliateId,
            `Apple analytics imported successfully, but payout ${touched.payoutPeriod} could not be refreshed automatically: ${error?.code || error?.message || 'unknown error'}.`,
            `apple_import_payout_refresh:${touched.affiliateId}:${touched.payoutPeriod}`,
          ]
        );
      }
    }

    return {
      ...importResult,
      payoutRefreshes: payoutRefreshes.length,
      payoutRefreshFailures,
    };
  }

  async function calculateMonthlyExpectation(client, {
    affiliate,
    payoutPeriod,
    environment,
  }) {
    const period = DateTime.fromISO(payoutPeriod, { zone: AFFILIATE_ACCOUNTING_TIMEZONE });
    const nextPeriod = period.plus({ months: 1 }).toISODate();

    const termResult = await client.query(
      `
      SELECT *
      FROM affiliate_compensation_terms
      WHERE affiliate_id = $1
        AND effective_from < $3::date
        AND (effective_through IS NULL OR effective_through >= $2::date)
      ORDER BY effective_from DESC
      LIMIT 1
      `,
      [affiliate.id, payoutPeriod, nextPeriod]
    );
    const term = termResult.rows[0] || null;

    if (!term) {
      return {
        term: null,
        sourceRows: 0,
        lines: [],
        eligibleRevenue: '0.00',
        commissionExact: '0.000000',
        adjustmentsExact: '0.000000',
        amountDue: '0.00',
        netExact: '0.000000',
        issues: [{ code: 'missing_compensation_term', message: 'No compensation term applies to this payout month.', blocking: true }],
      };
    }

    if (term.commission_basis !== 'base_price') {
      return {
        term,
        sourceRows: 0,
        lines: [],
        eligibleRevenue: '0.00',
        commissionExact: '0.000000',
        adjustmentsExact: '0.000000',
        amountDue: '0.00',
        netExact: '0.000000',
        issues: [{
          code: 'net_proceeds_not_implemented',
          message: 'Net-proceeds commission requires Apple proceeds data and is held for review in this build.',
          blocking: true,
        }],
      };
    }

    const eventsResult = await client.query(
      `
      SELECT
        metric_key,
        metric_value::text,
        report_period_start,
        subscription_adam_id,
        subscription_duration,
        subscription_pricing
      FROM affiliate_apple_metric_snapshots
      WHERE affiliate_id = $1
        AND report_kind = 'event'
        AND environment = $2
        AND report_period_start >= $3::date
        AND report_period_start < $4::date
      ORDER BY report_period_start ASC, metric_key ASC
      `,
      [affiliate.id, environment, payoutPeriod, nextPeriod]
    );

    const issues = [];
    const issueKeys = new Set();
    const linesByKey = new Map();

    const addIssue = (code, message, details = {}, blocking = false) => {
      const key = `${code}:${JSON.stringify(details)}`;
      if (issueKeys.has(key)) return;
      issueKeys.add(key);
      issues.push({ code, message, blocking, ...details });
    };

    for (const event of eventsResult.rows) {
      const countNumber = Number(event.metric_value);
      if (!Number.isSafeInteger(countNumber) || countNumber < 0) {
        addIssue('invalid_apple_count', 'Apple event count is not a safe nonnegative integer.', {
          metricKey: event.metric_key,
          value: event.metric_value,
          date: event.report_period_start,
        }, true);
        continue;
      }
      if (countNumber === 0) continue;

      const classification = classifyAppleMetricForBasePrice(event.metric_key);
      if (classification.action === 'ignore' || classification.action === 'noncommissionable_promo') {
        continue;
      }
      if (classification.action === 'needs_review') {
        addIssue(
          'apple_event_needs_pricing_review',
          'Apple reported a money-impacting event that cannot be priced safely from the Standard custom-code report alone.',
          { metricKey: event.metric_key, count: countNumber, date: event.report_period_start },
          classification.blocking === true
        );
        continue;
      }

      const duration = cleanText(event.subscription_duration, 100);
      if (!duration) {
        addIssue('missing_subscription_duration', 'A commissionable Apple event is missing Subscription Duration.', {
          metricKey: event.metric_key,
          count: countNumber,
          date: event.report_period_start,
        }, true);
        continue;
      }

      const priceResult = await client.query(
        `
        SELECT *
        FROM affiliate_base_price_schedule
        WHERE (subscription_adam_id = $1 OR subscription_adam_id IS NULL)
          AND lower(subscription_duration) = lower($2)
          AND subscription_pricing = $3
          AND effective_from <= $4::date
          AND (effective_through IS NULL OR effective_through >= $4::date)
        ORDER BY
          CASE WHEN subscription_adam_id = $1 THEN 0 ELSE 1 END,
          effective_from DESC
        LIMIT 1
        `,
        [
          event.subscription_adam_id || null,
          duration,
          classification.subscriptionPricing,
          event.report_period_start,
        ]
      );
      const priceRule = priceResult.rows[0] || null;
      if (!priceRule) {
        addIssue('missing_base_price_rule', 'No U.S. base-price rule safely matches this Apple event.', {
          metricKey: event.metric_key,
          count: countNumber,
          date: event.report_period_start,
          subscriptionDuration: duration,
          subscriptionPricing: classification.subscriptionPricing,
          subscriptionAdamId: event.subscription_adam_id || null,
        }, true);
        continue;
      }

      const unitPrice = String(priceRule.base_price_usd);
      const lineKey = `${priceRule.id}:${unitPrice}`;
      const existing = linesByKey.get(lineKey) || {
        label: priceRule.label,
        count: 0,
        unitPrice,
        pricing: classification.subscriptionPricing,
      };
      existing.count += countNumber;
      linesByKey.set(lineKey, existing);
    }

    const lines = [...linesByKey.values()];
    const commission = calculateBasePriceCommission({
      lines,
      commissionRate: String(term.commission_rate),
    });

    const adjustmentsResult = await client.query(
      `
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM affiliate_adjustments
      WHERE affiliate_id = $1
        AND target_period = $2::date
        AND currency = $3
      `,
      [affiliate.id, payoutPeriod, affiliate.payout_currency || 'USD']
    );
    const adjustmentsExact = adjustmentsResult.rows[0]?.total || '0';
    const net = moneyFromExactParts(commission.commissionExact, adjustmentsExact);

    return {
      term,
      sourceRows: eventsResult.rowCount,
      lines: commission.lines,
      eligibleRevenue: commission.eligibleRevenue,
      commissionExact: commission.commissionExact,
      adjustmentsExact: microsToDecimalString(decimalStringToMicros(adjustmentsExact), 6),
      amountDue: net.amountDue,
      netExact: net.netExact,
      negativeBalanceExact: net.negativeBalanceExact,
      issues,
    };
  }

  async function chooseAdjustmentTargetPeriod(client, affiliateId, startPeriod, environment) {
    let candidate = DateTime.fromISO(startPeriod, { zone: AFFILIATE_ACCOUNTING_TIMEZONE });
    const current = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE).startOf('month');
    if (candidate < current) candidate = current;

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const period = candidate.toISODate();
      const result = await client.query(
        `
        SELECT status, locked_at
        FROM affiliate_monthly_payouts
        WHERE affiliate_id = $1
          AND payout_period = $2::date
          AND environment = $3
        LIMIT 1
        `,
        [affiliateId, period, environment]
      );
      const row = result.rows[0];
      if (!row || (!row.locked_at && !['partially_paid', 'paid'].includes(row.status))) {
        return period;
      }
      candidate = candidate.plus({ months: 1 });
    }

    throw statusError(500, 'Unable to find an unlocked future payout period.', 'no_unlocked_payout_period');
  }

  async function syncOverpaymentCarryForward(client, {
    payout,
    amountPaid,
    actor,
    sourceRecordId,
  }) {
    const paidMicros = decimalStringToMicros(amountPaid || '0');
    const dueMicros = decimalStringToMicros(payout.amount_due || '0');
    const overpaymentMicros = paidMicros > dueMicros ? paidMicros - dueMicros : 0n;
    const desiredAdjustmentMicros = -overpaymentMicros;

    const priorResult = await client.query(
      `
      SELECT COALESCE(SUM(amount), 0)::text AS total
      FROM affiliate_adjustments
      WHERE affiliate_id = $1
        AND source_period = $2::date
        AND adjustment_type IN ('overpayment', 'overpayment_correction')
        AND related_source_key LIKE $3
      `,
      [payout.affiliate_id, payout.payout_period, `overpayment:${payout.id}:%`]
    );
    const alreadyAppliedMicros = decimalStringToMicros(priorResult.rows[0]?.total || '0');
    const deltaMicros = desiredAdjustmentMicros - alreadyAppliedMicros;
    if (deltaMicros === 0n) return null;

    const nextMonth = DateTime.fromISO(payout.payout_period, { zone: AFFILIATE_ACCOUNTING_TIMEZONE })
      .plus({ months: 1 })
      .toISODate();
    const targetPeriod = await chooseAdjustmentTargetPeriod(
      client,
      payout.affiliate_id,
      nextMonth,
      payout.environment
    );
    const deltaExact = microsToDecimalString(deltaMicros, 6);
    const desiredExact = microsToDecimalString(desiredAdjustmentMicros, 6);
    const adjustmentType = deltaMicros < 0n ? 'overpayment' : 'overpayment_correction';
    const reason = deltaMicros < 0n
      ? 'Prior payout was overpaid; remaining credit carried forward.'
      : 'Prior overpayment was corrected; excess carried-forward credit reversed.';
    const sourceKey = `overpayment:${payout.id}:${sourceRecordId}:${desiredExact}`;

    const insertResult = await client.query(
      `
      INSERT INTO affiliate_adjustments (
        affiliate_id,
        monthly_payout_id,
        adjustment_type,
        amount,
        currency,
        source_period,
        target_period,
        reason,
        related_source_key,
        created_by
      )
      VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (affiliate_id, related_source_key)
        WHERE related_source_key IS NOT NULL
      DO NOTHING
      RETURNING *
      `,
      [
        payout.affiliate_id,
        adjustmentType,
        deltaExact,
        payout.payout_currency || 'USD',
        payout.payout_period,
        targetPeriod,
        reason,
        sourceKey,
        actor,
      ]
    );

    if (insertResult.rows[0]) return insertResult.rows[0];
    const existing = await client.query(
      `SELECT * FROM affiliate_adjustments WHERE affiliate_id = $1 AND related_source_key = $2 LIMIT 1`,
      [payout.affiliate_id, sourceKey]
    );
    return existing.rows[0] || null;
  }

  async function reconcileLockedPayout({
    payout,
    affiliate,
    markReconciled = false,
    actor = 'system_affiliate_reconciliation',
  }) {
    let createdAdjustment = null;
    let targetPeriod = null;

    const result = await withTransaction(pool, async (client) => {
      const expectation = await calculateMonthlyExpectation(client, {
        affiliate,
        payoutPeriod: payout.payout_period,
        environment: payout.environment,
      });

      const blockingIssues = expectation.issues.filter((issue) => issue.blocking);
      if (blockingIssues.length || expectation.sourceRows === 0) {
        await client.query(
          `
          INSERT INTO affiliate_alerts (
            affiliate_id, alert_type, severity, status, title, message,
            dedupe_key, related_record_type, related_record_id
          )
          VALUES ($1, 'commission_processing_error', 'warning', 'open',
                  'Locked payout needs reconciliation review', $2, $3,
                  'affiliate_monthly_payout', $4)
          ON CONFLICT (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL
          DO NOTHING
          `,
          [
            affiliate.id,
            expectation.sourceRows === 0
              ? 'Apple event data is not available for this locked payout period yet.'
              : `Apple data changed, but ${blockingIssues.length} blocking reconciliation issue(s) prevent an automatic adjustment.`,
            `locked_payout_review:${payout.id}`,
            payout.id,
          ]
        );
        return { expectation, deltaExact: '0.000000', adjustment: null };
      }

      const priorAdjustments = await client.query(
        `
        SELECT COALESCE(SUM(amount), 0)::text AS total
        FROM affiliate_adjustments
        WHERE affiliate_id = $1
          AND adjustment_type = 'late_apple_data'
          AND source_period = $2::date
        `,
        [affiliate.id, payout.payout_period]
      );

      const expectedMicros = decimalStringToMicros(expectation.commissionExact);
      const originalMicros = decimalStringToMicros(payout.commission_earned_exact || '0');
      const alreadyAppliedMicros = decimalStringToMicros(priorAdjustments.rows[0]?.total || '0');
      const deltaMicros = expectedMicros - originalMicros - alreadyAppliedMicros;
      const deltaExact = microsToDecimalString(deltaMicros, 6);

      if (deltaMicros !== 0n) {
        const nextMonth = DateTime.fromISO(payout.payout_period, { zone: AFFILIATE_ACCOUNTING_TIMEZONE })
          .plus({ months: 1 })
          .toISODate();
        targetPeriod = await chooseAdjustmentTargetPeriod(
          client,
          affiliate.id,
          nextMonth,
          payout.environment
        );
        // Include the amount already applied in the idempotency key. Apple
        // corrections can oscillate (100 -> 110 -> 105 -> 110). Keying only
        // on the latest expected total would collide with the first 110 state
        // and fail to apply the later +5 delta.
        const sourceKey = `late_apple_data:${payout.id}:${expectation.commissionExact}:${microsToDecimalString(alreadyAppliedMicros, 6)}`;
        const adjustmentResult = await client.query(
          `
          INSERT INTO affiliate_adjustments (
            affiliate_id,
            monthly_payout_id,
            adjustment_type,
            amount,
            currency,
            source_period,
            target_period,
            reason,
            related_source_key,
            created_by
          )
          VALUES ($1, NULL, 'late_apple_data', $2, $3, $4, $5,
                  'Late or corrected Apple analytics after the source payout was locked.',
                  $6, $7)
          ON CONFLICT (affiliate_id, related_source_key)
            WHERE related_source_key IS NOT NULL
          DO NOTHING
          RETURNING *
          `,
          [
            affiliate.id,
            deltaExact,
            affiliate.payout_currency || 'USD',
            payout.payout_period,
            targetPeriod,
            sourceKey,
            actor,
          ]
        );
        createdAdjustment = adjustmentResult.rows[0] || null;
      }

      if (markReconciled && payout.data_status !== 'needs_review' && expectation.issues.length === 0) {
        await client.query(
          `UPDATE affiliate_monthly_payouts SET data_status = 'reconciled', updated_at = NOW() WHERE id = $1`,
          [payout.id]
        );
      }

      return { expectation, deltaExact, adjustment: createdAdjustment, targetPeriod };
    });

    // Refresh the future period outside the source transaction. The adjustment
    // has already committed and this call is itself idempotent/recalculable.
    if (createdAdjustment && targetPeriod) {
      await refreshMonthlyPayout({
        affiliateId: affiliate.id,
        payoutPeriod: targetPeriod,
        finalize: false,
        actor,
      });
    }

    return result;
  }

  async function refreshMonthlyPayout({
    affiliateId,
    payoutPeriod,
    finalize = false,
    markReconciled = false,
    actor = 'system_affiliate_payout',
  } = {}) {
    if (!UUID_RE.test(String(affiliateId || ''))) {
      throw statusError(400, 'Invalid affiliate ID.', 'invalid_affiliate_id');
    }
    const cleanPeriod = cleanPayoutPeriod(payoutPeriod);
    const accountingNow = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE);
    const currentPeriod = accountingNow.startOf('month').toISODate();
    if (finalize && cleanPeriod >= currentPeriod) {
      throw statusError(
        409,
        'Only a completed prior calendar month can be finalized.',
        'payout_period_not_closed'
      );
    }

    const affiliateResult = await pool.query(
      `SELECT * FROM affiliates WHERE id = $1 LIMIT 1`,
      [affiliateId]
    );
    const affiliate = affiliateResult.rows[0];
    if (!affiliate) throw statusError(404, 'Affiliate not found.', 'affiliate_not_found');
    const environment = affiliate.is_test ? 'test' : 'production';
    if ((finalize || markReconciled) && environment === 'production' && !allowAnalyticsEstimatePayouts) {
      throw statusError(
        409,
        'Production affiliate payouts are disabled because Apple Analytics custom-code counts are privacy-adjusted estimates. Set AFFILIATE_ALLOW_ANALYTICS_ESTIMATE_PAYOUTS=true only after explicitly accepting Apple-reported Analytics counts as the commission basis.',
        'analytics_estimate_payouts_not_approved'
      );
    }

    const existingResult = await pool.query(
      `
      SELECT * FROM affiliate_monthly_payouts
      WHERE affiliate_id = $1 AND payout_period = $2::date AND environment = $3
      LIMIT 1
      `,
      [affiliateId, cleanPeriod, environment]
    );
    const existing = existingResult.rows[0] || null;
    if (existing?.locked_at || ['partially_paid', 'paid'].includes(existing?.status)) {
      return reconcileLockedPayout({
        payout: existing,
        affiliate,
        markReconciled,
        actor,
      });
    }

    let negativeCarryForward = null;
    const result = await withTransaction(pool, async (client) => {
      // Serialize recalculations even before a payout row exists. A row-level
      // FOR UPDATE cannot lock a missing row, so use a transaction-scoped
      // advisory lock keyed to affiliate/month/environment to prevent two
      // workers from racing to create the same payout.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`affiliate_payout:${affiliateId}:${cleanPeriod}:${environment}`]
      );
      const lockedExistingResult = await client.query(
        `
        SELECT * FROM affiliate_monthly_payouts
        WHERE affiliate_id = $1 AND payout_period = $2::date AND environment = $3
        FOR UPDATE
        `,
        [affiliateId, cleanPeriod, environment]
      );
      const lockedExisting = lockedExistingResult.rows[0] || null;
      if (lockedExisting?.locked_at || ['partially_paid', 'paid'].includes(lockedExisting?.status)) {
        throw statusError(409, 'Payout became locked while recalculation was in progress. Retry reconciliation.', 'payout_locked_during_refresh');
      }

      const expectation = await calculateMonthlyExpectation(client, {
        affiliate,
        payoutPeriod: cleanPeriod,
        environment,
      });
      const blockingIssues = expectation.issues.filter((issue) => issue.blocking);
      const heldIssues = expectation.issues.filter((issue) => !issue.blocking);
      const dataStatus = blockingIssues.length
        ? 'needs_review'
        : (markReconciled && heldIssues.length === 0 && expectation.sourceRows > 0
          ? 'reconciled'
          : (finalize ? 'provisional' : (expectation.sourceRows === 0 ? 'awaiting_apple_data' : 'provisional')));

      let status = 'open';
      if (finalize && !blockingIssues.length) {
        status = expectation.amountDue === '0.00' ? 'paid' : 'ready_to_pay';
      } else if (lockedExisting?.status === 'ready_to_pay' && !blockingIssues.length) {
        status = 'ready_to_pay';
      }

      const periodDate = DateTime.fromISO(cleanPeriod, { zone: AFFILIATE_ACCOUNTING_TIMEZONE });
      const calculationDetails = {
        lines: expectation.lines,
        issues: expectation.issues,
        sourceRows: expectation.sourceRows,
        netExact: expectation.netExact,
        negativeBalanceExact: expectation.negativeBalanceExact || '0.000000',
        calculatedAt: new Date().toISOString(),
        accountingTimezone: AFFILIATE_ACCOUNTING_TIMEZONE,
        appleDataPolicy: dataStatus === 'provisional'
          ? 'Payable on the 1st from verified Apple data available at finalization; later differences carry forward.'
          : null,
      };

      let payoutResult;
      if (lockedExisting) {
        payoutResult = await client.query(
          `
          UPDATE affiliate_monthly_payouts
          SET compensation_term_id = $2,
              commission_basis = $3,
              commission_rate = $4,
              eligible_revenue = $5,
              commission_earned_exact = $6,
              adjustments_total = $7,
              amount_due = $8,
              status = $9,
              data_status = $10,
              calculation_details = $11::jsonb,
              period_started_at = COALESCE(period_started_at, $12::timestamptz),
              period_closed_at = CASE WHEN $13 THEN $14::timestamptz ELSE period_closed_at END,
              finalized_at = CASE WHEN $13 AND $9 <> 'open' THEN COALESCE(finalized_at, NOW()) ELSE finalized_at END,
              locked_at = CASE WHEN $13 AND $9 <> 'open' THEN COALESCE(locked_at, NOW()) ELSE locked_at END,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [
            lockedExisting.id,
            expectation.term?.id,
            expectation.term?.commission_basis || 'base_price',
            expectation.term?.commission_rate || '0',
            expectation.eligibleRevenue,
            expectation.commissionExact,
            expectation.adjustmentsExact,
            expectation.amountDue,
            status,
            dataStatus,
            JSON.stringify(calculationDetails),
            periodDate.startOf('month').toUTC().toISO(),
            finalize,
            periodDate.plus({ months: 1 }).startOf('month').toUTC().toISO(),
          ]
        );
      } else {
        if (!expectation.term) {
          throw statusError(409, 'Cannot create payout without a compensation term.', 'missing_compensation_term');
        }
        payoutResult = await client.query(
          `
          INSERT INTO affiliate_monthly_payouts (
            affiliate_id,
            compensation_term_id,
            payout_period,
            environment,
            commission_basis,
            commission_rate,
            eligible_revenue,
            commission_earned_exact,
            adjustments_total,
            amount_due,
            amount_paid,
            status,
            data_status,
            calculation_details,
            period_started_at,
            period_closed_at,
            finalized_at,
            locked_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0,
            $11, $12, $13::jsonb, $14::timestamptz,
            CASE WHEN $15 THEN $16::timestamptz ELSE NULL END,
            CASE WHEN $15 AND $11 <> 'open' THEN NOW() ELSE NULL END,
            CASE WHEN $15 AND $11 <> 'open' THEN NOW() ELSE NULL END
          )
          RETURNING *
          `,
          [
            affiliate.id,
            expectation.term.id,
            cleanPeriod,
            environment,
            expectation.term.commission_basis,
            expectation.term.commission_rate,
            expectation.eligibleRevenue,
            expectation.commissionExact,
            expectation.adjustmentsExact,
            expectation.amountDue,
            status,
            dataStatus,
            JSON.stringify(calculationDetails),
            periodDate.startOf('month').toUTC().toISO(),
            finalize,
            periodDate.plus({ months: 1 }).startOf('month').toUTC().toISO(),
          ]
        );
      }

      const payout = payoutResult.rows[0];
      await client.query(
        `
        UPDATE affiliate_adjustments
        SET monthly_payout_id = $1
        WHERE affiliate_id = $2
          AND target_period = $3::date
          AND monthly_payout_id IS NULL
        `,
        [payout.id, affiliate.id, cleanPeriod]
      );

      // A payout can never be negative cash. If valid adjustments exceed this
      // month's commission, consume what can be consumed here and carry only
      // the residual credit forward to the next unlocked period.
      const negativeMicros = decimalStringToMicros(expectation.negativeBalanceExact || '0');
      if (finalize && status === 'paid' && negativeMicros < 0n) {
        const nextMonth = periodDate.plus({ months: 1 }).toISODate();
        const targetPeriod = await chooseAdjustmentTargetPeriod(
          client,
          affiliate.id,
          nextMonth,
          environment
        );
        const sourceKey = `negative_balance:${payout.id}:${expectation.netExact}`;
        const carryResult = await client.query(
          `
          INSERT INTO affiliate_adjustments (
            affiliate_id, monthly_payout_id, adjustment_type, amount, currency,
            source_period, target_period, reason, related_source_key, created_by
          )
          VALUES ($1, NULL, 'negative_balance_carry_forward', $2, $3, $4, $5,
                  'Negative payout balance carried forward because affiliates are never paid a negative cash amount.',
                  $6, $7)
          ON CONFLICT (affiliate_id, related_source_key)
            WHERE related_source_key IS NOT NULL
          DO NOTHING
          RETURNING *
          `,
          [
            affiliate.id,
            expectation.negativeBalanceExact,
            affiliate.payout_currency || 'USD',
            cleanPeriod,
            targetPeriod,
            sourceKey,
            actor,
          ]
        );
        negativeCarryForward = carryResult.rows[0] || null;
      }

      if (expectation.issues.length) {
        await client.query(
          `
          INSERT INTO affiliate_alerts (
            affiliate_id, alert_type, severity, status, title, message,
            dedupe_key, related_record_type, related_record_id
          )
          VALUES ($1, 'commission_processing_error', 'warning', 'open',
                  'Affiliate payout needs review', $2, $3,
                  'affiliate_monthly_payout', $4)
          ON CONFLICT (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL
          DO UPDATE SET message = EXCLUDED.message, triggered_at = NOW()
          `,
          [
            affiliate.id,
            blockingIssues.length
              ? `${blockingIssues.length} blocking Apple reconciliation issue(s) must be resolved before this payout can be paid.`
              : `${heldIssues.length} ambiguous Apple pricing item(s) are excluded from this payout for now; verified commission remains payable and later resolution carries forward.`,
            `payout_review:${payout.id}`,
            payout.id,
          ]
        );
      } else {
        await client.query(
          `
          UPDATE affiliate_alerts
          SET status = 'resolved', resolved_at = NOW(), resolved_by = $2,
              resolution_note = 'Payout recalculation no longer has blocking issues.'
          WHERE dedupe_key = $1 AND status = 'open'
          `,
          [`payout_review:${payout.id}`, actor]
        );
      }

      if (finalize && status === 'ready_to_pay') {
        await client.query(
          `
          INSERT INTO affiliate_alerts (
            affiliate_id, alert_type, severity, status, title, message,
            dedupe_key, related_record_type, related_record_id
          )
          VALUES ($1, 'payout_due', 'info', 'open', 'Affiliate payout ready', $2, $3,
                  'affiliate_monthly_payout', $4)
          ON CONFLICT (dedupe_key) WHERE status = 'open' AND dedupe_key IS NOT NULL
          DO UPDATE SET message = EXCLUDED.message, triggered_at = NOW()
          `,
          [
            affiliate.id,
            `${affiliate.display_name} has ${expectation.amountDue} ${affiliate.payout_currency || 'USD'} ready to pay for ${cleanPeriod}.`,
            `payout_due:${payout.id}`,
            payout.id,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor, action_type, affiliate_id, related_record_type,
          related_record_id, after_value
        )
        VALUES ($1, $2, $3, 'affiliate_monthly_payout', $4, $5::jsonb)
        `,
        [
          actor,
          finalize ? 'affiliate_payout_finalized_or_refreshed' : 'affiliate_payout_refreshed',
          affiliate.id,
          payout.id,
          JSON.stringify({
            payoutPeriod: cleanPeriod,
            amountDue: payout.amount_due,
            dataStatus,
            status,
            issues: expectation.issues,
          }),
        ]
      );

      return {
        payout,
        calculation: expectation,
        negativeCarryForward,
      };
    });

    if (negativeCarryForward?.target_period) {
      await refreshMonthlyPayout({
        affiliateId: affiliate.id,
        payoutPeriod: negativeCarryForward.target_period,
        finalize: false,
        actor,
      });
    }

    return result;
  }

  async function finalizeAffiliatePayoutsForPeriod({
    payoutPeriod,
    markReconciled = false,
    includeTest = false,
    actor = 'system_affiliate_month_close',
  } = {}) {
    const cleanPeriod = cleanPayoutPeriod(payoutPeriod);
    const affiliateResult = await pool.query(
      `
      SELECT id, normalized_code, display_name, is_test
      FROM affiliates
      WHERE status IN ('active', 'inactive')
        AND ($1::boolean OR is_test = FALSE)
      ORDER BY normalized_code ASC
      `,
      [cleanBoolean(includeTest, 'includeTest', false)]
    );

    const results = [];
    const failures = [];
    for (const affiliate of affiliateResult.rows) {
      try {
        const refreshed = await refreshMonthlyPayout({
          affiliateId: affiliate.id,
          payoutPeriod: cleanPeriod,
          finalize: true,
          markReconciled,
          actor,
        });
        results.push({
          affiliateId: affiliate.id,
          customCode: affiliate.normalized_code,
          status: refreshed?.payout?.status || 'reconciled_locked_payout',
          dataStatus: refreshed?.payout?.data_status || null,
        });
      } catch (error) {
        failures.push({
          affiliateId: affiliate.id,
          customCode: affiliate.normalized_code,
          code: error?.code || 'affiliate_payout_finalize_failed',
          message: error?.message || 'Payout finalization failed.',
        });
      }
    }

    return {
      payoutPeriod: cleanPeriod,
      attempted: affiliateResult.rowCount,
      finalized: results.length,
      failures,
      results,
    };
  }

  async function createManualAdjustment({
    affiliateId,
    amount,
    targetPeriod,
    sourcePeriod = null,
    adjustmentType = 'manual_correction',
    reason,
    idempotencyKey,
    actor = 'admin',
  } = {}) {
    if (!UUID_RE.test(String(affiliateId || ''))) {
      throw statusError(400, 'Invalid affiliate ID.', 'invalid_affiliate_id');
    }
    const cleanAmount = String(amount ?? '').trim();
    if (!/^-?\d+(?:\.\d{1,6})?$/.test(cleanAmount) || decimalStringToMicros(cleanAmount) === 0n) {
      throw statusError(400, 'Adjustment amount must be a non-zero exact decimal.', 'invalid_adjustment_amount');
    }
    const cleanTarget = cleanPayoutPeriod(targetPeriod);
    const cleanSource = sourcePeriod ? cleanPayoutPeriod(sourcePeriod) : null;
    const cleanType = String(adjustmentType || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,80}$/.test(cleanType)) {
      throw statusError(400, 'Invalid adjustment type.', 'invalid_adjustment_type');
    }
    const cleanReason = cleanRequiredText(reason, 'reason', 1000);
    const cleanKey = cleanIdempotencyKey(idempotencyKey);

    const result = await withTransaction(pool, async (client) => {
      const affiliateResult = await client.query(
        `SELECT * FROM affiliates WHERE id = $1 LIMIT 1`,
        [affiliateId]
      );
      const affiliate = affiliateResult.rows[0];
      if (!affiliate) throw statusError(404, 'Affiliate not found.', 'affiliate_not_found');
      const environment = affiliate.is_test ? 'test' : 'production';

      const payoutResult = await client.query(
        `
        SELECT * FROM affiliate_monthly_payouts
        WHERE affiliate_id = $1 AND payout_period = $2::date AND environment = $3
        FOR UPDATE
        `,
        [affiliateId, cleanTarget, environment]
      );
      const payout = payoutResult.rows[0] || null;
      if (payout?.locked_at || ['partially_paid', 'paid'].includes(payout?.status)) {
        throw statusError(409, 'Adjustments cannot target a locked payout month.', 'adjustment_target_locked');
      }

      const relatedSourceKey = `manual:${cleanKey}`;
      const adjustmentResult = await client.query(
        `
        INSERT INTO affiliate_adjustments (
          affiliate_id, monthly_payout_id, adjustment_type, amount, currency,
          source_period, target_period, reason, related_source_key, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (affiliate_id, related_source_key)
          WHERE related_source_key IS NOT NULL
        DO NOTHING
        RETURNING *
        `,
        [
          affiliateId,
          payout?.id || null,
          cleanType,
          cleanAmount,
          affiliate.payout_currency || 'USD',
          cleanSource,
          cleanTarget,
          cleanReason,
          relatedSourceKey,
          actor,
        ]
      );

      let adjustment = adjustmentResult.rows[0] || null;
      let duplicate = false;
      if (!adjustment) {
        const existing = await client.query(
          `SELECT * FROM affiliate_adjustments WHERE affiliate_id = $1 AND related_source_key = $2 LIMIT 1`,
          [affiliateId, relatedSourceKey]
        );
        adjustment = existing.rows[0] || null;
        duplicate = true;
      }

      if (!duplicate) {
        await client.query(
          `
          INSERT INTO affiliate_admin_audit_log (
            admin_actor, action_type, affiliate_id, related_record_type,
            related_record_id, reason, after_value
          )
          VALUES ($1, 'affiliate_adjustment_created', $2, 'affiliate_adjustment', $3, $4, $5::jsonb)
          `,
          [
            actor,
            affiliateId,
            adjustment.id,
            cleanReason,
            JSON.stringify({ amount: cleanAmount, targetPeriod: cleanTarget, sourcePeriod: cleanSource, adjustmentType: cleanType }),
          ]
        );
      }

      return { adjustment, duplicate };
    });

    await refreshMonthlyPayout({
      affiliateId,
      payoutPeriod: cleanTarget,
      finalize: false,
      actor,
    });
    return result;
  }

  async function recordPayoutPayment({
    payoutId,
    amount,
    paymentDate,
    paymentMethod,
    paymentReference,
    note,
    idempotencyKey,
    actor = 'admin',
  } = {}) {
    if (!UUID_RE.test(String(payoutId || ''))) {
      throw statusError(400, 'Invalid payout ID.', 'invalid_payout_id');
    }

    const cleanAmount = String(amount ?? '').trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(cleanAmount) || Number(cleanAmount) <= 0) {
      throw statusError(400, 'Payment amount must be positive currency.', 'invalid_payout_amount');
    }
    const cleanPaymentDate = cleanDate(paymentDate, 'paymentDate');
    const accountingToday = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE).toISODate();
    if (cleanPaymentDate > accountingToday) {
      throw statusError(400, 'Payment date cannot be in the future.', 'future_payment_date');
    }
    const cleanKey = cleanIdempotencyKey(idempotencyKey);
    let carryForward = null;

    const result = await withTransaction(pool, async (client) => {
      const payoutResult = await client.query(
        `
        SELECT p.*, a.payout_currency, a.display_name, a.is_test
        FROM affiliate_monthly_payouts p
        JOIN affiliates a ON a.id = p.affiliate_id
        WHERE p.id = $1
        FOR UPDATE OF p
        `,
        [payoutId]
      );
      const payout = payoutResult.rows[0];

      if (!payout) throw statusError(404, 'Payout not found.', 'payout_not_found');
      if (!payout.is_test && !allowAnalyticsEstimatePayouts) {
        throw statusError(
          409,
          'Production affiliate payout payments are disabled because Apple Analytics custom-code counts are privacy-adjusted estimates. Explicitly approve this payout basis before enabling them.',
          'analytics_estimate_payouts_not_approved'
        );
      }
      if (payout.status === 'open') {
        throw statusError(409, 'Open payouts cannot be marked paid.', 'payout_still_open');
      }
      if (!['provisional', 'reconciled'].includes(payout.data_status)) {
        throw statusError(
          409,
          'Payout has unresolved Apple data or pricing issues and cannot be paid yet.',
          'payout_not_payable'
        );
      }

      const existingPayment = await client.query(
        `
        SELECT * FROM affiliate_payout_payments
        WHERE monthly_payout_id = $1 AND idempotency_key = $2
        LIMIT 1
        `,
        [payout.id, cleanKey]
      );
      if (existingPayment.rows[0]) {
        return { payment: existingPayment.rows[0], payout, duplicate: true, carryForward: null };
      }

      const paymentResult = await client.query(
        `
        INSERT INTO affiliate_payout_payments (
          monthly_payout_id,
          affiliate_id,
          entry_type,
          amount,
          currency,
          payment_date,
          payment_method,
          payment_reference,
          note,
          idempotency_key,
          created_by
        )
        VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
        `,
        [
          payout.id,
          payout.affiliate_id,
          cleanAmount,
          payout.payout_currency || 'USD',
          cleanPaymentDate,
          cleanText(paymentMethod, 120),
          cleanText(paymentReference, 300),
          cleanText(note, 1000),
          cleanKey,
          actor,
        ]
      );

      const sumResult = await client.query(
        `
        SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text AS amount_paid
        FROM affiliate_payout_payments
        WHERE monthly_payout_id = $1
        `,
        [payout.id]
      );
      const amountPaid = sumResult.rows[0]?.amount_paid || '0.00';

      const statusResult = await client.query(
        `
        UPDATE affiliate_monthly_payouts
        SET amount_paid = $2,
            status = CASE
              WHEN $2::numeric >= amount_due THEN 'paid'
              ELSE 'partially_paid'
            END,
            locked_at = COALESCE(locked_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [payout.id, amountPaid]
      );
      const updatedPayout = statusResult.rows[0];

      carryForward = await syncOverpaymentCarryForward(client, {
        payout,
        amountPaid,
        actor,
        sourceRecordId: paymentResult.rows[0].id,
      });

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor,
          action_type,
          affiliate_id,
          related_record_type,
          related_record_id,
          after_value
        )
        VALUES ($1, 'affiliate_payout_payment_recorded', $2, 'affiliate_payout_payment', $3, $4::jsonb)
        `,
        [
          actor,
          payout.affiliate_id,
          paymentResult.rows[0].id,
          JSON.stringify({
            amount: cleanAmount,
            paymentDate: cleanPaymentDate,
            paymentMethod: cleanText(paymentMethod, 120),
            idempotencyKey: cleanKey,
            resultingStatus: updatedPayout.status,
          }),
        ]
      );

      if (updatedPayout.status === 'paid') {
        await client.query(
          `
          UPDATE affiliate_alerts
          SET status = 'resolved', resolved_at = NOW(), resolved_by = $2,
              resolution_note = 'Payout payment completed.'
          WHERE dedupe_key = $1 AND status = 'open'
          `,
          [`payout_due:${payout.id}`, actor]
        );
      }

      return {
        payment: paymentResult.rows[0],
        payout: updatedPayout,
        duplicate: false,
        carryForward,
      };
    });

    if (carryForward?.target_period) {
      await refreshMonthlyPayout({
        affiliateId: result.payout.affiliate_id,
        payoutPeriod: carryForward.target_period,
        finalize: false,
        actor,
      });
    }

    return result;
  }

  async function recordPayoutPaymentCorrection({
    payoutId,
    paymentId,
    amount,
    paymentDate,
    reason,
    idempotencyKey,
    actor = 'admin',
  } = {}) {
    if (!UUID_RE.test(String(payoutId || '')) || !UUID_RE.test(String(paymentId || ''))) {
      throw statusError(400, 'Invalid payout or payment ID.', 'invalid_payment_correction_id');
    }
    const cleanAmount = String(amount ?? '').trim();
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleanAmount) || Number(cleanAmount) === 0) {
      throw statusError(400, 'Correction amount must be a non-zero currency amount.', 'invalid_payment_correction_amount');
    }
    const cleanReason = cleanRequiredText(reason, 'reason', 1000);
    const cleanPaymentDate = cleanDate(paymentDate, 'paymentDate');
    const accountingToday = DateTime.now().setZone(AFFILIATE_ACCOUNTING_TIMEZONE).toISODate();
    if (cleanPaymentDate > accountingToday) {
      throw statusError(400, 'Payment date cannot be in the future.', 'future_payment_date');
    }
    const cleanKey = cleanIdempotencyKey(idempotencyKey);
    let carryForward = null;

    const result = await withTransaction(pool, async (client) => {
      const payoutResult = await client.query(
        `
        SELECT p.*, a.payout_currency
        FROM affiliate_monthly_payouts p
        JOIN affiliates a ON a.id = p.affiliate_id
        WHERE p.id = $1
        FOR UPDATE OF p
        `,
        [payoutId]
      );
      const payout = payoutResult.rows[0];
      if (!payout) throw statusError(404, 'Payout not found.', 'payout_not_found');

      const originalResult = await client.query(
        `
        SELECT * FROM affiliate_payout_payments
        WHERE id = $1 AND monthly_payout_id = $2 AND entry_type = 'payment'
        LIMIT 1
        `,
        [paymentId, payoutId]
      );
      const original = originalResult.rows[0];
      if (!original) throw statusError(404, 'Original payout payment not found.', 'payment_not_found');

      const existing = await client.query(
        `SELECT * FROM affiliate_payout_payments WHERE monthly_payout_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [payoutId, cleanKey]
      );
      if (existing.rows[0]) {
        return { correction: existing.rows[0], payout, duplicate: true };
      }

      const correctionResult = await client.query(
        `
        INSERT INTO affiliate_payout_payments (
          monthly_payout_id, affiliate_id, entry_type, amount, currency,
          payment_date, note, idempotency_key, correction_of_payment_id, created_by
        )
        VALUES ($1, $2, 'correction', $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          payoutId,
          payout.affiliate_id,
          cleanAmount,
          original.currency,
          cleanPaymentDate,
          cleanReason,
          cleanKey,
          original.id,
          actor,
        ]
      );

      const sumResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(18,2)::text AS amount_paid FROM affiliate_payout_payments WHERE monthly_payout_id = $1`,
        [payoutId]
      );
      const amountPaid = sumResult.rows[0]?.amount_paid || '0.00';
      if (Number(amountPaid) < 0) {
        throw statusError(409, 'Payment correction would make the payout payment total negative.', 'invalid_payment_correction_total');
      }

      const updatedResult = await client.query(
        `
        UPDATE affiliate_monthly_payouts
        SET amount_paid = $2,
            status = CASE
              WHEN $2::numeric >= amount_due THEN 'paid'
              WHEN $2::numeric > 0 THEN 'partially_paid'
              ELSE 'ready_to_pay'
            END,
            locked_at = COALESCE(locked_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [payoutId, amountPaid]
      );

      carryForward = await syncOverpaymentCarryForward(client, {
        payout,
        amountPaid,
        actor,
        sourceRecordId: correctionResult.rows[0].id,
      });

      await client.query(
        `
        INSERT INTO affiliate_admin_audit_log (
          admin_actor, action_type, affiliate_id, related_record_type,
          related_record_id, reason, after_value
        )
        VALUES ($1, 'affiliate_payout_payment_corrected', $2, 'affiliate_payout_payment', $3, $4, $5::jsonb)
        `,
        [
          actor,
          payout.affiliate_id,
          correctionResult.rows[0].id,
          cleanReason,
          JSON.stringify({ amount: cleanAmount, correctionOf: original.id, idempotencyKey: cleanKey }),
        ]
      );

      return {
        correction: correctionResult.rows[0],
        payout: updatedResult.rows[0],
        duplicate: false,
        carryForward,
      };
    });

    if (carryForward?.target_period) {
      await refreshMonthlyPayout({
        affiliateId: result.payout.affiliate_id,
        payoutPeriod: carryForward.target_period,
        finalize: false,
        actor,
      });
    }

    return result;
  }

  return Object.freeze({
    createAffiliate,
    listAffiliates,
    findAffiliateByCode,
    recordReferralClick,
    resolvePartnerToken,
    getDashboardData,
    getPartnerDashboardLink,
    regeneratePartnerToken,
    importNormalizedAppleMetrics,
    refreshMonthlyPayout,
    finalizeAffiliatePayoutsForPeriod,
    createManualAdjustment,
    recordPayoutPayment,
    recordPayoutPaymentCorrection,
    buildPartnerUrl,
    buildReferralUrl,
  });
}
