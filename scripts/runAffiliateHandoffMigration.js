// scripts/runAffiliateHandoffMigration.js
// Applies ONLY migration 023_affiliate_referral_handoffs.sql.
//
// IMPORTANT:
// Production intentionally has older unrelated pending migrations in this repo.
// Do NOT use `npm run migrate` for this rollout. This runner acquires the same
// advisory lock as the normal runner, validates the affiliate schema that 023
// depends on, and applies only migration 023.
//
// Run from the backend service shell with:
//   npm run affiliate:handoff-migrate

import '../env.js';

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_VERSION = 23;
const MIGRATION_FILENAME = '023_affiliate_referral_handoffs.sql';
const MIGRATION_PATH = path.resolve(
    __dirname,
    '..',
    'migrations',
    MIGRATION_FILENAME
);

const ADVISORY_LOCK_NAME = 'debate-arena-backend-schema-migrations';

function sha256(buffer) {
    return crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
}

function durationMilliseconds(startedAt) {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    return Math.max(
        0,
        Math.round(Number(elapsedNanoseconds) / 1_000_000)
    );
}

async function ensureMigrationTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            filename TEXT NOT NULL UNIQUE,
            checksum_sha256 TEXT NOT NULL,
            execution_ms INTEGER NOT NULL
                CHECK (execution_ms >= 0),
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

async function acquireMigrationLock(client) {
    const result = await client.query(
        `
        SELECT pg_try_advisory_lock(
            hashtext($1)
        ) AS acquired
        `,
        [ADVISORY_LOCK_NAME]
    );

    if (result.rows[0]?.acquired !== true) {
        throw new Error(
            'Another migration process currently holds the database migration lock.'
        );
    }
}

async function releaseMigrationLock(client) {
    try {
        await client.query(
            `
            SELECT pg_advisory_unlock(
                hashtext($1)
            )
            `,
            [ADVISORY_LOCK_NAME]
        );
    } catch (error) {
        console.error(
            '[Affiliate Handoff Migration] Failed to release advisory lock:',
            error?.message || error
        );
    }
}

async function requirePrerequisiteSchema(client) {
    const tableResult = await client.query(`
        SELECT
            to_regclass('public.affiliates') IS NOT NULL AS has_affiliates,
            to_regclass('public.affiliate_referral_clicks') IS NOT NULL AS has_referral_clicks,
            to_regclass('public.affiliate_subscription_attributions') IS NOT NULL AS has_attributions,
            to_regclass('public.affiliate_account_referrals') IS NOT NULL AS has_account_referrals
    `);

    const tables = tableResult.rows[0] || {};
    const missingTables = [
        ['affiliates', tables.has_affiliates],
        ['affiliate_referral_clicks', tables.has_referral_clicks],
        ['affiliate_subscription_attributions', tables.has_attributions],
        ['affiliate_account_referrals', tables.has_account_referrals],
    ]
        .filter(([, exists]) => exists !== true)
        .map(([name]) => name);

    if (missingTables.length > 0) {
        throw new Error(
            'Migration 023 prerequisites are missing: ' +
            missingTables.join(', ') +
            '. Apply the already-approved affiliate migrations through 022 first. ' +
            'This dedicated runner will not apply older migrations automatically.'
        );
    }

    const columnResult = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'affiliate_subscription_attributions'
          AND column_name IN (
              'account_id',
              'creator_code',
              'normalized_creator_code',
              'attribution_source',
              'offer_type'
          )
    `);

    const columns = new Set(
        columnResult.rows.map((row) => row.column_name)
    );
    const requiredColumns = [
        'account_id',
        'creator_code',
        'normalized_creator_code',
        'attribution_source',
        'offer_type',
    ];
    const missingColumns = requiredColumns.filter(
        (column) => !columns.has(column)
    );

    if (missingColumns.length > 0) {
        throw new Error(
            'Migration 023 prerequisites are incomplete. ' +
            'affiliate_subscription_attributions is missing: ' +
            missingColumns.join(', ') +
            '. Apply the already-approved affiliate migrations through 022 first.'
        );
    }
}

async function run() {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (!connectionString) {
        throw new Error(
            'DATABASE_URL is required to run the affiliate handoff migration.'
        );
    }

    const fileBuffer = await fs.readFile(MIGRATION_PATH);
    const sql = fileBuffer
        .toString('utf8')
        .replace(/^\uFEFF/, '')
        .trim();

    if (!sql) {
        throw new Error(`${MIGRATION_FILENAME} is empty.`);
    }

    const checksum = sha256(fileBuffer);

    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 1,
    });

    pool.on('error', (error) => {
        console.error(
            '[Affiliate Handoff Migration] PostgreSQL pool error:',
            error?.message || error
        );
    });

    const client = await pool.connect();
    let lockAcquired = false;

    try {
        await acquireMigrationLock(client);
        lockAcquired = true;

        await ensureMigrationTable(client);

        const existingResult = await client.query(
            `
            SELECT
                version,
                filename,
                checksum_sha256,
                applied_at
            FROM schema_migrations
            WHERE version = $1
               OR filename = $2
            ORDER BY version ASC
            `,
            [MIGRATION_VERSION, MIGRATION_FILENAME]
        );

        if (existingResult.rowCount > 0) {
            const exact = existingResult.rows.find(
                (row) =>
                    Number(row.version) === MIGRATION_VERSION &&
                    row.filename === MIGRATION_FILENAME
            );

            if (!exact || existingResult.rowCount !== 1) {
                throw new Error(
                    `Migration version ${MIGRATION_VERSION} or filename ` +
                    `${MIGRATION_FILENAME} is already used by a different migration.`
                );
            }

            if (exact.checksum_sha256 !== checksum) {
                throw new Error(
                    `${MIGRATION_FILENAME} was already applied with a different checksum. ` +
                    'Do not modify an applied production migration.'
                );
            }

            console.log(
                `[Affiliate Handoff Migration] Already applied: ${MIGRATION_FILENAME}`
            );
            return;
        }

        // If the table exists without a migration ledger entry, stop rather
        // than guessing whether a manual/partial application is safe.
        const handoffTableResult = await client.query(`
            SELECT to_regclass('public.affiliate_referral_handoffs') AS table_name
        `);
        if (handoffTableResult.rows[0]?.table_name) {
            throw new Error(
                'affiliate_referral_handoffs already exists but migration 023 is not recorded. ' +
                'Stop and reconcile the production migration ledger before continuing.'
            );
        }

        await requirePrerequisiteSchema(client);

        console.log(
            '[Affiliate Handoff Migration] Applying ONLY ' +
            `${MIGRATION_FILENAME}. Unrelated pending migrations will not be touched.`
        );

        const startedAt = process.hrtime.bigint();

        try {
            await client.query('BEGIN');
            await client.query(sql);

            const executionMs = durationMilliseconds(startedAt);

            await client.query(
                `
                INSERT INTO schema_migrations (
                    version,
                    filename,
                    checksum_sha256,
                    execution_ms
                )
                VALUES ($1, $2, $3, $4)
                `,
                [
                    MIGRATION_VERSION,
                    MIGRATION_FILENAME,
                    checksum,
                    executionMs,
                ]
            );

            await client.query('COMMIT');

            console.log(
                `[Affiliate Handoff Migration] Applied ${MIGRATION_FILENAME} ` +
                `in ${executionMs} ms.`
            );
            console.log(
                '[Affiliate Handoff Migration] Success. No other migration was applied.'
            );
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error(
                    '[Affiliate Handoff Migration] Rollback failed:',
                    rollbackError?.message || rollbackError
                );
            }

            throw error;
        }
    } finally {
        if (lockAcquired) {
            await releaseMigrationLock(client);
        }

        client.release();
        await pool.end();
    }
}

run().catch((error) => {
    console.error(
        '[Affiliate Handoff Migration] Failed:',
        error?.message || error
    );
    process.exitCode = 1;
});
