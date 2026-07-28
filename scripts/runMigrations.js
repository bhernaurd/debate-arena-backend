// scripts/runMigrations.js
// Explicit PostgreSQL migration runner.
//
// Run manually with:
// npm run migrate
//
// This file is intentionally not imported by server.js.
// Migrations never run automatically during normal backend startup.

import '../env.js';

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationsDirectory = path.resolve(
    __dirname,
    '..',
    'migrations'
);

const migrationFilenamePattern =
    /^(\d{3,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

const advisoryLockName =
    'debate-arena-backend-schema-migrations';

function sha256(buffer) {
    return crypto
        .createHash('sha256')
        .update(buffer)
        .digest('hex');
}

function durationMilliseconds(startedAt) {
    const elapsedNanoseconds =
        process.hrtime.bigint() - startedAt;

    return Math.max(
        0,
        Math.round(Number(elapsedNanoseconds) / 1_000_000)
    );
}

async function loadMigrationFiles() {
    let directoryEntries;

    try {
        directoryEntries = await fs.readdir(
            migrationsDirectory,
            { withFileTypes: true }
        );
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error(
                `Migration directory does not exist: ${migrationsDirectory}`
            );
        }

        throw error;
    }

    const migrations = [];

    for (const entry of directoryEntries) {
        if (!entry.isFile()) {
            continue;
        }

        const match = migrationFilenamePattern.exec(entry.name);

        if (!match) {
            if (entry.name.endsWith('.sql')) {
                throw new Error(
                    `Invalid migration filename: ${entry.name}. ` +
                    'Expected a name such as 001_example_migration.sql.'
                );
            }

            continue;
        }

        const version = Number(match[1]);

        if (!Number.isSafeInteger(version) || version <= 0) {
            throw new Error(
                `Invalid migration version in ${entry.name}.`
            );
        }

        const filepath = path.join(
            migrationsDirectory,
            entry.name
        );

        const fileBuffer = await fs.readFile(filepath);
        const sql = fileBuffer
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .trim();

        if (!sql) {
            throw new Error(
                `Migration file is empty: ${entry.name}`
            );
        }

        migrations.push({
            version,
            filename: entry.name,
            filepath,
            checksum: sha256(fileBuffer),
            sql,
        });
    }

    migrations.sort((left, right) => {
        if (left.version !== right.version) {
            return left.version - right.version;
        }

        return left.filename.localeCompare(right.filename);
    });

    const seenVersions = new Map();

    for (const migration of migrations) {
        const existingFilename =
            seenVersions.get(migration.version);

        if (existingFilename) {
            throw new Error(
                `Duplicate migration version ${migration.version}: ` +
                `${existingFilename} and ${migration.filename}`
            );
        }

        seenVersions.set(
            migration.version,
            migration.filename
        );
    }

    return migrations;
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
        [advisoryLockName]
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
            [advisoryLockName]
        );
    } catch (error) {
        console.error(
            '[Migrations] Failed to release advisory lock:',
            error?.message || error
        );
    }
}

async function loadAppliedMigrations(client) {
    const result = await client.query(`
        SELECT
            version,
            filename,
            checksum_sha256,
            execution_ms,
            applied_at
        FROM schema_migrations
        ORDER BY version ASC
    `);

    return new Map(
        result.rows.map((row) => [
            Number(row.version),
            row,
        ])
    );
}

function validateMigrationHistory(
    migrationFiles,
    appliedMigrations
) {
    const filesByVersion = new Map(
        migrationFiles.map((migration) => [
            migration.version,
            migration,
        ])
    );

    for (const [version, applied] of appliedMigrations) {
        const migrationFile = filesByVersion.get(version);

        if (!migrationFile) {
            throw new Error(
                `Applied migration ${version} is missing from the repository: ` +
                `${applied.filename}`
            );
        }

        if (migrationFile.filename !== applied.filename) {
            throw new Error(
                `Migration ${version} filename changed after being applied. ` +
                `Database: ${applied.filename}. ` +
                `Repository: ${migrationFile.filename}.`
            );
        }

        if (
            migrationFile.checksum !==
            applied.checksum_sha256
        ) {
            throw new Error(
                `Migration ${migrationFile.filename} was modified after being applied. ` +
                'Create a new migration instead of editing an applied migration.'
            );
        }
    }
}

async function applyMigration(client, migration) {
    const startedAt = process.hrtime.bigint();

    console.log(
        `[Migrations] Applying ${migration.filename}...`
    );

    try {
        await client.query('BEGIN');

        await client.query(migration.sql);

        const executionMs =
            durationMilliseconds(startedAt);

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
                migration.version,
                migration.filename,
                migration.checksum,
                executionMs,
            ]
        );

        await client.query('COMMIT');

        console.log(
            `[Migrations] Applied ${migration.filename} ` +
            `in ${executionMs} ms.`
        );
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error(
                '[Migrations] Rollback failed:',
                rollbackError?.message || rollbackError
            );
        }

        throw new Error(
            `Migration failed: ${migration.filename}\n` +
            `${error?.message || error}`,
            { cause: error }
        );
    }
}

async function runMigrations() {
    const connectionString =
        process.env.DATABASE_URL?.trim();

    if (!connectionString) {
        throw new Error(
            'DATABASE_URL is required to run migrations.'
        );
    }

    const migrationFiles =
        await loadMigrationFiles();

    if (migrationFiles.length === 0) {
        console.log(
            '[Migrations] No migration files found.'
        );
        return;
    }

    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 1,
    });

    pool.on('error', (error) => {
        console.error(
            '[Migrations] PostgreSQL pool error:',
            error?.message || error
        );
    });

    const client = await pool.connect();
    let lockAcquired = false;

    try {
        await acquireMigrationLock(client);
        lockAcquired = true;

        await ensureMigrationTable(client);

        const appliedMigrations =
            await loadAppliedMigrations(client);

        validateMigrationHistory(
            migrationFiles,
            appliedMigrations
        );

        let appliedCount = 0;

        for (const migration of migrationFiles) {
            if (appliedMigrations.has(migration.version)) {
                console.log(
                    `[Migrations] Already applied: ${migration.filename}`
                );
                continue;
            }

            await applyMigration(client, migration);
            appliedCount += 1;
        }

        if (appliedCount === 0) {
            console.log(
                '[Migrations] Database is already up to date.'
            );
        } else {
            console.log(
                `[Migrations] Completed. Applied ${appliedCount} migration(s).`
            );
        }
    } finally {
        if (lockAcquired) {
            await releaseMigrationLock(client);
        }

        client.release();
        await pool.end();
    }
}

runMigrations().catch((error) => {
    console.error(
        '[Migrations] Failed:',
        error?.stack || error
    );

    process.exitCode = 1;
});
