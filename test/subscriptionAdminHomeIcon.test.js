import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('subscription admin uses a dedicated iOS home screen icon', () => {
  const dashboardSource = fs.readFileSync('subscriptionAdminDashboardBaseRoutes.js', 'utf8');
  const affiliateSource = fs.readFileSync('affiliateRoutes.js', 'utf8');
  const icon = fs.readFileSync('public/subscription-admin-icon.png');

  assert.equal((dashboardSource.match(/rel="apple-touch-icon"/g) || []).length, 2);
  assert.equal((dashboardSource.match(/\/subscription-admin-icon\.png\?v=1/g) || []).length, 4);
  assert.equal(affiliateSource.includes('/subscription-admin-icon.png'), false);
  assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
