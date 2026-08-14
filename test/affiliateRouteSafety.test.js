import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(
  fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(testDirectory, '..');
const source = fs.readFileSync(
  path.join(repositoryRoot, 'affiliateRoutes.js'),
  'utf8'
);

test('admin affiliate creation distinguishes duplicate creator codes from duplicate Apple offer references', () => {
  assert.match(
    source,
    /affiliates_offer_identifier_unique_idx[\s\S]*?affiliate_offer_identifier_already_exists/
  );
  assert.match(
    source,
    /affiliates_normalized_code_unique[\s\S]*?affiliate_code_already_exists/
  );
});


test('partner dashboard stays read-only and presents anonymous subscriber activity', () => {
  assert.match(source, /Anonymous Subscriber Activity/);
  assert.match(source, /Subscriber<\/th>/);
  assert.match(source, /Current Subscribers/);
  assert.match(source, /Promo Active/);
  assert.match(source, /Paid \+ Renewing/);
  assert.match(source, /Paid \+ Canceling/);
  assert.match(source, /Current State<\/th>/);
  assert.match(source, /Eligible Revenue Generated/);
  assert.doesNotMatch(source, /Commission-Earning Subscribers/);
  assert.doesNotMatch(source, /Search creators/i);
  assert.doesNotMatch(source, /document\.cookie/);
});


test('performance breakdown stays cohort-focused and does not repeat lifetime financial totals', () => {
  const start = source.indexOf("document.getElementById('performanceBreakdown').innerHTML");
  const end = source.indexOf("document.getElementById('subscriberActivity')", start);

  assert.ok(start >= 0, 'performance breakdown render block should exist');
  assert.ok(end > start, 'performance breakdown render block should have an end marker');

  const block = source.slice(start, end);
  assert.match(block, /Promo Renewal Rate/);
  assert.match(block, /Promo Non-Renewals/);
  assert.match(block, /Paid Conversion Rate/);
  assert.match(block, /Active Retention/);
  assert.match(block, /Cancellation Rate/);
  assert.doesNotMatch(block, /Eligible Revenue Generated/);
  assert.doesNotMatch(block, /Lifetime Commission Earned/);
  assert.doesNotMatch(block, /Lifetime Paid/);
});

test('conversion and retention copy distinguishes historical conversion from current access', () => {
  assert.match(source, /ever reached a commission-earning paid subscription/);
  assert.match(source, /still counts as converted even if they later cancel or expire/);
  assert.match(source, /still have subscription access right now/);
  assert.match(source, /previously converted but later expired are not counted as active/);
});
