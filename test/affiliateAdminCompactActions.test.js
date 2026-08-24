import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../affiliateRoutes.js', import.meta.url), 'utf8');

test('Affiliate Admin uses compact row actions without changing unlock wiring', () => {
  assert.match(source, /class="partner-link"[^>]*data-action="details"/);
  assert.match(source, /class="affiliate-actions"/);
  assert.match(source, /<details class="row-menu"><summary title="More actions" aria-label="More actions">•••<\/summary>/);
  assert.match(source, />Dashboard<\/button>/);
  assert.match(source, />Pause Affiliate<\/button>/);
  assert.match(source, />Activate Affiliate<\/button>/);
  assert.match(source, />Delete Affiliate<\/button>/);
  assert.doesNotMatch(source, /data-action="details"[^>]*>Details<\/button>/);

  // Regression: the owner authentication path must remain intact.
  assert.match(source, /\$\('unlockAdmin'\)\.addEventListener\('click'/);
  assert.match(source, /sessionStorage\.setItem\('agoraAffiliateAdminKey', adminKey\)/);

  // Regression: destructive behavior remains the already-tested Delete route.
  assert.match(source, /router\.delete\('\/api\/admin\/affiliates\/:id'/);
  assert.match(source, /deactivateCustomCode/);
});
