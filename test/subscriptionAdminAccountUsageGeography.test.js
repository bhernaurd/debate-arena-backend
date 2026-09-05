import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createAppleProceedsSyncService } from '../lib/appleProceedsSyncService.js';
import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';

test('account activity keeps total events and Most events without per-account geography', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /COALESCE\(usage\.total_events, 0\)::int AS total_events/);
  assert.match(source, /most_events: 'COALESCE\(usage\.total_events, 0\) DESC/);
  assert.match(source, /totalEvents: Number\(row\.total_events \|\| 0\)/);
  assert.doesNotMatch(source, /countrySource: row\.country_source/);
  assert.doesNotMatch(source, /analytics_storefront/);
});

test('geography endpoint uses aggregate Apple first-time download rows', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /router\.get\('\/data\/accounts-geography'/);
  assert.match(source, /FROM app_store_sales_report_rows/);
  assert.match(source, /apple_identifier = \$1/);
  assert.match(source, /product_type_identifier IN \('1', '1F', '1T'\)/);
  assert.match(source, /SUM\(units\)/);
  assert.match(source, /totalDownloads/);
  assert.match(source, /dataThroughDate/);
  assert.doesNotMatch(source, /unknownAccounts/);
});

test('accounts UI shows events per account and aggregate download geography', () => {
  const base = `<!doctype html><html><head><style>.hidden { display:none !important; }</style></head><body>
  <button class="nav" data-view="breakdown">Subscriber Analytics</button>
    <section id="view-history" class="hidden"></section>
  <script>
  const qs=()=>null,qsa=()=>[],api=()=>{},metric=()=>'',esc=(v)=>String(v),fmtDate=(v)=>String(v),shortId=(v)=>String(v),titleCase=(v)=>String(v),showError=()=>{};
  function eventParams(){}
  const viewMeta={breakdown:['Subscriber Analytics','Subscriber totals, plan mix and lifecycle trends over time']};
  const views=['overview','breakdown','customers','history','events'];
  function setView(view){}
  </script></body></html>`;
  const html = enhanceSubscriptionAdminAccountsHtml(base);
  assert.match(html, /<th>Events<\/th>/);
  assert.doesNotMatch(html, /<th>App Store country<\/th>/);
  assert.match(html, /First-time App Store downloads by country/);
  assert.match(html, /aggregate Apple reporting/);
  assert.match(html, /data-account-geo-range="30d"/);
  assert.match(html, /Most events/);
});

test('analytics app-open no longer accepts customer storefront country', () => {
  const source = fs.readFileSync('analytics.js', 'utf8');
  assert.doesNotMatch(source, /storefrontCountryCode/);
  assert.match(source, /await recordEvent\(userId, 'app_opened', null\)/);
});

test('daily Sales & Trends import includes the app initial-download row but ignores unrelated apps', async () => {
  const queries = [];
  const client = {
    async query(text, params = []) {
      queries.push({ text: String(text), params });
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query() { return { rows: [] }; },
    async connect() { return client; },
  };
  const reportsService = {
    isConfigured: () => true,
    vendorNumber: '12345',
    async downloadDailySalesReport() {
      return {
        reportDate: '2026-09-04',
        vendorNumber: '12345',
        sourceSha256: 'abc',
        rows: [
          { productId: 'agora_pro_monthly', rawRow: { row: 'subscription' } },
          { appleIdentifier: '6762416967', productTypeIdentifier: '1F', units: 1, countryCode: 'USA', rawRow: { row: 'app' } },
          { appleIdentifier: '9999999999', productTypeIdentifier: '1', units: 1, countryCode: 'CAN', rawRow: { row: 'other' } },
        ],
      };
    },
  };
  const service = createAppleProceedsSyncService({ pool, reportsService });
  const result = await service.syncDailySalesReport('2026-09-04');
  assert.equal(result.importedRows, 2);
  const inserts = queries.filter((row) => row.text.includes('INSERT INTO app_store_sales_report_rows'));
  assert.equal(inserts.length, 2);
  assert.ok(inserts.some((row) => row.params.includes('6762416967')));
  assert.ok(!inserts.some((row) => row.params.includes('9999999999')));
});

test('startup worker requests a 90-day one-time backfill when app download rows are absent', () => {
  const source = fs.readFileSync('appleProceedsSyncWorker.js', 'utf8');
  assert.match(source, /product_type_identifier IN \('1', '1F', '1T'\)/);
  assert.match(source, /if \(!downloadCoverage\.rows\[0\]\?\.has_download_rows\) \{\s*return 90;/);
});

test('obsolete per-account storefront migration is removed', () => {
  assert.equal(fs.existsSync('migrations/038_account_storefront_country.sql'), false);
});
