import '../env.js';

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const EXPECTED_PACKAGE_NAME = 'com.bhernaurd.theagora';
const REQUIRED_MIGRATION_VERSION = 33;
const REQUIRED_MIGRATION_FILENAME = '033_google_play_subscription_entitlements.sql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repositoryRoot = path.resolve(__dirname, '..');

function present(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function parseServiceAccountJson(rawValue) {
    if (!present(rawValue)) return null;
    const raw = rawValue.trim();
    const candidates = [raw];

    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded && decoded !== raw) candidates.push(decoded);
    } catch {}

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {}
    }

    return null;
}

function serviceAccountStatus({ jsonVariable, emailVariable, privateKeyVariable }) {
    const parsed = parseServiceAccountJson(process.env[jsonVariable]);
    const jsonReady = Boolean(
        parsed &&
        present(parsed.client_email) &&
        present(parsed.private_key)
    );
    const splitReady = Boolean(
        present(process.env[emailVariable]) &&
        present(process.env[privateKeyVariable])
    );

    return Object.freeze({
        configured: jsonReady || splitReady,
        source: jsonReady ? 'json' : splitReady ? 'split_env' : 'missing',
    });
}

async function fileExists(relativePath) {
    try {
        const stat = await fs.stat(path.join(repositoryRoot, relativePath));
        return stat.isFile();
    } catch {
        return false;
    }
}

async function databaseStatus(connectionString) {
    if (!present(connectionString)) {
        return Object.freeze({
            configured: false,
            reachable: false,
            migration033Applied: false,
            entitlementTableReady: false,
            reason: 'DATABASE_URL is missing',
        });
    }

    const pool = new Pool({
        connectionString: connectionString.trim(),
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 1,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 5_000,
    });

    try {
        const result = await pool.query(
            `
            SELECT
                EXISTS (
                    SELECT 1
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_name = 'schema_migrations'
                ) AS has_migration_table,
                to_regclass('public.google_play_subscription_entitlements') IS NOT NULL
                    AS has_entitlement_table,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'google_play_subscription_entitlements'
                      AND column_name = 'purchase_token_sha256'
                ) AS has_token_hash_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'google_play_subscription_entitlements'
                      AND column_name = 'obfuscated_external_account_id'
                ) AS has_account_binding_column
            `
        );

        const schema = result.rows[0] || {};
        let migration033Applied = false;

        if (schema.has_migration_table) {
            const migration = await pool.query(
                `
                SELECT EXISTS (
                    SELECT 1
                    FROM schema_migrations
                    WHERE version = $1
                      AND filename = $2
                ) AS applied
                `,
                [REQUIRED_MIGRATION_VERSION, REQUIRED_MIGRATION_FILENAME]
            );
            migration033Applied = migration.rows[0]?.applied === true;
        }

        return Object.freeze({
            configured: true,
            reachable: true,
            migration033Applied,
            entitlementTableReady: Boolean(
                schema.has_entitlement_table &&
                schema.has_token_hash_column &&
                schema.has_account_binding_column
            ),
            reason: null,
        });
    } catch (error) {
        return Object.freeze({
            configured: true,
            reachable: false,
            migration033Applied: false,
            entitlementTableReady: false,
            reason: error?.code || 'database_check_failed',
        });
    } finally {
        await pool.end();
    }
}

async function main() {
    const packageName =
        process.env.GOOGLE_PLAY_PACKAGE_NAME?.trim() || EXPECTED_PACKAGE_NAME;
    const googlePlayServiceAccount = serviceAccountStatus({
        jsonVariable: 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
        emailVariable: 'GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL',
        privateKeyVariable: 'GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY',
    });
    const firebaseServiceAccount = serviceAccountStatus({
        jsonVariable: present(process.env.FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON)
            ? 'FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON'
            : 'FIREBASE_SERVICE_ACCOUNT_JSON',
        emailVariable: 'FIREBASE_SERVICE_ACCOUNT_EMAIL',
        privateKeyVariable: 'FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY',
    });

    const database = await databaseStatus(process.env.DATABASE_URL);
    const privacyPolicyResource = await fileExists('public/privacy-policy/index.html');
    const accountDeletionResource = await fileExists('public/account-deletion/index.html');

    const checks = Object.freeze({
        packageNameMatches: packageName === EXPECTED_PACKAGE_NAME,
        googlePlayPublisherConfigured: googlePlayServiceAccount.configured,
        rtdnAudienceConfigured: present(process.env.GOOGLE_PLAY_RTDN_AUDIENCE),
        rtdnPushIdentityConfigured: present(
            process.env.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL
        ),
        firebaseMessagingConfigured: Boolean(
            firebaseServiceAccount.configured &&
            (present(process.env.FIREBASE_PROJECT_ID) ||
                present(parseServiceAccountJson(
                    process.env.FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON ||
                    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
                )?.project_id))
        ),
        databaseReachable: database.reachable,
        migration033Applied: database.migration033Applied,
        entitlementTableReady: database.entitlementTableReady,
        privacyPolicyResource,
        accountDeletionResource,
    });

    const ready = Object.values(checks).every(Boolean);

    // Deliberately report only presence/state. Never print service-account JSON,
    // private keys, OAuth tokens, purchase tokens, DATABASE_URL, or RTDN bearer data.
    console.log('[GooglePlayReadiness]', {
        ready,
        packageName,
        googlePlayCredentialSource: googlePlayServiceAccount.source,
        firebaseCredentialSource: firebaseServiceAccount.source,
        checks,
        databaseReason: database.reason,
    });

    if (!ready) process.exitCode = 1;
}

main().catch((error) => {
    console.error(
        '[GooglePlayReadiness] Check failed:',
        error?.code || error?.name || 'unknown_error'
    );
    process.exitCode = 1;
});
