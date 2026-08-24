import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('Affiliate Admin rendered inline script parses in JavaScript', () => {
  const source = fs.readFileSync(new URL('../affiliateRoutes.js', import.meta.url), 'utf8');
  const startMarker = 'function renderAffiliateAdminDashboardPage() {';
  const endMarker = '\n}\n\nexport function createAffiliateRouter';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'renderAffiliateAdminDashboardPage start not found');
  assert.notEqual(end, -1, 'renderAffiliateAdminDashboardPage end not found');

  const fnSource = source.slice(start, end + 2);
  const render = new Function(`${fnSource}; return renderAffiliateAdminDashboardPage;`)();
  const html = render();
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match, 'Affiliate Admin inline script not found');
  assert.doesNotThrow(() => new vm.Script(match[1], { filename: 'affiliate-admin-inline.js' }));
});
