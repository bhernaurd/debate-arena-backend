import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { enhanceSubscriptionAdminHistoryHtml } from '../lib/subscriptionAdminHistoryUi.js';
import { enhanceSubscriptionAdminOverviewHtml } from '../lib/subscriptionAdminOverviewUi.js';
import { enhanceSubscriptionAdminPayoutHtml } from '../lib/subscriptionAdminPayoutUi.js';
import { enhanceSubscriptionAdminRevenueHtml } from '../lib/subscriptionAdminRevenueUi.js';

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

function renderFinalDashboard() {
  let output = String(renderBaseDashboard())
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
  output = enhanceSubscriptionAdminRevenueHtml(output);
  return output;
}

test('navigation names clearly separate subscriber analytics from revenue', () => {
  const html = renderFinalDashboard();
  const nav = html.match(/<nav>([\s\S]*?)<\/nav>/i)?.[1] || '';

  assert.match(nav, /data-view="breakdown">Subscriber Analytics<\/button>/);
  assert.match(nav, /data-view="history">Revenue<\/button>/);
  assert.match(nav, /data-view="events">Subscribers<\/button>/);
  assert.match(html, /breakdown:\['Subscriber Analytics','Subscriber totals, plan mix and lifecycle trends over time'\]/);
  assert.match(html, /history:\['Revenue','Sales, Apple proceeds, fees and refunds over time'\]/);
});

test('Revenue keeps four financial KPIs and removes subscriber KPIs', () => {
  const html = renderFinalDashboard();
  const metricSet = html.match(/function historyMetricSet\(summary,isAllTime\)\{([\s\S]*?)function monthlyAppleCell/i)?.[1] || '';

  assert.ok(metricSet, 'historyMetricSet not found');
  assert.match(metricSet, /metric\('Gross sales'/);
  assert.match(metricSet, /metric\('Apple proceeds est\.'/);
  assert.match(metricSet, /metric\('Apple fees \+ tax est\.'/);
  assert.match(metricSet, /metric\('Refunds'/);
  assert.doesNotMatch(metricSet, /Apple reported gross/);
  assert.doesNotMatch(metricSet, /Final Apple proceeds/);
  assert.doesNotMatch(metricSet, /Paid customers|New paid|Trial starts|Trial → Paid|Cancellation requests|Subscriptions ended/);
});

test('Revenue includes trend graph and simplified monthly financial table', () => {
  const html = renderFinalDashboard();
  const revenue = html.match(/<section id="view-history"[^>]*>([\s\S]*?)<section id="view-events"/i)?.[1] || '';
  const historyTableFn = html.match(/function historyTableHtml\(months,currentMonth\)\{([\s\S]*?)function financialPeriodsHtml/i)?.[1] || '';

  assert.ok(revenue, 'Revenue section not found');
  assert.match(revenue, /<h2>Revenue trend<\/h2>/);
  assert.match(revenue, /id="revenueTrendChart"/);
  assert.match(revenue, /<h2>Monthly financial history<\/h2>/);
  assert.match(html, /function renderRevenueTrend\(selected='all'\)/);
  assert.ok(historyTableFn, 'historyTableHtml not found');
  assert.match(historyTableFn, /Gross sales<\/th><th>Apple proceeds est\.<\/th><th>Fees \+ tax est\.<\/th><th>Refunds<\/th><th>Final proceeds<\/th>/);
  assert.doesNotMatch(historyTableFn, /<th>New paid<\/th>|<th>Trials<\/th>|<th>Trial → Paid<\/th>|<th>Cancels<\/th>|<th>Ended<\/th>/);
});

test('Final Apple settlements are collapsed by default', () => {
  const html = renderFinalDashboard();
  const revenue = html.match(/<section id="view-history"[^>]*>([\s\S]*?)<section id="view-events"/i)?.[1] || '';

  assert.match(revenue, /<details class="section revenue-settlements">/);
  assert.doesNotMatch(revenue, /<details class="section revenue-settlements"[^>]*\sopen(?:\s|>)/);
  assert.match(revenue, /View settlements/);
  assert.match(revenue, /id="financialHistoryTable"/);
});

test('Revenue enhancer leaves the rendered client script syntactically valid', () => {
  const html = renderFinalDashboard();
  const script = html.match(/<script>([\s\S]*?)<\/script>/i)?.[1] || '';

  assert.ok(script, 'dashboard script not found');
  assert.doesNotMatch(script, /<\/html>/i);
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'subscription-admin-client.js' }));
});
