import '../env.js';

import pg from 'pg';

const { Pool } = pg;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
    const args = {
        accountId: null,
        originalTransactionId: null,
        environment: 'Production',
        apply: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];

        if (token === '--apply') {
            args.apply = true;
            continue;
        }

        if (token === '--account-id') {
            args.accountId = argv[index + 1] ?? null;
            index += 1;
            continue;
        }

        if (token === '--original-transaction-id') {
            args.originalTransactionId = argv[index + 1] ?? null;
            index += 1;
            continue;
        }

        if (token === '--environment') {
            args.environment = argv[index + 1] ?? null;
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${token}`);
    }

    return args;
}

function requireUuid(value, fieldName) {
    const cleaned = String(value ?? '').trim();

    if (!UUID_RE.test(cleaned)) {
        throw new Error(`${fieldName} must be a valid UUID.`);
    }

    return cleaned.toLowerCase();
}

function requireOriginalTransactionId(value) {
    const cleaned = String(value ?? '').trim();

    if (!/^[A-Za-z0-9._-]{1,255}$/.test(cleaned)) {
        throw new Error(
            'originalTransactionId must be a valid App Store transaction-chain identifier.'
        );
    }

    return cleaned;
}

function requireEnvironment(value) {
    const cleaned = String(value ?? '').trim();

    if (cleaned !== 'Production' && cleaned !== 'Sandbox') {
        throw new Error('environment must be Production or Sandbox.');
    }

    return cleaned;
}

function summarizeAccount(row) {
    return {
        account_id: row.account_id,
        account_status: row.account_status,
        display_name: row.display_name,
        email: row.email,
    };
}

function summarizeEntitlement(row) {
    return {
        original_transaction_id: row.original_transaction_id,
        environment: row.environment,
        product_id: row.product_id,
        status: row.status,
        is_trial: row.is_trial,
        auto_renew_enabled: row.auto_renew_enabled,
        expires_date: row.expires_date,
        user_id: row.user_id,
        app_account_token: row.app_account_token,
        latest_transaction_id: row.latest_transaction_id,
        latest_transaction_reason: row.latest_transaction_reason,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const accountId = requireUuid(args.accountId, 'accountId');
    const originalTransactionId = requireOriginalTransactionId(
        args.originalTransactionId
    );
    const environment = requireEnvironment(args.environment);

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

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const accountResult = await client.query(
            `
            SELECT
                a.id AS account_id,
                a.status AS account_status,
                a.display_name,
                COALESCE(ai.email, gi.email) AS email
            FROM accounts a
            LEFT JOIN LATERAL (
                SELECT email
                FROM account_apple_identities
                WHERE account_id = a.id
                ORDER BY last_authenticated_at DESC, created_at DESC
                LIMIT 1
            ) ai ON TRUE
            LEFT JOIN LATERAL (
                SELECT email
                FROM account_google_identities
                WHERE account_id = a.id
                ORDER BY last_authenticated_at DESC, created_at DESC
                LIMIT 1
            ) gi ON TRUE
            WHERE a.id = $1::uuid
            FOR UPDATE OF a
            `,
            [accountId]
        );

        const account = accountResult.rows[0] ?? null;

        if (!account) {
            throw new Error('The requested Agora account does not exist.');
        }

        if (account.account_status !== 'active') {
            throw new Error(
                `The requested Agora account is not active (${account.account_status}).`
            );
        }

        const entitlementResult = await client.query(
            `
            SELECT
                se.original_transaction_id,
                se.environment,
                se.product_id,
                se.status,
                se.is_trial,
                se.auto_renew_enabled,
                se.expires_date,
                se.user_id,
                se.app_account_token,
                tx.transaction_id AS latest_transaction_id,
                tx.transaction_reason AS latest_transaction_reason
            FROM subscription_entitlements se
            LEFT JOIN LATERAL (
                SELECT
                    transaction_id,
                    transaction_reason
                FROM app_store_transactions
                WHERE original_transaction_id = se.original_transaction_id
                  AND environment = se.environment
                ORDER BY
                    signed_date DESC NULLS LAST,
                    purchase_date DESC NULLS LAST,
                    updated_at DESC
                LIMIT 1
            ) tx ON TRUE
            WHERE se.original_transaction_id = $1
              AND se.environment = $2
            FOR UPDATE OF se
            `,
            [originalTransactionId, environment]
        );

        const entitlement = entitlementResult.rows[0] ?? null;

        if (!entitlement) {
            throw new Error(
                'The requested verified subscription entitlement does not exist.'
            );
        }

        const ownershipResult = await client.query(
            `
            SELECT
                account_id,
                ownership_status,
                claim_source,
                claimed_at,
                last_verified_at
            FROM account_subscription_ownership
            WHERE original_transaction_id = $1
              AND environment = $2
            FOR UPDATE
            `,
            [originalTransactionId, environment]
        );

        const existingOwnership = ownershipResult.rows[0] ?? null;

        const accountChainsResult = await client.query(
            `
            SELECT
                original_transaction_id,
                product_id,
                status,
                is_trial,
                auto_renew_enabled,
                has_pro_access,
                recurring_revenue_active,
                canceling,
                identity_source,
                latest_transaction_signed_date
            FROM subscription_admin_customers_v1
            WHERE environment = $1
              AND account_id = $2::uuid
            ORDER BY latest_transaction_signed_date DESC NULLS LAST
            `,
            [environment, accountId]
        );

        console.log('[SubscriptionOwnership] Account:');
        console.table([summarizeAccount(account)]);
        console.log('[SubscriptionOwnership] Target entitlement:');
        console.table([summarizeEntitlement(entitlement)]);
        console.log('[SubscriptionOwnership] Existing ownership:');
        console.table(existingOwnership ? [existingOwnership] : []);
        console.log('[SubscriptionOwnership] Existing chains already linked to account:');
        console.table(accountChainsResult.rows);

        if (existingOwnership) {
            const existingAccountId = String(
                existingOwnership.account_id ?? ''
            ).toLowerCase();

            if (
                existingAccountId === accountId &&
                existingOwnership.ownership_status === 'active'
            ) {
                console.log(
                    '[SubscriptionOwnership] No change needed: this chain is already linked to the requested account.'
                );
                await client.query('ROLLBACK');
                return;
            }

            throw new Error(
                'This subscription chain already has ownership metadata. Refusing to overwrite or transfer it automatically.'
            );
        }

        if (!args.apply) {
            console.log(
                '[SubscriptionOwnership] DRY RUN ONLY. No database changes were made.'
            );
            console.log(
                '[SubscriptionOwnership] Re-run this exact command with --apply after confirming the account and target entitlement are the same customer.'
            );
            await client.query('ROLLBACK');
            return;
        }

        await client.query(
            `
            INSERT INTO account_subscription_ownership (
                original_transaction_id,
                environment,
                account_id,
                ownership_status,
                claim_source,
                claimed_from_installation_id,
                verified_transaction_id,
                observed_app_account_token,
                claimed_at,
                last_verified_at,
                released_at,
                updated_at
            )
            VALUES (
                $1,
                $2,
                $3::uuid,
                'active',
                'manual_support',
                $4,
                $5,
                $6::uuid,
                NOW(),
                NOW(),
                NULL,
                NOW()
            )
            `,
            [
                originalTransactionId,
                environment,
                accountId,
                entitlement.user_id ?? null,
                entitlement.latest_transaction_id ?? null,
                entitlement.app_account_token ?? null,
            ]
        );

        await client.query('COMMIT');

        const [currentStateResult, metricsResult] = await Promise.all([
            pool.query(
                `
                SELECT
                    customer_key,
                    account_id,
                    account_display_name,
                    product_id,
                    status,
                    is_trial,
                    auto_renew_enabled,
                    recurring_revenue_active,
                    trial_active,
                    canceling,
                    original_transaction_id
                FROM subscription_admin_current_customers_v1
                WHERE environment = $1
                  AND account_id = $2::uuid
                `,
                [environment, accountId]
            ),
            pool.query(`
                SELECT *
                FROM subscription_admin_business_metrics_v1;
            `),
        ]);

        console.log('[SubscriptionOwnership] Ownership link applied successfully.');
        console.log('[SubscriptionOwnership] New current customer state:');
        console.table(currentStateResult.rows);
        console.log('[SubscriptionOwnership] Updated dashboard metrics:');
        console.table(metricsResult.rows);
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Ignore rollback errors while surfacing the original failure.
        }

        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(
        '[SubscriptionOwnership] Reconciliation failed:',
        error?.stack || error
    );
    process.exitCode = 1;
});
