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

function buildService(handler) {
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
      return handler(call);
    },
  });
  return { service, calls };
}

function offer(id, name, active = true) {
  return {
    type: 'subscriptionOfferCodes', id,
    attributes: { name, active, customerEligibilities: [] },
  };
}

function customCode(id, code, { active = true, numberOfCodes = 1000 } = {}) {
  return {
    type: 'subscriptionOfferCodeCustomCodes', id,
    attributes: { customCode: code, active, numberOfCodes, createdDate: '2026-08-24T12:00:00Z' },
  };
}

test('ensureCustomCode creates 1,000 redemptions by default', async () => {
  const { service, calls } = buildService(call => {
    const url = new URL(call.url);
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptions/subscription-id/offerCodes')) {
      return response(200, { data: [offer('offer-1', 'Affiliate First Month $0.99')], links: {} });
    }
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptionOfferCodes/offer-1/customCodes')) {
      return response(200, { data: [], links: {} });
    }
    if (call.method === 'POST' && url.pathname.endsWith('/subscriptionOfferCodeCustomCodes')) {
      return response(201, { data: customCode('custom-1', 'NEWCREATOR') });
    }
    throw new Error(`Unexpected request: ${call.method} ${url.pathname}`);
  });

  const result = await service.ensureCustomCode({
    offerReferenceName: 'Affiliate First Month $0.99',
    customCode: 'newcreator',
  });
  assert.equal(result.status, 'created');
  assert.equal(result.numberOfCodes, 1000);
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body.data.attributes, { customCode: 'NEWCREATOR', numberOfCodes: 1000 });
  assert.deepEqual(post.body.data.relationships.offerCode.data, { type: 'subscriptionOfferCodes', id: 'offer-1' });
});

test('ensureCustomCode reuses an existing active code on the shared offer', async () => {
  const { service, calls } = buildService(call => {
    const url = new URL(call.url);
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptions/subscription-id/offerCodes')) {
      return response(200, { data: [offer('offer-1', 'Affiliate First Month $0.99')], links: {} });
    }
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptionOfferCodes/offer-1/customCodes')) {
      return response(200, { data: [customCode('custom-existing', '365PUSHING')], links: {} });
    }
    throw new Error(`Unexpected request: ${call.method} ${url.pathname}`);
  });

  const result = await service.ensureCustomCode({
    offerReferenceName: 'Affiliate First Month $0.99',
    customCode: '365PUSHING',
  });
  assert.equal(result.status, 'already_exists');
  assert.equal(result.customCodeId, 'custom-existing');
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('ensureCustomCode rejects the same active code on a different offer', async () => {
  const { service } = buildService(call => {
    const url = new URL(call.url);
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptions/subscription-id/offerCodes')) {
      return response(200, { data: [offer('target', 'Affiliate First Month $0.99'), offer('other', 'Other Campaign')], links: {} });
    }
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptionOfferCodes/target/customCodes')) {
      return response(200, { data: [], links: {} });
    }
    if (call.method === 'GET' && url.pathname.endsWith('/subscriptionOfferCodes/other/customCodes')) {
      return response(200, { data: [customCode('taken', 'TAKENCODE')], links: {} });
    }
    throw new Error(`Unexpected request: ${call.method} ${url.pathname}`);
  });

  await assert.rejects(
    service.ensureCustomCode({ offerReferenceName: 'Affiliate First Month $0.99', customCode: 'TAKENCODE' }),
    error => error?.code === 'app_store_connect_custom_code_conflict'
  );
});

test('Affiliate Admin is wired for automatic provisioning and retry', () => {
  const source = fs.readFileSync(new URL('../affiliateRoutes.js', import.meta.url), 'utf8');
  assert.match(source, /req\.body\?\.appleCustomCodeCount \?\? 1000/);
  assert.match(source, /automatic App Store Connect creator-code provisioning/);
  assert.match(source, /Retry Apple Connection/);
  assert.match(source, /numberOfCodes:1000/);
});
