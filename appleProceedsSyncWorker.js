import cron from 'node-cron';
import pg from 'pg';

import { createAppStoreConnectReportsService } from './lib/appStoreConnectReportsService.js';
import { createAppleProceedsSyncService } from './lib/appleProceedsSyncService.js';

const { Pool } = pg;
const TIME_ZONE = 'America/Chicago';

function booleanEnvironment(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function cleanText(value, maxLength = 200) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function addMonths(date, amount) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + amount, 1));
  return value;
}

function financeRegions() {
  const configured = cleanText(process.env.APP_STORE_CONNECT_FINANCE_REGIONS, 200);
  const values = (configured || 'US')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9]{2}$/.test(value));
  return [...new Set(values.length ? values : ['US'])];
}

const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', false);

if (enabled) {
  const connectionString = process.env.DATABASE_URL?.trim();
  const reportsService = createAppStoreConnectReportsService();

  if (!connectionString) {
    console.warn('[AppleProceedsWorker] Disabled: DATABASE_URL is missing.');
  } else if (!reportsService.isConfigured()) {
    console.warn(
      '[AppleProceedsWorker] Disabled: App Store Connect report credentials or APP_STORE_CONNECT_VENDOR_NUMBER are missing.'
    );
  } else {
    const pool = new Pool({
      connectionString,
      ssl: connectionString.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
      max: 2,
    });
    const service = createAppleProceedsSyncService({ pool, reportsService });
    let running = false;

    pool.on('error', (error) => {
      console.error('[AppleProceedsWorker] Postgres pool error:', error?.message || error);
    });

    async function runSalesSync(reason = 'scheduled') {
      if (running) {
        console.log('[AppleProceedsWorker] Skipping overlapping sales sync.');
        return;
      }
      running = true;
      try {
        const results = await service.syncRecentSales({ days: 7 });
        const imported = results.filter((row) => row.status === 'imported');
        console.log('[AppleProceedsWorker] Sales reports synced.', {
          reason,
          reportDays: imported.length,
          importedRows: imported.reduce((sum, row) => sum + Number(row.importedRows || 0), 0),
        });
      } catch (error) {
        console.error('[AppleProceedsWorker] Sales sync failed:', error?.message || error);
      } finally {
        running = false;
      }
    }

    async function runFinanceSync(reason = 'scheduled') {
      const reportType =
        cleanText(process.env.APP_STORE_CONNECT_FINANCE_REPORT_TYPE, 32).toUpperCase() ||
        'FINANCE_DETAIL';
      const now = new Date();
      const months = [monthKey(addMonths(now, -1)), monthKey(addMonths(now, -2))];

      for (const regionCode of financeRegions()) {
        for (const reportDate of months) {
          try {
            const result = await service.syncFinanceReport({
              reportDate,
              regionCode,
              reportType,
            });
            if (result.status === 'imported') {
              console.log('[AppleProceedsWorker] Financial report synced.', {
                reason,
                reportDate,
                regionCode,
                importedRows: result.importedRows,
              });
            }
          } catch (error) {
            console.error('[AppleProceedsWorker] Financial report sync failed:', {
              reportDate,
              regionCode,
              error: error?.message || error,
            });
          }
        }
      }
    }

    cron.schedule('30 11 * * *', () => runSalesSync('daily'), {
      timezone: TIME_ZONE,
    });

    cron.schedule('0 12 * * 1', () => runFinanceSync('weekly'), {
      timezone: TIME_ZONE,
    });

    setTimeout(() => {
      runSalesSync('startup');
      runFinanceSync('startup');
    }, 45_000).unref?.();

    console.log('[AppleProceedsWorker] Enabled.', {
      dailySalesSync: '11:30 America/Chicago',
      weeklyFinanceSync: 'Monday 12:00 America/Chicago',
      vendorNumberConfigured: Boolean(reportsService.vendorNumber),
      financeRegions: financeRegions(),
    });
  }
}
