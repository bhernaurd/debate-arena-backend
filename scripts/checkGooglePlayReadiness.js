import '../env.js';

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

import {
    googlePlayProductionBypassChecks,
} from '../lib/googlePlayReleasePolicy.js';

const { Pool } = pg;
const EXPECTED_PACKAGE_NAME = 'com.bhernaurd.theagora';
const REQUIRED_MIGRATIONS = Object.freeze([
    Object.freeze({
        version: 33,
        filename: '033_google_play_subscription_entitlements.sql',
    }),
    Object.freeze({
        version: 34,
        filename: '034_google_play_rtdn_messages.sql',
    }),
    Object.freeze({
        version: 35,
        filename: '035_ai_content_reports.sql',
    }),
    Object.freeze({
        version: 36,
        filename: '036_account_manual_pro_grants.sql',
    }),
]);

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
            migration034Applied: false,
            migration035Applied: false,
            migration036Applied: false,
            entitlementTableReady: false,
            rtdnMessageTableReady: false,
            aiContentReportTableReady: false,
            manualProGrantTableReady: false,
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
                ) AS has_account_binding_column,
                to_regclass('public.google_play_rtdn_messages') IS NOT NULL
                    AS has_rtdn_message_table,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'google_play_rtdn_messages'
                      AND column_name = 'message_id'
                ) AS has_rtdn_message_id_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'google_play_rtdn_messages'
                      AND column_name = 'purchase_token_sha256'
                ) AS has_rtdn_token_hash_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'google_play_rtdn_messages'
                      AND column_name = 'status'
                ) AS has_rtdn_status_column,
                to_regclass('public.ai_content_reports') IS NOT NULL
                    AS has_ai_content_report_table,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'ai_content_reports'
                      AND column_name = 'response_text'
                ) AS has_ai_report_response_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'ai_content_reports'
                      AND column_name = 'response_truncated'
                ) AS has_ai_report_truncated_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'ai_content_reports'
                      AND column_name = 'reason'
                ) AS has_ai_report_reason_column,
                to_regclass('public.account_manual_pro_grants') IS NOT NULL
                    AS has_manual_pro_grant_table,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'account_manual_pro_grants'
                      AND column_name = 'account_id'
                ) AS has_manual_grant_account_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'account_manual_pro_grants'
                      AND column_name = 'reason'
                ) AS has_manual_grant_reason_column,
                EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = 'account_manual_pro_grants'
                      AND column_name = 'revoked_at'
                ) AS has_manual_grant_revocation_column
            `
        );

        const schema = result.rows[0] || {};
        const appliedMigrations = new Map();

        if (schema.has_migration_table) {
            const migrationResult = await pool.query(
                `
                SELECT version, filename
                FROM schema_migrations
                WHERE version = ANY($1::integer[])
                `,
                [REQUIRED_MIGRATIONS.map((migration) => migration.version)]
            );
            for (const row of migrationResult.rows || []) {
                appliedMigrations.set(Number(row.version), String(row.filename || ''));
            }
        }

        const migrationApplied = (migration) =>
            appliedMigrations.get(migration.version) === migration.filename;

        return Object.freeze({
            configured: true,
            reachable: true,
            migration033Applied: migrationApplied(REQUIRED_MIGRATIONS[0]),
            migration034Applied: migrationApplied(REQUIRED_MIGRATIONS[1]),
            migration035Applied: migrationApplied(REQUIRED_MIGRATIONS[2]),
            migration036Applied: migrationApplied(REQUIRED_MIGRATIONS[3]),
            entitlementTableReady: Boolean(
                schema.has_entitlement_table &&
                schema.has_token_hash_column &&
                schema.has_account_binding_column
            ),
            rtdnMessageTableReady: Boolean(
                schema.has_rtdn_message_table &&
                schema.has_rtdn_message_id_column &&
                schema.has_rtdn_token_hash_column &&
                schema.has_rtdn_status_column
            ),
            aiContentReportTableReady: Boolean(
                schema.has_ai_content_report_table &&
                schema.has_ai_report_response_column &&
                schema.has_ai_report_truncated_column &&
                schema.has_ai_report_reason_column
            ),
            manualProGrantTableReady: Boolean(
                schema.has_manual_pro_grant_table &&
                schema.has_manual_grant_account_column &&
                schema.has_manual_grant_reason_column &&
                schema.has_manual_grant_revocation_column
            ),
            reason: null,
        });
    } catch (error) {
        return Object.freeze({
            configured: true,
            reachable: false,
            migration033Applied: false,
            migration034Applied: false,
            migration035Applied: false,
            migration036Applied: false,
            entitlementTableReady: false,
            rtdnMessageTableReady: false,
            aiContentReportTableReady: false,
            manualProGrantTableReady: false,
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
    const productionBypassChecks =
        googlePlayProductionBypassChecks(
            process.env
        );

    const database = await databaseStatus(process.env.DATABASE_URL);
    const privacyPolicyResource = await fileExists('public/privacy-policy/index.html');
    const accountDeletionResource = await fileExists('public/account-deletion/index.html');
    const aiContentReportRoute = await fileExists('aiContentReportRoutes.js');
    const aiContentReportService = await fileExists('lib/aiContentReportService.js');
    const manualProGrantCli = await fileExists('scripts/manageManualProGrant.js');
    const aiSafetyPolicy = await fileExists('lib/aiSafetyPolicy.js');
    const rankedAiSafetyWrapper = await fileExists('lib/rankedDebateEngineService.js');
    const rankedAiCore = await fileExists('lib/rankedDebateEngineCoreService.js');

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
        migration034Applied: database.migration034Applied,
        migration035Applied: database.migration035Applied,
        migration036Applied: database.migration036Applied,
        entitlementTableReady: database.entitlementTableReady,
        rtdnMessageTableReady: database.rtdnMessageTableReady,
        aiContentReportTableReady: database.aiContentReportTableReady,
        manualProGrantTableReady: database.manualProGrantTableReady,
        aiContentReportRoute,
        aiContentReportService,
        manualProGrantCli,
        aiSafetyPolicy,
        rankedAiSafetyWrapper,
        rankedAiCore,
        ...productionBypassChecks,
        privacyPolicyResource,
        accountDeletionResource,
    });

    const ready = Object.values(checks).every(Boolean);

    // Deliberately report only presence/state. Never print service-account JSON,
    // private keys, OAuth tokens, purchase tokens, DATABASE_URL, RTDN bearer data,
    // AI report bodies, reported response text, or reviewer Google credentials.
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
