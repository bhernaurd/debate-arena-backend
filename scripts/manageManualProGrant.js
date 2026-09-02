import '../env.js';

import pg from 'pg';

const { Pool } = pg;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_REASONS = new Set([
    'play_review',
    'support',
    'internal',
]);

function fail(message) {
    throw new Error(message);
}

function argValue(name) {
    const args = process.argv.slice(3);
    const index = args.indexOf(name);
    if (index < 0) return null;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
        fail(`${name} requires a value.`);
    }
    return value.trim();
}

function normalizeEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (
        email.length < 3 ||
        email.length > 320 ||
        !email.includes('@')
    ) {
        fail('--google-email is invalid.');
    }
    return email;
}

function normalizeAccountId(value) {
    const accountId = String(value || '').trim().toLowerCase();
    if (!UUID_RE.test(accountId)) {
        fail('--account-id must be an Agora account UUID.');
    }
    return accountId;
}

async function resolveAccountId(client) {
    const rawAccountId = argValue('--account-id');
    const rawEmail = argValue('--google-email');

    if (Boolean(rawAccountId) === Boolean(rawEmail)) {
        fail('Provide exactly one of --account-id or --google-email.');
    }

    if (rawAccountId) {
        const accountId = normalizeAccountId(rawAccountId);
        const result = await client.query(
            `
            SELECT id
            FROM accounts
            WHERE id = $1
              AND status = 'active'
            LIMIT 1
            `,
            [accountId]
        );
        if (!result.rows[0]) {
            fail('No active Agora account matched --account-id.');
        }
        return accountId;
    }

    const email = normalizeEmail(rawEmail);
    const result = await client.query(
        `
        SELECT DISTINCT identity.account_id
        FROM account_google_identities AS identity
        INNER JOIN accounts AS account
            ON account.id = identity.account_id
        WHERE LOWER(identity.email) = $1
          AND identity.email_verified = TRUE
          AND account.status = 'active'
        ORDER BY identity.account_id
        `,
        [email]
    );

    if (result.rows.length === 0) {
        fail('No active verified Google Agora account matched --google-email. Sign in once first.');
    }
    if (result.rows.length > 1) {
        fail('More than one Agora account matched that Google email. Use --account-id instead.');
    }

    return String(result.rows[0].account_id).toLowerCase();
}

async function grant(client, accountId) {
    const reason = String(argValue('--reason') || 'play_review').trim();
    if (!ALLOWED_REASONS.has(reason)) {
        fail('--reason must be play_review, support, or internal.');
    }

    const result = await client.query(
        `
        INSERT INTO account_manual_pro_grants (
            account_id,
            reason
        )
        VALUES ($1, $2)
        ON CONFLICT (account_id)
            WHERE revoked_at IS NULL
        DO UPDATE SET
            reason = EXCLUDED.reason,
            updated_at = NOW()
        RETURNING id, account_id, reason, granted_at
        `,
        [accountId, reason]
    );

    return {
        changed: result.rowCount === 1,
        reason: result.rows[0]?.reason || reason,
    };
}

async function revoke(client, accountId) {
    const result = await client.query(
        `
        UPDATE account_manual_pro_grants
        SET
            revoked_at = NOW(),
            updated_at = NOW()
        WHERE account_id = $1
          AND revoked_at IS NULL
        RETURNING id
        `,
        [accountId]
    );

    return {
        changed: result.rowCount > 0,
        reason: null,
    };
}

async function main() {
    const action = String(process.argv[2] || '').trim().toLowerCase();
    if (!['grant', 'revoke'].includes(action)) {
        fail('Usage: manageManualProGrant.js <grant|revoke> (--account-id UUID | --google-email EMAIL) [--reason play_review|support|internal]');
    }

    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        fail('DATABASE_URL is required.');
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
        const accountId = await resolveAccountId(client);
        const result = action === 'grant'
            ? await grant(client, accountId)
            : await revoke(client, accountId);
        await client.query('COMMIT');

        // Deliberately omit Google email, DATABASE_URL, access tokens, and any
        // authentication credentials from command output.
        console.log('[ManualProGrant]', {
            action,
            accountId,
            changed: result.changed,
            reason: result.reason,
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error(
        '[ManualProGrant] Failed:',
        error?.message || 'unknown_error'
    );
    process.exitCode = 1;
});
