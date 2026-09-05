import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';

test('account activity exposes total events, country and Most events without changing Newest default', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardRoutes.js', 'utf8');
  assert.match(source, /new Set\(\['newest', 'oldest', 'last_sign_in', 'most_events'\]\)/);
  assert.match(source, /: 'newest';/);
  assert.match(source, /COUNT\(\*\)::int AS total_events/);
  assert.match(source, /excluded_analytics_users/);
  assert.match(source, /storefrontCountryCode/);
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
  assert.doesNotMatch(source, /UPDATE account_installations/);
  assert.match(source, /storefrontCountryCode \? \{ storefrontCountryCode \} : null/);
});
