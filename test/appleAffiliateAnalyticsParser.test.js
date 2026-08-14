import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeAppleSubscriptionEventRows,
  normalizeAppleSubscriptionStateRows,
  parseAppleTsv,
} from '../lib/appleAffiliateAnalyticsParser.js';

test('parses Apple subscription event Vanity Code into the affiliate code', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tSubscription Name\tSubscription Identifier\tSubscription Duration\tOffer Type\tVanity Code\tOffer Pricing\tCounts',
    '2026-09-13\tFull Price from Paid Offer\tAgora Pro Monthly\t12345\t1 month\tOffer Code\tMAXAGORA\tPay As You Go\t3',
  ].join('\n');

  const rows = normalizeAppleSubscriptionEventRows(tsv);
  const primary = rows.find((row) => row.metricKey === 'full_price_from_paid_offer');
  assert.ok(primary);
  assert.equal(primary.normalizedCode, 'MAXAGORA');
  assert.equal(primary.metricValue, 3);
  assert.equal(primary.subscriptionPricing, 'Full Price');
});

test('parses preserved-price renewals by creator code', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tSubscription Duration\tVanity Code\tCounts',
    '2026-10-13\tPreserved Price Renewals\t1 month\tMAXAGORA\t7',
  ].join('\n');

  const rows = normalizeAppleSubscriptionEventRows(tsv);
  assert.equal(rows[0].metricKey, 'preserved_price_renewals');
  assert.equal(rows[0].subscriptionPricing, 'Preserved Price');
  assert.equal(rows[0].metricValue, 7);
});

test('parses active paid offers from the subscription state report', () => {
  const tsv = [
    'Date\tState Metric\tSubscription Duration\tOffer Type\tVanity Code\tOffer Pricing\tCounts',
    '2026-08-13\tPaid offers\t1 month\tOffer Code\tMAXAGORA\tPay As You Go\t14',
  ].join('\n');

  const rows = normalizeAppleSubscriptionStateRows(tsv);
  assert.equal(rows[0].metricKey, 'paid_offers');
  assert.equal(rows[0].metricValue, 14);
});

test('ignores rows that have no custom/vanity code', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tVanity Code\tCounts',
    '2026-09-13\tFull Price Renewals\t\t20',
  ].join('\n');

  assert.deepEqual(normalizeAppleSubscriptionEventRows(tsv), []);
});

test('generic TSV parser preserves report headers', () => {
  const rows = parseAppleTsv('A\tB\n1\t2\n');
  assert.deepEqual(rows, [{ A: '1', B: '2' }]);
});

test('derives active, paid-plan, and canceling state totals from Apple state rows', () => {
  const tsv = [
    'Date\tState Metric\tVanity Code\tCancellation Reason\tCounts',
    '2026-09-30\tPreserved price\tMAXAGORA\tTurned off auto-renew\t3',
  ].join('\n');

  const rows = normalizeAppleSubscriptionStateRows(tsv);
  const keys = rows.map((row) => row.metricKey);
  assert.ok(keys.includes('preserved_price'));
  assert.ok(keys.includes('active_plans'));
  assert.ok(keys.includes('paid_plans'));
  assert.ok(keys.includes('canceling_active'));
});

test('derives total paid-offer conversions from Apple event rows', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tVanity Code\tCounts',
    '2026-09-13\tFull Price from Paid Offer\tMAXAGORA\t4',
  ].join('\n');

  const rows = normalizeAppleSubscriptionEventRows(tsv);
  assert.ok(rows.some((row) => row.metricKey === 'paid_subscriptions_from_offers_all' && row.metricValue === 4));
});

test('TSV parser handles quoted tabs, embedded newlines, and escaped quotes', () => {
  const text = 'A\tB\n"hello\tworld"\t"line 1\nline 2 ""quoted"""\n';
  const rows = parseAppleTsv(text);
  assert.deepEqual(rows, [{ A: 'hello\tworld', B: 'line 1\nline 2 "quoted"' }]);
});

test('grace period contributes to active access but not Active Plans', () => {
  const tsv = [
    'Date\tState Metric\tVanity Code\tCounts',
    '2026-10-01\tGrace period\tMAXAGORA\t2',
  ].join('\n');

  const rows = normalizeAppleSubscriptionStateRows(tsv);
  const keys = rows.map((row) => row.metricKey);
  assert.ok(keys.includes('grace_period'));
  assert.ok(keys.includes('active_access'));
  assert.ok(!keys.includes('active_plans'));
});

test('parses Apple commitment-based and contingent transition metrics without dropping them', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tSubscription Duration\tVanity Code\tCounts',
    '2026-10-13\tFull Price Commitment-Based Payments\t1 month\tMAXAGORA\t2',
    '2026-10-14\tContingent Price Renewal from Full Price\t1 month\tMAXAGORA\t1',
  ].join('\n');

  const rows = normalizeAppleSubscriptionEventRows(tsv);
  assert.ok(rows.some((row) => row.metricKey === 'full_price_commitment_based_payments'));
  assert.ok(rows.some((row) => row.metricKey === 'contingent_price_renewal_from_full_price'));
});

test('rejects negative and fractional Apple Counts instead of corrupting affiliate totals', () => {
  const tsv = [
    'Event Date\tEvent Sub Type\tVanity Code\tCounts',
    '2026-10-13\tFull Price Renewals\tMAXAGORA\t-1',
    '2026-10-14\tFull Price Renewals\tMAXAGORA\t1.5',
    '2026-10-15\tFull Price Renewals\tMAXAGORA\t2',
  ].join('\n');

  const rows = normalizeAppleSubscriptionEventRows(tsv);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.metricValue === 2));
});
