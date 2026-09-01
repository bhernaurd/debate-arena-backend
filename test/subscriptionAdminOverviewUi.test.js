import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';
import { enhanceSubscriptionAdminLifetimeHtml } from '../lib/subscriptionAdminLifetimeUi.js';

function renderBaseDashboard() {
  const source = fs.readFileSync(
    new URL('../subscriptionAdminDashboardBaseRoutes.js', import.meta.url),
    'utf8'
  );
  const startMarker = 'function renderDashboardPage({ sessionHours }) {';
  const endMarker = '\n\nfunction queryString(req) {';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'renderDashboardPage start not found');
  assert.notEqual(end, -1, 'renderDashboardPage end not found');

  const fnSource = source.slice(start, end);
  const render = new Function(`${fnSource}; return renderDashboardPage;`)();
  return render({ sessionHours: 12 });
}

function applyDashboardEnhancements(html) {
  let output = String(html)
    .replace(
      'Auto-renew off but access remains',
      'Paid subscriptions ending this month'
    )
    .replace(
      `metric('Estimated MRR',money(m.estimated_mrr_usd||0),'Recurring only. Lifetime excluded')`,
      `metric('Sales this month',money(m.net_sales_this_month_usd||0),'Customer billings this month · before Apple fees/tax')`
    );
  output = enhanceSubscriptionAdminHistoryHtml(output);
  output = enhanceSubscriptionAdminPayoutHtml(output);
  output = enhanceSubscriptionAdminOverviewHtml(output);
  output = enhanceSubscriptionAdminLifetimeHtml(output);
  return output;
}

test('Overview shows free trials instead of Lifetime Pro', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());

  assert.match(html, /data-view="breakdown">Breakdown<\/button>/);
  assert.match(html, /id="view-breakdown"/);
  assert.match(html, /id="breakdownMetrics"/);
  assert.match(html, /id="breakdownPeriod"/);
  assert.match(html, /id="breakdownTable"/);

  const overview = html.match(/<section id="view-overview">([\s\S]*?)<section id="view-breakdown"/i)?.[1] || '';
  assert.ok(overview, 'Overview section not found');
  assert.doesNotMatch(overview, /<h2>Access source<\/h2>/);
  assert.doesNotMatch(overview, /<h2>Status<\/h2>/);
  assert.match(overview, /<h2>Apple payouts<\/h2>/);
  assert.match(overview, /Recent subscribers/);

  const loadOverview = html.match(/async function loadOverview\(\)\{([\s\S]*?)let breakdownData/i)?.[1] || '';
  assert.ok(loadOverview, 'loadOverview function not found');
  assert.match(loadOverview, /metric\('Active subscriptions'/);
  assert.match(loadOverview, /metric\('Paid subscribers'/);
  assert.match(loadOverview, /metric\('Gross sales this month'/);
  assert.match(loadOverview, /metric\('Apple proceeds est\.'/);
  assert.doesNotMatch(loadOverview, /metric\('Trials'/);
  assert.doesNotMatch(loadOverview, /metric\('Monthly'/);
  assert.doesNotMatch(loadOverview, /metric\('Annual'/);
  assert.match(loadOverview, /metric\('Free trials'/);
  assert.doesNotMatch(loadOverview, /metric\('Lifetime Pro'/);
  assert.doesNotMatch(loadOverview, /metric\('Lifetime'/);
  assert.doesNotMatch(loadOverview, /metric\('Canceling'/);
  assert.doesNotMatch(loadOverview, /sourceDistribution/);
  assert.doesNotMatch(loadOverview, /statusDistribution/);
});

test('Breakdown mirrors History with period selection and subscriber-only metrics', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());
  const breakdown = html.match(/<section id="view-breakdown"[^>]*>([\s\S]*?)<section id="view-customers"/i)?.[1] || '';

  assert.ok(breakdown, 'Breakdown section not found');
  assert.match(breakdown, /id="breakdownPeriod"/);
  assert.match(breakdown, /<option value="current">Current<\/option>/);
  assert.match(breakdown, /id="breakdownNote"/);
  assert.match(breakdown, /<h2>New subscribers by month<\/h2>/);
  assert.match(breakdown, /id="breakdownChartSummary"/);
  assert.match(breakdown, /id="breakdownChart"/);
  assert.match(breakdown, /<h2>Subscriber history<\/h2>/);
  assert.match(breakdown, /id="breakdownTable"/);
  assert.doesNotMatch(breakdown, /Access source/);
  assert.doesNotMatch(breakdown, /Estimated MRR|Gross sales|Apple proceeds/);

  assert.match(html, /async function loadBreakdown\(\)/);
  assert.match(html, /api\('\/overview'\),api\('\/history'\)/);
  assert.match(html, /function renderSubscriberGrowthChart\(selected='current'\)/);
  assert.match(html, /newSubscribers/);
  assert.match(html, /activeSubscriptionsAtMonthEnd/);
  assert.match(html, /New subscribers by month/);
  assert.match(html, /<rect/);
  assert.doesNotMatch(html, /Subscriber growth by month/);
  assert.match(html, /metric\('Active subscriptions'/);
  assert.match(html, /metric\('Free period'/);
  assert.match(html, /metric\('Monthly'/);
  assert.match(html, /metric\('Annual'/);
  assert.match(html, /metric\('Lifetime'/);
  assert.match(html, /metric\('Canceling'/);
  assert.match(html, /metric\('Free period starts'/);
  assert.match(html, /metric\('New paid'/);
  assert.match(html, /metric\('Free → Paid'/);
  assert.match(html, /metric\('Subscriptions ended'/);
  assert.match(html, /breakdownPeriod'\)\.addEventListener\('change',renderBreakdownPeriod\)/);
});

test('Customers navigation is removed and Events becomes Subscribers', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());
  const nav = html.match(/<nav>([\s\S]*?)<\/nav>/i)?.[1] || '';

  assert.ok(nav, 'Navigation not found');
  assert.doesNotMatch(nav, /data-view="customers"/);
  assert.doesNotMatch(nav, />Customers<\/button>/);
  assert.doesNotMatch(nav, />Events<\/button>/);
  assert.match(nav, /data-view="events">Subscribers<\/button>/);
  assert.match(html, /events:\['Subscribers','Current subscribers and subscription lifecycle history'\]/);
  assert.match(html, /<h2>Subscribers<\/h2><span>Current state · click a subscriber for full history<\/span>/);
});

test('Apple payout schedule is collapsed by default and emphasizes current information', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());
  const payoutSection = html.match(/<div class="section apple-payout-section">([\s\S]*?)<div class="section"><div class="sectionhead"><h2>Recent subscribers/i)?.[1] || '';

  assert.ok(payoutSection, 'Apple payout section not found');
  assert.match(payoutSection, /id="applePayoutSummary"/);
  assert.match(payoutSection, /<details class="apple-payout-details">/);
  assert.doesNotMatch(payoutSection, /<details class="apple-payout-details"[^>]*\sopen(?:\s|>)/);
  assert.match(payoutSection, /View full payout schedule/);
  assert.match(payoutSection, /Past and future fiscal periods/);
  assert.match(payoutSection, /id="applePayoutCalendar"/);

  const renderPayout = html.match(/function renderApplePayoutCalendar\(h\)\{([\s\S]*?)function eventParams/i)?.[1] || '';
  assert.ok(renderPayout, 'renderApplePayoutCalendar function not found');
  assert.match(renderPayout, /Next expected payout/);
  assert.match(renderPayout, /Current Apple fiscal period/);
  assert.doesNotMatch(renderPayout, /<div class="label">Apple payment rule<\/div>/);
});
