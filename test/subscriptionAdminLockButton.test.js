import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('subscription dashboard exposes a Lock control that clears the session', () => {
  const source = fs.readFileSync('subscriptionAdminDashboardBaseRoutes.js', 'utf8');
  assert.match(source, /action="\/subscription-admin\/logout"/);
  assert.match(source, />Lock<\/button>/);
  assert.equal(source.includes('>Sign out</button>'), false);
});
