import '../env.js';

import pg from 'pg';

const { Pool } = pg;

const connectionString =
    process.env.DATABASE_URL?.trim();

if (!connectionString) {
    throw new Error(
        'DATABASE_URL is required.'
    );
}

const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
    max: 1,
});

async function main() {
    const schemaResult = await pool.query(`
        SELECT
            EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'subscription_entitlements'
                  AND column_name = 'pro_access_source'
            ) AS has_source_column,
            EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'subscription_entitlements'
                  AND column_name = 'is_recurring_pro'
            ) AS has_recurring_column,
            EXISTS (
                SELECT 1
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'subscription_entitlements'
                  AND column_name = 'is_lifetime_pro'
            ) AS has_lifetime_column,
            EXISTS (
                SELECT 1
                FROM pg_trigger
                WHERE tgname =
                    'subscription_entitlements_normalize_lifetime_pro'
                  AND NOT tgisinternal
            ) AS has_lifetime_trigger,
            EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname =
                    'affiliate_subscription_attributions_no_lifetime_pro'
            ) AS has_affiliate_guard;
    `);

    const lifetimeResult = await pool.query(`
        SELECT
            COUNT(*) AS lifetime_rows,
            COUNT(*) FILTER (
                WHERE status = 'active'
                  AND is_trial = false
                  AND auto_renew_enabled IS NULL
                  AND expires_date IS NULL
                  AND grace_period_expires_date IS NULL
                  AND pro_access_source = 'lifetime'
                  AND is_recurring_pro = false
                  AND is_lifetime_pro = true
            ) AS normalized_active_lifetime_rows,
            COUNT(*) FILTER (
                WHERE product_id = 'agora_pro_lifetime'
                  AND status = 'active'
                  AND (
                        expires_date IS NOT NULL
                        OR auto_renew_enabled IS NOT NULL
                        OR is_trial = true
                        OR is_recurring_pro = true
                        OR is_lifetime_pro = false
                  )
            ) AS invalid_active_lifetime_rows
        FROM subscription_entitlements
        WHERE product_id = 'agora_pro_lifetime';
    `);

    const schema = schemaResult.rows[0] || {};
    const lifetime = lifetimeResult.rows[0] || {};

    const ready = Boolean(
        schema.has_source_column &&
        schema.has_recurring_column &&
        schema.has_lifetime_column &&
        schema.has_lifetime_trigger &&
        schema.has_affiliate_guard &&
        Number(lifetime.invalid_active_lifetime_rows || 0) === 0
    );

    console.log('[LifetimePro] Database readiness:', {
        ready,
        schema,
        lifetime,
    });

    if (!ready) {
        process.exitCode = 1;
    }
}

main()
    .catch((error) => {
        console.error(
            '[LifetimePro] Readiness check failed:',
            error?.stack || error
        );
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
