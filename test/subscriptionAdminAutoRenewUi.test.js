import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';
import { enhanceSubscriptionAdminRevenueHtml } from '../lib/subscriptionAdminRevenueUi.js';
import { enhanceSubscriptionAdminLifetimeHtml } from '../lib/subscriptionAdminLifetimeUi.js';
import { enhanceSubscriptionAdminAccountsHtml } from '../lib/subscriptionAdminAccountsUi.js';
import { enhanceSubscriptionAdminAutoRenewHtml } from '../lib/subscriptionAdminAutoRenewUi.js';

function renderBaseDashboard() {
  const source = fs.readFileSync(new URL('../subscriptionAdminDashboardBaseRoutes.js', import.meta.url), 'utf8');
  const a = source.indexOf('function renderDashboardPage({ sessionHours }) {');
  const b = source.indexOf('\n\nfunction queryString(req) {', a);
  return new Function(`${source.slice(a, b)}; return renderDashboardPage;`)()({ sessionHours: 12 });
}

function renderFinalDashboard() {
  let output = String(renderBaseDashboard())
    .replace('Auto-renew off but access remains', 'Paid subscriptions ending this month')
    .replace(`metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`, `metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`);
  output = enhanceSubscriptionAdminHistoryHtml(output);
  output = enhanceSubscriptionAdminPayoutHtml(output);
  output = enhanceSubscriptionAdminOverviewHtml(output);
  output = enhanceSubscriptionAdminRevenueHtml(output);
  output = enhanceSubscriptionAdminLifetimeHtml(output);
  output = enhanceSubscriptionAdminAccountsHtml(output);
  return enhanceSubscriptionAdminAutoRenewHtml(output);
}

test('Subscriber Analytics shows Apple auto-renew freshness and drawer shows per-chain verification age', () => {
  const html = renderFinalDashboard();
  assert.match(html, /id="renewalFreshness"/);
  assert.match(html, /api\('\/auto-renew-verification'\)/);
  assert.match(html, /function autoRenewDetail\(c\)/);
  assert.match(html, /verified '\+age/);
  assert.match(html, /\['Auto-renew',autoRenewDetail\(c\)\]/);
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1] || '';
  assert.ok(script);
  new vm.Script(script, { filename: 'subscription-admin-client.js' });
});

test('dashboard exposes private auto-renew verification state route', () => {
  const source = fs.readFileSync(new URL('../subscriptionAdminDashboardRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /router\.get\('\/data\/auto-renew-verification'/);
  assert.match(source, /getAppleSubscriptionVerificationState/);
});

test('real-time Apple signed renewal notifications publish verification state', () => {
  const source = fs.readFileSync(new URL('../appStoreSubscriptionRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /recordAppleAutoRenewVerification/);
  assert.match(source, /source: 'apple_notification'/);
});
