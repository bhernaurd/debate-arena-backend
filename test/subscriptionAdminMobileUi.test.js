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
  assert.match(output, /apple-mobile-web-app-capable/);
  assert.match(output, /apple-touch-icon\.png\?v=2/);
  assert.match(output, /subscription-admin-icon\.png\?v=2/);
  assert.match(output, /\/\* subscription-admin-mobile-v1 \*\//);
  assert.match(output, /@media \(max-width:760px\)/);
  assert.match(output, /grid-template-areas:"brand lock" "nav nav"/);
  assert.match(output, /\.nav:nth-child\(4\),\.nav:nth-child\(5\)\{grid-column:span 3;/);
  assert.match(output, /#view-accounts:has\(\[data-account-range="7"\]\.active\) #accountsDailyChart svg\{min-width:0!important;/);
  assert.match(output, /\.desktop-sentinel\{display:block\}/);
});
