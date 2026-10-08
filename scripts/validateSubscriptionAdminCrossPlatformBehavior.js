import '../env.js';

import fs from 'node:fs/promises';
import pg from 'pg';

import { loadSubscriptionAdminHistory } from '../lib/subscriptionAdminHistoryService.js';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  max: 1,
});

async function read(path) {
  return fs.readFile(new URL(path, import.meta.url), 'utf8');
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function number(row, key) {
  return Number(row?.[key] || 0);
}

const fixtureSql = await read('../test/fixtures/subscription_admin_cross_platform_prereqs.sql');
const migrationSql = await read('../migrations/053_subscription_admin_cross_platform.sql');

const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(fixtureSql);
  await client.query(migrationSql);

  // Two App Store customers give us an iOS baseline: one paid monthly, one
  // active annual trial. These rows match the existing Apple admin projection.
  await client.query(`
    INSERT INTO subscription_admin_customers_v1 (
      original_transaction_id,
      environment,
      product_id,
      pro_access_source,
      is_recurring_pro,
      is_lifetime_pro,
      status,
      is_trial,
      auto_renew_enabled,
      purchase_date,
      original_purchase_date,
      expires_date,
      source,
      created_at,
      updated_at,
      latest_transaction_id,
      latest_transaction_reason,
      latest_transaction_type,
      latest_purchase_date,
      latest_transaction_signed_date,
      currency,
      price_milliunits,
      quantity,
      has_pro_access,
      recurring_revenue_active,
      trial_active,
      canceling,
      access_ends_at,
      recurring_business_metrics_eligible,
      estimated_mrr_usd,
      customer_key
    )
    VALUES
      (
        'apple-paid-chain',
        'Production',
        'agora_pro_monthly',
        'monthly',
        TRUE,
        FALSE,
        'active',
        FALSE,
        TRUE,
        NOW() - INTERVAL '2 days',
        NOW() - INTERVAL '2 days',
        NOW() + INTERVAL '28 days',
        'app_store',
        NOW() - INTERVAL '2 days',
        NOW(),
        'apple-paid-tx',
        'purchase',
        'PURCHASED',
        NOW() - INTERVAL '2 days',
        NOW(),
        'USD',
        7990,
        1,
        TRUE,
        TRUE,
        FALSE,
        FALSE,
        NOW() + INTERVAL '28 days',
        TRUE,
        7.99,
        'apple-paid-customer'
      ),
      (
        'apple-trial-chain',
        'Production',
        'agora_pro_yearly',
        'annual',
        TRUE,
        FALSE,
        'trial',
        TRUE,
        TRUE,
        NOW() - INTERVAL '1 day',
        NOW() - INTERVAL '1 day',
        NOW() + INTERVAL '2 days',
        'app_store',
        NOW() - INTERVAL '1 day',
        NOW(),
        'apple-trial-tx',
        'trial_start',
        'PURCHASED',
        NOW() - INTERVAL '1 day',
        NOW(),
        'USD',
        NULL,
        1,
        TRUE,
        FALSE,
        TRUE,
        FALSE,
        NOW() + INTERVAL '2 days',
        FALSE,
        0,
        'apple-trial-customer'
      );
  `);

  await client.query(`
    INSERT INTO subscription_admin_transaction_timeline_v1 (
      original_transaction_id,
      environment,
      transaction_id,
      product_id,
      pro_access_source,
      transaction_reason,
      transaction_type,
      offer_type,
      offer_identifier,
      offer_discount_type,
      is_trial,
      purchase_date,
      original_purchase_date,
      expires_date,
      revocation_date,
      signed_date,
      storefront,
      currency,
      price_milliunits,
      quantity,
      created_at,
      updated_at
    )
    VALUES
      (
        'apple-paid-chain',
        'Production',
        'apple-paid-tx',
        'agora_pro_monthly',
        'monthly',
        'purchase',
        'PURCHASED',
        NULL,
        NULL,
        NULL,
        FALSE,
        NOW() - INTERVAL '2 days',
        NOW() - INTERVAL '2 days',
        NOW() + INTERVAL '28 days',
        NULL,
        NOW() - INTERVAL '2 days',
        'USA',
        'USD',
        7990,
        1,
        NOW() - INTERVAL '2 days',
        NOW()
      ),
      (
        'apple-trial-chain',
        'Production',
        'apple-trial-tx',
        'agora_pro_yearly',
        'annual',
        'trial_start',
        'PURCHASED',
        'INTRODUCTORY',
        'three-day-trial',
        'FREE_TRIAL',
        TRUE,
        NOW() - INTERVAL '1 day',
        NOW() - INTERVAL '1 day',
        NOW() + INTERVAL '2 days',
        NULL,
        NOW() - INTERVAL '1 day',
        'USA',
        'USD',
        NULL,
        1,
        NOW() - INTERVAL '1 day',
        NOW()
      );
  `);

  const ids = {
    creatorTrial: '11111111-1111-4111-8111-111111111111',
    paidMonthly: '33333333-3333-4333-8333-333333333333',
    cancelingAnnual: '44444444-4444-4444-8444-444444444444',
    expired: '55555555-5555-4555-8555-555555555555',
    sandbox: '66666666-6666-4666-8666-666666666666',
    pending: '77777777-7777-4777-8777-777777777777',
    affiliate: '22222222-2222-4222-8222-222222222222',
  };

  await client.query(
    `
      INSERT INTO accounts (id, status, display_name)
      VALUES
        ($1::uuid, 'active', 'Creator Trial'),
        ($2::uuid, 'active', 'Paid Monthly'),
        ($3::uuid, 'active', 'Canceling Annual'),
        ($4::uuid, 'active', 'Expired User'),
        ($5::uuid, 'active', 'Sandbox User'),
        ($6::uuid, 'active', 'Pending User')
    `,
    [
      ids.creatorTrial,
      ids.paidMonthly,
      ids.cancelingAnnual,
      ids.expired,
      ids.sandbox,
      ids.pending,
    ]
  );

  await client.query(
    `
      INSERT INTO account_google_identities (
        account_id,
        email,
        display_name,
        last_authenticated_at
      )
      VALUES
        ($1::uuid, 'creator-trial@example.com', 'Creator Trial', NOW()),
        ($2::uuid, 'paid-monthly@example.com', 'Paid Monthly', NOW()),
        ($3::uuid, 'canceling-annual@example.com', 'Canceling Annual', NOW()),
        ($4::uuid, 'expired@example.com', 'Expired User', NOW()),
        ($5::uuid, 'sandbox@example.com', 'Sandbox User', NOW()),
        ($6::uuid, 'pending@example.com', 'Pending User', NOW())
    `,
    [
      ids.creatorTrial,
      ids.paidMonthly,
      ids.cancelingAnnual,
      ids.expired,
      ids.sandbox,
      ids.pending,
    ]
  );

  await client.query(
    `
      INSERT INTO affiliates (id, display_name, custom_code)
      VALUES ($1::uuid, 'Creator CI', 'CREATORCI')
    `,
    [ids.affiliate]
  );

  const tokens = {
    creatorTrial: 'a'.repeat(64),
    paidMonthly: 'b'.repeat(64),
    cancelingAnnual: 'c'.repeat(64),
    expired: 'd'.repeat(64),
    sandbox: 'e'.repeat(64),
    pending: 'f'.repeat(64),
  };

  await client.query(
    `
      INSERT INTO google_play_subscription_entitlements (
        purchase_token_sha256,
        account_id,
        product_id,
        base_plan_id,
        offer_id,
        normalized_status,
        is_trial,
        auto_renew_enabled,
        test_purchase,
        latest_order_id,
        region_code,
        start_time,
        expires_date,
        pricing_cohort,
        pricing_cohort_source,
        last_verified_at
      )
      VALUES
        (
          $1, $7::uuid, 'agora_pro_monthly', 'monthly-standard',
          'creator-seven-day-trial', 'trial', TRUE, TRUE, FALSE,
          'GPA.TRIAL-ORDER', 'US', NOW() - INTERVAL '1 day',
          NOW() + INTERVAL '6 days', 'standard', 'creator_code', NOW()
        ),
        (
          $2, $8::uuid, 'agora_pro_monthly', 'monthly-standard',
          NULL, 'active', FALSE, TRUE, FALSE,
          'GPA.MONTHLY-ORDER', 'US', NOW() - INTERVAL '10 days',
          NOW() + INTERVAL '20 days', 'standard', 'paywall', NOW()
        ),
        (
          $3, $9::uuid, 'agora_pro_yearly', 'yearly-standard',
          NULL, 'active', FALSE, FALSE, FALSE,
          'GPA.ANNUAL-ORDER', 'US', NOW() - INTERVAL '40 days',
          NOW() + INTERVAL '325 days', 'standard', 'paywall', NOW()
        ),
        (
          $4, $10::uuid, 'agora_pro_monthly', 'monthly-standard',
          NULL, 'expired', FALSE, FALSE, FALSE,
          'GPA.EXPIRED-ORDER', 'US', NOW() - INTERVAL '60 days',
          NOW() - INTERVAL '30 days', 'standard', 'paywall', NOW()
        ),
        (
          $5, $11::uuid, 'agora_pro_monthly', 'monthly-standard',
          NULL, 'active', FALSE, TRUE, TRUE,
          'GPA.SANDBOX-ORDER', 'US', NOW() - INTERVAL '3 days',
          NOW() + INTERVAL '27 days', 'standard', 'paywall', NOW()
        ),
        (
          $6, $12::uuid, 'agora_pro_monthly', 'monthly-standard',
          NULL, 'pending', FALSE, TRUE, FALSE,
          NULL, 'US', NOW(), NULL, 'standard', 'paywall', NOW()
        )
    `,
    [
      tokens.creatorTrial,
      tokens.paidMonthly,
      tokens.cancelingAnnual,
      tokens.expired,
      tokens.sandbox,
      tokens.pending,
      ids.creatorTrial,
      ids.paidMonthly,
      ids.cancelingAnnual,
      ids.expired,
      ids.sandbox,
      ids.pending,
    ]
  );

  await client.query(
    `
      INSERT INTO affiliate_google_play_subscription_attributions (
        purchase_token_sha256,
        affiliate_id,
        normalized_creator_code,
        attribution_source
      )
      VALUES ($1, $2::uuid, 'CREATORCI', 'account_creator_code')
    `,
    [tokens.creatorTrial, ids.affiliate]
  );

  const beforeMetricsResult = await client.query(
    'SELECT * FROM subscription_admin_cross_platform_business_metrics_v1'
  );
  const before = beforeMetricsResult.rows[0] || {};

  expectEqual(number(before, 'active_pro_entitlements'), 5, 'active Pro');
  expectEqual(number(before, 'active_paid_subscribers'), 3, 'active paid subscribers');
  expectEqual(number(before, 'active_trials'), 2, 'active trials');
  expectEqual(number(before, 'paid_monthly'), 2, 'paid monthly');
  expectEqual(number(before, 'paid_annual'), 1, 'paid annual');
  expectEqual(number(before, 'canceling_subscriptions'), 1, 'canceling subscriptions');
  expectEqual(number(before, 'affiliate_attributed_recurring_chains'), 1, 'affiliate-attributed subscriptions');
  expectEqual(number(before, 'app_store_active_pro_entitlements'), 2, 'App Store active Pro');
  expectEqual(number(before, 'google_play_active_pro_entitlements'), 3, 'Google Play active Pro');
  expectEqual(number(before, 'app_store_active_paid_subscribers'), 1, 'App Store paid');
  expectEqual(number(before, 'google_play_active_paid_subscribers'), 2, 'Google Play paid');
  expectEqual(number(before, 'app_store_active_trials'), 1, 'App Store trials');
  expectEqual(number(before, 'google_play_active_trials'), 1, 'Google Play trials');
  expectEqual(number(before, 'sandbox_active_pro_entitlements'), 1, 'sandbox active Pro');

  const inactiveRows = await client.query(
    `
      SELECT account_id, status, has_pro_access
      FROM subscription_admin_cross_platform_customers_v1
      WHERE account_id IN ($1::uuid, $2::uuid)
      ORDER BY account_id
    `,
    [ids.expired, ids.pending]
  );

  const expired = inactiveRows.rows.find((row) => row.account_id === ids.expired);
  const pending = inactiveRows.rows.find((row) => row.account_id === ids.pending);
  expectEqual(expired?.status, 'expired', 'expired Google status');
  expectEqual(expired?.has_pro_access, false, 'expired Google access');
  expectEqual(pending?.status, 'unknown', 'pending Google dashboard status');
  expectEqual(pending?.has_pro_access, false, 'pending Google access');

  // Convert the creator trial to paid. The state trigger must preserve the
  // creator attribution while the transaction timeline records a conversion.
  await client.query(
    `
      UPDATE google_play_subscription_entitlements
      SET
        normalized_status = 'active',
        is_trial = FALSE,
        latest_order_id = 'GPA.TRIAL-PAID-ORDER',
        expires_date = NOW() + INTERVAL '30 days',
        last_verified_at = NOW(),
        updated_at = NOW()
      WHERE purchase_token_sha256 = $1
    `,
    [tokens.creatorTrial]
  );

  // Simulate the strongest churn edge case in a single server verification:
  // active + renewing -> expired + auto-renew off. History must count both the
  // cancellation request and the subscription ending, even though one state
  // event represents both changes.
  await client.query(
    `
      UPDATE google_play_subscription_entitlements
      SET
        normalized_status = 'expired',
        auto_renew_enabled = FALSE,
        expires_date = NOW() - INTERVAL '1 minute',
        last_verified_at = NOW(),
        updated_at = NOW()
      WHERE purchase_token_sha256 = $1
    `,
    [tokens.paidMonthly]
  );

  const conversion = await client.query(
    `
      SELECT transaction_reason, is_trial, store_platform
      FROM subscription_admin_cross_platform_transaction_timeline_v1
      WHERE original_transaction_id = $1
        AND transaction_reason = 'trial_conversion'
      LIMIT 1
    `,
    ['gp:' + tokens.creatorTrial]
  );

  expectEqual(conversion.rows[0]?.transaction_reason, 'trial_conversion', 'Google trial conversion');
  expectEqual(conversion.rows[0]?.is_trial, false, 'converted Google transaction trial flag');
  expectEqual(conversion.rows[0]?.store_platform, 'google_play', 'converted Google store');

  const churnEvent = await client.query(
    `
      SELECT
        event_type,
        subtype,
        status_after,
        auto_renew_enabled,
        metadata
      FROM subscription_admin_cross_platform_events_v1
      WHERE original_transaction_id = $1
        AND status_after = 'expired'
      ORDER BY event_at DESC
      LIMIT 1
    `,
    ['gp:' + tokens.paidMonthly]
  );

  const churn = churnEvent.rows[0] || {};
  expectEqual(churn.event_type, 'DID_CHANGE_RENEWAL_STATUS', 'simultaneous Google churn event type');
  expectEqual(churn.subtype, 'AUTO_RENEW_DISABLED', 'simultaneous Google churn subtype');
  expectEqual(churn.status_after, 'expired', 'simultaneous Google churn status');
  expectEqual(churn.auto_renew_enabled, false, 'simultaneous Google churn renewal state');
  expectEqual(churn.metadata?.previousStatus, 'active', 'simultaneous Google churn previous status');
  expectEqual(churn.metadata?.previousAutoRenewEnabled, true, 'simultaneous Google churn previous renewal state');

  const afterMetricsResult = await client.query(
    'SELECT * FROM subscription_admin_cross_platform_business_metrics_v1'
  );
  const after = afterMetricsResult.rows[0] || {};

  expectEqual(number(after, 'active_pro_entitlements'), 4, 'active Pro after conversion + expiry');
  expectEqual(number(after, 'active_paid_subscribers'), 3, 'active paid after conversion + expiry');
  expectEqual(number(after, 'active_trials'), 1, 'active trials after conversion');
  expectEqual(number(after, 'google_play_active_pro_entitlements'), 2, 'Google active Pro after expiry');
  expectEqual(number(after, 'google_play_active_paid_subscribers'), 2, 'Google paid after conversion + expiry');
  expectEqual(number(after, 'google_play_active_trials'), 0, 'Google trials after conversion');

  const transactionalPool = {
    query: (...args) => client.query(...args),
  };
  const noOpCurrencyConverter = {
    reportingCurrency: 'USD',
    async convertBag(bag) {
      return {
        bag,
        convertedCurrencies: [],
        fallbackCurrencies: [],
      };
    },
  };

  const history = await loadSubscriptionAdminHistory(transactionalPool, {
    currencyConverter: noOpCurrencyConverter,
  });

  expectEqual(history.allTime.newSubscribers, 6, 'cross-platform new subscribers');
  expectEqual(history.allTime.paidCustomers, 5, 'cross-platform new paid subscribers');
  expectEqual(history.allTime.trialStarts, 2, 'cross-platform trial starts');
  expectEqual(history.allTime.trialConversions, 1, 'Google trial conversions');
  expectEqual(history.allTime.cancellationRequests, 1, 'Google cancellation requests');
  expectEqual(history.allTime.subscriptionsEnded, 1, 'Google subscriptions ended');
  expectEqual(history.allTime.paidTransactions, 1, 'verified-price paid transactions remain App Store only');
  expectEqual(history.allTime.grossSales?.USD, 7.99, 'gross sales do not invent Google Play revenue');

  console.log('[CrossPlatformAdminBehavior] Validation passed:', {
    before: {
      activePro: number(before, 'active_pro_entitlements'),
      paid: number(before, 'active_paid_subscribers'),
      trials: number(before, 'active_trials'),
      canceling: number(before, 'canceling_subscriptions'),
      appStoreActivePro: number(before, 'app_store_active_pro_entitlements'),
      googlePlayActivePro: number(before, 'google_play_active_pro_entitlements'),
      affiliateAttributed: number(before, 'affiliate_attributed_recurring_chains'),
      sandboxActivePro: number(before, 'sandbox_active_pro_entitlements'),
    },
    after: {
      activePro: number(after, 'active_pro_entitlements'),
      paid: number(after, 'active_paid_subscribers'),
      trials: number(after, 'active_trials'),
      googlePlayActivePro: number(after, 'google_play_active_pro_entitlements'),
    },
    history: {
      newSubscribers: history.allTime.newSubscribers,
      paidCustomers: history.allTime.paidCustomers,
      trialStarts: history.allTime.trialStarts,
      trialConversions: history.allTime.trialConversions,
      cancellationRequests: history.allTime.cancellationRequests,
      subscriptionsEnded: history.allTime.subscriptionsEnded,
      grossSales: history.allTime.grossSales,
    },
  });

  await client.query('ROLLBACK');
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
