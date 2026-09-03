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
import { enhanceSubscriptionAdminSubscribersHtml } from '../lib/subscriptionAdminSubscribersUi.js';

function renderBaseDashboard(){
  const source=fs.readFileSync(new URL('../subscriptionAdminDashboardBaseRoutes.js',import.meta.url),'utf8');
  const a=source.indexOf('function renderDashboardPage({ sessionHours }) {');
  const b=source.indexOf('\n\nfunction queryString(req) {',a);
  return new Function(`${source.slice(a,b)}; return renderDashboardPage;`)()({sessionHours:12});
}
function renderFinalDashboard(){
  let output=String(renderBaseDashboard())
    .replace('Auto-renew off but access remains','Paid subscriptions ending this month')
    .replace(`metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`,`metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`)
    .replace(`<div class="section"><div class="sectionhead"><h2>Subscription events</h2><span>Newest first</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading events...</div></div></div>`,`<div class="section"><div class="sectionhead"><h2>Subscription customers</h2><span>Current state · click a customer for full history</span></div><div class="tablewrap" id="eventTable"><div class="loading">Loading customers...</div></div></div>`)
    .replace(`placeholder="Event type, e.g. RENEWAL"`,`placeholder="Filter history event, e.g. DID_RENEW"`);
  output=enhanceSubscriptionAdminHistoryHtml(output);
  output=enhanceSubscriptionAdminPayoutHtml(output);
  output=enhanceSubscriptionAdminOverviewHtml(output);
  output=enhanceSubscriptionAdminRevenueHtml(output);
  output=enhanceSubscriptionAdminLifetimeHtml(output);
  output=enhanceSubscriptionAdminAccountsHtml(output);
  output=enhanceSubscriptionAdminAutoRenewHtml(output);
  return enhanceSubscriptionAdminSubscribersHtml(output);
}

test('Subscribers tab offers activity, newest, and oldest sorting',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/id="subscriberSort"/);
  assert.match(html,/Last activity/);
  assert.match(html,/Newest subscribers/);
  assert.match(html,/Oldest subscribers/);
  assert.match(html,/Subscriber since/);
  assert.match(html,/subscriber_since\|\|r\.original_purchase_date/);
  assert.match(html,/api\('\/customers\?'\+subscriberParams\(\)\.toString\(\)\)/);
  const script=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1]||'';
  assert.ok(script);
  new vm.Script(script,{filename:'subscription-admin-client.js'});
});

test('customer API uses a validated server-side sort',()=>{
  const source=fs.readFileSync(new URL('../subscriptionAdminRoutes.js',import.meta.url),'utf8');
  assert.match(source,/CUSTOMER_SORTS/);
  assert.match(source,/normalizeCustomerSort\(req\.query\.sort\)/);
  assert.match(source,/sort === 'newest'/);
  assert.match(source,/sort === 'oldest'/);
  assert.match(source,/subscriber_since DESC NULLS LAST/);
  assert.match(source,/subscriber_since ASC NULLS LAST/);
  assert.match(source,/SELECT MIN\(COALESCE\(history\.original_purchase_date, history\.purchase_date, history\.created_at\)\)/);
});
