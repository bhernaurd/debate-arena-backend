import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { createAppStoreConnectAffiliateService } from '../lib/appStoreConnectAffiliateService.js';

function privateKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body == null ? '' : JSON.stringify(body); },
  };
}

function offer(id, name, active = true) {
  return {
    type: 'subscriptionOfferCodes', id,
    attributes: { name, active, customerEligibilities: [] },
  };
}

function customCode(id, code, active = true) {
  return {
    type: 'subscriptionOfferCodeCustomCodes', id,
    attributes: { customCode: code, active, numberOfCodes: 1000 },
  };
}

test('deactivateCustomCode deactivates every active batch for the creator code', async () => {
  const calls = [];
  const service = createAppStoreConnectAffiliateService({
    issuerId: 'issuer-id',
    keyId: 'key-id',
    privateKey: privateKeyPem(),
    subscriptionId: 'subscription-id',
    fetchImpl: async (url, options = {}) => {
      const call = {
        url: String(url),
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : null,
      };
      calls.push(call);
      const parsed = new URL(call.url);
      if (call.method === 'GET' && parsed.pathname.endsWith('/subscriptions/subscription-id/offerCodes')) {
        return response(200, { data: [offer('offer-1', 'Affiliate First Month $0.99')], links: {} });
      }
      if (call.method === 'GET' && parsed.pathname.endsWith('/subscriptionOfferCodes/offer-1/customCodes')) {
        return response(200, {
          data: [
            customCode('batch-1', 'DELETECODE', true),
            customCode('batch-2', 'DELETECODE', true),
            customCode('old-batch', 'DELETECODE', false),
            customCode('other', 'OTHERCODE', true),
          ],
          links: {},
        });
      }
      if (call.method === 'PATCH' && parsed.pathname.includes('/subscriptionOfferCodeCustomCodes/')) {
        const id = parsed.pathname.split('/').pop();
        return response(200, { data: customCode(id, 'DELETECODE', false) });
      }
      throw new Error(`Unexpected request: ${call.method} ${parsed.pathname}`);
    },
  });

  const result = await service.deactivateCustomCode({
    offerReferenceName: 'Affiliate First Month $0.99',
    customCode: 'deletecode',
  });

  assert.equal(result.status, 'deactivated');
  assert.equal(result.deactivatedCount, 2);
  assert.deepEqual(result.customCodeIds.sort(), ['batch-1', 'batch-2']);

  const patches = calls.filter(call => call.method === 'PATCH');
  assert.equal(patches.length, 2);
  for (const patch of patches) {
    assert.equal(patch.body.data.type, 'subscriptionOfferCodeCustomCodes');
    assert.equal(patch.body.data.id, patch.url.split('/').pop());
    assert.deepEqual(patch.body.data.attributes, { active: false });
  }
});

test('Affiliate Admin delete is wired to Apple deactivation and archival', () => {
  const source = fs.readFileSync(new URL('../affiliateRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /data-action="delete"/);
  assert.match(source, /router\.delete\('\/api\/admin\/affiliates\/:id'/);
  assert.match(source, /deactivateCustomCode/);
  assert.match(source, /status = 'archived'/);
  assert.match(source, /code_status = 'disabled'/);
  assert.match(source, /linkedAffiliate\?\.status !== 'archived'/);
  assert.match(source, /<option value="archived">Archived<\/option>/);
});
