import assert from 'node:assert/strict';
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
