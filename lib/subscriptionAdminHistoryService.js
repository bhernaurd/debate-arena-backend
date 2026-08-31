import { getAppleFiscalPayoutCalendar } from './appleFiscalCalendar.js';
import { createSubscriptionUsdConverter } from './subscriptionUsdConversionService.js';

const HISTORY_TIME_ZONE = 'America/Chicago';
const LIFETIME_PRODUCT_ID = 'agora_pro_lifetime';

function monthKeyExpression(column) {
  return `TO_CHAR(DATE_TRUNC('month', ${column} AT TIME ZONE '${HISTORY_TIME_ZONE}'), 'YYYY-MM')`;
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentMonthKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HISTORY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return year && month ? `${year}-${month}` : new Date().toISOString().slice(0, 7);
}

function nextMonthKey(monthKey) {
  const [year, month] = String(monthKey).split('-').map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  const date = new Date(Date.UTC(year, month, 1));
  return date.toISOString().slice(0, 7);
}

function monthRange(firstMonth, lastMonth) {
  if (!firstMonth || !lastMonth) return [lastMonth || currentMonthKey()];

  const months = [];
  let cursor = firstMonth;
  let guard = 0;

  while (cursor && cursor <= lastMonth && guard < 240) {
    months.push(cursor);
    if (cursor === lastMonth) break;
    cursor = nextMonthKey(cursor);
    guard += 1;
  }

  return months.length ? months : [lastMonth];
}

function emptyMonth(month) {
  return {
    month,
    grossSales: {},
    refunds: {},
    netSales: {},
    appleReportedGrossSales: {},
    appleEstimatedProceeds: {},
    appleEstimatedDeductions: {},
    appleReportDays: 0,
    appleReportImportedThrough: null,
    paidTransactions: 0,
    newPaidSubscribers: 0,
    trialStarts: 0,
    trialConversions: 0,
    cancellationRequests: 0,
    subscriptionsEnded: 0,
    lifetimeGrants: 0,
    activeProAtMonthEnd: null,
  };
}

function addCurrencyAmount(target, currency, amount) {
  const code = String(currency || 'USD').trim().toUpperCase() || 'USD';
  target[code] = numberValue(target[code]) + numberValue(amount);
}

function finalizeCurrencyBag(bag) {
  return Object.fromEntries(
    Object.entries(bag || {})
      .map(([currency, amount]) => [currency, Math.round(numberValue(amount) * 100) / 100])
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function addBag(target, source) {
  for (const [currency, amount] of Object.entries(source || {})) {
    addCurrencyAmount(target, currency, amount);
  }
}

function allTimeFromMonths(months) {
  const allTime = {
    grossSales: {},
    refunds: {},
    netSales: {},
    appleReportedGrossSales: {},
    appleEstimatedProceeds: {},
    appleEstimatedDeductions: {},
    paidTransactions: 0,
    paidCustomers: 0,
    trialStarts: 0,
    trialConversions: 0,
    cancellationRequests: 0,
    subscriptionsEnded: 0,
    lifetimeGrants: 0,
  };

  for (const month of months) {
    addBag(allTime.grossSales, month.grossSales);
    addBag(allTime.refunds, month.refunds);
    addBag(allTime.netSales, month.netSales);
    addBag(allTime.appleReportedGrossSales, month.appleReportedGrossSales);
    addBag(allTime.appleEstimatedProceeds, month.appleEstimatedProceeds);
    addBag(allTime.appleEstimatedDeductions, month.appleEstimatedDeductions);

    allTime.paidTransactions += numberValue(month.paidTransactions);
    allTime.paidCustomers += numberValue(month.newPaidSubscribers);
    allTime.trialStarts += numberValue(month.trialStarts);
    allTime.trialConversions += numberValue(month.trialConversions);
    allTime.cancellationRequests += numberValue(month.cancellationRequests);
    allTime.subscriptionsEnded += numberValue(month.subscriptionsEnded);
    allTime.lifetimeGrants += numberValue(month.lifetimeGrants);
  }

  allTime.grossSales = finalizeCurrencyBag(allTime.grossSales);
  allTime.refunds = finalizeCurrencyBag(allTime.refunds);
  allTime.netSales = finalizeCurrencyBag(allTime.netSales);
  allTime.appleReportedGrossSales = finalizeCurrencyBag(allTime.appleReportedGrossSales);
  allTime.appleEstimatedProceeds = finalizeCurrencyBag(allTime.appleEstimatedProceeds);
  allTime.appleEstimatedDeductions = finalizeCurrencyBag(allTime.appleEstimatedDeductions);
  return allTime;
}

function normalizeFinancialPeriods(rows) {
  const byPeriod = new Map();

  for (const row of rows || []) {
    const key = String(row.report_date || '');
    if (!key) continue;

    if (!byPeriod.has(key)) {
      byPeriod.set(key, {
        reportDate: key,
        periodStart: row.period_start || null,
        periodEnd: row.period_end || null,
        finalProceeds: {},
        regions: new Set(),
      });
    }

    const period = byPeriod.get(key);
    if (row.period_start && (!period.periodStart || row.period_start < period.periodStart)) {
      period.periodStart = row.period_start;
    }
    if (row.period_end && (!period.periodEnd || row.period_end > period.periodEnd)) {
      period.periodEnd = row.period_end;
    }
    if (row.region_code) period.regions.add(row.region_code);
    addCurrencyAmount(period.finalProceeds, row.currency, row.final_proceeds);
  }

  return [...byPeriod.values()]
    .sort((left, right) => left.reportDate.localeCompare(right.reportDate))
    .map((period) => ({
      ...period,
      regions: [...period.regions].sort(),
      finalProceeds: finalizeCurrencyBag(period.finalProceeds),
    }));
}

export async function loadSubscriptionAdminHistory(
  pool,
  { currencyConverter = createSubscriptionUsdConverter() } = {}
) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL pool is required for subscription history.');
  }

  const salesMonth = monthKeyExpression('transaction.purchase_date');
  const refundMonth = monthKeyExpression('event.event_at');
  const milestoneMonth = monthKeyExpression('fact_at');
  const lifecycleMonth = monthKeyExpression('event.event_at');

  const [
    salesResult,
    refundResult,
    milestoneResult,
    lifecycleResult,
    activeResult,
    appleSalesResult,
    appleImportResult,
    financeResult,
    financeImportResult,
  ] = await Promise.all([
    pool.query(`
      SELECT
        ${salesMonth} AS month_key,
        COALESCE(NULLIF(UPPER(transaction.currency), ''), 'USD') AS currency,
        ROUND(SUM(transaction.price_milliunits)::numeric / 1000.0, 2) AS gross_sales,
        COUNT(*)::int AS paid_transactions
      FROM app_store_transactions transaction
      WHERE transaction.environment = 'Production'
        AND transaction.purchase_date IS NOT NULL
        AND transaction.is_trial = FALSE
        AND transaction.price_milliunits IS NOT NULL
        AND transaction.price_milliunits > 0
      GROUP BY month_key, currency
      ORDER BY month_key ASC, currency ASC
    `),
    pool.query(`
      WITH refunded_transactions AS (
        SELECT DISTINCT ON (event.transaction_id)
          event.transaction_id,
          event.event_at,
          transaction.currency,
          transaction.price_milliunits
        FROM subscription_events event
        JOIN app_store_transactions transaction
          ON transaction.transaction_id = event.transaction_id
         AND transaction.environment = event.environment
        WHERE event.environment = 'Production'
          AND UPPER(event.event_type) = 'REFUND'
          AND event.transaction_id IS NOT NULL
          AND transaction.price_milliunits IS NOT NULL
          AND transaction.price_milliunits > 0
        ORDER BY event.transaction_id, event.event_at ASC, event.event_key ASC
      )
      SELECT
        ${refundMonth.replaceAll('event.', 'refunded.')} AS month_key,
        COALESCE(NULLIF(UPPER(refunded.currency), ''), 'USD') AS currency,
        ROUND(SUM(refunded.price_milliunits)::numeric / 1000.0, 2) AS refunds
      FROM refunded_transactions refunded
      GROUP BY month_key, currency
      ORDER BY month_key ASC, currency ASC
    `),
    pool.query(`
      WITH identity_map AS (
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
      first_paid AS (
        SELECT DISTINCT ON (customer_key)
          customer_key,
          purchase_date AS fact_at
        FROM transaction_facts
        WHERE purchase_date IS NOT NULL
          AND is_trial = FALSE
          AND price_milliunits IS NOT NULL
          AND price_milliunits > 0
        ORDER BY customer_key, purchase_date ASC, signed_date ASC NULLS LAST, transaction_id ASC
      ),
      first_trial AS (
        SELECT DISTINCT ON (customer_key)
          customer_key,
          purchase_date AS fact_at
        FROM transaction_facts
        WHERE purchase_date IS NOT NULL
          AND is_trial = TRUE
        ORDER BY customer_key, purchase_date ASC, signed_date ASC NULLS LAST, transaction_id ASC
      ),
      trial_conversion AS (
        SELECT paid.customer_key, paid.fact_at
        FROM first_paid paid
        WHERE EXISTS (
          SELECT 1
          FROM transaction_facts trial
          WHERE trial.customer_key = paid.customer_key
            AND trial.is_trial = TRUE
            AND trial.purchase_date IS NOT NULL
            AND trial.purchase_date < paid.fact_at
        )
      ),
      lifetime_grant AS (
        SELECT DISTINCT ON (customer_key)
          customer_key,
          purchase_date AS fact_at
        FROM transaction_facts
        WHERE product_id = '${LIFETIME_PRODUCT_ID}'
          AND purchase_date IS NOT NULL
        ORDER BY customer_key, purchase_date ASC, signed_date ASC NULLS LAST, transaction_id ASC
      ),
      facts AS (
        SELECT fact_at, 'new_paid'::text AS kind FROM first_paid
        UNION ALL
        SELECT fact_at, 'trial_start'::text FROM first_trial
        UNION ALL
        SELECT fact_at, 'trial_conversion'::text FROM trial_conversion
        UNION ALL
        SELECT fact_at, 'lifetime_grant'::text FROM lifetime_grant
      )
      SELECT
        ${milestoneMonth} AS month_key,
        COUNT(*) FILTER (WHERE kind = 'new_paid')::int AS new_paid_subscribers,
        COUNT(*) FILTER (WHERE kind = 'trial_start')::int AS trial_starts,
        COUNT(*) FILTER (WHERE kind = 'trial_conversion')::int AS trial_conversions,
        COUNT(*) FILTER (WHERE kind = 'lifetime_grant')::int AS lifetime_grants
      FROM facts
      GROUP BY month_key
      ORDER BY month_key ASC
    `),
    pool.query(`
      WITH identity_map AS (
        SELECT
          original_transaction_id,
          environment,
          MIN(customer_key) AS customer_key
        FROM subscription_admin_customers_v1
        GROUP BY original_transaction_id, environment
      ),
      lifecycle AS (
        SELECT
          event.*,
          COALESCE(identity.customer_key, event.original_transaction_id) AS customer_key
        FROM subscription_events event
        LEFT JOIN identity_map identity
          ON identity.original_transaction_id = event.original_transaction_id
         AND identity.environment = event.environment
        WHERE event.environment = 'Production'
          AND event.source = 'apple_notification'
      )
      SELECT
        ${lifecycleMonth} AS month_key,
        COUNT(DISTINCT customer_key) FILTER (
          WHERE UPPER(event_type) = 'DID_CHANGE_RENEWAL_STATUS'
            AND UPPER(COALESCE(subtype, '')) = 'AUTO_RENEW_DISABLED'
        )::int AS cancellation_requests,
        COUNT(DISTINCT customer_key) FILTER (
          WHERE UPPER(event_type) = 'EXPIRED'
        )::int AS subscriptions_ended
      FROM lifecycle event
      WHERE UPPER(event_type) IN ('DID_CHANGE_RENEWAL_STATUS', 'EXPIRED')
      GROUP BY month_key
      ORDER BY month_key ASC
    `),
    pool.query(`
      WITH bounds AS (
        SELECT DATE_TRUNC('month', MIN(purchase_date AT TIME ZONE '${HISTORY_TIME_ZONE}')) AS first_month
        FROM app_store_transactions
        WHERE environment = 'Production'
          AND purchase_date IS NOT NULL
      ),
      months AS (
        SELECT month_start
        FROM bounds,
        LATERAL GENERATE_SERIES(
          first_month,
          DATE_TRUNC('month', NOW() AT TIME ZONE '${HISTORY_TIME_ZONE}') - INTERVAL '1 month',
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
      )
      SELECT
        TO_CHAR(month.month_start, 'YYYY-MM') AS month_key,
        COUNT(DISTINCT transaction.customer_key)::int AS active_pro_at_month_end
      FROM months month
      LEFT JOIN transaction_facts transaction
        ON transaction.purchase_date < (month.month_start + INTERVAL '1 month') AT TIME ZONE '${HISTORY_TIME_ZONE}'
       AND (
            (
              transaction.product_id = '${LIFETIME_PRODUCT_ID}'
              AND (
                transaction.revocation_date IS NULL
                OR transaction.revocation_date >= (month.month_start + INTERVAL '1 month') AT TIME ZONE '${HISTORY_TIME_ZONE}'
              )
            )
            OR
            (
              transaction.product_id IN ('agora_pro_monthly', 'agora_pro_yearly')
              AND transaction.expires_date IS NOT NULL
              AND transaction.expires_date >= (month.month_start + INTERVAL '1 month') AT TIME ZONE '${HISTORY_TIME_ZONE}'
              AND (
                transaction.revocation_date IS NULL
                OR transaction.revocation_date >= (month.month_start + INTERVAL '1 month') AT TIME ZONE '${HISTORY_TIME_ZONE}'
              )
            )
          )
      GROUP BY month.month_start
      ORDER BY month.month_start ASC
    `),
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', report_date), 'YYYY-MM') AS month_key,
        customer_currency,
        proceeds_currency,
        ROUND(COALESCE(SUM(gross_customer_amount), 0), 2) AS apple_reported_gross_sales,
        ROUND(COALESCE(SUM(developer_proceeds_amount), 0), 2) AS apple_estimated_proceeds
      FROM app_store_sales_report_rows
      WHERE product_id IN ('agora_pro_monthly', 'agora_pro_yearly', '${LIFETIME_PRODUCT_ID}')
      GROUP BY month_key, customer_currency, proceeds_currency
      ORDER BY month_key ASC, customer_currency ASC, proceeds_currency ASC
    `),
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', report_date), 'YYYY-MM') AS month_key,
        COUNT(*)::int AS imported_days,
        MAX(report_date) AS imported_through
      FROM app_store_sales_report_imports
      WHERE report_type = 'SALES'
        AND report_subtype = 'SUMMARY'
        AND frequency = 'DAILY'
      GROUP BY month_key
      ORDER BY month_key ASC
    `),
    pool.query(`
      SELECT
        report_date,
        region_code,
        MIN(period_start) AS period_start,
        MAX(period_end) AS period_end,
        COALESCE(NULLIF(UPPER(partner_share_currency), ''), 'USD') AS currency,
        ROUND(COALESCE(SUM(extended_partner_share), 0), 2) AS final_proceeds
      FROM app_store_finance_report_rows
      WHERE product_id IN ('agora_pro_monthly', 'agora_pro_yearly', '${LIFETIME_PRODUCT_ID}')
      GROUP BY report_date, region_code, currency
      ORDER BY report_date ASC, region_code ASC, currency ASC
    `),
    pool.query(`
      SELECT
        MAX(imported_at) AS last_finance_imported_at,
        COUNT(*)::int AS finance_report_count
      FROM app_store_finance_report_imports
    `),
  ]);

  const current = currentMonthKey();
  const observedKeys = [
    ...salesResult.rows,
    ...refundResult.rows,
    ...milestoneResult.rows,
    ...lifecycleResult.rows,
    ...activeResult.rows,
    ...appleSalesResult.rows,
    ...appleImportResult.rows,
  ]
    .map((row) => String(row.month_key || ''))
    .filter(Boolean)
    .sort();

  const first = observedKeys[0] || current;
  const byMonth = new Map(
    monthRange(first, current).map((month) => [month, emptyMonth(month)])
  );

  function ensure(month) {
    if (!month) return null;
    if (!byMonth.has(month)) byMonth.set(month, emptyMonth(month));
    return byMonth.get(month);
  }

  for (const row of salesResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    addCurrencyAmount(month.grossSales, row.currency, row.gross_sales);
    month.paidTransactions += numberValue(row.paid_transactions);
  }

  for (const row of refundResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    addCurrencyAmount(month.refunds, row.currency, row.refunds);
  }

  for (const row of milestoneResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    month.newPaidSubscribers += numberValue(row.new_paid_subscribers);
    month.trialStarts += numberValue(row.trial_starts);
    month.trialConversions += numberValue(row.trial_conversions);
    month.lifetimeGrants += numberValue(row.lifetime_grants);
  }

  for (const row of lifecycleResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    month.cancellationRequests += numberValue(row.cancellation_requests);
    month.subscriptionsEnded += numberValue(row.subscriptions_ended);
  }

  for (const row of activeResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    month.activeProAtMonthEnd = numberValue(row.active_pro_at_month_end);
  }

  for (const row of appleSalesResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    addCurrencyAmount(
      month.appleReportedGrossSales,
      row.customer_currency,
      row.apple_reported_gross_sales
    );
    addCurrencyAmount(
      month.appleEstimatedProceeds,
      row.proceeds_currency,
      row.apple_estimated_proceeds
    );
  }

  for (const row of appleImportResult.rows) {
    const month = ensure(row.month_key);
    if (!month) continue;
    month.appleReportDays = numberValue(row.imported_days);
    month.appleReportImportedThrough = row.imported_through || null;
  }

  const months = [...byMonth.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((month) => {
      const currencies = new Set([
        ...Object.keys(month.grossSales),
        ...Object.keys(month.refunds),
      ]);

      for (const currency of currencies) {
        month.netSales[currency] =
          numberValue(month.grossSales[currency]) -
          numberValue(month.refunds[currency]);
      }

      const appleCurrencies = new Set([
        ...Object.keys(month.appleReportedGrossSales),
        ...Object.keys(month.appleEstimatedProceeds),
      ]);
      for (const currency of appleCurrencies) {
        if (
          Object.hasOwn(month.appleReportedGrossSales, currency) &&
          Object.hasOwn(month.appleEstimatedProceeds, currency)
        ) {
          month.appleEstimatedDeductions[currency] =
            numberValue(month.appleReportedGrossSales[currency]) -
            numberValue(month.appleEstimatedProceeds[currency]);
        }
      }

      month.grossSales = finalizeCurrencyBag(month.grossSales);
      month.refunds = finalizeCurrencyBag(month.refunds);
      month.netSales = finalizeCurrencyBag(month.netSales);
      month.appleReportedGrossSales = finalizeCurrencyBag(month.appleReportedGrossSales);
      month.appleEstimatedProceeds = finalizeCurrencyBag(month.appleEstimatedProceeds);
      month.appleEstimatedDeductions = finalizeCurrencyBag(month.appleEstimatedDeductions);
      return month;
    });

  const financialPeriods = normalizeFinancialPeriods(financeResult.rows);

  const fxConvertedCurrencies = new Set();
  const fxFallbackCurrencies = new Set();
  const fxFailures = [];

  async function normalizeMoneyBag(bag, monthKey, label) {
    const sourceBag = finalizeCurrencyBag(bag || {});
    try {
      const converted = await currencyConverter.convertBag(sourceBag, monthKey);
      for (const currency of converted.convertedCurrencies || []) {
        fxConvertedCurrencies.add(currency);
      }
      for (const currency of converted.fallbackCurrencies || []) {
        fxFallbackCurrencies.add(currency);
      }
      return finalizeCurrencyBag(converted.bag || { USD: 0 });
    } catch (error) {
      fxFailures.push({
        month: monthKey,
        label,
        currencies: Object.keys(sourceBag).filter((currency) => currency !== 'USD'),
        error: error?.message || String(error),
      });
      return sourceBag;
    }
  }

  function usdDifference(left, right) {
    if (
      Object.keys(left || {}).some((currency) => currency !== 'USD') ||
      Object.keys(right || {}).some((currency) => currency !== 'USD')
    ) {
      return {};
    }
    return finalizeCurrencyBag({
      USD: numberValue(left?.USD) - numberValue(right?.USD),
    });
  }

  for (const month of months) {
    month.grossSales = await normalizeMoneyBag(
      month.grossSales,
      month.month,
      'verified_gross_sales'
    );
    month.refunds = await normalizeMoneyBag(
      month.refunds,
      month.month,
      'verified_refunds'
    );
    month.appleReportedGrossSales = await normalizeMoneyBag(
      month.appleReportedGrossSales,
      month.month,
      'apple_reported_gross_sales'
    );
    month.appleEstimatedProceeds = await normalizeMoneyBag(
      month.appleEstimatedProceeds,
      month.month,
      'apple_estimated_proceeds'
    );

    month.netSales = usdDifference(month.grossSales, month.refunds);
    month.appleEstimatedDeductions = usdDifference(
      month.appleReportedGrossSales,
      month.appleEstimatedProceeds
    );
  }

  for (const period of financialPeriods) {
    period.finalProceeds = await normalizeMoneyBag(
      period.finalProceeds,
      period.reportDate,
      'apple_final_proceeds'
    );
  }

  const allTime = allTimeFromMonths(months);
  allTime.finalAppleProceeds = {};
  for (const period of financialPeriods) {
    addBag(allTime.finalAppleProceeds, period.finalProceeds);
  }
  allTime.finalAppleProceeds = finalizeCurrencyBag(allTime.finalAppleProceeds);

  const lastSalesImport = appleImportResult.rows
    .map((row) => row.imported_through)
    .filter(Boolean)
    .sort()
    .at(-1) || null;

  return {
    generatedAt: new Date().toISOString(),
    timeZone: HISTORY_TIME_ZONE,
    currentMonth: current,
    reporting: {
      currency: {
        reportingCurrency: currencyConverter.reportingCurrency || 'USD',
        status: fxFailures.length ? 'partial' : 'normalized',
        source: 'Frankfurter central-bank reference rates',
        convertedCurrencies: [...fxConvertedCurrencies].sort(),
        fallbackCurrencies: [...fxFallbackCurrencies].sort(),
        failures: fxFailures,
        note: 'Original App Store currencies remain stored on each transaction; dashboard revenue is normalized to USD for reporting.',
      },
      salesAndTrends: {
        importedThrough: lastSalesImport,
        hasImportedReports: appleImportResult.rows.length > 0,
        note: 'Estimated Apple proceeds from Sales and Trends Summary Sales reports.',
      },
      finance: {
        hasImportedReports: Number(financeImportResult.rows[0]?.finance_report_count || 0) > 0,
        lastImportedAt: financeImportResult.rows[0]?.last_finance_imported_at || null,
        note: 'Final settled proceeds from Apple financial reports use Apple fiscal periods.',
      },
    },
    allTime,
    months,
    financialPeriods,
    payoutCalendar: getAppleFiscalPayoutCalendar(),
  };
}

export default loadSubscriptionAdminHistory;
