import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadSubscriptionAdminHistory,
} from '../lib/subscriptionAdminHistoryService.js';

function currentChicagoMonth() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

function fakePool(month) {
  return {
    async query(sql) {
      const text = String(sql);

      if (
        text.includes('ROUND(SUM(transaction.price_milliunits)') &&
        text.includes('paid_transactions')
      ) {
        return {
          rows: [
            {
              month_key: month,
              currency: 'CAD',
              gross_sales: '20.00',
              paid_transactions: 1,
            },
          ],
        };
      }

      if (text.includes('WITH refunded_transactions AS')) {
        return { rows: [] };
      }

      if (text.includes("COUNT(*) FILTER (WHERE kind = 'new_paid')")) {
        return { rows: [] };
      }

      if (
        text.includes("UPPER(event_type) = 'DID_CHANGE_RENEWAL_STATUS'") &&
        text.includes('subscriptions_ended')
      ) {
        return { rows: [] };
      }

      if (text.includes('active_pro_at_month_end')) {
        return { rows: [] };
      }

      if (
        text.includes('FROM app_store_sales_report_rows') &&
        text.includes('apple_reported_gross_sales')
      ) {
        return {
          rows: [
            {
              month_key: month,
              customer_currency: 'CAD',
              proceeds_currency: 'USD',
              apple_reported_gross_sales: '20.00',
              apple_estimated_proceeds: '11.00',
            },
          ],
        };
      }

      if (
        text.includes('FROM app_store_sales_report_imports') &&
        text.includes('imported_days')
      ) {
        return {
          rows: [
            {
              month_key: month,
              imported_days: 1,
              imported_through: `${month}-20`,
            },
          ],
        };
      }

      if (text.includes('FROM app_store_finance_report_rows')) {
        return { rows: [] };
      }

      if (
        text.includes('FROM app_store_finance_report_imports') &&
        text.includes('finance_report_count')
      ) {
        return {
          rows: [
            {
              last_finance_imported_at: null,
              finance_report_count: 0,
            },
          ],
        };
      }

      throw new Error(`Unexpected query in test: ${text.slice(0, 120)}`);
    },
  };
}

test('normalizes foreign subscription revenue and Apple comparison values to USD', async () => {
  const month = currentChicagoMonth();
  const conversions = [];

  const currencyConverter = {
    reportingCurrency: 'USD',
    async convertBag(bag, monthKey) {
      conversions.push({ bag: { ...bag }, monthKey });
      const usd =
        Number(bag?.USD || 0) +
        Number(bag?.CAD || 0) * 0.75;

      return {
        bag: {
          USD: Math.round((usd + Number.EPSILON) * 100) / 100,
        },
        convertedCurrencies: Object.hasOwn(bag || {}, 'CAD') ? ['CAD'] : [],
        fallbackCurrencies: [],
      };
    },
  };

  const history = await loadSubscriptionAdminHistory(
    fakePool(month),
    { currencyConverter }
  );

  const current = history.months.find((row) => row.month === month);

  assert.ok(current);
  assert.deepEqual(current.grossSales, { USD: 15 });
  assert.deepEqual(current.appleReportedGrossSales, { USD: 15 });
  assert.deepEqual(current.appleEstimatedProceeds, { USD: 11 });
  assert.deepEqual(current.appleEstimatedDeductions, { USD: 4 });
  assert.deepEqual(current.netSales, { USD: 15 });
  assert.deepEqual(history.allTime.grossSales, { USD: 15 });
  assert.equal(history.reporting.currency.reportingCurrency, 'USD');
  assert.equal(history.reporting.currency.status, 'normalized');
  assert.deepEqual(history.reporting.currency.convertedCurrencies, ['CAD']);
  assert.ok(conversions.length >= 4);
});
