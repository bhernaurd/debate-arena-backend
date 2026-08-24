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
    const viewResult = await pool.query(`
        SELECT
            to_regclass('public.subscription_admin_current_customers_v1') IS NOT NULL
                AS has_current_customer_view;
    `);

    const hasCurrentCustomerView =
        viewResult.rows[0]?.has_current_customer_view === true;

    if (!hasCurrentCustomerView) {
        console.log('[SubscriptionCurrentState] Readiness:', {
            ready: false,
            reason: 'Run migration 028_subscription_customer_current_state.sql first.',
        });
        process.exitCode = 1;
        return;
    }

    const [metricsResult, duplicateResult, supersededResult, conflictResult] =
        await Promise.all([
            pool.query(`
                SELECT *
                FROM subscription_admin_business_metrics_v1;
            `),
            pool.query(`
                SELECT COUNT(*)::int AS duplicate_current_customer_rows
                FROM (
                    SELECT customer_key, environment
                    FROM subscription_admin_current_customers_v1
                    GROUP BY customer_key, environment
                    HAVING COUNT(*) > 1
                ) duplicates;
            `),
            pool.query(`
                SELECT COUNT(*)::int AS superseded_canceling_chains
                FROM subscription_admin_customers_v1 old_chain
                WHERE old_chain.environment = 'Production'
                  AND old_chain.canceling
                  AND EXISTS (
                    SELECT 1
                    FROM subscription_admin_customers_v1 current_chain
                    WHERE current_chain.environment = old_chain.environment
                      AND current_chain.customer_key = old_chain.customer_key
                      AND current_chain.original_transaction_id <> old_chain.original_transaction_id
                      AND (
                        (
                          current_chain.recurring_revenue_active
                          AND current_chain.auto_renew_enabled = TRUE
                        )
                        OR (
                          current_chain.is_lifetime_pro
                          AND current_chain.has_pro_access
                        )
                      )
                  );
            `),
            pool.query(`
                SELECT COUNT(*)::int AS invalid_current_canceling_rows
                FROM subscription_admin_current_customers_v1 current_customer
                WHERE current_customer.environment = 'Production'
                  AND current_customer.canceling
                  AND EXISTS (
                    SELECT 1
                    FROM subscription_admin_customers_v1 other_chain
                    WHERE other_chain.environment = current_customer.environment
                      AND other_chain.customer_key = current_customer.customer_key
                      AND other_chain.original_transaction_id <> current_customer.original_transaction_id
                      AND (
                        (
                          other_chain.recurring_revenue_active
                          AND other_chain.auto_renew_enabled = TRUE
                        )
                        OR (
                          other_chain.is_lifetime_pro
                          AND other_chain.has_pro_access
                        )
                      )
                  );
            `),
        ]);

    const duplicates = Number(
        duplicateResult.rows[0]?.duplicate_current_customer_rows || 0
    );
    const invalidCanceling = Number(
        conflictResult.rows[0]?.invalid_current_canceling_rows || 0
    );

    const ready = duplicates === 0 && invalidCanceling === 0;

    console.log('[SubscriptionCurrentState] Readiness:', {
        ready,
        metrics: metricsResult.rows[0] || {},
        duplicateCurrentCustomerRows: duplicates,
        supersededCancelingChains: Number(
            supersededResult.rows[0]?.superseded_canceling_chains || 0
        ),
        invalidCurrentCancelingRows: invalidCanceling,
    });

    if (!ready) {
        process.exitCode = 1;
    }
}

main()
    .catch((error) => {
        console.error(
            '[SubscriptionCurrentState] Readiness check failed:',
            error?.stack || error
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
