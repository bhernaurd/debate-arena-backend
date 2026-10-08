import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations', '052_google_play_affiliate_attribution.sql'),
  'utf8'
);
const programService = fs.readFileSync(
  path.join(root, 'lib', 'affiliateProgramService.js'),
  'utf8'
);
const googleService = fs.readFileSync(
  path.join(root, 'lib', 'googlePlaySubscriptionService.js'),
  'utf8'
);
const rtdnService = fs.readFileSync(
  path.join(root, 'lib', 'googlePlayRtdnService.js'),
  'utf8'
);
const server = fs.readFileSync(
  path.join(root, 'server.js'),
  'utf8'
);

test('migration stores permanent Google affiliate ownership without raw purchase tokens', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS affiliate_google_play_subscription_attributions/);
  assert.match(migration, /purchase_token_sha256 TEXT PRIMARY KEY/);
  assert.match(migration, /root_purchase_token_sha256 TEXT NOT NULL/);
  assert.match(migration, /linked_google_play_purchase/);
  assert.match(migration, /account_creator_code/);
  assert.doesNotMatch(migration, /purchase_token\s+TEXT/i);
});

test('Google affiliate billing ledger is order-id idempotent and separates trial from paid orders', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS affiliate_google_play_billing_events/);
  assert.match(migration, /event_key TEXT NOT NULL UNIQUE/);
  assert.match(migration, /event_type IN \('trial_start', 'paid_order', 'reversal'\)/);
  assert.match(migration, /test_purchase BOOLEAN NOT NULL DEFAULT FALSE/);
});

test('verified Google purchase service records affiliate ownership inside entitlement transaction', () => {
  assert.match(googleService, /affiliateGooglePlayAttributionService/);
  assert.match(googleService, /recordVerifiedPurchase/);
  assert.match(googleService, /verifiedOfferId/);
  assert.match(googleService, /linkedPurchaseTokenSha256/);
  assert.match(googleService, /latestOrderId/);
  assert.match(googleService, /billingEventAt/);
});

test('RTDN timestamps drive renewals and voided purchases drive affiliate reversals', () => {
  assert.match(rtdnService, /notification\.eventTimeMillis/);
  assert.match(rtdnService, /billingEventAt/);
  assert.match(rtdnService, /voidedPurchaseNotification/);
  assert.match(rtdnService, /recordVoidedAffiliatePurchase/);
  assert.match(rtdnService, /googleOrderId: orderId/);
});

test('affiliate dashboard combines verified Apple and Google subscriber state', () => {
  assert.match(programService, /async function googleSubscriberSnapshot/);
  assert.match(programService, /affiliate_google_play_subscription_attributions/);
  assert.match(programService, /mergeExactSubscriberSnapshots/);
  assert.match(programService, /verified_cross_platform_subscriptions/);
});

test('affiliate payout calculation includes only verified paid Google orders', () => {
  assert.match(programService, /FROM affiliate_google_play_billing_events/);
  assert.match(programService, /event_type = 'paid_order'/);
  assert.match(programService, /AS reversed/);
  assert.match(programService, /if \(event\.reversed === true\) continue/);
  assert.match(programService, /test_purchase = \$2/);
  assert.match(programService, /Google Play ·/);
  assert.match(programService, /missing_google_play_base_price_rule/);
});

test('new verified Google billing events refresh derived affiliate payout state', () => {
  assert.match(server, /onAffiliateBillingEvent/);
  assert.match(server, /refreshMonthlyPayout/);
  assert.match(server, /system_google_play_billing/);
  assert.match(server, /America\/Chicago/);
});

test('Google refund accounting refreshes the original paid-order month', () => {
  assert.match(googleService, /result\.originalEventAt/);
  assert.match(googleService, /new Date\(result\.originalEventAt\)\.toISOString\(\)/);
  assert.match(programService, /reversed paid order in sourceRows/);
});
