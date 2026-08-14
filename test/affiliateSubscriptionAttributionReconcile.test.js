import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(
  fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(testDirectory, '..');

const scriptSource = fs.readFileSync(
  path.join(
    repositoryRoot,
    'scripts',
    'reconcileAffiliateSubscriptionAttributions.js'
  ),
  'utf8'
);

test('reconciliation only backfills stored verified offer-code transactions that map to active affiliates', () => {
  assert.match(
    scriptSource,
    /FROM app_store_transactions tx[\s\S]*?JOIN affiliates affiliate/
  );
  assert.match(
    scriptSource,
    /tx\.offer_type[\s\S]*?OFFER_CODE/
  );
  assert.match(
    scriptSource,
    /affiliate\.status = 'active'/
  );
  assert.match(
    scriptSource,
    /affiliate\.code_status = 'active'/
  );
  assert.match(
    scriptSource,
    /NOT EXISTS[\s\S]*?affiliate_subscription_attributions/
  );
});

test('reconciliation canonicalizes legacy environment casing and remains idempotent', () => {
  assert.match(
    scriptSource,
    /LOWER\(tx\.environment\) = 'production'[\s\S]*?'Production'/
  );
  assert.match(
    scriptSource,
    /LOWER\(tx\.environment\) = 'sandbox'[\s\S]*?'Sandbox'/
  );
  assert.match(
    scriptSource,
    /DISTINCT ON/
  );
});

test('reconciliation uses the same attribution service and wraps each candidate atomically', () => {
  assert.match(
    scriptSource,
    /createAffiliateSubscriptionAttributionService/
  );
  assert.match(
    scriptSource,
    /await client\.query\('BEGIN'\)[\s\S]*?observeVerifiedTransaction[\s\S]*?await client\.query\('COMMIT'\)/
  );
  assert.match(
    scriptSource,
    /await client\.query\('ROLLBACK'\)/
  );
});
