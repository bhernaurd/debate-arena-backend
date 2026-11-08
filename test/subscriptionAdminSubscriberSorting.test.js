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
  assert.match(html,/<th>Subscription<\/th>/);
  assert.match(html,/<th>Value<\/th>/);
  assert.match(html,/<th>Next billing<\/th>/);
  // Environment columns elsewhere in the admin page do not belong to the subscriber table.
  assert.doesNotMatch(html,/<th>Price<\/th>/);
  assert.doesNotMatch(html,/Months subscribed/);
  assert.match(html,/Payments collected/);
  assert.match(html,/payments\)\+' collected'/);
  assert.match(html,/Lifetime value/);
  assert.match(html,/lifetime_value_usd/);
  assert.match(html,/subscriberPlanPriceUsd/);
  assert.match(html,/subscriberOriginalPlanPrice/);
  assert.match(html,/actualPaymentText/);
  assert.match(html,/Actual payment/);
  assert.match(html,/US plan price/);
  assert.match(html,/Local currency not reported by Google Play/);
  assert.match(html,/payment_count/);
  assert.match(html,/paymentCountFromTransactions/);
  assert.doesNotMatch(html,/subscriberMonths\(r\)/);
  assert.match(html,/subscriber_since\|\|r\.original_purchase_date/);
  assert.match(html,/api\('\/customers\?'\+subscriberParams\(\)\.toString\(\)\)/);
  const script=html.match(/<script>\s*([\s\S]*?)\s*<\/script>/i)?.[1]||'';
  assert.ok(script);
  new vm.Script(script,{filename:'subscription-admin-client.js'});
});

test('Subscribers table combines plan/store and keeps detailed attribution in customer drawer',()=>{
  const html=renderFinalDashboard();
  assert.match(html,/<th>Subscription<\/th>/);
  assert.match(html,/<th>Referral<\/th>/);
  assert.match(html,/Google Play/);
  assert.match(html,/App Store/);
  assert.match(html,/googlePlanMilli/);
  assert.match(html,/agora_pro_monthly/);
  assert.match(html,/7990/);
  assert.match(html,/agora_pro_yearly/);
  assert.match(html,/49990/);
  assert.match(html,/affiliate_display_name/);
  assert.match(html,/affiliate_code/);
  assert.match(html,/\['Referral',c\.affiliate_display_name/);
  assert.match(html,/Affiliate attribution/);
  assert.match(html,/affiliate_attribution_source/);
  assert.match(html,/t\.store_platform==='google_play'/);
  assert.match(html,/e\.store_platform==='google_play'/);
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
  assert.match(source,/lifetime_value_by_currency/);
  assert.match(source,/subscription_admin_cross_platform_transaction_timeline_v1/);
  assert.match(source,/timeline\.is_trial IS NOT TRUE/);
  assert.match(source,/timeline\.revocation_date IS NULL/);
  assert.match(source,/timeline\.price_milliunits IS NOT NULL/);
  assert.match(source,/timeline\.store_platform = 'google_play'/);
  assert.match(source,/timeline\.product_id IN \('agora_pro_monthly', 'agora_pro_yearly'\)/);
  assert.match(source,/THEN 7990/);
  assert.match(source,/THEN 49990/);
  assert.match(source,/createSubscriptionUsdConverter/);
  assert.match(source,/subscriberUsdSummary/);
  assert.match(source,/canonicalPlanPriceUsd/);
  assert.match(source,/US_PLAN_PRICE_MILLIUNITS/);
  assert.match(source,/lifetime_value_usd/);
  assert.match(source,/price_usd/);
  assert.match(source,/payment_count: paymentCount/);
  assert.match(source,/reportingCurrency: 'USD'/);
});
