import assert from 'node:assert/strict';
import test from 'node:test';

import { enhanceSubscriptionAdminMobileHtml } from '../lib/subscriptionAdminMobileUi.js';

test('mobile subscription admin enhancements stay scoped to mobile layout', () => {
  const input = `<!doctype html><html><head>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="apple-touch-icon" sizes="180x180" href="/subscription-admin-icon.png?v=1" />
  <link rel="icon" type="image/png" sizes="180x180" href="/subscription-admin-icon.png?v=1" />
  <style>.desktop-sentinel{display:block}</style></head><body><div class="shell"><aside><nav></nav></aside><main></main></div></body></html>`;

  const output = enhanceSubscriptionAdminMobileHtml(input);

  assert.match(output, /viewport-fit=cover/);
  assert.match(output, /theme-color/);
  assert.match(output, /apple-mobile-web-app-capable/);
  assert.match(output, /rel="manifest" href="\/subscription-admin\.webmanifest\?v=1"/);
  assert.match(output, /apple-touch-icon\.png\?v=3/);
  assert.match(output, /subscription-admin-icon\.png\?v=3/);
  assert.match(output, /background:url\('\/subscription-admin-icon\.png\?v=3'\) center\/cover no-repeat/);
  assert.match(output, /\/\* subscription-admin-mobile-v1 \*\//);
  assert.match(output, /@media \(max-width:760px\)/);
  assert.match(output, /grid-template-areas:"brand lock" "nav nav"/);
  assert.match(output, /\.nav:nth-child\(4\),\.nav:nth-child\(5\)\{grid-column:span 3;/);
  assert.match(output, /#breakdownChart,#accountsDailyChart,#accountsChart,#revenueTrendChart\{overflow-x:auto;/);
  assert.match(output, /#breakdownChart svg\{min-width:680px!important;/);
  assert.match(output, /#accountsDailyChart svg\{min-width:900px!important;/);
  assert.match(output, /const chartIds = \['breakdownChart','accountsDailyChart','accountsChart','revenueTrendChart'\]/);
  assert.match(output, /element\.scrollLeft = Math\.max\(0, element\.scrollWidth - element\.clientWidth\)/);
  assert.match(output, /MutationObserver\(\(\) => alignCurrent\(element\)\)/);
  assert.match(output, /\[data-view\],\[data-account-range\]/);
  assert.doesNotMatch(output, /#view-accounts:has\([^)]*\) #accountsDailyChart svg\{min-width:0!important;/);
  assert.doesNotMatch(output, /#breakdownChart svg\{min-width:0!important;/);
  assert.match(output, /\.desktop-sentinel\{display:block\}/);
});
