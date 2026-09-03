import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('overview derives Trials ending from active trials with auto-renew disabled', () => {
  const source = fs.readFileSync(new URL('../subscriptionAdminRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /trials_ending/);
  assert.match(source, /AND trial_active\s+AND auto_renew_enabled = FALSE/);
  assert.match(source, /trials_ending: trialsEndingResult\.rows\[0\]\?\.trials_ending \|\| 0/);
});

test('Subscriber Analytics shows Trials ending as a separate warning metric', () => {
  const overviewUi = fs.readFileSync(new URL('../lib/subscriptionAdminOverviewUi.js', import.meta.url), 'utf8');
  const lifetimeUi = fs.readFileSync(new URL('../lib/subscriptionAdminLifetimeUi.js', import.meta.url), 'utf8');
  assert.match(overviewUi, /metric\('Trials ending',m\.trials_ending\|\|0,'Free trials with auto-renew off'\)/);
  assert.match(lifetimeUi, /key\.includes\('trials ending'\)/);
});
