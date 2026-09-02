import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';
import { enhanceSubscriptionAdminRevenueHtml } from '../lib/subscriptionAdminRevenueUi.js';
import { enhanceSubscriptionAdminLifetimeHtml } from '../lib/subscriptionAdminLifetimeUi.js';

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
  return enhanceSubscriptionAdminLifetimeHtml(output);
}
test('Overview uses compact monthly context',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/new this month/); assert.match(html,/first paid this month/); assert.match(html,/started this month/); assert.match(html,/Month to date/); assert.match(html,/overviewAppleHint/);
  const overview=html.match(/<section id="view-overview">([\s\S]*?)<section id="view-breakdown"/i)?.[1]||'';
  assert.doesNotMatch(overview,/historyPeriod|breakdownPeriod/);
});
test('Subscriber Analytics shows canonical Agora account count',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/api\('\/accounts-summary'\)/); assert.match(html,/metric\('Accounts'/); assert.match(html,/Registered Agora accounts · excludes deleted/); assert.match(html,/tone-info/);
});
test('rendered client stays valid',()=>{
  const script=renderFinalDashboard().match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1]||''; assert.ok(script); new vm.Script(script,{filename:'subscription-admin-client.js'});
});
test('account summary route uses accounts table',()=>{
  const source=fs.readFileSync(new URL('../subscriptionAdminDashboardRoutes.js',import.meta.url),'utf8'); assert.match(source,/router\.get\('\/data\/accounts-summary'/); assert.match(source,/FROM accounts/); assert.match(source,/status <> 'deleted'/);
});
