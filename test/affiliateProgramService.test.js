import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAppleOfferRedemptionUrl,
  calculateBasePriceCommission,
  hashPartnerToken,
  normalizeAffiliateCode,
} from '../lib/affiliateProgramService.js';
import { renderPartnerDashboardPage } from '../affiliateRoutes.js';

test('normalizes affiliate codes without fuzzy matching', () => {
  assert.equal(normalizeAffiliateCode(' maxagora '), 'MAXAGORA');
  assert.throws(() => normalizeAffiliateCode('MAX-AGORA'));
  assert.throws(() => normalizeAffiliateCode(''));
});

test('builds the exact Apple custom-code redemption URL', () => {
  assert.equal(
    buildAppleOfferRedemptionUrl({
      appAppleId: '6762416967',
      customCode: 'maxagora',
    }),
    'https://apps.apple.com/redeem?ctx=offercodes&id=6762416967&code=MAXAGORA'
  );
});

test('partner tokens are hashed deterministically', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
  assert.equal(hashPartnerToken(token), hashPartnerToken(token));
  assert.notEqual(hashPartnerToken(token), hashPartnerToken(token + 'x'));
});

test('base-price commission rounds once at the monthly level', () => {
  const result = calculateBasePriceCommission({
    commissionRate: '0.5',
    lines: [
      { label: '$4.99 Monthly', unitPrice: '4.99', count: 37 },
      { label: '$7.99 Monthly', unitPrice: '7.99', count: 21 },
    ],
  });

  assert.equal(result.eligibleRevenue, '352.42');
  assert.equal(result.commissionExact, '176.210000');
  assert.equal(result.finalCommission, '176.21');
});

test('fractional-cent commissions are not rounded per transaction', () => {
  const result = calculateBasePriceCommission({
    commissionRate: '0.5',
    lines: [
      { label: '$7.99 Monthly', unitPrice: '7.99', count: 2 },
    ],
  });

  assert.equal(result.eligibleRevenue, '15.98');
  assert.equal(result.commissionExact, '7.990000');
  assert.equal(result.finalCommission, '7.99');
});

test('partner dashboard contains Overview and Breakdown tabs', () => {
  const html = renderPartnerDashboardPage('abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  assert.match(html, />Overview</);
  assert.match(html, />Breakdown</);
  assert.match(html, /Copy Referral Link/);
  assert.match(html, /Estimated This Month/);
  assert.match(html, /Currently Owed/);
});

test('classifies only unambiguous Apple renewal/recovery metrics as automatic base-price commission', async () => {
  const { classifyAppleMetricForBasePrice } = await import('../lib/affiliateProgramService.js');
  assert.deepEqual(classifyAppleMetricForBasePrice('full_price_renewals'), {
    action: 'commissionable',
    subscriptionPricing: 'Full Price',
  });
  assert.deepEqual(classifyAppleMetricForBasePrice('preserved_price_renewals'), {
    action: 'commissionable',
    subscriptionPricing: 'Preserved Price',
  });
  assert.deepEqual(classifyAppleMetricForBasePrice('full_price_from_paid_offer'), { action: 'needs_review', subscriptionPricing: null, blocking: true });
  assert.equal(classifyAppleMetricForBasePrice('refunds_from_full_price').action, 'needs_review');
  assert.equal(classifyAppleMetricForBasePrice('paid_offer_start').action, 'noncommissionable_promo');
});

test('processing-date comparison rejects older Apple instances', async () => {
  const { compareProcessingDates } = await import('../lib/affiliateProgramService.js');
  assert.equal(compareProcessingDates('2026-09-03', '2026-09-02'), 1);
  assert.equal(compareProcessingDates('2026-09-02', '2026-09-03'), -1);
  assert.equal(compareProcessingDates('2026-09-03', '2026-09-03'), 0);
});

test('partner dashboard does not expose a creator-name browser or misleading commission-earning label', () => {
  const html = renderPartnerDashboardPage('abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  assert.doesNotMatch(html, /Search creators/i);
  assert.doesNotMatch(html, /Commission-Earning/i);
  assert.match(html, /Active Paid/);
});


test('money-impacting ambiguous Apple events are explicitly classified for review', async () => {
  const { classifyAppleMetricForBasePrice } = await import('../lib/affiliateProgramService.js');
  for (const key of [
    'full_price_from_paid_offer',
    'refunds_from_full_price',
    'refunds_from_preserved_price',
    'plan_changes',
  ]) {
    const result = classifyAppleMetricForBasePrice(key);
    assert.equal(result.action, 'needs_review');
    assert.equal(result.blocking, true);
  }
});


test('service rejects string booleans instead of treating "false" as true', async () => {
  const { createAffiliateProgramService } = await import('../lib/affiliateProgramService.js');
  const fakePool = { query: async () => { throw new Error('database should not be reached'); } };
  const service = createAffiliateProgramService({ pool: fakePool, appAppleId: '6762416967' });

  await assert.rejects(
    service.createAffiliate({
      internalName: 'Test',
      displayName: 'Test',
      customCode: 'TESTCODE',
      affiliateSince: '2026-08-13',
      commissionRate: '0.5',
      commissionBasis: 'base_price',
      codeStatus: 'active',
      payoutCurrency: 'USD',
      isTest: 'false',
    }),
    (error) => error?.code === 'invalid_boolean'
  );

  await assert.rejects(
    service.finalizeAffiliatePayoutsForPeriod({
      payoutPeriod: '2026-07-01',
      includeTest: 'false',
    }),
    (error) => error?.code === 'invalid_boolean'
  );
});
