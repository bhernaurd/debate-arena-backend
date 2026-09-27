import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  classifyAffiliateTrackingFact,
  summarizeAffiliateTrackingFacts,
  evaluateAffiliateTrackingInvariants,
  createAffiliateTrackingHealthService,
} from '../lib/affiliateTrackingHealthService.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const CURRENT_OFFER = 'AFFILIATE 7 DAY FREE PROMO';
const OLD_OFFER = 'AFFILIATE FIRST MONTH $0.99';

function fact(overrides = {}) {
  return {
    originalTransactionId: 'orig-default',
    accountId: '11111111-1111-4111-8111-111111111111',
    normalizedOfferIdentifier: CURRENT_OFFER,
    hasEntitlement: true,
    status: 'active',
    autoRenewEnabled: true,
    expiresAt: '2026-10-04T12:00:00Z',
    gracePeriodExpiresAt: null,
    hasStandardPaidFollowup: false,
    autoRenewDisabledAt: null,
    ...overrides,
  };
}

const options = {
  currentOfferIdentifier: CURRENT_OFFER,
  acceptedOfferIdentifiers: [CURRENT_OFFER, OLD_OFFER],
  now: NOW,
};

test('scenario: active 7-day trial is one current subscriber and not cancelled', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({ originalTransactionId: 'trial-active' }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentSubscribers, 1);
  assert.equal(summary.cancelledSubscribers, 0);
  assert.equal(summary.currentStateCounts.trial_active, 1);
});

test('scenario: trial cancelled before paid is not double-counted as current', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'trial-cancelled',
      autoRenewEnabled: false,
      autoRenewDisabledAt: '2026-09-29T12:00:00Z',
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentSubscribers, 0);
  assert.equal(summary.cancelledSubscribers, 1);
  assert.equal(summary.currentStateCounts.trial_canceling, 1);
});

test('scenario: converted subscriber with renewal on is paid and renewing', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'paid-renewing',
      hasStandardPaidFollowup: true,
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentSubscribers, 1);
  assert.equal(summary.cancelledSubscribers, 0);
  assert.equal(summary.currentStateCounts.paid_renewing, 1);
});

test('scenario: paid subscriber who turns off renewal is paid and canceling only', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'paid-canceling',
      hasStandardPaidFollowup: true,
      autoRenewEnabled: false,
      autoRenewDisabledAt: '2026-10-05T12:00:00Z',
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentSubscribers, 0);
  assert.equal(summary.cancelledSubscribers, 1);
  assert.equal(summary.currentStateCounts.paid_canceling, 1);
});

test('scenario: billing retry has a single billing-retry state', () => {
  const classified = classifyAffiliateTrackingFact(
    fact({
      originalTransactionId: 'retry',
      status: 'billing_retry',
      hasStandardPaidFollowup: true,
    }),
    options
  );
  assert.equal(classified.state, 'billing_retry');
});

test('scenario: expired trial without conversion remains a lifetime referral', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'expired-trial',
      status: 'expired',
      autoRenewEnabled: false,
      expiresAt: '2026-09-25T12:00:00Z',
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentSubscribers, 0);
  assert.equal(summary.cancelledSubscribers, 1);
  assert.equal(summary.currentStateCounts.trial_expired_without_conversion, 1);
});

test('scenario: previous $0.99 referral cancelled before full price stays historical', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'old-cancelled',
      normalizedOfferIdentifier: OLD_OFFER,
      autoRenewEnabled: false,
      autoRenewDisabledAt: '2026-09-20T12:00:00Z',
      hasStandardPaidFollowup: false,
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentProgramReferrals, 0);
  assert.equal(summary.historicalReferrals, 1);
  assert.equal(summary.currentSubscribers, 0);
  assert.equal(summary.cancelledSubscribers, 1);
  assert.equal(summary.historicalStateCounts.previous_offer_cancelled, 1);
});

test('scenario: previous offer referral can convert to full price without entering current trial funnel', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'old-converted',
      normalizedOfferIdentifier: OLD_OFFER,
      hasStandardPaidFollowup: true,
    }),
  ], options);

  assert.equal(summary.totalReferrals, 1);
  assert.equal(summary.currentProgramReferrals, 0);
  assert.equal(summary.historicalReferrals, 1);
  assert.equal(summary.historicalStateCounts.previous_offer_converted, 1);
});

test('scenario: migrated affiliate keeps old history and new trial metrics separate', () => {
  const summary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'old-cancelled',
      normalizedOfferIdentifier: OLD_OFFER,
      autoRenewEnabled: false,
      autoRenewDisabledAt: '2026-09-20T12:00:00Z',
    }),
    fact({
      originalTransactionId: 'new-trial',
      normalizedOfferIdentifier: CURRENT_OFFER,
    }),
  ], options);

  assert.equal(summary.totalReferrals, 2);
  assert.equal(summary.currentProgramReferrals, 1);
  assert.equal(summary.historicalReferrals, 1);
  assert.equal(summary.currentSubscribers, 1);
  assert.equal(summary.cancelledSubscribers, 1);
  assert.equal(summary.currentStateCounts.trial_active, 1);
  assert.equal(summary.historicalStateCounts.previous_offer_cancelled, 1);
});

test('invariants detect a published dashboard mismatch', () => {
  const rawSummary = summarizeAffiliateTrackingFacts([
    fact({
      originalTransactionId: 'one',
      autoRenewEnabled: false,
      autoRenewDisabledAt: '2026-09-29T12:00:00Z',
    }),
  ], options);

  const validation = evaluateAffiliateTrackingInvariants({
    rawSummary,
    publishedOverview: {
      totalReferrals: 1,
      currentSubscribers: 1,
      cancelledSubscribers: 1,
    },
    duplicateOwnership: 0,
    payoutRows: [],
  });

  assert.equal(validation.status, 'mismatch');
  assert.equal(validation.checks.currentSubscribersReconcile, false);
  assert.ok(validation.errors.some((item) => item.code === 'dashboard_metric_mismatch'));
});

test('invariants verify exact commission math', () => {
  const rawSummary = summarizeAffiliateTrackingFacts([], options);
  const validation = evaluateAffiliateTrackingInvariants({
    rawSummary,
    publishedOverview: {
      totalReferrals: 0,
      currentSubscribers: 0,
      cancelledSubscribers: 0,
    },
    duplicateOwnership: 0,
    payoutRows: [{
      payout_period: '2026-09-01',
      eligible_revenue: '15.980000',
      commission_rate: '0.500000',
      commission_earned_exact: '7.990000',
    }],
  });

  assert.equal(validation.status, 'verified');
  assert.equal(validation.checks.commissionMathReconciles, true);
  assert.equal(validation.checks.payoutMathChecked, 1);
});

test('tracking health service is read-only and reconciles raw facts to projected dashboard totals', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push(text);

      if (text.includes('FROM affiliates') && text.includes('status <>')) {
        return {
          rows: [{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            display_name: 'Creator',
            normalized_code: 'CREATOR',
            status: 'active',
            code_status: 'active',
            is_test: false,
            normalized_apple_offer_identifier: CURRENT_OFFER,
          }],
        };
      }
      if (text.includes('FROM affiliate_apple_offer_aliases')) {
        return {
          rows: [
            { normalized_offer_identifier: CURRENT_OFFER },
            { normalized_offer_identifier: OLD_OFFER },
          ],
        };
      }
      if (text.includes('FROM affiliate_subscription_attributions attribution')) {
        return {
          rows: [{
            original_transaction_id: 'orig-1',
            account_id: '11111111-1111-4111-8111-111111111111',
            normalized_offer_identifier: CURRENT_OFFER,
            has_entitlement: true,
            status: 'active',
            auto_renew_enabled: false,
            expires_date: '2026-10-04T12:00:00Z',
            grace_period_expires_date: null,
            has_standard_paid_followup: false,
            auto_renew_disabled_at: '2026-09-29T12:00:00Z',
          }],
        };
      }
      if (text.includes('HAVING COUNT(DISTINCT affiliate_id) > 1')) {
        return { rows: [{ count: 0 }] };
      }
      if (text.includes('FROM affiliate_monthly_payouts')) {
        return { rows: [] };
      }

      throw new Error('Unexpected SQL: ' + text);
    },
  };

  const service = createAffiliateTrackingHealthService({
    pool,
    projectPublishedDashboard: async () => ({
      overview: {
        totalReferrals: 1,
        currentSubscribers: 0,
        cancelledSubscribers: 1,
      },
    }),
  });

  const result = await service.getHealth();

  assert.equal(result.overall, 'verified');
  assert.equal(result.affiliates.length, 1);
  assert.equal(result.affiliates[0].raw.totalReferrals, 1);
  assert.equal(result.affiliates[0].checks.currentSubscribersReconcile, true);

  const combined = queries.join('\n').toUpperCase();
  assert.doesNotMatch(combined, /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bALTER\b|\bDROP\b/);
});

test('tracking health implementation contains only read queries for production reconciliation', async () => {
  const source = await readFile(
    new URL('../lib/affiliateTrackingHealthService.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(source, /\bUPDATE\s+[a-z_]/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
  assert.match(source, /affiliate_subscription_attributions/);
  assert.match(source, /subscription_entitlements/);
  assert.match(source, /app_store_transactions/);
  assert.match(source, /subscription_events/);
  assert.match(source, /affiliate_monthly_payouts/);
});
