from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    if text.count(old) != 1:
        raise SystemExit(f'{label} anchor was not unique')
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Analytics ingestion: accept a coarse three-letter App Store storefront code
# on app-open, persist it on a linked installation, and retain it in event
# metadata so accounts created later can still inherit the observation.
# ---------------------------------------------------------------------------
analytics_path = Path('analytics.js')
a = analytics_path.read_text()

a = replace_once(
    a,
    "function sanitizeMetadata(meta) {\n  if (meta === undefined || meta === null) return null;\n  if (typeof meta !== 'object' || Array.isArray(meta)) return undefined;\n  if (JSON.stringify(meta).length > MAX_METADATA_BYTES) return undefined;\n  return meta;\n}\n",
    "function sanitizeMetadata(meta) {\n  if (meta === undefined || meta === null) return null;\n  if (typeof meta !== 'object' || Array.isArray(meta)) return undefined;\n  if (JSON.stringify(meta).length > MAX_METADATA_BYTES) return undefined;\n  return meta;\n}\n\nfunction normalizeStorefrontCountryCode(value) {\n  if (value === undefined || value === null || value === '') return null;\n  const code = String(value).trim().toUpperCase();\n  return /^[A-Z]{3}$/.test(code) ? code : undefined;\n}\n",
    'analytics country normalizer',
)

a = replace_once(
    a,
    "  async function recordActiveDay(userId) {\n    await pool.query(\n      `INSERT INTO user_activity_days (user_id, active_date)\n       VALUES ($1, (now() AT TIME ZONE $2)::date)\n       ON CONFLICT (user_id, active_date) DO NOTHING`,\n      [userId, APP_TIMEZONE]\n    );\n  }\n",
    "  async function recordActiveDay(userId) {\n    await pool.query(\n      `INSERT INTO user_activity_days (user_id, active_date)\n       VALUES ($1, (now() AT TIME ZONE $2)::date)\n       ON CONFLICT (user_id, active_date) DO NOTHING`,\n      [userId, APP_TIMEZONE]\n    );\n  }\n\n  async function recordStorefrontCountry(userId, countryCode) {\n    if (!countryCode) return;\n    await pool.query(\n      `UPDATE account_installations\n       SET app_store_country_code = $2,\n           app_store_country_observed_at = NOW(),\n           updated_at = NOW()\n       WHERE installation_id = $1\n         AND unlinked_at IS NULL`,\n      [userId, countryCode]\n    );\n  }\n",
    'analytics storefront persistence',
)

a = replace_once(
    a,
    "      const userId = identity.userId;\n\n      await recordActiveDay(userId);\n      await recordEvent(userId, 'app_opened', null);\n\n      return res.json({ success: true });",
    "      const userId = identity.userId;\n      const rawStorefrontCountryCode = req.body?.storefrontCountryCode;\n      const storefrontCountryCode = normalizeStorefrontCountryCode(rawStorefrontCountryCode);\n\n      if (rawStorefrontCountryCode != null && rawStorefrontCountryCode !== '' && storefrontCountryCode === undefined) {\n        return res.status(400).json({\n          success: false,\n          error: 'invalid storefrontCountryCode',\n        });\n      }\n\n      await recordStorefrontCountry(userId, storefrontCountryCode);\n      await recordActiveDay(userId);\n      await recordEvent(\n        userId,\n        'app_opened',\n        storefrontCountryCode ? { storefrontCountryCode } : null\n      );\n\n      return res.json({ success: true });",
    'analytics app-open country capture',
)
analytics_path.write_text(a)

# ---------------------------------------------------------------------------
# Dashboard data: total tracked events per authenticated account, resolved App
# Store storefront country, Most events sorting, and a geography endpoint.
# ---------------------------------------------------------------------------
routes_path = Path('subscriptionAdminDashboardRoutes.js')
r = routes_path.read_text()

r = replace_once(
    r,
    "const allowedSorts = new Set(['newest', 'oldest', 'last_sign_in']);",
    "const allowedSorts = new Set(['newest', 'oldest', 'last_sign_in', 'most_events']);",
    'account activity sorts',
)

r = replace_once(
    r,
    "          OR COALESCE(aff.display_name, '') ILIKE ${p}\n        )`);",
    "          OR COALESCE(aff.display_name, '') ILIKE ${p}\n          OR COALESCE(country.country_code, '') ILIKE ${p}\n        )`);",
    'account activity country search',
)

r = replace_once(
    r,
    "        last_sign_in: 'COALESCE(GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at), a.created_at) DESC, a.created_at DESC',\n      }[sort];",
    "        last_sign_in: 'COALESCE(GREATEST(a.last_authenticated_at, ai.last_authenticated_at, gi.last_authenticated_at), a.created_at) DESC, a.created_at DESC',\n        most_events: 'COALESCE(usage.total_events, 0) DESC, a.created_at DESC, a.id DESC',\n      }[sort];",
    'account activity most events order',
)

r = replace_once(
    r,
    "          ar.creator_code AS referral_code,\n          aff.display_name AS affiliate_display_name,\n          ar.claim_source AS referral_source,\n          ar.claimed_at AS referral_claimed_at\n        FROM accounts a",
    "          ar.creator_code AS referral_code,\n          aff.display_name AS affiliate_display_name,\n          ar.claim_source AS referral_source,\n          ar.claimed_at AS referral_claimed_at,\n          COALESCE(usage.total_events, 0)::int AS total_events,\n          usage.last_event_at,\n          country.country_code,\n          country.country_source\n        FROM accounts a",
    'account activity select additions',
)

r = replace_once(
    r,
    "        LEFT JOIN affiliate_account_referrals ar ON ar.account_id = a.id\n        LEFT JOIN affiliates aff ON aff.id = ar.affiliate_id\n        LEFT JOIN LATERAL (\n          SELECT\n            BOOL_OR(has_pro_access) AS has_pro_access,",
    "        LEFT JOIN affiliate_account_referrals ar ON ar.account_id = a.id\n        LEFT JOIN affiliates aff ON aff.id = ar.affiliate_id\n        LEFT JOIN LATERAL (\n          SELECT\n            COUNT(*)::int AS total_events,\n            MAX(e.created_at) AS last_event_at\n          FROM user_events e\n          WHERE e.user_id IN (\n            SELECT DISTINCT installation_id\n            FROM account_installations account_install\n            WHERE account_install.account_id = a.id\n          )\n            AND NOT EXISTS (\n              SELECT 1\n              FROM excluded_analytics_users excluded\n              WHERE excluded.user_id = e.user_id\n            )\n        ) usage ON TRUE\n        LEFT JOIN LATERAL (\n          SELECT country_code, country_source\n          FROM (\n            SELECT\n              install_country.app_store_country_code AS country_code,\n              'observed_storefront'::text AS country_source,\n              install_country.app_store_country_observed_at AS observed_at,\n              0 AS source_priority\n            FROM account_installations install_country\n            WHERE install_country.account_id = a.id\n              AND install_country.app_store_country_code ~ '^[A-Z]{3}$'\n\n            UNION ALL\n\n            SELECT\n              UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code,\n              'analytics_storefront'::text AS country_source,\n              event_country.created_at AS observed_at,\n              1 AS source_priority\n            FROM user_events event_country\n            WHERE event_country.user_id IN (\n              SELECT DISTINCT installation_id\n              FROM account_installations linked_install\n              WHERE linked_install.account_id = a.id\n            )\n              AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'\n            ORDER BY observed_at DESC NULLS LAST\n            LIMIT 1\n          ) observed_country\n          ORDER BY source_priority ASC, observed_at DESC NULLS LAST\n          LIMIT 1\n        ) observed_country ON TRUE\n        LEFT JOIN LATERAL (\n          SELECT\n            UPPER(storefront) AS country_code\n          FROM subscription_admin_current_customers_v1 subscription_country\n          WHERE subscription_country.account_id = a.id\n            AND subscription_country.environment = 'Production'\n            AND UPPER(COALESCE(subscription_country.storefront, '')) ~ '^[A-Z]{3}$'\n          ORDER BY COALESCE(subscription_country.latest_transaction_signed_date, subscription_country.updated_at) DESC NULLS LAST\n          LIMIT 1\n        ) subscription_country ON TRUE\n        LEFT JOIN LATERAL (\n          SELECT\n            COALESCE(observed_country.country_code, subscription_country.country_code) AS country_code,\n            CASE\n              WHEN observed_country.country_code IS NOT NULL THEN observed_country.country_source\n              WHEN subscription_country.country_code IS NOT NULL THEN 'subscription_storefront'\n              ELSE NULL\n            END AS country_source\n        ) country ON TRUE\n        LEFT JOIN LATERAL (\n          SELECT\n            BOOL_OR(has_pro_access) AS has_pro_access,",
    'account activity usage and country joins',
)

r = replace_once(
    r,
    "          referralSource: row.referral_source,\n          referralClaimedAt: row.referral_claimed_at,\n        })),",
    "          referralSource: row.referral_source,\n          referralClaimedAt: row.referral_claimed_at,\n          totalEvents: Number(row.total_events || 0),\n          lastEventAt: row.last_event_at,\n          countryCode: row.country_code || null,\n          countrySource: row.country_source || null,\n        })),",
    'account activity response fields',
)

geography_route = r'''  router.get('/data/accounts-geography', async (req, res) => {
    try {
      const allowedPeriods = new Set(['7d', '30d', 'all']);
      const period = allowedPeriods.has(String(req.query.period || ''))
        ? String(req.query.period)
        : '30d';
      const where = [];
      if (period === '7d') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 6`);
      } else if (period === '30d') {
        where.push(`(a.created_at AT TIME ZONE 'America/Chicago')::date >= (NOW() AT TIME ZONE 'America/Chicago')::date - 29`);
      }

      const result = await historyPool.query(`
        WITH account_country AS (
          SELECT
            a.id,
            a.created_at,
            COALESCE(observed_country.country_code, subscription_country.country_code) AS country_code
          FROM accounts a
          LEFT JOIN LATERAL (
            SELECT country_code
            FROM (
              SELECT
                install_country.app_store_country_code AS country_code,
                install_country.app_store_country_observed_at AS observed_at,
                0 AS source_priority
              FROM account_installations install_country
              WHERE install_country.account_id = a.id
                AND install_country.app_store_country_code ~ '^[A-Z]{3}$'

              UNION ALL

              SELECT
                UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code,
                event_country.created_at AS observed_at,
                1 AS source_priority
              FROM user_events event_country
              WHERE event_country.user_id IN (
                SELECT DISTINCT installation_id
                FROM account_installations linked_install
                WHERE linked_install.account_id = a.id
              )
                AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'
              ORDER BY observed_at DESC NULLS LAST
              LIMIT 1
            ) observed
            ORDER BY source_priority ASC, observed_at DESC NULLS LAST
            LIMIT 1
          ) observed_country ON TRUE
          LEFT JOIN LATERAL (
            SELECT UPPER(storefront) AS country_code
            FROM subscription_admin_current_customers_v1 subscription_country
            WHERE subscription_country.account_id = a.id
              AND subscription_country.environment = 'Production'
              AND UPPER(COALESCE(subscription_country.storefront, '')) ~ '^[A-Z]{3}$'
            ORDER BY COALESCE(subscription_country.latest_transaction_signed_date, subscription_country.updated_at) DESC NULLS LAST
            LIMIT 1
          ) subscription_country ON TRUE
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        )
        SELECT
          country_code,
          COUNT(*)::int AS accounts
        FROM account_country
        GROUP BY country_code
        ORDER BY accounts DESC, country_code ASC NULLS LAST
      `);

      const rows = result.rows || [];
      const totalAccounts = rows.reduce((sum, row) => sum + Number(row.accounts || 0), 0);
      const countries = rows
        .filter((row) => row.country_code)
        .map((row) => ({
          countryCode: row.country_code,
          accounts: Number(row.accounts || 0),
        }));
      const knownAccounts = countries.reduce((sum, row) => sum + row.accounts, 0);

      return res.json({
        success: true,
        period,
        totalAccounts,
        knownAccounts,
        unknownAccounts: Math.max(0, totalAccounts - knownAccounts),
        countries,
      });
    } catch (error) {
      console.error('[subscription-admin] account geography failed', error);
      return res.status(500).json({ error: 'Failed to load account geography' });
    }
  });

'''

r = replace_once(
    r,
    "  router.get('/data/accounts-summary', async (_req, res) => {",
    geography_route + "  router.get('/data/accounts-summary', async (_req, res) => {",
    'account geography route insertion',
)
routes_path.write_text(r)

# ---------------------------------------------------------------------------
# Accounts UI: add Events and App Store country columns plus a geographic
# interest map with 7D/30D/All range controls. The map uses a lightweight
# local SVG silhouette and bubbles, keeping the private dashboard dependency-free.
# ---------------------------------------------------------------------------
ui_path = Path('lib/subscriptionAdminAccountsUi.js')
u = ui_path.read_text()

u = replace_once(
    u,
    'placeholder="Search name, email, account ID, or referral"',
    'placeholder="Search name, email, account ID, referral, or country code"',
    'account activity search placeholder',
)

u = replace_once(
    u,
    '<option value="oldest">Oldest</option><option value="last_sign_in">Last sign-in</option>',
    '<option value="oldest">Oldest</option><option value="last_sign_in">Last sign-in</option><option value="most_events">Most events</option>',
    'account activity most events option',
)

month_section = r'''      <div class="section">\n        <div class="sectionhead"><h2>Accounts created by month</h2><span id="accountsChartSummary">New registered accounts</span></div>'''
geography_section = r'''      <div class="section">\n        <div class="sectionhead account-geography-head"><div><h2>Geographic interest</h2><span class="account-geography-note">App Store country · not precise device location</span></div><div class="accounts-daily-controls"><span id="accountGeographySummary">Loading geography...</span><div class="account-range" role="group" aria-label="Account geography range"><button type="button" data-account-geo-range="7d">7D</button><button type="button" class="active" data-account-geo-range="30d">30D</button><button type="button" data-account-geo-range="all">All</button></div></div></div>\n        <div class="account-geography-layout">\n          <div id="accountGeographyMap" class="account-geography-map"><div class="loading">Loading geographic interest...</div></div>\n          <div id="accountGeographyList" class="account-geography-list"><div class="loading">Loading countries...</div></div>\n        </div>\n      </div>\n'''
u = replace_once(u, month_section, geography_section + month_section, 'geography section')

css_anchor = r'''    .account-referral { display:flex;flex-direction:column;gap:2px; }\n'''
css_add = css_anchor + r'''    .account-events { font-variant-numeric:tabular-nums;font-weight:780;color:#dfe4ec; }\n    .account-country { display:inline-flex;align-items:center;gap:6px;white-space:nowrap; }\n    .account-country-code { color:#dfe4ec;font-weight:750;letter-spacing:.04em; }\n    .account-geography-head > div:first-child { display:flex;flex-direction:column;gap:4px; }\n    .account-geography-note { color:#69717e !important;font-size:10px !important; }\n    .account-geography-layout { display:grid;grid-template-columns:minmax(0,1.55fr) minmax(240px,.65fr);min-height:340px; }\n    .account-geography-map { min-width:0;padding:16px;border-right:1px solid #20242c;display:flex;align-items:center;justify-content:center; }\n    .account-geography-map svg { display:block;width:100%;height:auto;max-height:390px; }\n    .account-geography-list { padding:12px 16px;max-height:390px;overflow:auto; }\n    .account-geography-row { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid #1c2027; }\n    .account-geography-row:last-child { border-bottom:0; }\n    .account-geography-country { display:flex;align-items:center;gap:8px;min-width:0; }\n    .account-geography-country strong { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px; }\n    .account-geography-country span { color:#69717e;font-size:10px;letter-spacing:.04em; }\n    .account-geography-value { text-align:right;font-variant-numeric:tabular-nums; }\n    .account-geography-value strong { font-size:12px; }\n    .account-geography-value span { display:block;color:#69717e;font-size:10px;margin-top:2px; }\n    .account-map-outline { fill:#151a20;stroke:#303844;stroke-width:1.2; }\n    .account-map-grid { stroke:#1d242c;stroke-width:1; }\n    .account-map-bubble { fill:#d4b566;stroke:#fff3c4;stroke-width:1.3;fill-opacity:.76; }\n    .account-map-bubble:hover { fill-opacity:1; }\n    @media (max-width:900px){ .account-geography-layout{grid-template-columns:1fr}.account-geography-map{border-right:0;border-bottom:1px solid #20242c}.account-geography-list{max-height:300px} }\n'''
u = replace_once(u, css_anchor, css_add, 'geography css')

old_table = r'''  function accountActivityTableHtml(rows){\n    if(!rows?.length)return '<div class="empty">No accounts match these filters.</div>';\n    return '<table><thead><tr><th>Account</th><th>Status</th><th>Access</th><th>Referral</th><th>Created</th><th>Last sign-in</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><div class="account-activity-name"><strong>'+esc(accountActivityName(row))+'</strong>'+(row.email&&row.email!==accountActivityName(row)?'<span class="muted">'+esc(row.email)+'</span>':'')+'<span class="account-activity-id">'+esc(row.id)+'</span></div></td><td>'+accountStatusHtml(row)+'</td><td>'+accountAccessHtml(row)+'</td><td>'+accountReferralHtml(row)+'</td><td>'+esc(fmtDate(row.createdAt))+'</td><td>'+esc(row.lastAuthenticatedAt?fmtDate(row.lastAuthenticatedAt):'Never')+'</td></tr>').join('')+'</tbody></table>';\n  }\n'''
new_table = r'''  function accountCountryHtml(row){ const code=String(row.countryCode||'').toUpperCase(); return code?'<span class="account-country"><span class="account-country-code">'+esc(code)+'</span></span>':'<span class="muted">Unknown</span>'; }\n  function accountActivityTableHtml(rows){\n    if(!rows?.length)return '<div class="empty">No accounts match these filters.</div>';\n    return '<table><thead><tr><th>Account</th><th>Status</th><th>Access</th><th>Events</th><th>App Store country</th><th>Referral</th><th>Created</th><th>Last sign-in</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><div class="account-activity-name"><strong>'+esc(accountActivityName(row))+'</strong>'+(row.email&&row.email!==accountActivityName(row)?'<span class="muted">'+esc(row.email)+'</span>':'')+'<span class="account-activity-id">'+esc(row.id)+'</span></div></td><td>'+accountStatusHtml(row)+'</td><td>'+accountAccessHtml(row)+'</td><td><span class="account-events" title="Tracked analytics events across this account’s linked installations">'+esc(Number(row.totalEvents||0).toLocaleString())+'</span></td><td>'+accountCountryHtml(row)+'</td><td>'+accountReferralHtml(row)+'</td><td>'+esc(fmtDate(row.createdAt))+'</td><td>'+esc(row.lastAuthenticatedAt?fmtDate(row.lastAuthenticatedAt):'Never')+'</td></tr>').join('')+'</tbody></table>';\n  }\n'''
u = replace_once(u, old_table, new_table, 'account activity table')

geo_script_anchor = r'''  async function loadAccountActivity(){\n'''
geo_script = r'''  const ACCOUNT_COUNTRY_META={"USA":["United States",38,-97],"CAN":["Canada",60,-95],"MEX":["Mexico",23,-102],"BRA":["Brazil",-10,-55],"ARG":["Argentina",-34,-64],"CHL":["Chile",-30,-71],"COL":["Colombia",4,-72],"PER":["Peru",-10,-76],"VEN":["Venezuela",8,-66],"URY":["Uruguay",-33,-56],"GBR":["United Kingdom",54,-2],"IRL":["Ireland",53,-8],"FRA":["France",46,2],"DEU":["Germany",51,9],"ESP":["Spain",40,-4],"PRT":["Portugal",39.5,-8],"ITA":["Italy",42.8,12.8],"NLD":["Netherlands",52.5,5.8],"BEL":["Belgium",50.8,4],"CHE":["Switzerland",47,8],"AUT":["Austria",47.3,13.3],"SWE":["Sweden",62,15],"NOR":["Norway",62,10],"FIN":["Finland",64,26],"DNK":["Denmark",56,10],"POL":["Poland",52,20],"CZE":["Czech Republic",49.8,15.5],"SVK":["Slovakia",48.7,19.5],"HUN":["Hungary",47,20],"ROU":["Romania",46,25],"BGR":["Bulgaria",43,25],"GRC":["Greece",39,22],"HRV":["Croatia",45.2,15.5],"SVN":["Slovenia",46.1,14.8],"SRB":["Serbia",44.1,16.4],"UKR":["Ukraine",49,32],"RUS":["Russia",60,100],"TUR":["Turkey",39,35],"ISR":["Israel",31.5,34.8],"SAU":["Saudi Arabia",25,45],"ARE":["United Arab Emirates",24,54],"QAT":["Qatar",25.5,51.2],"KWT":["Kuwait",29.5,45.8],"EGY":["Egypt",27,30],"MAR":["Morocco",32,-5],"DZA":["Algeria",28,3],"ZAF":["South Africa",-29,24],"NGA":["Nigeria",10,8],"KEN":["Kenya",1,38],"ETH":["Ethiopia",8,38],"GHA":["Ghana",8,-2],"IND":["India",20,77],"PAK":["Pakistan",30,70],"BGD":["Bangladesh",24,90],"LKA":["Sri Lanka",7,81],"NPL":["Nepal",28,84],"CHN":["China",35,105],"HKG":["Hong Kong",22.2,114.2],"TWN":["Taiwan",23.5,121],"JPN":["Japan",36,138],"KOR":["South Korea",37,127.5],"PHL":["Philippines",13,122],"IDN":["Indonesia",-5,120],"MYS":["Malaysia",2.5,112.5],"SGP":["Singapore",1.4,103.8],"THA":["Thailand",15,100],"VNM":["Vietnam",16.2,107.8],"KHM":["Cambodia",13,105],"AUS":["Australia",-27,133],"NZL":["New Zealand",-41,174],"FJI":["Fiji",-18,175],"PNG":["Papua New Guinea",-6,147],"KAZ":["Kazakhstan",48,68],"UZB":["Uzbekistan",41,64],"GEO":["Georgia",42,43.5],"ARM":["Armenia",40,45],"AZE":["Azerbaijan",40.5,47.5],"ISL":["Iceland",65,-18],"EST":["Estonia",59,26],"LVA":["Latvia",57,25],"LTU":["Lithuania",56,24],"CYP":["Cyprus",35,33],"MLT":["Malta",35.8,14.6],"LUX":["Luxembourg",49.8,6.2]};\n  const ACCOUNT_WORLD_PATHS=['M70 135 L125 82 L205 64 L286 98 L308 151 L274 190 L229 185 L205 225 L151 205 L112 175 Z','M246 228 L291 226 L330 271 L326 345 L297 421 L266 389 L249 315 Z','M443 103 L487 83 L540 91 L566 121 L548 148 L514 143 L493 174 L462 159 Z','M491 168 L554 164 L595 205 L579 286 L538 356 L494 321 L470 245 Z','M558 93 L676 65 L820 83 L915 132 L892 194 L810 218 L754 181 L682 205 L621 165 Z','M770 284 L847 271 L904 306 L882 362 L806 369 L764 332 Z','M918 366 L946 348 L969 375 L947 411 L920 397 Z'];\n  let accountGeographyRange='30d';\n  function accountCountryName(code){ return ACCOUNT_COUNTRY_META[String(code||'').toUpperCase()]?.[0]||String(code||'Unknown'); }\n  function accountMapPoint(code){ const meta=ACCOUNT_COUNTRY_META[String(code||'').toUpperCase()]; if(!meta)return null; const lat=Number(meta[1]),lon=Number(meta[2]); return {x:((lon+180)/360)*1000,y:((85-Math.max(-85,Math.min(85,lat)))/170)*500}; }\n  function renderAccountGeography(data){\n    const map=qs('#accountGeographyMap'),list=qs('#accountGeographyList'),summary=qs('#accountGeographySummary'); if(!map||!list||!summary)return;\n    const rows=[...(data?.countries||[])].sort((a,b)=>Number(b.accounts||0)-Number(a.accounts||0)); const known=Number(data?.knownAccounts||0),total=Number(data?.totalAccounts||0),unknown=Number(data?.unknownAccounts||0);\n    summary.textContent=total?(known+' of '+total+' known · '+Math.round((known/total)*100)+'% coverage'):'No accounts in this period';\n    qsa('[data-account-geo-range]').forEach(button=>button.classList.toggle('active',button.dataset.accountGeoRange===accountGeographyRange));\n    if(!rows.length){ map.innerHTML='<div class="empty">No known App Store countries in this period.</div>'; list.innerHTML='<div class="empty">'+(unknown?esc(unknown+' account'+(unknown===1?'':'s')+' currently unknown'):'No geography data yet.')+'</div>'; return; }\n    const max=Math.max(1,...rows.map(row=>Number(row.accounts||0)));\n    const gridLines=[250,500,750].map(x=>'<line class="account-map-grid" x1="'+x+'" y1="25" x2="'+x+'" y2="475"/>').join('')+[125,250,375].map(y=>'<line class="account-map-grid" x1="25" y1="'+y+'" x2="975" y2="'+y+'"/>').join('');\n    const outlines=ACCOUNT_WORLD_PATHS.map(path=>'<path class="account-map-outline" d="'+path+'"/>').join('');\n    const bubbles=rows.map(row=>{ const point=accountMapPoint(row.countryCode); if(!point)return ''; const value=Number(row.accounts||0),radius=6+Math.sqrt(value/max)*20; return '<circle class="account-map-bubble" cx="'+point.x.toFixed(1)+'" cy="'+point.y.toFixed(1)+'" r="'+radius.toFixed(1)+'"><title>'+esc(accountCountryName(row.countryCode)+': '+value+' account'+(value===1?'':'s'))+'</title></circle>'; }).join('');\n    map.innerHTML='<svg role="img" aria-label="Account interest by App Store country" viewBox="0 0 1000 500">'+gridLines+outlines+bubbles+'</svg>';\n    list.innerHTML=rows.map(row=>{ const value=Number(row.accounts||0),share=known?Math.round((value/known)*100):0; return '<div class="account-geography-row"><div class="account-geography-country"><strong>'+esc(accountCountryName(row.countryCode))+'</strong><span>'+esc(row.countryCode)+'</span></div><div class="account-geography-value"><strong>'+esc(value)+'</strong><span>'+esc(share+'% known')+'</span></div></div>'; }).join('')+(unknown?'<div class="account-geography-row"><div class="account-geography-country"><strong>Unknown</strong><span>Awaiting storefront</span></div><div class="account-geography-value"><strong>'+esc(unknown)+'</strong></div></div>':'');\n  }\n  async function loadAccountGeography(){\n    const map=qs('#accountGeographyMap'),list=qs('#accountGeographyList'); if(!map||!list)return; map.innerHTML='<div class="loading">Loading geographic interest...</div>'; list.innerHTML='<div class="loading">Loading countries...</div>';\n    try{ const data=await api('/accounts-geography?period='+encodeURIComponent(accountGeographyRange)); renderAccountGeography(data); }catch(e){ showError(map,e); showError(list,e); }\n  }\n  function bindAccountGeography(){ qsa('[data-account-geo-range]').forEach(button=>{ if(button.dataset.bound==='1')return; button.dataset.bound='1'; button.addEventListener('click',()=>{ accountGeographyRange=button.dataset.accountGeoRange||'30d'; loadAccountGeography(); }); }); }\n'''
u = replace_once(u, geo_script_anchor, geo_script + geo_script_anchor, 'geography client script')

u = replace_once(
    u,
    r'''    bindAccountActivity(); loadAccountActivity();\n    try{''',
    r'''    bindAccountActivity(); loadAccountActivity(); bindAccountGeography(); loadAccountGeography();\n    try{''',
    'load accounts geography hook',
)
ui_path.write_text(u)

# ---------------------------------------------------------------------------
# Tests: protect semantics and keep Newest as the default sort.
# ---------------------------------------------------------------------------
test_path = Path('test/subscriptionAdminAccountUsageGeography.test.js')
test_path.write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';

test('account activity exposes total events, country and Most events without changing Newest default', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /new Set\(\['newest', 'oldest', 'last_sign_in', 'most_events'\]\)/);
  assert.match(source, /: 'newest';/);
  assert.match(source, /COUNT\(\*\)::int AS total_events/);
  assert.match(source, /excluded_analytics_users/);
  assert.match(source, /app_store_country_code/);
  assert.match(source, /subscription_storefront/);
  assert.match(source, /totalEvents: Number\(row\.total_events \|\| 0\)/);
  assert.match(source, /countryCode: row\.country_code \|\| null/);
});

test('geography endpoint defaults to 30 days and returns coverage', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /router\.get\('\/data\/accounts-geography'/);
  assert.match(source, /new Set\(\['7d', '30d', 'all'\]\)/);
  assert.match(source, /: '30d';/);
  assert.match(source, /knownAccounts/);
  assert.match(source, /unknownAccounts/);
});

test('accounts UI renders usage and geographic interest controls', () => {
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
  assert.match(html, /<th>App Store country<\/th>/);
  assert.match(html, /<h2>Geographic interest<\/h2>/);
  assert.match(html, /data-account-geo-range="30d"/);
  assert.match(html, /<option value="newest" selected>Newest<\/option>/);
  assert.match(html, /<option value="most_events">Most events<\/option>/);
  assert.match(html, /function loadAccountGeography\(\)/);
});

test('analytics app-open accepts a validated storefront country and persists it', () => {
  const source = fs.readFileSync('analytics.js', 'utf8');
  assert.match(source, /normalizeStorefrontCountryCode/);
  assert.match(source, /storefrontCountryCode/);
  assert.match(source, /UPDATE account_installations/);
  assert.match(source, /app_store_country_observed_at = NOW\(\)/);
});
''')

print('Account usage and geography patch applied.')
