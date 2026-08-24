import '../env.js';

import pg from 'pg';

import { createAppStoreConnectReportsService } from '../lib/appStoreConnectReportsService.js';

const { Pool } = pg;

function bool(value) {
  return Boolean(String(value || '').trim());
}

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required.');

  const reportsService = createAppStoreConnectReportsService();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
    max: 1,
  });

  try {
    const schemaResult = await pool.query(`
      SELECT
        TO_REGCLASS('public.app_store_sales_report_imports') IS NOT NULL AS has_sales_imports,
        TO_REGCLASS('public.app_store_sales_report_rows') IS NOT NULL AS has_sales_rows,
        TO_REGCLASS('public.app_store_finance_report_imports') IS NOT NULL AS has_finance_imports,
        TO_REGCLASS('public.app_store_finance_report_rows') IS NOT NULL AS has_finance_rows
    `);
    const schema = schemaResult.rows[0] || {};

    let sales = null;
    let finance = null;

    if (schema.has_sales_imports && schema.has_sales_rows) {
      const result = await pool.query(`
        SELECT
          MAX(report_date) AS imported_through,
          MAX(imported_at) AS last_imported_at,
          COUNT(*)::int AS report_days,
          COALESCE(SUM(row_count), 0)::int AS imported_rows
        FROM app_store_sales_report_imports
      `);
      sales = result.rows[0] || null;
    }

    if (schema.has_finance_imports && schema.has_finance_rows) {
      const result = await pool.query(`
        SELECT
          MAX(report_date) AS latest_report_period,
          MAX(imported_at) AS last_imported_at,
          COUNT(*)::int AS imported_reports,
          COALESCE(SUM(row_count), 0)::int AS imported_rows
        FROM app_store_finance_report_imports
      `);
      finance = result.rows[0] || null;
    }

    const readiness = {
      ready:
        reportsService.isConfigured() &&
        schema.has_sales_imports === true &&
        schema.has_sales_rows === true &&
        schema.has_finance_imports === true &&
        schema.has_finance_rows === true,
      configuration: {
        issuer_id: bool(process.env.APP_STORE_CONNECT_ISSUER_ID),
        key_id: bool(process.env.APP_STORE_CONNECT_KEY_ID),
        private_key: bool(process.env.APP_STORE_CONNECT_PRIVATE_KEY),
        vendor_number: bool(process.env.APP_STORE_CONNECT_VENDOR_NUMBER),
        automatic_sync_enabled:
          ['1', 'true', 'yes', 'on'].includes(
            String(process.env.APP_STORE_CONNECT_REPORTS_ENABLED || '')
              .trim()
              .toLowerCase()
          ),
      },
      schema,
      sales,
      finance,
    };

    console.log('[AppleProceeds] Readiness:', readiness);

    if (!readiness.ready) {
      console.log(
        '[AppleProceeds] Next: run npm run migrate, add APP_STORE_CONNECT_VENDOR_NUMBER, then run npm run apple-proceeds:sync -- --days 90.'
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[AppleProceeds] Readiness check failed:', error?.stack || error);
  process.exitCode = 1;
});
