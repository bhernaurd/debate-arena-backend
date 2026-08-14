import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DateTime } from 'luxon';

import {
  buildAppleOfferRedemptionUrl,
  calculateBasePriceCommission,
  hashPartnerToken,
  normalizeAffiliateCode,
  parseAffiliateDashboardRange,
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


test('dashboard supports explicit calendar-month accounting periods', () => {
  const now = DateTime.fromISO('2026-08-14T17:21:00', { zone: 'America/Chicago' });

  const july = parseAffiliateDashboardRange('month:2026-07', now);
  assert.equal(july.key, 'month:2026-07');
  assert.equal(july.kind, 'month');
  assert.equal(july.monthKey, '2026-07');
  assert.equal(july.currentMonthKey, '2026-08');
  assert.equal(july.start, '2026-07-01');
  assert.equal(july.endExclusive, '2026-08-01');
  assert.equal(july.label, 'July 2026');
  assert.equal(july.isCurrentMonth, false);

  const current = parseAffiliateDashboardRange('this_month', now);
  assert.equal(current.key, 'month:2026-08');
  assert.equal(current.label, 'August 2026');
  assert.equal(current.isCurrentMonth, true);

  assert.throws(
    () => parseAffiliateDashboardRange('month:2026-09', now),
    (error) => error?.code === 'invalid_dashboard_month'
  );
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

test('partner dashboard uses one mutually exclusive current-state model', () => {
  const html = renderPartnerDashboardPage('abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  assert.match(html, /Each referred subscriber appears in one current state only/);
  assert.match(html, /Promo Active/);
  assert.match(html, /Paid \+ Renewing/);
  assert.match(html, /Paid \+ Canceling/);
  assert.match(html, /Billing Retry/);
  assert.match(html, /Expired/);
  assert.match(html, /Pending Apple State/);
  assert.match(html, /Current State<\/th>/);
  assert.doesNotMatch(html, /<th>Stage<\/th>/);
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

test('partner dashboard exposes the approved affiliate metrics without a creator-name browser', () => {
  const html = renderPartnerDashboardPage('abcdefghijklmnopqrstuvwxyz0123456789ABCDE');
  assert.doesNotMatch(html, /Search creators/i);
  assert.match(html, /Current Subscribers/);
  assert.match(html, /Promo Active/);
  assert.match(html, /Paid \+ Renewing/);
  assert.match(html, /Paid \+ Canceling/);
  assert.match(html, /Billing Retry/);
  assert.match(html, /Expired/);
  assert.match(html, /Eligible Revenue Generated/);
  assert.match(html, /Lifetime Commission Earned/);
  assert.match(html, /Lifetime Paid/);
  assert.match(html, /Anonymous Subscriber Activity/);
  assert.match(html, /Promotional \$0\.99 payments are excluded from commission/);
  assert.doesNotMatch(html, /Commission-Earning Subscribers/);
  assert.doesNotMatch(html, />Canceling<\/div>/);
});


test('dashboard service derives anonymous subscriber state from verified Apple subscription chains', async () => {
  const source = await readFile(
    new URL('../lib/affiliateProgramService.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /FROM affiliate_subscription_attributions a/);
  assert.match(source, /LEFT JOIN subscription_entitlements e/);
  assert.match(source, /LEFT JOIN app_store_transactions t/);
  assert.match(source, /affiliate\.is_test \? 'Sandbox' : 'Production'/);
  assert.match(source, /commissionEarningSubscribers/);
  assert.match(source, /promoActiveSubscribers/);
  assert.match(source, /paidRenewingSubscribers/);
  assert.match(source, /paidCancelingSubscribers/);
  assert.match(source, /pendingStateSubscribers/);
  assert.match(source, /current_state/);
  assert.match(source, /anonymousSubscriberActivity/);
  assert.match(source, /subscriberAlias/);
  assert.match(source, /offer_type::text/);
  assert.match(source, /expires_date > NOW\(\)/);
  assert.match(source, /grace_period_expires_date > NOW\(\)/);
  assert.match(source, /slice\(0, 12\)/);
  assert.doesNotMatch(
    renderPartnerDashboardPage('abcdefghijklmnopqrstuvwxyz0123456789ABCDE'),
    /original_transaction_id|app_account_token|user_id/i
  );
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


test('production affiliate creation requires an Apple offer reference name before database writes', async () => {
  const { createAffiliateProgramService } = await import('../lib/affiliateProgramService.js');
  const fakePool = {
    query: async () => { throw new Error('database should not be reached'); },
    connect: async () => { throw new Error('database should not be reached'); },
  };
  const service = createAffiliateProgramService({
    pool: fakePool,
    appAppleId: '6762416967',
    tokenEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
  });

  await assert.rejects(
    service.createAffiliate({
      internalName: 'Max',
      displayName: 'Max',
      customCode: 'MAXAGORA',
      affiliateSince: '2026-08-14',
      commissionRate: '0.5',
      commissionBasis: 'base_price',
      codeStatus: 'active',
      payoutCurrency: 'USD',
      isTest: false,
    }),
    (error) => error?.code === 'affiliate_offer_identifier_required'
  );
});

test('affiliate audit-log queries explicitly type UUID parameters reused as text', async () => {
  const source = await readFile(
    new URL('../lib/affiliateProgramService.js', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /VALUES \(\$1, 'affiliate_created', \$2::uuid, 'affiliate', \$2::uuid::text, \$3::jsonb\)/
  );
  assert.match(
    source,
    /VALUES \(\$1, 'affiliate_dashboard_token_regenerated', \$2::uuid, 'affiliate', \$2::uuid::text\)/
  );

  assert.doesNotMatch(
    source,
    /VALUES \(\$1, 'affiliate_created', \$2, 'affiliate', \$2::text, \$3::jsonb\)/
  );
  assert.doesNotMatch(
    source,
    /VALUES \(\$1, 'affiliate_dashboard_token_regenerated', \$2, 'affiliate', \$2::text\)/
  );
});

test('admin affiliate service exposes overview, alert, payout, and operational controls without changing attribution ownership', async () => {
  const source = await readFile(
    new URL('../lib/affiliateProgramService.js', import.meta.url),
    'utf8'
  );

  assert.match(source, /async function setAffiliateOperationalStatus/);
  assert.match(source, /async function listAffiliateAlerts/);
  assert.match(source, /async function resolveAffiliateAlert/);
  assert.match(source, /async function listAdminPayouts/);
  assert.match(source, /affiliate_subscription_attributions attr/);
  assert.match(source, /CASE WHEN a\.is_test THEN 'Sandbox' ELSE 'Production' END/);
  assert.match(source, /CASE WHEN a\.is_test THEN 'test' ELSE 'production' END/);
  assert.match(source, /affiliate_alert_resolved/);
  assert.match(source, /affiliate_activated/);
  assert.match(source, /affiliate_paused/);
});

test('admin can refresh a whole payout month without finalizing it', async () => {
  const source = await readFile(
    new URL('../lib/affiliateProgramService.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /async function refreshAffiliatePayoutsForPeriod/);
  assert.match(source, /finalize: false/);
  assert.match(source, /refreshAffiliatePayoutsForPeriod,/);
});
