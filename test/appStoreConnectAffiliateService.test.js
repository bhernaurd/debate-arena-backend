import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAppStoreConnectAffiliateService,
} from '../lib/appStoreConnectAffiliateService.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function makeFetch() {
  return async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/subscriptions/subscription-1/offerCodes')) {
      return jsonResponse({
        data: [
          {
            type: 'subscriptionOfferCodes',
            id: 'offer-affiliate-shared',
            attributes: {
              name: 'Affiliate First Month $0.99',
              customerEligibilities: ['NEW'],
              offerMode: 'PAY_AS_YOU_GO',
              duration: 'ONE_MONTH',
              numberOfPeriods: 1,
              active: true,
              autoRenewEnabled: true,
            },
          },
          {
            type: 'subscriptionOfferCodes',
            id: 'offer-family',
            attributes: {
              name: 'Friends and Family Free Pro',
              customerEligibilities: ['EXPIRED', 'EXISTING', 'NEW'],
              offerMode: 'FREE_TRIAL',
              active: true,
            },
          },
        ],
        links: { next: null },
      });
    }

    if (parsed.pathname.endsWith('/subscriptionOfferCodes/offer-affiliate-shared/customCodes')) {
      return jsonResponse({
        data: [
          { id: 'am-1', attributes: { customCode: 'AM99', numberOfCodes: 500, createdDate: '2026-08-14T10:00:00Z', active: true } },
          { id: 'levi-1', attributes: { customCode: 'LEVI99', numberOfCodes: 500, createdDate: '2026-08-14T10:01:00Z', active: true } },
          { id: 'max-old', attributes: { customCode: 'MAXAGORA', numberOfCodes: 25000, createdDate: '2026-08-14T09:00:00Z', active: true } },
          { id: 'max-new', attributes: { customCode: 'MAXAGORA', numberOfCodes: 500, createdDate: '2026-08-14T11:00:00Z', active: true } },
        ],
        links: { next: null },
      });
    }

    if (parsed.pathname.endsWith('/subscriptionOfferCodes/offer-family/customCodes')) {
      return jsonResponse({
        data: [
          { id: 'family-1', attributes: { customCode: 'BHERNAURD', numberOfCodes: 25, createdDate: '2026-08-13T10:00:00Z', active: true } },
        ],
        links: { next: null },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('groups duplicate Apple custom-code resources into one creator-code candidate', async () => {
  // The fake PEM above is intentionally not used for real network signing in
  // this test environment. Replace crypto signing through a generated key.
  const crypto = await import('node:crypto');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const svc = createAppStoreConnectAffiliateService({
    issuerId: 'issuer', keyId: 'KEY123', privateKey,
    subscriptionId: 'subscription-1', fetchImpl: makeFetch(),
  });

  const result = await svc.listImports({
    importPreferences: [
      { normalized_code: 'BHERNAURD', disposition: 'ignored' },
    ],
  });

  assert.deepEqual(result.imports.map(x => x.customCode), ['AM99', 'LEVI99', 'MAXAGORA']);
  assert.equal(result.ignored.length, 1);
  assert.equal(result.ignored[0].customCode, 'BHERNAURD');

  const max = result.imports.find(x => x.customCode === 'MAXAGORA');
  assert.equal(max.configurationCount, 2);
  assert.equal(max.canonical, null);
  assert.equal(max.needsCanonicalChoice, true);
});

test('canonical selection can point MAXAGORA at the newer 500-code resource while preserving old history', async () => {
  const crypto = await import('node:crypto');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const svc = createAppStoreConnectAffiliateService({
    issuerId: 'issuer', keyId: 'KEY123', privateKey,
    subscriptionId: 'subscription-1', fetchImpl: makeFetch(),
  });

  const result = await svc.listImports({
    importPreferences: [
      {
        normalized_code: 'MAXAGORA',
        disposition: 'pending',
        canonical_offer_id: 'offer-affiliate-shared',
        canonical_custom_code_id: 'max-new',
      },
    ],
  });

  const max = result.imports.find(x => x.customCode === 'MAXAGORA');
  assert.equal(max.configurationCount, 2);
  assert.equal(max.canonical.customCodeId, 'max-new');
  assert.equal(max.canonical.numberOfCodes, 500);
  assert.equal(max.configurations.some(x => x.numberOfCodes === 25000), true);
});

test('shared Apple offer blocks exact subscription-chain attribution across different creator codes', async () => {
  const crypto = await import('node:crypto');
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const svc = createAppStoreConnectAffiliateService({
    issuerId: 'issuer', keyId: 'KEY123', privateKey,
    subscriptionId: 'subscription-1', fetchImpl: makeFetch(),
  });

  const result = await svc.listImports();
  const am = result.imports.find(x => x.customCode === 'AM99');
  const levi = result.imports.find(x => x.customCode === 'LEVI99');

  assert.equal(am.canonical.distinctCustomCodesOnOffer, 3);
  assert.equal(levi.canonical.distinctCustomCodesOnOffer, 3);
  assert.equal(am.exactAttributionReady, false);
  assert.match(am.attributionBlockReason, /multiple custom creator codes|different custom creator codes/i);
});
