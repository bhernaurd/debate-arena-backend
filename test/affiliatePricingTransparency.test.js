import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderPartnerDashboardPage } from '../affiliateRoutes.js';
import { createAppStoreConnectAffiliateService } from '../lib/appStoreConnectAffiliateService.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');

function applePricingPayload() {
  return {
    data: [
      {
        type: 'subscriptionPrices',
        id: 'price-current',
        attributes: {
          startDate: '2026-01-01',
          preserved: false,
          planType: 'UPFRONT',
        },
        relationships: {
          territory: { data: { type: 'territories', id: 'USA' } },
          subscriptionPricePoint: {
            data: { type: 'subscriptionPricePoints', id: 'point-499' },
          },
        },
      },
      {
        type: 'subscriptionPrices',
        id: 'price-next',
        attributes: {
          startDate: '2026-09-01',
          preserved: false,
          planType: 'UPFRONT',
        },
        relationships: {
          territory: { data: { type: 'territories', id: 'USA' } },
          subscriptionPricePoint: {
            data: { type: 'subscriptionPricePoints', id: 'point-799' },
          },
        },
      },
      {
        type: 'subscriptionPrices',
        id: 'price-preserved',
        attributes: {
          startDate: null,
          preserved: true,
          planType: 'UPFRONT',
        },
        relationships: {
          territory: { data: { type: 'territories', id: 'USA' } },
          subscriptionPricePoint: {
            data: { type: 'subscriptionPricePoints', id: 'point-499' },
          },
        },
      },
    ],
    included: [
      {
        type: 'territories',
        id: 'USA',
        attributes: { currency: 'USD' },
      },
      {
        type: 'subscriptionPricePoints',
        id: 'point-499',
        attributes: { customerPrice: '4.99' },
      },
      {
        type: 'subscriptionPricePoints',
        id: 'point-799',
        attributes: { customerPrice: '7.99' },
      },
    ],
    links: { next: null },
  };
}

test('App Store Connect pricing identifies current, scheduled, and preserved U.S. prices', async () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const privateKeyPem = privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  let calls = 0;

  const service = createAppStoreConnectAffiliateService({
    issuerId: 'test-issuer',
    keyId: 'test-key',
    privateKey: privateKeyPem,
    subscriptionId: 'subscription-123',
    fetchImpl: async url => {
      calls += 1;
      assert.match(String(url), /\/subscriptions\/subscription-123\/prices/);
      assert.match(String(url), /filter%5Bterritory%5D=USA/);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(applePricingPayload()),
      };
    },
  });

  const pricing = await service.getSubscriptionPricingSummary({
    territory: 'USA',
    now: new Date('2026-08-14T12:00:00Z'),
  });

  assert.equal(pricing.current.customerPrice, '4.99');
  assert.equal(pricing.current.currency, 'USD');
  assert.equal(pricing.next.customerPrice, '7.99');
  assert.equal(pricing.next.startDate, '2026-09-01');
  assert.equal(pricing.preservedPrices[0].customerPrice, '4.99');

  await service.getSubscriptionPricingSummary({
    territory: 'USA',
    now: new Date('2026-08-14T12:00:00Z'),
  });
  assert.equal(calls, 1, 'partner dashboard pricing should use the short in-memory cache');
});

test('partner dashboard includes current pricing and active price-tier transparency', () => {
  const html = renderPartnerDashboardPage(
    'abcdefghijklmnopqrstuvwxyz0123456789ABCDE'
  );

  assert.match(html, /Current Monthly Price/);
  assert.match(html, /Scheduled Monthly Price/);
  assert.match(html, /activePriceTierRows/);
  assert.match(html, /Active .* Subscribers/);
  assert.match(html, /latest verified Apple paid transaction/);
  assert.match(html, /\$0\.99 Promo/);
});

test('affiliate dashboard service groups active paid chains by latest verified Apple transaction price', () => {
  const source = fs.readFileSync(
    path.join(repositoryRoot, 'lib', 'affiliateProgramService.js'),
    'utf8'
  );

  assert.match(source, /price_milliunits/);
  assert.match(source, /activePaidPriceTiers/);
  assert.match(source, /t\.transaction_id IS DISTINCT FROM chain\.attribution_transaction_id/);
  assert.match(source, /NOT IN \('3', 'OFFER_CODE'\)/);
  assert.match(source, /subscriberPricing/);
});
