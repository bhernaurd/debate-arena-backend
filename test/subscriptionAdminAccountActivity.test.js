import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';

test('account activity route supports newest-first account creation inspection', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /router\.get\('\/data\/accounts-activity'/);
  assert.match(source, /: 'newest';/);
  assert.match(source, /newest: 'a\.created_at DESC, a\.id DESC'/);
  assert.match(source, /most_recently_active: 'usage\.last_event_at DESC NULLS LAST, a\.created_at DESC, a\.id DESC'/);
  assert.match(source, /MAX\(e\.created_at\) AS last_event_at/);
  assert.match(source, /FROM accounts a/);
  assert.match(source, /account_apple_identities/);
  assert.match(source, /affiliate_account_referrals/);
  assert.match(source, /subscription_admin_cross_platform_current_customers_v1/);
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
  assert.match(html, /<option value="most_recently_active">Most recently active<\/option>/);
  assert.doesNotMatch(html, /<option value="last_sign_in">/);
  assert.match(html, /<th>Last active<\/th>/);
  assert.match(html, /row\.lastEventAt\?fmtDate\(row\.lastEventAt\):'Never'/);
  assert.doesNotMatch(html, /<th>Last sign-in<\/th>/);
  assert.match(html, /function accountActivityParams\(\)/);
  assert.match(html, /loadAccountActivity/);
});

test('account activity resolves verified subscription referrals when no account claim exists', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  const start = source.indexOf("router.get('/data/accounts-activity'");
  const end = source.indexOf("router.get('/data/accounts-geography'", start);
  const route = source.slice(start, end);
  assert.match(route, /LEFT JOIN LATERAL \([\s\S]*?FROM subscription_admin_customers_v1 sc/);
  assert.match(route, /sc.account_id = a.id/);
  assert.match(route, /sc.environment = 'Production'/);
  assert.match(route, /FROM affiliate_google_play_subscription_attributions g/);
  assert.match(route, /g.account_id = a.id/);
  assert.match(route, /COALESCE\(apple_aff.creator_code, play_aff.creator_code, ar.creator_code\) AS referral_code/);
  assert.match(route, /verified_apple_subscription/);
  assert.match(route, /verified_google_play_subscription/);
  assert.match(route, /OR COALESCE\(apple_aff.creator_code, ''\) ILIKE/);
  assert.match(route, /OR COALESCE\(play_aff.creator_code, ''\) ILIKE/);
});

test('account activity table shows last tracked event rather than last authentication', () => {
  const source = fs.readFileSync('lib/subscriptionAdminAccountsUi.js', 'utf8');
  assert.match(source, /<th>Last active<\/th>/);
  assert.match(source, /row\.lastEventAt\?fmtDate\(row\.lastEventAt\):'Never'/);
  assert.doesNotMatch(source, /row\.lastAuthenticatedAt/);
  assert.doesNotMatch(source, /<th>Last sign-in<\/th>/);
});

test('account activity counts only app opens over linked installations', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  const start = source.indexOf("router.get('/data/accounts-activity'");
  const end = source.indexOf("router.get('/data/accounts-geography'", start);
  const route = source.slice(start, end);
  assert.match(route, /COUNT\(\*\) FILTER \(WHERE e\.event_name = 'app_opened'\)::int AS app_opens/);
  assert.match(route, /COALESCE\(usage\.app_opens, 0\)::int AS app_opens/);
  assert.match(route, /appOpens: Number\(row\.app_opens \|\| 0\)/);
  assert.match(route, /FROM account_installations account_install/);
  assert.match(route, /FROM excluded_analytics_users excluded/);
});

test('account activity shows lifetime app opens between referral and created', () => {
  for (const path of ['lib/subscriptionAdminAccountsUi.js', 'lib/subscriptionAdminAccountsUiBase.js']) {
    const source = fs.readFileSync(path, 'utf8');
    assert.match(source, /<th>Referral<\/th><th>App opens<\/th><th>Created<\/th>/);
    assert.match(source, /Number\(row\.appOpens\|\|0\)\.toLocaleString\(\)/);
  }
});
