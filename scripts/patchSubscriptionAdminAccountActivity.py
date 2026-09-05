from pathlib import Path

routes = Path('subscriptionAdminDashboardRoutes.js')
s = routes.read_text()
route_anchor = "  router.get('/data/accounts-summary', async (_req, res) => {"
if route_anchor not in s:
    raise SystemExit('accounts summary route anchor not found')

activity_route = r'''  router.get('/data/accounts-activity', async (req, res) => {
    try {
      const allowedSorts = new Set(['newest', 'oldest', 'last_sign_in']);
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
          ar.claimed_at AS referral_claimed_at
        FROM accounts a
        LEFT JOIN latest_apple_identity ai ON ai.account_id = a.id
        LEFT JOIN latest_google_identity gi ON gi.account_id = a.id
        LEFT JOIN affiliate_account_referrals ar ON ar.account_id = a.id
        LEFT JOIN affiliates aff ON aff.id = ar.affiliate_id
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
        })),
      });
    } catch (error) {
      console.error('[subscription-admin] account activity failed', error);
      res.status(500).json({ error: 'Failed to load account activity' });
    }
  });

'''

if "router.get('/data/accounts-activity'" not in s:
    s = s.replace(route_anchor, activity_route + route_anchor)
routes.write_text(s)

ui = Path('lib/subscriptionAdminAccountsUi.js')
x = ui.read_text()
old_section = '''      <div class="section">\\n        <div class="sectionhead"><h2>Accounts created by month</h2><span id="accountsChartSummary">New registered accounts</span></div>\\n        <div id="accountsChart" class="accounts-chart"><div class="loading">Loading account creation history...</div></div>\\n      </div>'''
activity_section = '''      <div class="section">\\n        <div class="sectionhead"><h2>Account activity</h2><span>Newest accounts first · America/Chicago</span></div>\\n        <div class="toolbar account-activity-toolbar">\\n          <input id="accountActivitySearch" type="search" placeholder="Search name, email, account ID, or referral" autocomplete="off" />\\n          <select id="accountActivityPeriod" aria-label="Account activity period"><option value="all">All accounts</option><option value="today">Today</option><option value="7d">Last 7 days</option></select>\\n          <select id="accountActivityAccess" aria-label="Account access filter"><option value="all">All access</option><option value="pro">Pro</option><option value="free">Free</option></select>\\n          <select id="accountActivitySort" aria-label="Account activity sort"><option value="newest" selected>Newest</option><option value="oldest">Oldest</option><option value="last_sign_in">Last sign-in</option></select>\\n          <button type="button" id="accountActivityRefresh">Refresh</button>\\n        </div>\\n        <div class="tablewrap" id="accountActivityTable"><div class="loading">Loading account activity...</div></div>\\n      </div>\\n      <div class="section">\\n        <div class="sectionhead"><h2>Accounts created by month</h2><span id="accountsChartSummary">New registered accounts</span></div>\\n        <div id="accountsChart" class="accounts-chart"><div class="loading">Loading account creation history...</div></div>\\n      </div>'''
if old_section not in x:
    raise SystemExit('accounts month section anchor not found')
if 'id="accountActivityTable"' not in x:
    x = x.replace(old_section, activity_section)

css_anchor = '''    .account-range button.active { color:#d9efff;background:rgba(102,168,232,.16);box-shadow:inset 0 0 0 1px rgba(102,168,232,.24); }\\n'''
css_add = css_anchor + '''    .account-activity-toolbar { display:grid;grid-template-columns:minmax(260px,1fr) repeat(3,minmax(120px,auto)) auto;align-items:center;padding:14px 16px;margin:0;border-bottom:1px solid #20242c;gap:8px; }\\n    .account-activity-toolbar input,.account-activity-toolbar select,.account-activity-toolbar button { min-height:38px; }\\n    .account-activity-name { display:flex;flex-direction:column;gap:3px;min-width:180px; }\\n    .account-activity-name strong { color:#f1f3f6;font-size:12px; }\\n    .account-activity-id { color:#737b89;font:10px ui-monospace,SFMono-Regular,Menlo,monospace; }\\n    .account-status-active { color:#8de1bd; }\\n    .account-status-deleted,.account-status-deletion_pending { color:#ff9ca4; }\\n    .account-access-pro { color:#8de1bd;font-weight:750; }\\n    .account-access-trial { color:#bba6ff;font-weight:750; }\\n    .account-referral { display:flex;flex-direction:column;gap:2px; }\\n    @media (max-width:900px){ .account-activity-toolbar{grid-template-columns:1fr 1fr}.account-activity-toolbar input{grid-column:1/-1}.account-activity-toolbar button{grid-column:1/-1} }\\n'''
if css_anchor not in x:
    raise SystemExit('accounts css anchor not found')
if '.account-activity-toolbar' not in x:
    x = x.replace(css_anchor, css_add)

script_anchor = '''  async function loadAccounts(){\\n    const metrics=qs('#accountMetrics'), dailyChart=qs('#accountsDailyChart'), chart=qs('#accountsChart'), table=qs('#accountsTable');'''
activity_script = r'''  function accountActivityParams(){
    const p=new URLSearchParams();
    const q=qs('#accountActivitySearch')?.value?.trim(); if(q)p.set('q',q);
    p.set('period',qs('#accountActivityPeriod')?.value||'all');
    p.set('access',qs('#accountActivityAccess')?.value||'all');
    p.set('sort',qs('#accountActivitySort')?.value||'newest');
    return p;
  }
  function accountActivityName(row){ return row.displayName || row.email || shortId(row.id); }
  function accountStatusHtml(row){ const status=String(row.status||'unknown'); return '<span class="pill account-status-'+esc(status)+'">'+esc(titleCase(status))+'</span>'; }
  function accountAccessHtml(row){ const label=String(row.accessLabel||'Free'); const cls=row.hasProAccess?(label==='Trial'?'account-access-trial':'account-access-pro'):''; return '<span class="'+cls+'">'+esc(label)+'</span>'; }
  function accountReferralHtml(row){ if(!row.referralCode&&!row.affiliateDisplayName)return '<span class="muted">None</span>'; return '<div class="account-referral"><strong>'+esc(row.referralCode||row.affiliateDisplayName)+'</strong>'+(row.affiliateDisplayName&&row.affiliateDisplayName!==row.referralCode?'<span class="muted">'+esc(row.affiliateDisplayName)+'</span>':'')+'</div>'; }
  function accountActivityTableHtml(rows){
    if(!rows?.length)return '<div class="empty">No accounts match these filters.</div>';
    return '<table><thead><tr><th>Account</th><th>Status</th><th>Access</th><th>Referral</th><th>Created</th><th>Last sign-in</th></tr></thead><tbody>'+rows.map(row=>'<tr><td><div class="account-activity-name"><strong>'+esc(accountActivityName(row))+'</strong>'+(row.email&&row.email!==accountActivityName(row)?'<span class="muted">'+esc(row.email)+'</span>':'')+'<span class="account-activity-id">'+esc(row.id)+'</span></div></td><td>'+accountStatusHtml(row)+'</td><td>'+accountAccessHtml(row)+'</td><td>'+accountReferralHtml(row)+'</td><td>'+esc(fmtDate(row.createdAt))+'</td><td>'+esc(row.lastAuthenticatedAt?fmtDate(row.lastAuthenticatedAt):'Never')+'</td></tr>').join('')+'</tbody></table>';
  }
  async function loadAccountActivity(){
    const el=qs('#accountActivityTable'); if(!el)return;
    el.innerHTML='<div class="loading">Loading account activity...</div>';
    try{ const data=await api('/accounts-activity?'+accountActivityParams().toString()); el.innerHTML=accountActivityTableHtml(data.accounts||[]); }
    catch(e){ showError(el,e); }
  }
  function bindAccountActivity(){
    const search=qs('#accountActivitySearch');
    if(search&&!search.dataset.bound){ search.dataset.bound='1'; let timer; search.addEventListener('input',()=>{ clearTimeout(timer); timer=setTimeout(loadAccountActivity,250); }); }
    ['#accountActivityPeriod','#accountActivityAccess','#accountActivitySort'].forEach(selector=>{ const el=qs(selector); if(el&&!el.dataset.bound){ el.dataset.bound='1'; el.addEventListener('change',loadAccountActivity); } });
    const refresh=qs('#accountActivityRefresh'); if(refresh&&!refresh.dataset.bound){ refresh.dataset.bound='1'; refresh.addEventListener('click',loadAccountActivity); }
  }
'''
if script_anchor not in x:
    raise SystemExit('loadAccounts script anchor not found')
if 'function accountActivityParams()' not in x:
    x = x.replace(script_anchor, activity_script.replace('\n', '\\n') + script_anchor)

old_load = '''    const metrics=qs('#accountMetrics'), dailyChart=qs('#accountsDailyChart'), chart=qs('#accountsChart'), table=qs('#accountsTable');\\n    metrics.innerHTML='<div class="loading">Loading accounts...</div>'; dailyChart.innerHTML='<div class="loading">Loading daily account creation...</div>'; chart.innerHTML='<div class="loading">Loading account creation history...</div>'; table.innerHTML='<div class="loading">Loading account history...</div>';'''
new_load = '''    const metrics=qs('#accountMetrics'), dailyChart=qs('#accountsDailyChart'), chart=qs('#accountsChart'), table=qs('#accountsTable');\\n    metrics.innerHTML='<div class="loading">Loading accounts...</div>'; dailyChart.innerHTML='<div class="loading">Loading daily account creation...</div>'; chart.innerHTML='<div class="loading">Loading account creation history...</div>'; table.innerHTML='<div class="loading">Loading account history...</div>';\\n    bindAccountActivity(); loadAccountActivity();'''
if old_load not in x:
    raise SystemExit('loadAccounts initialization anchor not found')
x = x.replace(old_load, new_load)
ui.write_text(x)

test = Path('test/subscriptionAdminAccountActivity.test.js')
test.write_text(r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';

test('account activity route supports newest-first account creation inspection', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /router\.get\('\/data\/accounts-activity'/);
  assert.match(source, /: 'newest';/);
  assert.match(source, /newest: 'a\.created_at DESC, a\.id DESC'/);
  assert.match(source, /FROM accounts a/);
  assert.match(source, /account_apple_identities/);
  assert.match(source, /affiliate_account_referrals/);
  assert.match(source, /subscription_admin_current_customers_v1/);
  assert.match(source, /LIMIT 200/);
});

test('accounts UI exposes activity search, filters and Newest default', () => {
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
  assert.match(html, /<h2>Account activity<\/h2>/);
  assert.match(html, /id="accountActivitySearch"/);
  assert.match(html, /id="accountActivitySort"/);
  assert.match(html, /<option value="newest" selected>Newest<\/option>/);
  assert.match(html, /function accountActivityParams\(\)/);
  assert.match(html, /loadAccountActivity/);
});
''')
