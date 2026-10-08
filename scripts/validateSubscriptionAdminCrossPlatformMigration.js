import '../env.js';

import fs from 'node:fs/promises';
import pg from 'pg';

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

const fixtureSql = await read('../test/fixtures/subscription_admin_cross_platform_prereqs.sql');
const migrationSql = await read('../migrations/053_subscription_admin_cross_platform.sql');

const client = await pool.connect();

try {
  await client.query('BEGIN');
  await client.query(fixtureSql);
  await client.query(migrationSql);

  const relationCheck = await client.query(`
    SELECT
      to_regclass('public.google_play_subscription_state_events') IS NOT NULL AS has_state_events,
      to_regclass('public.subscription_admin_cross_platform_customers_v1') IS NOT NULL AS has_customers,
      to_regclass('public.subscription_admin_cross_platform_current_customers_v1') IS NOT NULL AS has_current,
      to_regclass('public.subscription_admin_cross_platform_business_metrics_v1') IS NOT NULL AS has_metrics,
      to_regclass('public.subscription_admin_cross_platform_transaction_timeline_v1') IS NOT NULL AS has_timeline,
      to_regclass('public.subscription_admin_cross_platform_events_v1') IS NOT NULL AS has_events
  `);

  const relations = relationCheck.rows[0] || {};
  if (Object.values(relations).some((value) => value !== true)) {
    throw new Error(
      'Migration 053 did not create every required cross-platform admin relation: ' +
      JSON.stringify(relations)
    );
  }

  const accountId = '11111111-1111-4111-8111-111111111111';
  const affiliateId = '22222222-2222-4222-8222-222222222222';
  const tokenHash = 'a'.repeat(64);

  await client.query(
    `
      INSERT INTO accounts (id, status, display_name)
      VALUES ($1::uuid, 'active', 'Android Test User')
    `,
    [accountId]
  );

  await client.query(
    `
      INSERT INTO account_google_identities (
        account_id,
        email,
        display_name,
        last_authenticated_at
      )
      VALUES (
        $1::uuid,
        'android-ci@example.com',
        'Android Test User',
        NOW()
      )
    `,
    [accountId]
  );

  await client.query(
    `
      INSERT INTO affiliates (id, display_name, custom_code)
      VALUES ($1::uuid, 'Creator CI', 'CREATORCI')
    `,
    [affiliateId]
  );

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
        pricing_cohort_source
      )
      VALUES (
        $1,
        $2::uuid,
        'agora_pro_monthly',
        'monthly-standard',
        'creator-seven-day-trial',
        'trial',
        TRUE,
        TRUE,
        FALSE,
        'GPA.CI-ORDER',
        'US',
        NOW(),
        NOW() + INTERVAL '7 days',
        'standard',
        'paywall'
      )
    `,
    [tokenHash, accountId]
  );

  await client.query(
    `
      INSERT INTO affiliate_google_play_subscription_attributions (
        purchase_token_sha256,
        affiliate_id,
        normalized_creator_code,
        attribution_source
      )
      VALUES (
        $1,
        $2::uuid,
        'CREATORCI',
        'account_creator_code'
      )
    `,
    [tokenHash, affiliateId]
  );

  const googleCustomer = await client.query(
    `
      SELECT
        store_platform,
        environment,
        status,
        trial_active,
        recurring_revenue_active,
        affiliate_code,
        affiliate_attribution_source
      FROM subscription_admin_cross_platform_current_customers_v1
      WHERE account_id = $1::uuid
      LIMIT 1
    `,
    [accountId]
  );

  const row = googleCustomer.rows[0];
  if (
    !row ||
    row.store_platform !== 'google_play' ||
    row.environment !== 'Production' ||
    row.status !== 'trial' ||
    row.trial_active !== true ||
    row.recurring_revenue_active !== false ||
    row.affiliate_code !== 'CREATORCI' ||
    row.affiliate_attribution_source !== 'account_creator_code'
  ) {
    throw new Error(
      'Cross-platform customer projection did not preserve the verified Google Play state: ' +
      JSON.stringify(row || null)
    );
  }

  const eventCount = await client.query(
    `
      SELECT COUNT(*)::int AS count
      FROM google_play_subscription_state_events
      WHERE purchase_token_sha256 = $1
    `,
    [tokenHash]
  );

  if (eventCount.rows[0]?.count !== 1) {
    throw new Error(
      'Google Play entitlement insert did not create exactly one baseline state event.'
    );
  }

  console.log('[CrossPlatformAdminMigration] Validation passed:', {
    relations,
    googleCustomer: row,
    stateEvents: eventCount.rows[0]?.count,
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
