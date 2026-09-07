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
  assert.match(output, /mobile-web-app-capable/);
  assert.match(output, /application-name/);
  assert.match(output, /rel="manifest" href="\/subscription-admin\.webmanifest\?v=3"/);
  assert.doesNotMatch(output, /rel="apple-touch-icon"/);
  assert.match(output, /subscription-admin-icon\.svg\?v=5/);
  assert.match(output, /background:url\('\/subscription-admin-icon\.svg\?v=5'\) center\/cover no-repeat/);
  assert.match(output, /\/\* subscription-admin-mobile-v1 \*\//);
  assert.match(output, /@media \(max-width:760px\)/);
  assert.match(output, /grid-template-areas:"brand lock" "nav nav"/);
  assert.match(output, /\.nav:nth-child\(4\),\.nav:nth-child\(5\)\{grid-column:span 3;/);
  assert.match(output, /#breakdownChart,#accountsDailyChart,#accountsChart,#revenueTrendChart\{overflow-x:auto;/);
  assert.match(output, /#breakdownChart svg\{min-width:680px!important;/);
  assert.match(output, /#accountsDailyChart svg\{min-width:900px!important;/);
  assert.match(output, /\.drawerback\.open \.drawer\{display:block!important;position:fixed!important;inset:0!important;width:100%!important;max-width:100%!important;height:100dvh!important;/);
  assert.match(output, /grid-template-columns:none!important;grid-template-rows:none!important;grid-template-areas:none!important;gap:0!important;/);
  assert.match(output, /\.drawer>\.drawerhead\{display:flex!important;flex-direction:row!important;justify-content:space-between!important;align-items:center!important;position:sticky!important;top:0!important;/);
  assert.match(output, /\.drawer>\.drawerhead>div\{min-width:0!important;width:auto!important;max-width:calc\(100% - 90px\)!important;flex:1 1 auto!important;/);
  assert.match(output, /\.drawerhead \.sub\{display:block!important;max-width:100%!important;font-size:11px;line-height:1\.35;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;/);
  assert.match(output, /\.detailgrid\{display:grid!important;grid-template-columns:minmax\(0,1fr\)!important;gap:10px!important;margin-top:0!important;/);
  assert.match(output, /\.detail span\{display:block;max-width:100%;font-size:15px;line-height:1\.45;white-space:normal;overflow-wrap:anywhere;/);
  assert.match(output, /\.timeline\+\.timeline\{margin-top:30px!important;/);
  assert.match(output, /\.event\{display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0 0 10px!important;border:1px solid #242832;border-left:3px solid #3a404b;border-radius:12px;/);
  assert.match(output, /const chartIds = \['breakdownChart','accountsDailyChart','accountsChart','revenueTrendChart'\]/);
  assert.match(output, /element\.scrollLeft = Math\.max\(0, element\.scrollWidth - element\.clientWidth\)/);
  assert.match(output, /MutationObserver\(\(\) => alignCurrent\(element\)\)/);
  assert.match(output, /\[data-view\],\[data-account-range\]/);
  assert.doesNotMatch(output, /#view-accounts:has\([^)]*\) #accountsDailyChart svg\{min-width:0!important;/);
  assert.doesNotMatch(output, /#breakdownChart svg\{min-width:0!important;/);
  assert.match(output, /\.desktop-sentinel\{display:block\}/);
});
