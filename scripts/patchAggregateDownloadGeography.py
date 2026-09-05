from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise AssertionError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


def replace_between(text, start_marker, end_marker, replacement, label):
    start = text.find(start_marker)
    if start < 0:
        raise AssertionError(f"{label}: start marker not found")
    end = text.find(end_marker, start)
    if end < 0:
        raise AssertionError(f"{label}: end marker not found")
    return text[:start] + replacement + text[end:]

# 1) Stop accepting or persisting per-user App Store storefront country.
analytics_path = Path('analytics.js')
analytics = analytics_path.read_text()
analytics, removed = re.subn(
    r"\nfunction normalizeStorefrontCountryCode\(value\) \{.*?\n\}\n",
    "\n",
    analytics,
    count=1,
    flags=re.S,
)
if removed != 1:
    raise AssertionError(f"analytics storefront normalizer: expected 1 removal, found {removed}")

app_open_start = "      const userId = identity.userId;\n"
app_open_end = "\n      return res.json({ success: true });"
start = analytics.find(app_open_start, analytics.find("router.post('/app-open'"))
if start < 0:
    raise AssertionError('analytics app-open userId marker not found')
end = analytics.find(app_open_end, start)
if end < 0:
    raise AssertionError('analytics app-open return marker not found')
analytics = (
    analytics[:start]
    + "      const userId = identity.userId;\n\n"
      "      await recordActiveDay(userId);\n"
      "      await recordEvent(userId, 'app_opened', null);\n"
    + analytics[end:]
)
if 'storefrontCountryCode' in analytics:
    raise AssertionError('analytics.js still contains storefrontCountryCode')
analytics_path.write_text(analytics)

# 2) Import aggregate initial app-download rows alongside the existing Agora Pro rows.
sync_path = Path('lib/appleProceedsSyncService.js')
sync = sync_path.read_text()
insert_marker = "\nfunction canonicalProductId(row) {"
addition = """

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
"""
sync = replace_once(sync, insert_marker, addition + insert_marker, 'apple sales helper insertion')
sync = replace_once(
    sync,
    "    const rows = report.rows.filter(isAgoraProduct);",
    "    const rows = report.rows.filter(isAgoraSalesReportRow);",
    'daily sales aggregate row filter',
)
sync_path.write_text(sync)

# 3) Make production startup automatically backfill 90 days once aggregate download rows are absent.
worker_path = Path('appleProceedsSyncWorker.js')
worker = worker_path.read_text()
worker = replace_once(
    worker,
    "const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', true);",
    "const enabled = booleanEnvironment('APP_STORE_CONNECT_REPORTS_ENABLED', true);\nconst agoraAppleId = cleanText(process.env.AFFILIATE_APPLE_APP_ID || '6762416967', 32);",
    'worker app id config',
)
startup_marker = "      try {\n        const result = await pool.query(`\n          SELECT MAX(report_date) AS imported_through"
startup_replacement = """      try {
        const downloadCoverage = await pool.query(`
          SELECT EXISTS (
            SELECT 1
            FROM app_store_sales_report_rows
            WHERE apple_identifier = $1
              AND product_type_identifier IN ('1', '1F', '1T')
          ) AS has_download_rows
        `, [agoraAppleId]);

        if (!downloadCoverage.rows[0]?.has_download_rows) {
          return 90;
        }

        const result = await pool.query(`
          SELECT MAX(report_date) AS imported_through"""
worker = replace_once(worker, startup_marker, startup_replacement, 'worker one-time geography backfill')
worker_path.write_text(worker)

# 4) Keep total event counts per account, but make geography aggregate Apple reporting only.
routes_path = Path('subscriptionAdminDashboardRoutes.js')
routes = routes_path.read_text()
account_activity_route = r"""  router.get('/data/accounts-activity', async (req, res) => {
    try {
      const allowedSorts = new Set(['newest', 'oldest', 'last_sign_in', 'most_events']);
      const allowedPeriods = new Set(['all', 'today', '7d']);
      const allowedAccess = new Set(['all', 'pro', 'free']);
      const sort = allowedSorts.has(String(req.query.sort || '')) ? String(req.query.sort) : 'newest';
      const period = allowedPeriods.has(String(req.query.period || '')) ? String(req.query.period) : 'all';
      const access = allowedAccess.has(String(req.query.access || '')) ? String(req.query.access) : 'all';
      const q = String(req.query.q || '').trim().slice(0, 160);
      const params = [];
      const where = [];
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(
          a.id::text ILIKE ${p}
          OR COALESCE(a.display_name, '') ILIKE ${p}
          OR COALESCE(ai.email, '') ILIKE ${p}
          OR COALESCE(gi.email, '') ILIKE ${p}
          OR COALESCE(ar.creator_code, '') ILIKE ${p}
          OR COALESCE(aff.display_name, '') ILIKE ${p}
        )`);
      }
      if (period === 'today') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date = (NOW() AT TIME ZONE 'America/Chicago')::date`);
      } else if (period === '7d') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 6`);
      }
      if (access === 'pro') where.push(`COALESCE(sub.has_pro_access, FALSE) = TRUE`);
      if (access === 'free') where.push(`COALESCE(sub.has_pro_access, FALSE) = FALSE`);
      const orderBy = {
        newest: 'a.created_at DESC, a.id DESC',
        oldest: 'a.created_at ASC, a.id ASC',
        last_sign_in: 'COALESCE(GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at), a.created_at) DESC, a.created_at DESC',
        most_events: 'COALESCE(usage.total_events, 0) DESC, a.created_at DESC',
      }[sort];
      const result = await historyPool.query(`
        WITH latest_apple_identity AS (
          SELECT DISTINCT ON (account_id)
            account_id,
            email,
            is_private_email,
            last_authenticated_at
          FROM account_apple_identities
          ORDER BY account_id, last_authenticated_at DESC NULLS LAST, created_at DESC
        ),
        latest_google_identity AS (
          SELECT DISTINCT ON (account_id)
            account_id,
            email,
            display_name,
            last_authenticated_at
          FROM account_google_identities
          ORDER BY account_id, last_authenticated_at DESC NULLS LAST, created_at DESC
        )
        SELECT
          a.id,
          a.status,
          COALESCE(NULLIF(BTRIM(a.display_name), ''), NULLIF(BTRIM(gi.display_name), '')) AS display_name,
          COALESCE(ai.email, gi.email) AS email,
          ai.is_private_email,
          CASE
            WHEN ai.account_id IS NOT NULL THEN 'Apple'
            WHEN gi.account_id IS NOT NULL THEN 'Google'
            ELSE 'Account'
          END AS identity_source,
          a.created_at,
          a.updated_at,
          GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at) AS last_authenticated_at,
          COALESCE(sub.has_pro_access, FALSE) AS has_pro_access,
          CASE
            WHEN COALESCE(sub.lifetime_active, FALSE) THEN 'Lifetime'
            WHEN COALESCE(sub.trial_active, FALSE) THEN 'Trial'
            WHEN COALESCE(sub.paid_active, FALSE) THEN 'Paid'
            WHEN COALESCE(sub.has_pro_access, FALSE) THEN 'Pro'
            ELSE 'Free'
          END AS access_label,
          ar.creator_code AS referral_code,
          aff.display_name AS affiliate_display_name,
          ar.claim_source AS referral_source,
          ar.claimed_at AS referral_claimed_at,
          COALESCE(usage.total_events, 0)::int AS total_events,
          usage.last_event_at
        FROM accounts a
        LEFT JOIN latest_apple_identity ai ON ai.account_id = a.id
        LEFT JOIN latest_google_identity gi ON gi.account_id = a.id
        LEFT JOIN affiliate_account_referrals ar ON ar.account_id = a.id
        LEFT JOIN affiliates aff ON aff.id = ar.affiliate_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*)::int AS total_events,
            MAX(e.created_at) AS last_event_at
          FROM user_events e
          WHERE e.user_id IN (
            SELECT DISTINCT installation_id
            FROM account_installations account_install
            WHERE account_install.account_id = a.id
          )
            AND NOT EXISTS (
              SELECT 1
              FROM excluded_analytics_users excluded
              WHERE excluded.user_id = e.user_id
            )
        ) usage ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            BOOL_OR(has_pro_access) AS has_pro_access,
            BOOL_OR(trial_active) AS trial_active,
            BOOL_OR(recurring_revenue_active) AS paid_active,
            BOOL_OR(is_lifetime_pro AND has_pro_access) AS lifetime_active
          FROM subscription_admin_current_customers_v1
          WHERE account_id = a.id
            AND environment = 'Production'
        ) sub ON TRUE
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY ${orderBy}
        LIMIT 200
      `, params);
      res.json({
        sort,
        period,
        access,
        query: q,
        accounts: result.rows.map((row) => ({
          id: row.id,
          status: row.status,
          displayName: row.display_name,
          email: row.email,
          isPrivateEmail: row.is_private_email,
          identitySource: row.identity_source,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastAuthenticatedAt: row.last_authenticated_at,
          hasProAccess: Boolean(row.has_pro_access),
          accessLabel: row.access_label,
          referralCode: row.referral_code,
          affiliateDisplayName: row.affiliate_display_name,
          referralSource: row.referral_source,
          referralClaimedAt: row.referral_claimed_at,
          totalEvents: Number(row.total_events || 0),
          lastEventAt: row.last_event_at,
        })),
      });
    } catch (error) {
      console.error('[subscription-admin] account activity failed', error);
      res.status(500).json({ error: 'Failed to load account activity' });
    }
  });

"""
routes = replace_between(
    routes,
    "  router.get('/data/accounts-activity'",
    "  router.get('/data/accounts-geography'",
    account_activity_route,
    'account activity route',
)

geography_route = r"""  router.get('/data/accounts-geography', async (req, res) => {
    try {
      const allowedPeriods = new Set(['7d', '30d', 'all']);
      const period = allowedPeriods.has(String(req.query.period || ''))
        ? String(req.query.period)
        : '30d';
      const agoraAppleId = String(process.env.AFFILIATE_APPLE_APP_ID || '6762416967').trim();
      const params = [agoraAppleId];
      const where = [
        `apple_identifier = $1`,
        `product_type_identifier IN ('1', '1F', '1T')`,
        `COALESCE(units, 0) > 0`,
      ];
      if (period === '7d') {
        where.push(`report_date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 6`);
      } else if (period === '30d') {
        where.push(`report_date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 29`);
      }

      const result = await historyPool.query(`
        SELECT
          CASE
            WHEN UPPER(COALESCE(country_code, '')) ~ '^[A-Z]{3}$'
              THEN UPPER(country_code)
            ELSE NULL
          END AS country_code,
          ROUND(COALESCE(SUM(units), 0), 0)::int AS downloads,
          MAX(report_date) AS data_through_date
        FROM app_store_sales_report_rows
        WHERE ${where.join(' AND ')}
        GROUP BY 1
        ORDER BY downloads DESC, country_code ASC NULLS LAST
      `, params);

      const rows = result.rows || [];
      const totalDownloads = rows.reduce((sum, row) => sum + Number(row.downloads || 0), 0);
      const knownDownloads = rows
        .filter((row) => row.country_code)
        .reduce((sum, row) => sum + Number(row.downloads || 0), 0);
      const countries = rows
        .filter((row) => row.country_code)
        .map((row) => ({
          countryCode: row.country_code,
          downloads: Number(row.downloads || 0),
        }));
      const dataThroughDate = rows.reduce((latest, row) => {
        const value = row.data_through_date ? String(row.data_through_date).slice(0, 10) : null;
        return value && (!latest || value > latest) ? value : latest;
      }, null);

      res.json({
        period,
        source: 'app_store_connect_sales_trends',
        totalDownloads,
        knownDownloads,
        unknownDownloads: Math.max(0, totalDownloads - knownDownloads),
        dataThroughDate,
        countries,
      });
    } catch (error) {
      console.error('[subscription-admin] aggregate download geography failed', error);
      res.status(500).json({ error: 'Failed to load geographic interest' });
    }
  });

"""
routes = replace_between(
    routes,
    "  router.get('/data/accounts-geography'",
    "  router.get('/data/accounts-summary'",
    geography_route,
    'aggregate geography route',
)
routes_path.write_text(routes)

# 5) Update the dashboard wording and rendering to aggregate downloads, not per-account geography.
ui_path = Path('lib/subscriptionAdminAccountsUi.js')
ui = ui_path.read_text()
ui = ui.replace(
    'placeholder="Search name, email, account ID, referral, or country code"',
    'placeholder="Search name, email, account ID, or referral"',
)
ui = ui.replace(
    'App Store country · not precise device location',
    'First-time App Store downloads by country · aggregate Apple reporting',
)
ui = ui.replace('<th>App Store country</th>', '')
ui = ui.replace("<td>'+accountCountryHtml(row)+'</td>", '')
ui = ui.replace(
    "const rows=[...(data?.countries||[])].sort((a,b)=>Number(b.accounts||0)-Number(a.accounts||0)); const known=Number(data?.knownAccounts||0),total=Number(data?.totalAccounts||0),unknown=Number(data?.unknownAccounts||0);",
    "const rows=[...(data?.countries||[])].sort((a,b)=>Number(b.downloads||0)-Number(a.downloads||0)); const known=Number(data?.knownDownloads||0),total=Number(data?.totalDownloads||0),unknown=Number(data?.unknownDownloads||0);",
)
ui = ui.replace(
    "summary.textContent=total?(known+' of '+total+' known · '+Math.round((known/total)*100)+'% coverage'):'No accounts in this period';",
    "summary.textContent=total?(total+' first-time download'+(total===1?'':'s')+(data?.dataThroughDate?' · through '+accountDayLabel(String(data.dataThroughDate).slice(0,10),true):'')):'No first-time downloads in this period';",
)
ui = ui.replace(
    "if(!rows.length){ map.innerHTML='<div class=\"empty\">No known App Store countries in this period.</div>'; list.innerHTML='<div class=\"empty\">'+(unknown?esc(unknown+' account'+(unknown===1?'':'s')+' currently unknown'):'No geography data yet.')+'</div>'; return; }",
    "if(!rows.length){ map.innerHTML='<div class=\"empty\">No first-time App Store downloads in this period.</div>'; list.innerHTML='<div class=\"empty\">'+(unknown?esc(unknown+' download'+(unknown===1?'':'s')+' with unknown country'):'No geography data yet.')+'</div>'; return; }",
)
ui = ui.replace('Number(row.accounts||0)', 'Number(row.downloads||0)')
ui = ui.replace("account'+(value===1?'':'s')", "download'+(value===1?'':'s')")
ui = ui.replace(
    'aria-label="Account interest by App Store country"',
    'aria-label="First-time App Store downloads by country"',
)
ui = ui.replace(
    "<strong>Unknown</strong><span>Awaiting storefront</span>",
    "<strong>Unknown</strong><span>Apple country unavailable</span>",
)
if '<th>App Store country</th>' in ui:
    raise AssertionError('per-account country column still present')
if 'First-time App Store downloads by country · aggregate Apple reporting' not in ui:
    raise AssertionError('aggregate geography UI note not applied')
ui_path.write_text(ui)

# 6) Replace tests with behavior focused on aggregate geography and event counts.
test_path = Path('test/subscriptionAdminAccountUsageGeography.test.js')
test_path.write_text(r'''import assert from 'node:assert/strict';
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
''')

print('Aggregate download geography patch applied.')
