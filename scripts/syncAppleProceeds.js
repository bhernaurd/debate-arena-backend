import '../env.js';

import pg from 'pg';

import { createAppStoreConnectReportsService } from '../lib/appStoreConnectReportsService.js';
import { createAppleProceedsSyncService } from '../lib/appleProceedsSyncService.js';

const { Pool } = pg;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error('DATABASE_URL is required.');
  return value;
}

async function main() {
  const connectionString = requireDatabaseUrl();
  const reportsService = createAppStoreConnectReportsService();

  if (!reportsService.isConfigured()) {
    throw new Error(
      'Apple proceeds reporting is not configured. Add APP_STORE_CONNECT_VENDOR_NUMBER in Railway. Existing APP_STORE_CONNECT_ISSUER_ID, APP_STORE_CONNECT_KEY_ID, and APP_STORE_CONNECT_PRIVATE_KEY are also required.'
    );
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
    max: 2,
  });

  try {
    const service = createAppleProceedsSyncService({ pool, reportsService });
    const financeMonth = argumentValue('--finance-month');
    const region = argumentValue('--region') || 'ZZ';
    const financeType = argumentValue('--finance-type') || 'FINANCIAL';
    const singleDate = argumentValue('--date');
    const days = Number(argumentValue('--days') || 90);

    if (financeMonth) {
      const result = await service.syncFinanceReport({
        reportDate: financeMonth,
        regionCode: region,
        reportType: financeType,
      });
      console.log('[AppleProceeds] Finance sync result:', result);
      return;
    }

    if (singleDate) {
      const result = await service.syncDailySalesReport(singleDate);
      console.log('[AppleProceeds] Daily sales sync result:', result);
      return;
    }

    const results = await service.syncRecentSales({ days });
    const summary = results.reduce(
      (accumulator, item) => {
        accumulator[item.status] = (accumulator[item.status] || 0) + 1;
        accumulator.importedRows += Number(item.importedRows || 0);
        return accumulator;
      },
      { importedRows: 0 }
    );

    console.log('[AppleProceeds] Sales sync complete:', {
      vendorNumber: reportsService.vendorNumber,
      daysRequested: Math.max(1, Math.min(365, days || 90)),
      ...summary,
    });

    if (hasFlag('--verbose')) {
      console.table(results);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[AppleProceeds] Sync failed:', error?.stack || error);
  process.exitCode = 1;
});
