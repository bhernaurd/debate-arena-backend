import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routes = fs.readFileSync(path.join(root, 'appStoreSubscriptionRoutes.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('App Store subscription route no longer uses the legacy one-offer-per-affiliate tracker', () => {
  assert.doesNotMatch(routes, /affiliateTrackingService/);
  assert.doesNotMatch(routes, /recordAffiliateAttribution/);
  assert.match(routes, /affiliateSubscriptionAttributionService/);
  assert.match(routes, /observeVerifiedTransaction/);
});

test('client sync passes installation identity and optional account identity into shared-offer attribution', () => {
  assert.match(routes, /affiliateAccountId:\s*accountAuthorization\?\.accountId \|\| null/);
  assert.match(routes, /affiliateInstallationId:\s*requestedUserId/);
  assert.match(routes, /accountId: affiliateAccountId/);
  assert.match(routes, /installationId: affiliateInstallationId/);
});

test('persistVerifiedSnapshot explicitly receives affiliate attribution dependencies instead of relying on undeclared variables', () => {
  assert.match(
    routes,
    /async function persistVerifiedSnapshot\(client, \{[\s\S]*?affiliateAccountId = null,[\s\S]*?affiliateInstallationId = null,[\s\S]*?affiliateSubscriptionAttributionService = null,/
  );
});

test('affiliate attribution is isolated by a savepoint and cannot deny Apple subscription access', () => {
  assert.match(routes, /SAVEPOINT \$\{savepoint\}/);
  assert.match(routes, /ROLLBACK TO SAVEPOINT \$\{savepoint\}/);
  const entitlement = routes.indexOf('const entitlement = await upsertEntitlement(client, {');
  const event = routes.indexOf('await insertSubscriptionEvent(client, {', entitlement);
  const attribution = routes.indexOf('await observeAffiliateAttributionSafely(', event);
  assert.ok(entitlement >= 0 && event > entitlement && attribution > event);
});

test('server injects one corrected attribution service into both affiliate and App Store routers', () => {
  assert.match(server, /createAffiliateSubscriptionAttributionService/);
  assert.match(server, /const affiliateSubscriptionAttributionService/);
  assert.match(server, /createAffiliateRouter\(pool, \{[\s\S]*?accountAuthService,[\s\S]*?affiliateSubscriptionAttributionService/);
  assert.match(server, /createAppStoreSubscriptionRouter\(pool, \{[\s\S]*?accountSubscriptionOwnershipService,[\s\S]*?affiliateSubscriptionAttributionService/);
});
