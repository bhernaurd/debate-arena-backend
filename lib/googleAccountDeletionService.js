import crypto from 'node:crypto';

import {
    GoogleSignInError,
    createGoogleIdTokenVerifier,
} from './googleSignIn.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CHALLENGE_FAILURES = 20;
const CANONICAL_GOOGLE_ISSUER = 'https://accounts.google.com';
const ACCOUNT_DELETION_REASON = 'account_deletion';

export class GoogleAccountDeletionError extends Error {
    constructor(code, message, {
        status = 500,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GoogleAccountDeletionError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GoogleAccountDeletionError(code, message, options);
}

function requireString(value, name, maxLength) {
    if (typeof value !== 'string') {
        fail('invalid_input', `${name} must be a string.`, { status: 400 });
    }
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maxLength) {
        fail('invalid_input', `${name} is invalid.`, { status: 400 });
    }
    return cleaned;
}

function requireUuid(value, name) {
    const cleaned = requireString(value, name, 64);
    if (!UUID_RE.test(cleaned)) {
        fail('invalid_input', `${name} must be a UUID.`, { status: 400 });
    }
    return cleaned.toLowerCase();
}

function requireInstallationId(value) {
    const cleaned = requireString(value, 'installationId', 128);
    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail('invalid_input', 'installationId has an invalid format.', { status: 400 });
    }
    return cleaned;
}

function nowDate(now) {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) {
        fail('invalid_configuration', 'now() returned an invalid value.', { status: 500 });
    }
    return new Date(value);
}

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function constantTimeStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function constantTimeHexEqual(left, right) {
    if (!/^[0-9a-f]{64}$/.test(String(left || '')) || !/^[0-9a-f]{64}$/.test(String(right || ''))) {
        return false;
    }
    return crypto.timingSafeEqual(
        Buffer.from(left, 'hex'),
        Buffer.from(right, 'hex')
    );
}

function mapGoogleFailure(error) {
    if (!(error instanceof GoogleSignInError)) return error;
    if (error.status >= 500 || error.retryable) {
        return new GoogleAccountDeletionError(
            'google_authentication_unavailable',
            'Google authentication is temporarily unavailable.',
            { status: 503, retryable: true, cause: error }
        );
    }
    return new GoogleAccountDeletionError(
        'invalid_google_credential',
        'The Google sign-in credential could not be verified.',
        { status: 401, retryable: false, cause: error }
    );
}

async function withTransaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original failure.
        }
        throw error;
    } finally {
        client.release();
    }
}

function normalizeChallenge(row) {
    if (!row) return null;
    return {
        id: String(row.id),
        installationId: String(row.installation_id),
        accountId: row.account_id ? String(row.account_id).toLowerCase() : null,
        purpose: String(row.purpose),
        nonceSha256: String(row.nonce_sha256),
        expiresAt: new Date(row.expires_at),
        consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
        failedAttempts: Number(row.failed_attempts || 0),
    };
}

export function createGoogleAccountDeletionService({
    pool,
    verifyGoogleIdToken = null,
    googleClientId = process.env.GOOGLE_ANDROID_WEB_CLIENT_ID ?? '',
    now = () => Date.now(),
} = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        fail('invalid_configuration', 'A PostgreSQL pool is required.', { status: 500 });
    }
    if (typeof now !== 'function') {
        fail('invalid_configuration', 'now must be a function.', { status: 500 });
    }

    const verify = verifyGoogleIdToken ?? createGoogleIdTokenVerifier({
        clientId: googleClientId,
        now,
    });

    async function createChallenge({ accountId, installationId } = {}) {
        const cleanAccountId = requireUuid(accountId, 'accountId');
        const cleanInstallationId = requireInstallationId(installationId);
        const createdAt = nowDate(now);
        const expiresAt = new Date(createdAt.getTime() + CHALLENGE_LIFETIME_MS);
        const rawNonce = crypto.randomBytes(32).toString('base64url');
        const nonceSha256 = sha256(rawNonce);

        const result = await pool.query(
            `
            INSERT INTO account_auth_challenges (
                installation_id,
                account_id,
                purpose,
                nonce_sha256,
                created_at,
                expires_at
            )
            VALUES ($1, $2, 'delete_account', $3, $4, $5)
            RETURNING id, purpose, expires_at
            `,
            [
                cleanInstallationId,
                cleanAccountId,
                nonceSha256,
                createdAt,
                expiresAt,
            ]
        );

        const challenge = result.rows[0];
        if (!challenge?.id) {
            fail(
                'account_deletion_unavailable',
                'Account deletion could not be prepared. Please try again.',
                { status: 503, retryable: true }
            );
        }

        return Object.freeze({
            challengeId: String(challenge.id),
            purpose: 'delete_account',
            rawNonce,
            nonceSha256,
            expiresAt: new Date(challenge.expires_at).toISOString(),
        });
    }

    async function consumeChallenge({
        accountId,
        installationId,
        challengeId,
        rawNonce,
    }) {
        const cleanAccountId = requireUuid(accountId, 'accountId');
        const cleanInstallationId = requireInstallationId(installationId);
        const cleanChallengeId = requireUuid(challengeId, 'challengeId');
        const cleanRawNonce = requireString(rawNonce, 'rawNonce', 512);
        const attemptedAt = nowDate(now);
        const presentedHash = sha256(cleanRawNonce);

        const decision = await withTransaction(pool, async (client) => {
            const found = await client.query(
                `
                SELECT
                    id,
                    installation_id,
                    account_id,
                    purpose,
                    nonce_sha256,
                    expires_at,
                    consumed_at,
                    failed_attempts
                FROM account_auth_challenges
                WHERE id = $1
                FOR UPDATE
                `,
                [cleanChallengeId]
            );
            const challenge = normalizeChallenge(found.rows[0]);

            if (
                !challenge ||
                challenge.installationId !== cleanInstallationId ||
                challenge.accountId !== cleanAccountId ||
                challenge.purpose !== 'delete_account'
            ) {
                return { error: 'invalid_challenge', status: 401 };
            }
            if (challenge.consumedAt) {
                return { error: 'challenge_already_used', status: 409 };
            }
            if (
                challenge.failedAttempts >= MAX_CHALLENGE_FAILURES ||
                challenge.expiresAt.getTime() <= attemptedAt.getTime()
            ) {
                return { error: 'challenge_expired', status: 401 };
            }
            if (!constantTimeHexEqual(challenge.nonceSha256, presentedHash)) {
                await client.query(
                    `
                    UPDATE account_auth_challenges
                    SET
                        failed_attempts = LEAST(failed_attempts + 1, $3),
                        consumed_at = CASE
                            WHEN failed_attempts + 1 >= $3
                                THEN COALESCE(consumed_at, $2)
                            ELSE consumed_at
                        END
                    WHERE id = $1
                    `,
                    [challenge.id, attemptedAt, MAX_CHALLENGE_FAILURES]
                );
                return { error: 'invalid_challenge', status: 401 };
            }

            const consumed = await client.query(
                `
                UPDATE account_auth_challenges
                SET consumed_at = $2
                WHERE id = $1
                  AND consumed_at IS NULL
                RETURNING id
                `,
                [challenge.id, attemptedAt]
            );
            if (consumed.rowCount !== 1) {
                return { error: 'challenge_already_used', status: 409 };
            }
            return { challenge };
        });

        if (decision.error) {
            const messages = {
                invalid_challenge: 'The authentication challenge is invalid.',
                challenge_already_used: 'The authentication challenge has already been used.',
                challenge_expired: 'The authentication challenge has expired.',
            };
            fail(
                decision.error,
                messages[decision.error] || 'The authentication challenge is invalid.',
                { status: decision.status }
            );
        }

        return {
            challenge: decision.challenge,
            rawNonce: cleanRawNonce,
            accountId: cleanAccountId,
            installationId: cleanInstallationId,
        };
    }

    async function finalizeDeletion({
        accountId,
        credentialIdentity,
    }) {
        const requestedAt = nowDate(now);

        return withTransaction(pool, async (client) => {
            const identityResult = await client.query(
                `
                SELECT
                    gi.id AS identity_id,
                    gi.account_id,
                    gi.subject,
                    a.status AS account_status
                FROM accounts a
                JOIN account_google_identities gi
                  ON gi.account_id = a.id
                WHERE a.id = $1
                  AND gi.issuer = $2
                  AND gi.audience = $3
                FOR UPDATE OF a, gi
                `,
                [
                    accountId,
                    CANONICAL_GOOGLE_ISSUER,
                    credentialIdentity.audience,
                ]
            );
            const identity = identityResult.rows[0];
            if (!identity) {
                fail(
                    'account_identity_unavailable',
                    'The Google identity for this account is unavailable.',
                    { status: 409 }
                );
            }
            if (identity.account_status !== 'active') {
                fail('account_unavailable', 'This account is unavailable.', { status: 403 });
            }
            if (
                String(identity.account_id).toLowerCase() !== accountId ||
                !constantTimeStringEqual(String(identity.subject), credentialIdentity.subject)
            ) {
                fail(
                    'invalid_google_credential',
                    'The Google sign-in credential could not be verified.',
                    { status: 401 }
                );
            }

            const request = await client.query(
                `
                INSERT INTO account_deletion_requests (
                    account_id,
                    status,
                    request_source,
                    apple_revocation_status,
                    requested_at,
                    processing_started_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,
                    'processing',
                    'android_app',
                    'not_required',
                    $2,
                    $2,
                    $2,
                    $2
                )
                ON CONFLICT (account_id)
                    WHERE status IN ('pending', 'processing')
                DO NOTHING
                RETURNING id
                `,
                [accountId, requestedAt]
            );
            if (request.rowCount !== 1) {
                fail(
                    'account_deletion_in_progress',
                    'Account deletion is already in progress.',
                    { status: 409 }
                );
            }
            const requestId = request.rows[0].id;

            const markedPending = await client.query(
                `
                UPDATE accounts
                SET
                    status = 'deletion_pending',
                    auth_version = auth_version + 1,
                    deletion_requested_at = $2,
                    updated_at = $2
                WHERE id = $1
                  AND status = 'active'
                RETURNING id
                `,
                [accountId, requestedAt]
            );
            if (markedPending.rowCount !== 1) {
                fail('account_unavailable', 'This account is unavailable.', { status: 403 });
            }

            await client.query(
                `
                UPDATE account_sessions
                SET
                    revoked_at = COALESCE(revoked_at, $2),
                    revocation_reason = COALESCE(revocation_reason, $3),
                    last_used_at = GREATEST(last_used_at, $2)
                WHERE account_id = $1
                `,
                [accountId, requestedAt, ACCOUNT_DELETION_REASON]
            );

            await client.query(
                `
                UPDATE account_subscription_ownership
                SET
                    ownership_status = 'released',
                    released_at = COALESCE(released_at, $2),
                    claimed_from_installation_id = NULL,
                    observed_app_account_token = NULL,
                    updated_at = $2
                WHERE account_id = $1
                  AND ownership_status <> 'released'
                `,
                [accountId, requestedAt]
            );

            await client.query(
                'DELETE FROM account_achievement_unlocks WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                'DELETE FROM account_daily_challenge_progress WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                'DELETE FROM account_debate_history WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                'DELETE FROM account_sessions WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                `
                DELETE FROM account_auth_challenges
                WHERE account_id = $1
                   OR installation_id IN (
                        SELECT installation_id
                        FROM account_installations
                        WHERE account_id = $1
                   )
                `,
                [accountId]
            );
            await client.query(
                'DELETE FROM account_installations WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                'DELETE FROM account_apple_identities WHERE account_id = $1',
                [accountId]
            );
            await client.query(
                'DELETE FROM account_google_identities WHERE account_id = $1',
                [accountId]
            );

            const deletedAccount = await client.query(
                `
                UPDATE accounts
                SET
                    status = 'deleted',
                    auth_version = auth_version + 1,
                    display_name = NULL,
                    last_authenticated_at = NULL,
                    deleted_at = $2,
                    updated_at = $2
                WHERE id = $1
                  AND status = 'deletion_pending'
                RETURNING id
                `,
                [accountId, requestedAt]
            );
            if (deletedAccount.rowCount !== 1) {
                fail(
                    'account_deletion_conflict',
                    'Account deletion could not be completed.',
                    { status: 503, retryable: true }
                );
            }

            const completed = await client.query(
                `
                UPDATE account_deletion_requests
                SET
                    status = 'completed',
                    apple_revocation_status = 'not_required',
                    completed_at = $3,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    updated_at = $3
                WHERE id = $1
                  AND account_id = $2
                  AND status = 'processing'
                RETURNING id
                `,
                [requestId, accountId, requestedAt]
            );
            if (completed.rowCount !== 1) {
                fail(
                    'account_deletion_conflict',
                    'Account deletion could not be completed.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                accountId,
                status: 'deleted',
                deletedAt: requestedAt,
                appleRevocationStatus: 'not_required',
            });
        });
    }

    async function deleteAccount({
        accountId,
        installationId,
        challengeId,
        rawNonce,
        idToken,
    } = {}) {
        const consumed = await consumeChallenge({
            accountId,
            installationId,
            challengeId,
            rawNonce,
        });
        const cleanIdToken = requireString(idToken, 'idToken', 32_768);

        let credentialIdentity;
        try {
            credentialIdentity = await verify(cleanIdToken, {
                expectedNonce: consumed.rawNonce,
            });
        } catch (error) {
            throw mapGoogleFailure(error);
        }

        return finalizeDeletion({
            accountId: consumed.accountId,
            credentialIdentity,
        });
    }

    return Object.freeze({
        createChallenge,
        deleteAccount,
    });
}

export const googleAccountDeletionConstants = Object.freeze({
    challengeLifetimeMilliseconds: CHALLENGE_LIFETIME_MS,
    maximumChallengeFailures: MAX_CHALLENGE_FAILURES,
});
