import crypto from 'node:crypto';
import express from 'express';

const VALID_ENVIRONMENTS = new Map([
  ['production', 'Production'],
  ['sandbox', 'Sandbox'],
  ['all', null],
]);

const VALID_ACCESS_SOURCES = new Set([
  'monthly',
  'annual',
  'lifetime',
]);

const VALID_STATUSES = new Set([
  'trial',
  'active',
  'grace_period',
  'billing_retry',
  'expired',
  'revoked',
  'unknown',
]);

function cleanText(value, maxLength = 500) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeEnvironment(value, fallback = 'Production') {
  const raw = cleanText(value, 32).toLowerCase();
  const key = raw || fallback.toLowerCase();

  if (!VALID_ENVIRONMENTS.has(key)) {
    const error = new Error('environment must be Production, Sandbox, or all.');
    error.statusCode = 400;
    error.code = 'invalid_environment';
    throw error;
  }

  return VALID_ENVIRONMENTS.get(key);
}

function normalizeOptionalAccessSource(value) {
  const clean = cleanText(value, 32).toLowerCase();
  if (!clean || clean === 'all') return null;

  if (!VALID_ACCESS_SOURCES.has(clean)) {
    const error = new Error('accessSource must be monthly, annual, lifetime, or all.');
    error.statusCode = 400;
    error.code = 'invalid_access_source';
    throw error;
  }

  return clean;
}

function normalizeOptionalStatus(value) {
  const clean = cleanText(value, 32).toLowerCase();
  if (!clean || clean === 'all') return null;

  if (!VALID_STATUSES.has(clean)) {
    const error = new Error('status is not a recognized subscription state.');
    error.statusCode = 400;
    error.code = 'invalid_status';
    throw error;
  }

  return clean;
}

function normalizeBooleanQuery(value, fieldName) {
  const clean = cleanText(value, 16).toLowerCase();
  if (!clean || clean === 'all') return null;
  if (['true', '1', 'yes', 'on'].includes(clean)) return true;
  if (['false', '0', 'no', 'off'].includes(clean)) return false;

  const error = new Error(`${fieldName} must be true, false, or all.`);
  error.statusCode = 400;
  error.code = 'invalid_boolean_filter';
  throw error;
}

function requireAdminKey(adminKey) {
  const expected = cleanText(adminKey, 4096);

  return (req, res, next) => {
    // Temporary server/CLI control-plane authentication. The web dashboard
    // will use a separate owner session so this key never ships in browser JS.
    if (expected.length < 32) {
      return res.status(503).json({
        success: false,
        error: {
          code: 'subscription_admin_not_configured',
          message: 'Subscription admin authentication is not configured.',
        },
      });
    }

    const supplied = cleanText(req.get('x-admin-key'), 4096);
    const left = Buffer.from(supplied, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    const matches =
      left.length === right.length &&
      crypto.timingSafeEqual(left, right);

    if (!matches) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'subscription_admin_unauthorized',
          message: 'Unauthorized.',
        },
      });
    }

    return next();
  };
}

function privateApiHeaders(_req, res, next) {
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return next();
}

function jsonError(res, error) {
  const statusCode = Number(error?.statusCode) || 500;
  const code = error?.code || 'subscription_admin_internal_error';

  if (statusCode >= 500) {
    console.error('[SubscriptionAdminAPI]', error);
  }

  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message:
        statusCode >= 500
          ? 'Subscription dashboard request failed.'
          : error.message,
    },
  });
}

function normalizeMetrics(row = {}) {
  const integerFields = [
    'active_pro_entitlements',
    'active_paid_subscribers',
    'active_trials',
    'active_lifetime_pro',
    'paid_monthly',
    'paid_annual',
    'canceling_subscriptions',
    'billing_retry_subscriptions',
    'revoked_entitlements',
    'affiliate_attributed_recurring_chains',
    'sandbox_active_pro_entitlements',
  ];

  const output = { ...row };
  for (const field of integerFields) {
    output[field] = Number(row[field] || 0);
  }
  output.estimated_mrr_usd = Number(row.estimated_mrr_usd || 0);
  return output;
}

function buildCustomerFilters(query) {
  const environment = normalizeEnvironment(query.environment, 'Production');
  const accessSource = normalizeOptionalAccessSource(query.accessSource);
  const status = normalizeOptionalStatus(query.status);
  const hasProAccess = normalizeBooleanQuery(query.hasProAccess, 'hasProAccess');
  const recurring = normalizeBooleanQuery(query.recurring, 'recurring');
  const search = cleanText(query.q, 200);

  const clauses = [];
  const values = [];

  function add(value, sql) {
    values.push(value);
    clauses.push(sql.replace('?', `$${values.length}`));
  }

  if (environment) add(environment, 'environment = ?');
  if (accessSource) add(accessSource, 'pro_access_source = ?');
  if (status) add(status, 'status = ?');
  if (hasProAccess !== null) add(hasProAccess, 'has_pro_access = ?');
  if (recurring !== null) add(recurring, 'is_recurring_pro = ?');

  if (search) {
    values.push(`%${search}%`);
    const p = `$${values.length}`;
    clauses.push(`(
      customer_key ILIKE ${p}
      OR COALESCE(account_id::text, '') ILIKE ${p}
      OR COALESCE(account_email, '') ILIKE ${p}
      OR COALESCE(account_display_name, '') ILIKE ${p}
      OR original_transaction_id ILIKE ${p}
      OR COALESCE(latest_transaction_id, '') ILIKE ${p}
      OR COALESCE(affiliate_code, '') ILIKE ${p}
    )`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

export function createSubscriptionAdminRouter(
  pool,
  {
    adminKey =
      process.env.SUBSCRIPTION_DASHBOARD_ADMIN_KEY ||
      process.env.ANALYTICS_ADMIN_KEY,
  } = {}
) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL pool is required for the subscription admin API.');
  }

  const router = express.Router();
  router.use(privateApiHeaders);
  router.use(requireAdminKey(adminKey));

  router.get('/overview', async (_req, res) => {
    try {
      const [metricsResult, sourceResult, statusResult, recentResult] =
        await Promise.all([
          pool.query('SELECT * FROM subscription_admin_business_metrics_v1'),
          pool.query(`
            SELECT
              pro_access_source,
              COUNT(*) FILTER (WHERE has_pro_access)::int AS active_pro,
              COUNT(*) FILTER (WHERE recurring_revenue_active)::int AS paid_recurring,
              COUNT(*) FILTER (WHERE trial_active)::int AS trials,
              ROUND(COALESCE(SUM(estimated_mrr_usd), 0), 2) AS estimated_mrr_usd
            FROM subscription_admin_current_customers_v1
            WHERE environment = 'Production'
            GROUP BY pro_access_source
            ORDER BY pro_access_source
          `),
          pool.query(`
            SELECT status, COUNT(*)::int AS count
            FROM subscription_admin_current_customers_v1
            WHERE environment = 'Production'
            GROUP BY status
            ORDER BY count DESC, status ASC
          `),
          pool.query(`
            SELECT
              customer_key,
              original_transaction_id,
              environment,
              account_id,
              account_display_name,
              account_email,
              identity_source,
              product_id,
              pro_access_source,
              status,
              has_pro_access,
              is_trial,
              is_recurring_pro,
              is_lifetime_pro,
              auto_renew_enabled,
              canceling,
              access_ends_at,
              pricing_cohort,
              affiliate_code,
              latest_transaction_id,
              latest_transaction_reason,
              latest_transaction_signed_date,
              currency,
              price_milliunits,
              updated_at
            FROM subscription_admin_current_customers_v1
            WHERE environment = 'Production'
            ORDER BY
              COALESCE(latest_transaction_signed_date, updated_at) DESC NULLS LAST,
              customer_key ASC
            LIMIT 12
          `),
        ]);

      return res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        metrics: normalizeMetrics(metricsResult.rows[0] || {}),
        byAccessSource: sourceResult.rows.map((row) => ({
          ...row,
          active_pro: Number(row.active_pro || 0),
          paid_recurring: Number(row.paid_recurring || 0),
          trials: Number(row.trials || 0),
          estimated_mrr_usd: Number(row.estimated_mrr_usd || 0),
        })),
        byStatus: statusResult.rows.map((row) => ({
          ...row,
          count: Number(row.count || 0),
        })),
        recentCustomers: recentResult.rows,
      });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/customers', async (req, res) => {
    try {
      const limit = boundedInteger(req.query.limit, 50, 1, 100);
      const offset = boundedInteger(req.query.offset, 0, 0, 100000);
      const filters = buildCustomerFilters(req.query);

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM subscription_admin_current_customers_v1
         ${filters.whereSql}`,
        filters.values
      );

      const values = [...filters.values, limit, offset];
      const limitParam = `$${values.length - 1}`;
      const offsetParam = `$${values.length}`;

      const customersResult = await pool.query(
        `
        SELECT
          customer_key,
          original_transaction_id,
          environment,
          account_id,
          account_status,
          account_display_name,
          account_email,
          apple_email,
          apple_private_email,
          google_email,
          identity_source,
          installation_user_id,
          app_account_token,
          product_id,
          pro_access_source,
          status,
          has_pro_access,
          is_trial,
          is_recurring_pro,
          is_lifetime_pro,
          auto_renew_enabled,
          recurring_revenue_active,
          trial_active,
          canceling,
          access_ends_at,
          purchase_date,
          original_purchase_date,
          expires_date,
          grace_period_expires_date,
          revocation_date,
          pricing_cohort,
          affiliate_id,
          affiliate_display_name,
          affiliate_code,
          latest_transaction_id,
          latest_transaction_reason,
          latest_offer_type,
          latest_offer_identifier,
          latest_purchase_date,
          latest_transaction_signed_date,
          storefront,
          currency,
          price_milliunits,
          estimated_mrr_usd,
          created_at,
          updated_at
        FROM subscription_admin_current_customers_v1
        ${filters.whereSql}
        ORDER BY
          CASE WHEN has_pro_access THEN 0 ELSE 1 END,
          CASE WHEN environment = 'Production' THEN 0 ELSE 1 END,
          COALESCE(latest_transaction_signed_date, updated_at) DESC NULLS LAST,
          customer_key ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
        `,
        values
      );

      return res.json({
        success: true,
        total: Number(countResult.rows[0]?.count || 0),
        limit,
        offset,
        customers: customersResult.rows,
      });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/customers/:customerKey', async (req, res) => {
    try {
      const customerKey = cleanText(req.params.customerKey, 256);
      if (!customerKey) {
        const error = new Error('customerKey is required.');
        error.statusCode = 400;
        error.code = 'invalid_customer_key';
        throw error;
      }

      const chainsResult = await pool.query(
        `
        SELECT *
        FROM subscription_admin_customers_v1
        WHERE customer_key = $1
        ORDER BY
          CASE WHEN environment = 'Production' THEN 0 ELSE 1 END,
          CASE WHEN has_pro_access THEN 0 ELSE 1 END,
          updated_at DESC
        `,
        [customerKey]
      );

      if (chainsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'subscription_customer_not_found',
            message: 'Subscription customer was not found.',
          },
        });
      }

      const [transactionsResult, eventsResult] = await Promise.all([
        pool.query(
          `
          SELECT timeline.*
          FROM subscription_admin_transaction_timeline_v1 timeline
          JOIN subscription_admin_customers_v1 customer
            ON customer.original_transaction_id = timeline.original_transaction_id
           AND customer.environment = timeline.environment
          WHERE customer.customer_key = $1
          ORDER BY
            timeline.signed_date DESC NULLS LAST,
            timeline.purchase_date DESC NULLS LAST,
            timeline.updated_at DESC
          LIMIT 250
          `,
          [customerKey]
        ),
        pool.query(
          `
          SELECT
            event.event_key,
            event.notification_uuid,
            event.source,
            event.user_id,
            event.original_transaction_id,
            event.transaction_id,
            event.event_type,
            event.subtype,
            event.environment,
            event.product_id,
            event.status_after,
            event.is_trial,
            event.auto_renew_enabled,
            event.expires_date,
            event.event_at,
            event.metadata
          FROM subscription_events event
          JOIN subscription_admin_customers_v1 customer
            ON customer.original_transaction_id = event.original_transaction_id
           AND customer.environment = event.environment
          WHERE customer.customer_key = $1
          ORDER BY event.event_at DESC, event.event_key DESC
          LIMIT 250
          `,
          [customerKey]
        ),
      ]);

      return res.json({
        success: true,
        customerKey,
        chains: chainsResult.rows,
        transactions: transactionsResult.rows,
        events: eventsResult.rows,
      });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  router.get('/events', async (req, res) => {
    try {
      const environment = normalizeEnvironment(req.query.environment, 'Production');
      const limit = boundedInteger(req.query.limit, 50, 1, 200);
      const eventType = cleanText(req.query.eventType, 100).toUpperCase();
      const search = cleanText(req.query.q, 200);

      const clauses = [];
      const values = [];

      function add(value, sql) {
        values.push(value);
        clauses.push(sql.replace('?', `$${values.length}`));
      }

      if (environment) add(environment, 'event.environment = ?');
      if (eventType) add(eventType, 'UPPER(event.event_type) = ?');
      if (search) {
        values.push(`%${search}%`);
        const p = `$${values.length}`;
        clauses.push(`(
          COALESCE(customer.customer_key, '') ILIKE ${p}
          OR COALESCE(customer.account_email, '') ILIKE ${p}
          OR event.original_transaction_id ILIKE ${p}
          OR COALESCE(event.transaction_id, '') ILIKE ${p}
        )`);
      }

      values.push(limit);
      const limitParam = `$${values.length}`;
      const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const result = await pool.query(
        `
        SELECT
          event.event_key,
          event.notification_uuid,
          event.source,
          event.user_id,
          event.original_transaction_id,
          event.transaction_id,
          event.event_type,
          event.subtype,
          event.environment,
          event.product_id,
          event.status_after,
          event.is_trial,
          event.auto_renew_enabled,
          event.expires_date,
          event.event_at,
          event.metadata,
          customer.customer_key,
          customer.account_id,
          customer.account_display_name,
          customer.account_email,
          customer.pro_access_source,
          customer.affiliate_code
        FROM subscription_events event
        LEFT JOIN subscription_admin_customers_v1 customer
          ON customer.original_transaction_id = event.original_transaction_id
         AND customer.environment = event.environment
        ${whereSql}
        ORDER BY event.event_at DESC, event.event_key DESC
        LIMIT ${limitParam}
        `,
        values
      );

      return res.json({
        success: true,
        events: result.rows,
      });
    } catch (error) {
      return jsonError(res, error);
    }
  });

  return router;
}
