// env.js must be first so Railway variables are available before configuration.
import '../env.js';

import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function assertCondition(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function normalizeBaseUrl(value) {
    const cleaned = String(value ?? '').trim().replace(/\/+$/, '');

    if (!cleaned) {
        throw new Error('The account-auth smoke-test base URL is empty.');
    }

    let url;

    try {
        url = new URL(cleaned);
    } catch {
        throw new Error(
            'ACCOUNT_AUTH_SMOKE_BASE_URL must be a valid HTTP or HTTPS URL.'
        );
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error(
            'ACCOUNT_AUTH_SMOKE_BASE_URL must use HTTP or HTTPS.'
        );
    }

    return cleaned;
}

function resolveBaseUrl() {
    if (process.env.ACCOUNT_AUTH_SMOKE_BASE_URL) {
        return normalizeBaseUrl(
            process.env.ACCOUNT_AUTH_SMOKE_BASE_URL
        );
    }

    const port = String(process.env.PORT || '3000').trim();

    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) {
        throw new Error('PORT must be a valid TCP port.');
    }

    return `http://127.0.0.1:${port}`;
}

async function readJson(response) {
    const text = await response.text();

    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(
            `Account-auth endpoint returned invalid JSON with HTTP ${response.status}.`
        );
    }
}

function sha256(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the live smoke test.');
}

const baseUrl = resolveBaseUrl();
const installationId = [
    'account-auth-smoke',
    Date.now(),
    crypto.randomBytes(6).toString('hex'),
].join('-');

const pool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

let challengeId = null;

try {
    const response = await fetch(
        `${baseUrl}/api/account/apple/challenge`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Installation-ID': installationId,
                'X-iOS-Version': '3.8',
                'X-iOS-Build': '1',
                'User-Agent': 'TheAgoraAccountAuthSmokeTest/1.0',
            },
            body: '{}',
            signal: AbortSignal.timeout(10_000),
        }
    );

    const body = await readJson(response);

    assertCondition(
        response.status === 201,
        `Expected HTTP 201 from the challenge endpoint, received ${response.status}: ${JSON.stringify(body)}`
    );
    assertCondition(
        response.headers.get('cache-control')?.includes('no-store'),
        'Challenge response must include Cache-Control: no-store.'
    );
    assertCondition(
        response.headers.get('pragma') === 'no-cache',
        'Challenge response must include Pragma: no-cache.'
    );
    assertCondition(
        body && typeof body === 'object' && !Array.isArray(body),
        'Challenge response must be a JSON object.'
    );
    assertCondition(
        UUID_RE.test(body.challengeId),
        'Challenge response contains an invalid challengeId.'
    );
    assertCondition(
        body.purpose === 'sign_in_with_apple',
        'Challenge response contains an unexpected purpose.'
    );
    assertCondition(
        typeof body.rawNonce === 'string' &&
            body.rawNonce.length >= 40 &&
            body.rawNonce.length <= 128 &&
            BASE64URL_RE.test(body.rawNonce),
        'Challenge response contains an invalid rawNonce.'
    );
    assertCondition(
        typeof body.nonceSha256 === 'string' &&
            SHA256_HEX_RE.test(body.nonceSha256),
        'Challenge response contains an invalid nonceSha256.'
    );
    assertCondition(
        sha256(body.rawNonce) === body.nonceSha256,
        'Challenge nonce hash does not match the returned raw nonce.'
    );

    const expiresAt = new Date(body.expiresAt);
    const now = Date.now();

    assertCondition(
        !Number.isNaN(expiresAt.getTime()),
        'Challenge response contains an invalid expiresAt value.'
    );
    assertCondition(
        expiresAt.getTime() > now,
        'Challenge must expire in the future.'
    );
    assertCondition(
        expiresAt.getTime() <= now + 15 * 60 * 1000 + 5_000,
        'Challenge lifetime exceeds the configured maximum.'
    );

    challengeId = body.challengeId;

    console.log('✓ live account-auth challenge endpoint returned HTTP 201');
    console.log('✓ response disables caching and exposes no credentials');
    console.log('✓ raw nonce and SHA-256 nonce binding are valid');

    const result = await pool.query(
        `
            SELECT
                id,
                installation_id,
                purpose,
                nonce_sha256,
                expires_at,
                consumed_at,
                failed_attempts
            FROM account_auth_challenges
            WHERE id = $1
        `,
        [challengeId]
    );

    assertCondition(
        result.rowCount === 1,
        'The challenge was not persisted in PostgreSQL.'
    );

    const row = result.rows[0];

    assertCondition(
        row.installation_id === installationId,
        'Persisted challenge installation does not match the request.'
    );
    assertCondition(
        row.purpose === 'sign_in_with_apple',
        'Persisted challenge purpose is invalid.'
    );
    assertCondition(
        row.nonce_sha256 === body.nonceSha256,
        'Persisted challenge nonce hash does not match the response.'
    );
    assertCondition(
        row.consumed_at === null,
        'A newly created challenge must not already be consumed.'
    );
    assertCondition(
        Number(row.failed_attempts) === 0,
        'A newly created challenge must have zero failed attempts.'
    );

    console.log('✓ challenge was persisted with the exact installation and nonce');
    console.log('✓ no Apple authorization code or Apple token was requested');
} catch (error) {
    if (error?.name === 'TimeoutError') {
        throw new Error(
            `Timed out connecting to ${baseUrl}. Confirm the deployed server is listening or set ACCOUNT_AUTH_SMOKE_BASE_URL.`
        );
    }

    throw error;
} finally {
    try {
        await pool.query(
            `
                DELETE FROM account_auth_challenges
                WHERE installation_id = $1
            `,
            [installationId]
        );

        if (challengeId) {
            const remaining = await pool.query(
                `
                    SELECT 1
                    FROM account_auth_challenges
                    WHERE id = $1
                `,
                [challengeId]
            );

            assertCondition(
                remaining.rowCount === 0,
                'Smoke-test challenge cleanup did not complete.'
            );
        }

        console.log('✓ smoke-test challenge was removed from PostgreSQL');
    } finally {
        await pool.end();
    }
}

console.log('All live account-auth server smoke checks passed.');
