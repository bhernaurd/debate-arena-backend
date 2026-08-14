// scripts/runAffiliateMigration.js
// Applies ONLY migration 018_affiliate_program.sql.
//
// This exists because production currently has older pending migrations
// (016/017) that are unrelated to the affiliate program. Running the normal
// `npm run migrate` command would attempt those first.
//
// Run manually from the backend service shell with:
//   node scripts/runAffiliateMigration.js

import '../env.js';

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_VERSION = 18;
const MIGRATION_FILENAME = '018_affiliate_program.sql';
const MIGRATION_PATH = path.resolve(
    __dirname,
    '..',
    'migrations',
    MIGRATION_FILENAME
);

// Use the same lock as the normal migration runner so the two can never run
// against the schema concurrently.
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
            '[Affiliate Migration] Failed to release advisory lock:',
            error?.message || error
        );
    }
}

async function run() {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (!connectionString) {
        throw new Error(
            'DATABASE_URL is required to run the affiliate migration.'
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
            '[Affiliate Migration] PostgreSQL pool error:',
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
                `[Affiliate Migration] Already applied: ${MIGRATION_FILENAME}`
            );
            return;
        }

        console.log(
            '[Affiliate Migration] Applying ONLY 018_affiliate_program.sql. ' +
            'Pending migrations 016/017 will not be touched.'
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
                `[Affiliate Migration] Applied ${MIGRATION_FILENAME} ` +
                `in ${executionMs} ms.`
            );
            console.log(
                '[Affiliate Migration] Success. No other migration was applied.'
            );
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error(
                    '[Affiliate Migration] Rollback failed:',
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
        '[Affiliate Migration] Failed:',
        error?.stack || error
    );

    process.exitCode = 1;
});
