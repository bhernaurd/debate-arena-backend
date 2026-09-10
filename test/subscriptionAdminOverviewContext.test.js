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

function renderBaseDashboard() {
  const source=fs.readFileSync(new URL('../subscriptionAdminDashboardBaseRoutes.js',import.meta.url),'utf8');
  const a=source.indexOf('function renderDashboardPage({ sessionHours }) {');
  const b=source.indexOf('\n\nfunction queryString(req) {',a);
  const render=new Function(`${source.slice(a,b)}; return renderDashboardPage;`)();
  return render({sessionHours:12});
}
function renderFinalDashboard(){
  let output=String(renderBaseDashboard()).replace('Auto-renew off but access remains','Paid subscriptions ending this month').replace(`metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`,`metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`);
  output=enhanceSubscriptionAdminHistoryHtml(output);
  output=enhanceSubscriptionAdminPayoutHtml(output);
  output=enhanceSubscriptionAdminOverviewHtml(output);
  output=enhanceSubscriptionAdminRevenueHtml(output);
  output=enhanceSubscriptionAdminLifetimeHtml(output);
  return enhanceSubscriptionAdminAccountsHtml(output);
}
test('Overview uses compact monthly context',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/new this month/); assert.match(html,/first paid this month/); assert.match(html,/started this month/); assert.match(html,/Month to date/); assert.match(html,/overviewAppleHint/);
  const overview=html.match(/<section id="view-overview">([\s\S]*?)<section id="view-breakdown"/i)?.[1]||'';
  assert.doesNotMatch(overview,/historyPeriod|breakdownPeriod/);
});
test('Accounts has its own acquisition tab and is removed from Subscriber Analytics',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/data-view="accounts">Accounts<\/button>/);
  assert.match(html,/id="view-accounts"/);
  assert.match(html,/<h2>Accounts created by day<\/h2>/);
  assert.match(html,/<h2>Accounts created by month<\/h2>/);
  assert.match(html,/metric\('Current accounts'/);
  assert.match(html,/metric\('Created today'/);
  assert.match(html,/metric\('Created this month'/);
  assert.match(html,/metric\('All-time created'/);
  assert.match(html,/data-account-range="7"/);
  assert.match(html,/data-account-range="30"/);
  assert.match(html,/data-account-range="90"/);
  assert.match(html,/aria-label="Accounts created by day"/);
  assert.match(html,/aria-label="Accounts created by month"/);
  const breakdown=html.match(/<section id="view-breakdown"[^>]*>([\s\S]*?)<section id="view-customers"/i)?.[1]||'';
  assert.doesNotMatch(breakdown,/metric\('Accounts'/);
});
test('rendered client stays valid',()=>{
  const script=renderFinalDashboard().match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1]||''; assert.ok(script); new vm.Script(script,{filename:'subscription-admin-client.js'});
});
test('account summary route tracks daily and monthly creations from canonical accounts table',()=>{
  const source=fs.readFileSync(new URL('../subscriptionAdminDashboardRoutes.js',import.meta.url),'utf8'); assert.match(source,/router\.get\('\/data\/accounts-summary'/); assert.match(source,/FROM accounts/); assert.match(source,/status <> 'deleted'/); assert.match(source,/created_at AT TIME ZONE 'America\/Chicago'/); assert.match(source,/generate_series/); assert.match(source,/createdToday/); assert.match(source,/createdLast7Days/); assert.match(source,/createdPrevious7Days/); assert.match(source,/days: dailyResult\.rows/); assert.match(source,/createdAccounts/);
});
