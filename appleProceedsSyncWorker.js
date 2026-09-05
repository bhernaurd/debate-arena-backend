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

function dateKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

function addDays(date, amount) {
  const value = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  value.setUTCDate(value.getUTCDate() + amount);
  return value;
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
  const values = (configured || 'ZZ')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9]{2}$/.test(value));
  return [...new Set(values.length ? values : ['ZZ'])];
}

const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', true);
const agoraAppleId = cleanText(process.env.AFFILIATE_APPLE_APP_ID || '6762416967', 32);

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

    async function startupSalesLookbackDays(reason) {
      if (reason !== 'startup') return 7;

      try {
        const downloadCoverage = await pool.query(`
          SELECT
            EXISTS (
              SELECT 1
              FROM app_store_sales_report_rows
              WHERE apple_identifier = $1
                AND product_type_identifier IN ('1', '1F', '1T')
                AND COALESCE(units, 0) > 0
            ) AS has_download_rows,
            EXISTS (
              SELECT 1
              FROM app_store_sales_report_rows
              WHERE apple_identifier = $1
                AND product_type_identifier IN ('1', '1F', '1T')
                AND COALESCE(units, 0) > 0
                AND report_date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 89
                AND NOT (UPPER(COALESCE(country_code, '')) ~ '^[A-Z]{2,3}$')
            ) AS has_missing_country_rows
        `, [agoraAppleId]);

        if (
          !downloadCoverage.rows[0]?.has_download_rows ||
          downloadCoverage.rows[0]?.has_missing_country_rows
        ) {
          return 90;
        }

        const result = await pool.query(`
          SELECT MAX(report_date) AS imported_through
          FROM app_store_sales_report_imports
          WHERE report_type = 'SALES'
            AND report_subtype = 'SUMMARY'
            AND frequency = 'DAILY'
        `);
        const lastKey = dateKey(result.rows[0]?.imported_through);
        if (!lastKey) return 90;

        const last = new Date(`${lastKey}T00:00:00Z`);
        const through = addDays(new Date(), -1);
        const gapDays = Math.floor((through.getTime() - last.getTime()) / 86_400_000) + 1;
        return Math.max(7, Math.min(365, gapDays));
      } catch (error) {
        console.warn('[AppleProceedsWorker] Could not determine Sales & Trends catch-up window.', error?.message || error);
        return 90;
      }
    }

    async function recordNoReportChecks(results) {
      const noReports = (results || []).filter((row) => row.status === 'not_available' && row.reportDate);
      for (const row of noReports) {
        await pool.query(`
          INSERT INTO app_store_sales_report_imports (
            report_date, vendor_number, report_type, report_subtype, frequency,
            source_sha256, row_count, imported_at
          )
          VALUES ($1,$2,'SALES','SUMMARY','DAILY',NULL,0,NOW())
          ON CONFLICT (report_date, vendor_number, report_type, report_subtype, frequency)
          DO UPDATE SET source_sha256 = NULL, row_count = 0, imported_at = NOW()
        `, [row.reportDate, reportsService.vendorNumber]);
      }
    }

    async function runSalesSync(reason = 'scheduled') {
      if (running) {
        console.log('[AppleProceedsWorker] Skipping overlapping sales sync.');
        return;
      }
      running = true;
      try {
        const days = await startupSalesLookbackDays(reason);
        const results = await service.syncRecentSales({ days });
        await recordNoReportChecks(results);
        const imported = results.filter((row) => row.status === 'imported');
        console.log('[AppleProceedsWorker] Sales reports synced.', {
          reason,
          checkedDays: results.length,
          lookbackDays: days,
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
        'FINANCIAL';
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
