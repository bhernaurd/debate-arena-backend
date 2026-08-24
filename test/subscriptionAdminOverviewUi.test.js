import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';

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
  return output;
}

test('Overview keeps four primary KPIs and moves subscriber detail to Breakdown', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());

  assert.match(html, /data-view="breakdown">Breakdown<\/button>/);
  assert.match(html, /id="view-breakdown"/);
  assert.match(html, /id="breakdownMetrics"/);

  const overview = html.match(/<section id="view-overview">([\s\S]*?)<section id="view-breakdown"/i)?.[1] || '';
  assert.ok(overview, 'Overview section not found');
  assert.doesNotMatch(overview, /<h2>Access source<\/h2>/);
  assert.doesNotMatch(overview, /<h2>Status<\/h2>/);
  assert.match(overview, /<h2>Apple payouts<\/h2>/);
  assert.match(overview, /Recent customers/);

  const loadOverview = html.match(/async function loadOverview\(\)\{([\s\S]*?)async function loadBreakdown/i)?.[1] || '';
  assert.ok(loadOverview, 'loadOverview function not found');
  assert.match(loadOverview, /metric\('Active Pro'/);
  assert.match(loadOverview, /metric\('Paid subscribers'/);
  assert.match(loadOverview, /metric\('Gross sales this month'/);
  assert.match(loadOverview, /metric\('Apple proceeds est\.'/);
  assert.doesNotMatch(loadOverview, /metric\('Trials'/);
  assert.doesNotMatch(loadOverview, /metric\('Monthly'/);
  assert.doesNotMatch(loadOverview, /metric\('Annual'/);
  assert.doesNotMatch(loadOverview, /metric\('Lifetime'/);
  assert.doesNotMatch(loadOverview, /metric\('Canceling'/);

  assert.match(html, /async function loadBreakdown\(\)/);
  assert.match(html, /metric\('Trials'/);
  assert.match(html, /metric\('Monthly'/);
  assert.match(html, /metric\('Annual'/);
  assert.match(html, /metric\('Lifetime'/);
  assert.match(html, /metric\('Canceling'/);
});

test('Apple payout schedule is collapsed by default and emphasizes current information', () => {
  const html = applyDashboardEnhancements(renderBaseDashboard());
  const payoutSection = html.match(/<div class="section apple-payout-section">([\s\S]*?)<div class="section"><div class="sectionhead"><h2>Recent customers/i)?.[1] || '';

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
