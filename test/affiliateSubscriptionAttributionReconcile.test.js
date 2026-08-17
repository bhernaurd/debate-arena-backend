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

test('reconciliation scans verified offer-code transactions for known shared affiliate campaigns without assuming one affiliate per Apple offer', () => {
  assert.match(
    scriptSource,
    /FROM app_store_transactions tx/
  );

  // Shared-offer architecture: do not require a direct JOIN from the Apple
  // offer identifier to exactly one affiliate. Multiple affiliates may share
  // the same Apple offer reference.
  assert.doesNotMatch(
    scriptSource,
    /FROM app_store_transactions tx[\s\S]*?JOIN affiliates affiliate/
  );

  assert.match(
    scriptSource,
    /tx\.offer_type[\s\S]*?OFFER_CODE/
  );

  // The Apple offer still has to be recognized as one of our affiliate
  // campaigns, but that check is intentionally EXISTS-based so many creator
  // codes/affiliates can share the same offer reference.
  assert.match(
    scriptSource,
    /EXISTS\s*\([\s\S]*?FROM affiliates affiliate[\s\S]*?normalized_apple_offer_identifier[\s\S]*?tx\.offer_identifier/
  );

  assert.match(
    scriptSource,
    /affiliate\.status IN \('active', 'inactive'\)/
  );

  assert.match(
    scriptSource,
    /NOT EXISTS[\s\S]*?affiliate_subscription_attributions/
  );
});

test('reconciliation carries appAccountToken evidence forward so creator-code claims can resolve shared-offer attribution', () => {
  assert.match(
    scriptSource,
    /tx\.app_account_token/
  );

  assert.match(
    scriptSource,
    /appAccountToken:\s*row\.app_account_token/
  );

  assert.match(
    scriptSource,
    /createAffiliateSubscriptionAttributionService/
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

test('reconciliation uses the shared attribution service and wraps each candidate atomically', () => {
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

test('reconciliation avoids infinite retries when shared-offer rows are still waiting for creator-code evidence', () => {
  assert.match(
    scriptSource,
    /batchProgress === 0/
  );
});

test('reconciliation honors the public App Clip rollout gate and requires exact handoff evidence for new shared-offer ownership', () => {
  assert.match(
    scriptSource,
    /AFFILIATE_APP_CLIP_HANDOFF_ENABLED/
  );
  assert.match(
    scriptSource,
    /requireReferralHandoffForNewAttribution\s*=\s*parseBoolean/
  );
  assert.match(
    scriptSource,
    /createAffiliateSubscriptionAttributionService\(\{[\s\S]*?requireReferralHandoffForNewAttribution[\s\S]*?\}\)/
  );
});
