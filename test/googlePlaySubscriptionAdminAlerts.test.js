import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGooglePlaySubscriptionAdminNotification,
  classifyGooglePlaySubscriptionAdminMilestone,
} from '../lib/googlePlaySubscriptionService.js';

const TOKEN_HASH = 'a'.repeat(64);
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

test('classifies a first verified Google Play trial as a subscriber milestone', () => {
  assert.equal(
    classifyGooglePlaySubscriptionAdminMilestone({
      previousEntitlement: null,
      isPro: true,
      isTrial: true,
    }),
    'trial_started'
  );
});

test('classifies a first direct paid Google Play subscription', () => {
  assert.equal(
    classifyGooglePlaySubscriptionAdminMilestone({
      previousEntitlement: null,
      isPro: true,
      isTrial: false,
    }),
    'new_paid_subscription'
  );
});

test('classifies the first paid state after a Google Play trial', () => {
  assert.equal(
    classifyGooglePlaySubscriptionAdminMilestone({
      previousEntitlement: {
        normalized_status: 'trial',
        is_trial: true,
      },
      isPro: true,
      isTrial: false,
    }),
    'trial_converted_to_paid'
  );
});

test('does not duplicate a subscriber milestone on routine restore/sync', () => {
  assert.equal(
    classifyGooglePlaySubscriptionAdminMilestone({
      previousEntitlement: {
        normalized_status: 'trial',
        is_trial: true,
      },
      isPro: true,
      isTrial: true,
    }),
    null
  );

  assert.equal(
    classifyGooglePlaySubscriptionAdminMilestone({
      previousEntitlement: {
        normalized_status: 'active',
        is_trial: false,
      },
      isPro: true,
      isTrial: false,
    }),
    null
  );
});

test('builds a production Google Play Telegram/outbox alert without exposing purchase token', () => {
  const alert = buildGooglePlaySubscriptionAdminNotification({
    kind: 'trial_started',
    accountId: ACCOUNT_ID,
    purchaseTokenSha256: TOKEN_HASH,
    latestOrderId: 'GPA.1234-5678-9012-34567',
    productId: 'agora_pro_monthly',
    basePlanId: 'monthly',
    offerId: 'creator-seven-day-trial',
    isTrial: true,
    autoRenewEnabled: true,
    expiryDate: new Date('2026-10-21T18:00:00.000Z'),
    testPurchase: false,
    affiliateCode: 'SCHORE',
    normalizedStatus: 'trial',
  });

  assert.ok(alert);
  assert.equal(alert.source, 'google_play_verified_purchase');
  assert.equal(alert.environment, 'Production');
  assert.equal(alert.eventKind, 'trial_started');
  assert.match(alert.telegramText, /New Google Play Agora Pro trial started/);
  assert.match(alert.telegramText, /Store: Google Play/);
  assert.match(alert.telegramText, /Plan: Monthly/);
  assert.match(alert.telegramText, /Offer: creator-seven-day-trial/);
  assert.match(alert.telegramText, /Affiliate: SCHORE/);
  assert.match(alert.telegramText, /Auto-renew: On/);
  assert.equal(alert.telegramText.includes('purchaseToken'), false);
  assert.equal(alert.telegramText.includes(TOKEN_HASH), false);
  assert.equal(alert.payload.purchaseTokenSha256, TOKEN_HASH);
});

test('marks Google Play test purchases as Sandbox for existing notification filtering', () => {
  const alert = buildGooglePlaySubscriptionAdminNotification({
    kind: 'new_paid_subscription',
    accountId: ACCOUNT_ID,
    purchaseTokenSha256: TOKEN_HASH,
    productId: 'agora_pro_monthly',
    isTrial: false,
    testPurchase: true,
  });

  assert.equal(alert.environment, 'Sandbox');
});
