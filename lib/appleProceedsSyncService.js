import crypto from 'node:crypto';

import { AGORA_PRO_PRODUCT_IDS } from './agoraProProducts.js';
import { createAppStoreConnectReportsService } from './appStoreConnectReportsService.js';

function cleanText(value, maxLength = 1000) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function rowHash(row) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(row?.rawRow || row || {}))
    .digest('hex');
}

function isAgoraProduct(row) {
  const candidates = [row?.productId, row?.title, row?.sku]
    .map((value) => cleanText(value, 200))
    .filter(Boolean);
  return candidates.some((value) => AGORA_PRO_PRODUCT_IDS.has(value));
}


const INITIAL_APP_DOWNLOAD_PRODUCT_TYPES = new Set(['1', '1F', '1T']);

function agoraAppleId() {
  return cleanText(process.env.AFFILIATE_APPLE_APP_ID || '6762416967', 32);
}

function isAgoraAppDownloadRow(row) {
  const appleIdentifier = cleanText(row?.appleIdentifier, 32);
  const productTypeIdentifier = cleanText(row?.productTypeIdentifier, 16).toUpperCase();
  return (
    appleIdentifier === agoraAppleId() &&
    INITIAL_APP_DOWNLOAD_PRODUCT_TYPES.has(productTypeIdentifier)
  );
}

function isAgoraSalesReportRow(row) {
  return isAgoraProduct(row) || isAgoraAppDownloadRow(row);
}

function canonicalProductId(row) {
  const candidates = [row?.productId, row?.title, row?.sku]
    .map((value) => cleanText(value, 200))
    .filter(Boolean);
  return candidates.find((value) => AGORA_PRO_PRODUCT_IDS.has(value)) || candidates[0] || null;
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
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export function createAppleProceedsSyncService({
  pool,
  reportsService = createAppStoreConnectReportsService(),
} = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new Error('A PostgreSQL pool is required for Apple proceeds sync.');
  }

  async function syncDailySalesReport(reportDate) {
    let report;
    try {
      report = await reportsService.downloadDailySalesReport({ reportDate });
    } catch (error) {
      if (error?.noReport === true) {
        return {
          reportDate,
          status: 'not_available',
          importedRows: 0,
          message: error.message,
        };
      }
      throw error;
    }

    const rows = report.rows.filter(isAgoraSalesReportRow);

    await withTransaction(pool, async (client) => {
      await client.query(
        `DELETE FROM app_store_sales_report_rows WHERE report_date = $1 AND vendor_number = $2`,
        [report.reportDate, report.vendorNumber]
      );

      for (const row of rows) {
        await client.query(
          `
          INSERT INTO app_store_sales_report_rows (
            report_date,
            vendor_number,
            row_hash,
            product_id,
            sku,
            title,
            product_type_identifier,
            units,
            customer_currency,
            customer_price,
            gross_customer_amount,
            country_code,
            proceeds_currency,
            developer_proceeds_per_unit,
            developer_proceeds_amount,
            subscription,
            period,
            promo_code,
            order_type,
            proceeds_reason,
            preserved_pricing,
            apple_identifier,
            raw_row,
            imported_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,NOW()
          )
          `,
          [
            report.reportDate,
            report.vendorNumber,
            rowHash(row),
            canonicalProductId(row),
            row.sku,
            row.title,
            row.productTypeIdentifier,
            row.units,
            row.customerCurrency,
            row.customerPrice,
            row.grossCustomerAmount,
            row.countryCode,
            row.proceedsCurrency,
            row.developerProceedsPerUnit,
            row.developerProceedsAmount,
            row.subscription,
            row.period,
            row.promoCode,
            row.orderType,
            row.proceedsReason,
            row.preservedPricing,
            row.appleIdentifier,
            JSON.stringify(row.rawRow || {}),
          ]
        );
      }

      await client.query(
        `
        INSERT INTO app_store_sales_report_imports (
          report_date,
          vendor_number,
          report_type,
          report_subtype,
          frequency,
          source_sha256,
          row_count,
          imported_at
        )
        VALUES ($1,$2,'SALES','SUMMARY','DAILY',$3,$4,NOW())
        ON CONFLICT (report_date, vendor_number, report_type, report_subtype, frequency)
        DO UPDATE SET
          source_sha256 = EXCLUDED.source_sha256,
          row_count = EXCLUDED.row_count,
          imported_at = NOW()
        `,
        [report.reportDate, report.vendorNumber, report.sourceSha256, rows.length]
      );
    });

    return {
      reportDate: report.reportDate,
      status: 'imported',
      importedRows: rows.length,
      sourceRows: report.rows.length,
    };
  }

  async function syncSalesRange({ startDate, endDate }) {
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw new Error('A valid sales report date range is required.');
    }

    const results = [];
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      results.push(await syncDailySalesReport(dateKey(cursor)));
    }
    return results;
  }

  async function syncRecentSales({ days = 90, throughDate = null } = {}) {
    const safeDays = Math.max(1, Math.min(365, Number(days) || 90));
    const through = throughDate
      ? new Date(`${throughDate}T00:00:00Z`)
      : addDays(new Date(), -1);
    const start = addDays(through, -(safeDays - 1));
    return syncSalesRange({
      startDate: dateKey(start),
      endDate: dateKey(through),
    });
  }

  async function syncFinanceReport({
    reportDate,
    regionCode = 'US',
    reportType = 'FINANCE_DETAIL',
  }) {
    let report;
    try {
      report = await reportsService.downloadFinanceReport({
        reportDate,
        regionCode,
        reportType,
      });
    } catch (error) {
      if (error?.noReport === true) {
        return {
          reportDate,
          regionCode,
          reportType,
          status: 'not_available',
          importedRows: 0,
          message: error.message,
        };
      }
      throw error;
    }

    const rows = report.rows.filter(isAgoraProduct);

    await withTransaction(pool, async (client) => {
      await client.query(
        `
        DELETE FROM app_store_finance_report_rows
        WHERE report_date = $1
          AND vendor_number = $2
          AND region_code = $3
          AND report_type = $4
        `,
        [report.reportDate, report.vendorNumber, report.regionCode, report.reportType]
      );

      for (const row of rows) {
        await client.query(
          `
          INSERT INTO app_store_finance_report_rows (
            report_date,
            vendor_number,
            region_code,
            report_type,
            row_hash,
            period_start,
            period_end,
            product_id,
            title,
            product_type_identifier,
            country_of_sale,
            quantity,
            customer_currency,
            customer_price,
            partner_share_currency,
            partner_share_per_unit,
            extended_partner_share,
            sale_or_return,
            promo_code,
            order_type,
            raw_row,
            imported_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,NOW()
          )
          `,
          [
            report.reportDate,
            report.vendorNumber,
            report.regionCode,
            report.reportType,
            rowHash(row),
            row.periodStart,
            row.periodEnd,
            canonicalProductId(row),
            row.title,
            row.productTypeIdentifier,
            row.countryOfSale,
            row.quantity,
            row.customerCurrency,
            row.customerPrice,
            row.partnerShareCurrency,
            row.partnerSharePerUnit,
            row.extendedPartnerShare,
            row.saleOrReturn,
            row.promoCode,
            row.orderType,
            JSON.stringify(row.rawRow || {}),
          ]
        );
      }

      await client.query(
        `
        INSERT INTO app_store_finance_report_imports (
          report_date,
          vendor_number,
          region_code,
          report_type,
          source_sha256,
          row_count,
          imported_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT (report_date, vendor_number, region_code, report_type)
        DO UPDATE SET
          source_sha256 = EXCLUDED.source_sha256,
          row_count = EXCLUDED.row_count,
          imported_at = NOW()
        `,
        [
          report.reportDate,
          report.vendorNumber,
          report.regionCode,
          report.reportType,
          report.sourceSha256,
          rows.length,
        ]
      );
    });

    return {
      reportDate: report.reportDate,
      regionCode: report.regionCode,
      reportType: report.reportType,
      status: 'imported',
      importedRows: rows.length,
      sourceRows: report.rows.length,
    };
  }

  return Object.freeze({
    isConfigured: reportsService.isConfigured,
    vendorNumber: reportsService.vendorNumber,
    syncDailySalesReport,
    syncSalesRange,
    syncRecentSales,
    syncFinanceReport,
  });
}

export default createAppleProceedsSyncService;
