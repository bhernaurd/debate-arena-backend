const BREAKDOWN_TIME_ZONE = 'America/Chicago';
const MONTHLY_PRODUCT_ID = 'agora_pro_monthly';
const ANNUAL_PRODUCT_ID = 'agora_pro_yearly';
const LIFETIME_PRODUCT_ID = 'agora_pro_lifetime';

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSnapshot(row = {}, month = null) {
  return {
    month,
    totalSubscribers: numberValue(row.total_subscribers),
    freePeriod: numberValue(row.free_period),
    paidMonthly: numberValue(row.paid_monthly),
    paidAnnual: numberValue(row.paid_annual),
    lifetime: numberValue(row.lifetime),
    canceling: numberValue(row.canceling),
  };
}

export async function loadSubscriptionAdminBreakdown(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL pool is required for subscription breakdown.');
  }

  const [currentResult, monthlyResult] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
        )::int AS total_subscribers,
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
            AND is_recurring_pro
            AND (
              is_trial = TRUE
              OR price_milliunits = 0
            )
        )::int AS free_period,
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
            AND product_id = '${MONTHLY_PRODUCT_ID}'
            AND NOT (
              is_trial = TRUE
              OR price_milliunits = 0
            )
        )::int AS paid_monthly,
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
            AND product_id = '${ANNUAL_PRODUCT_ID}'
            AND NOT (
              is_trial = TRUE
              OR price_milliunits = 0
            )
        )::int AS paid_annual,
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
            AND is_lifetime_pro
        )::int AS lifetime,
        COUNT(*) FILTER (
          WHERE environment = 'Production'
            AND has_pro_access
            AND is_recurring_pro
            AND auto_renew_enabled = FALSE
        )::int AS canceling
      FROM subscription_admin_current_customers_v1
    `),
    pool.query(`
      WITH bounds AS (
        SELECT DATE_TRUNC(
          'month',
          MIN(purchase_date AT TIME ZONE '${BREAKDOWN_TIME_ZONE}')
        ) AS first_month
        FROM app_store_transactions
        WHERE environment = 'Production'
          AND purchase_date IS NOT NULL
      ),
      months AS (
        SELECT
          month_start,
          (month_start + INTERVAL '1 month') AT TIME ZONE '${BREAKDOWN_TIME_ZONE}' AS month_end
        FROM bounds,
        LATERAL GENERATE_SERIES(
          first_month,
          DATE_TRUNC('month', NOW() AT TIME ZONE '${BREAKDOWN_TIME_ZONE}') - INTERVAL '1 month',
          INTERVAL '1 month'
        ) AS month_start
        WHERE first_month IS NOT NULL
      ),
      identity_map AS (
        SELECT
          original_transaction_id,
          environment,
          MIN(customer_key) AS customer_key
        FROM subscription_admin_customers_v1
        GROUP BY original_transaction_id, environment
      ),
      transaction_facts AS (
        SELECT
          transaction.*,
          COALESCE(identity.customer_key, transaction.original_transaction_id) AS customer_key
        FROM app_store_transactions transaction
        LEFT JOIN identity_map identity
          ON identity.original_transaction_id = transaction.original_transaction_id
         AND identity.environment = transaction.environment
        WHERE transaction.environment = 'Production'
      ),
      active_chain_transactions AS (
        SELECT
          TO_CHAR(month.month_start, 'YYYY-MM') AS month_key,
          month.month_end,
          transaction.customer_key,
          transaction.original_transaction_id,
          transaction.product_id,
          transaction.is_trial,
          transaction.price_milliunits,
          transaction.purchase_date,
          transaction.signed_date,
          ROW_NUMBER() OVER (
            PARTITION BY month.month_start, transaction.original_transaction_id
            ORDER BY
              transaction.purchase_date DESC NULLS LAST,
              transaction.signed_date DESC NULLS LAST,
              transaction.transaction_id DESC
          )::int AS chain_rank
        FROM months month
        JOIN transaction_facts transaction
          ON transaction.purchase_date < month.month_end
         AND (
              (
                transaction.product_id = '${LIFETIME_PRODUCT_ID}'
                AND (
                  transaction.revocation_date IS NULL
                  OR transaction.revocation_date >= month.month_end
                )
              )
              OR
              (
                transaction.product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}')
                AND transaction.expires_date IS NOT NULL
                AND transaction.expires_date >= month.month_end
                AND (
                  transaction.revocation_date IS NULL
                  OR transaction.revocation_date >= month.month_end
                )
              )
            )
      ),
      active_chains AS (
        SELECT
          chain.*,
          event.auto_renew_enabled
        FROM active_chain_transactions chain
        LEFT JOIN LATERAL (
          SELECT subscription_event.auto_renew_enabled
          FROM subscription_events subscription_event
          WHERE subscription_event.environment = 'Production'
            AND subscription_event.original_transaction_id = chain.original_transaction_id
            AND subscription_event.event_at < chain.month_end
            AND subscription_event.auto_renew_enabled IS NOT NULL
          ORDER BY
            subscription_event.event_at DESC,
            subscription_event.event_key DESC
          LIMIT 1
        ) event ON TRUE
        WHERE chain.chain_rank = 1
      ),
      customer_ranked AS (
        SELECT
          chain.*,
          ROW_NUMBER() OVER (
            PARTITION BY chain.month_key, chain.customer_key
            ORDER BY
              CASE
                WHEN chain.product_id = '${LIFETIME_PRODUCT_ID}' THEN 0
                WHEN chain.product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}')
                  AND NOT (chain.is_trial = TRUE OR chain.price_milliunits = 0)
                  AND chain.auto_renew_enabled = TRUE THEN 1
                WHEN chain.product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}')
                  AND NOT (chain.is_trial = TRUE OR chain.price_milliunits = 0) THEN 2
                WHEN chain.product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}') THEN 3
                ELSE 4
              END,
              chain.purchase_date DESC NULLS LAST,
              chain.signed_date DESC NULLS LAST,
              chain.original_transaction_id DESC
          )::int AS customer_rank
        FROM active_chains chain
      )
      SELECT
        month_key,
        COUNT(*)::int AS total_subscribers,
        COUNT(*) FILTER (
          WHERE product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}')
            AND (is_trial = TRUE OR price_milliunits = 0)
        )::int AS free_period,
        COUNT(*) FILTER (
          WHERE product_id = '${MONTHLY_PRODUCT_ID}'
            AND NOT (is_trial = TRUE OR price_milliunits = 0)
        )::int AS paid_monthly,
        COUNT(*) FILTER (
          WHERE product_id = '${ANNUAL_PRODUCT_ID}'
            AND NOT (is_trial = TRUE OR price_milliunits = 0)
        )::int AS paid_annual,
        COUNT(*) FILTER (
          WHERE product_id = '${LIFETIME_PRODUCT_ID}'
        )::int AS lifetime,
        COUNT(*) FILTER (
          WHERE product_id IN ('${MONTHLY_PRODUCT_ID}', '${ANNUAL_PRODUCT_ID}')
            AND auto_renew_enabled = FALSE
        )::int AS canceling
      FROM customer_ranked
      WHERE customer_rank = 1
      GROUP BY month_key
      ORDER BY month_key ASC
    `),
  ]);

  const current = normalizeSnapshot(currentResult.rows[0] || {}, 'current');
  const months = (monthlyResult.rows || []).map((row) =>
    normalizeSnapshot(row, String(row.month_key || ''))
  );

  return {
    generatedAt: new Date().toISOString(),
    timeZone: BREAKDOWN_TIME_ZONE,
    current,
    months,
  };
}

export default loadSubscriptionAdminBreakdown;
