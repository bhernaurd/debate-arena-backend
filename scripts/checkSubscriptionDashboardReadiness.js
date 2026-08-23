import '../env.js';

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

async function main() {
    const viewsResult = await pool.query(`
        SELECT
            to_regclass('public.subscription_admin_customers_v1') IS NOT NULL
                AS has_customer_view,
            to_regclass('public.subscription_admin_business_metrics_v1') IS NOT NULL
                AS has_metrics_view,
            to_regclass('public.subscription_admin_transaction_timeline_v1') IS NOT NULL
                AS has_timeline_view;
    `);

    const views = viewsResult.rows[0] || {};

    if (
        !views.has_customer_view ||
        !views.has_metrics_view ||
        !views.has_timeline_view
    ) {
        console.log('[SubscriptionDashboard] Readiness:', {
            ready: false,
            views,
            reason: 'Run migration 027_subscription_admin_dashboard_views.sql first.',
        });
        process.exitCode = 1;
        return;
    }

    const metricsResult = await pool.query(`
        SELECT *
        FROM subscription_admin_business_metrics_v1;
    `);

    const integrityResult = await pool.query(`
        SELECT
            COUNT(*) FILTER (
                WHERE is_lifetime_pro
                  AND recurring_business_metrics_eligible
            ) AS lifetime_marked_recurring_business,
            COUNT(*) FILTER (
                WHERE is_lifetime_pro
                  AND estimated_mrr_usd <> 0
            ) AS lifetime_with_mrr,
            COUNT(*) FILTER (
                WHERE is_lifetime_pro
                  AND canceling
            ) AS lifetime_marked_canceling,
            COUNT(*) FILTER (
                WHERE is_lifetime_pro
                  AND auto_renew_enabled IS NOT NULL
            ) AS lifetime_with_auto_renew,
            COUNT(*) FILTER (
                WHERE is_lifetime_pro
                  AND access_ends_at IS NOT NULL
            ) AS lifetime_with_access_end
        FROM subscription_admin_customers_v1;
    `);

    const identityResult = await pool.query(`
        SELECT
            COUNT(*) AS entitlement_rows,
            COUNT(*) FILTER (WHERE account_id IS NOT NULL) AS linked_accounts,
            COUNT(*) FILTER (WHERE account_email IS NOT NULL) AS rows_with_email,
            COUNT(*) FILTER (WHERE affiliate_id IS NOT NULL) AS affiliate_attributed_rows
        FROM subscription_admin_customers_v1;
    `);

    const integrity = integrityResult.rows[0] || {};
    const invalidLifetimeRows =
        Number(integrity.lifetime_marked_recurring_business || 0) +
        Number(integrity.lifetime_with_mrr || 0) +
        Number(integrity.lifetime_marked_canceling || 0) +
        Number(integrity.lifetime_with_auto_renew || 0) +
        Number(integrity.lifetime_with_access_end || 0);

    const ready = invalidLifetimeRows === 0;

    console.log('[SubscriptionDashboard] Readiness:', {
        ready,
        views,
        metrics: metricsResult.rows[0] || {},
        identityCoverage: identityResult.rows[0] || {},
        lifetimeIntegrity: integrity,
    });

    if (!ready) {
        process.exitCode = 1;
    }
}

main()
    .catch((error) => {
        console.error(
            '[SubscriptionDashboard] Readiness check failed:',
            error?.stack || error
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
