import crypto from 'crypto';

import {
    AccountCryptoError,
    decryptAppleRefreshToken,
    encryptAppleRefreshToken,
    generateAgoraRefreshToken,
    hashToken,
    issueAgoraAccessToken,
    loadAccountCryptoConfig,
    verifyAgoraAccessToken,
} from './accountCrypto.js';

import {
    AppleSignInError,
    createAppleIdentityTokenVerifier,
    exchangeAppleAuthorizationCode,
    loadAppleSignInConfig,
} from './appleSignIn.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const IOS_VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,3}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const CHALLENGE_PURPOSES = new Set([
    'sign_in_with_apple',
    'reauthenticate',
    'delete_account',
]);

const DEFAULT_CHALLENGE_LIFETIME_SECONDS = 10 * 60;
const MAX_CHALLENGE_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const MAX_REFRESH_SESSION_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const MAX_CHALLENGE_FAILURES = 20;

const SESSION_REVOCATION_REASON_ROTATED = 'rotated';
const SESSION_REVOCATION_REASON_REUSE = 'refresh_token_reuse';
const SESSION_REVOCATION_REASON_EXPIRED = 'expired';
const SESSION_REVOCATION_REASON_RELINKED = 'installation_relinked';
const SESSION_REVOCATION_REASON_REAUTHENTICATED = 'reauthenticated';

export class AccountAuthError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            cause,
        } = {}
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AccountAuthError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAuthError(code, message, options);
}

function isAccountAuthError(error) {
    return error instanceof AccountAuthError;
}

function requireObject(value, fieldName) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('invalid_input', `${fieldName} must be an object.`, {
            status: 400,
        });
    }

    return value;
}

function requireNonEmptyString(
    value,
    fieldName,
    maxLength = 16_384
) {
    if (typeof value !== 'string') {
        fail('invalid_input', `${fieldName} must be a string.`, {
            status: 400,
        });
    }

    const cleaned = value.trim();

    if (!cleaned) {
        fail('invalid_input', `${fieldName} must not be empty.`, {
            status: 400,
        });
    }

    if (cleaned.length > maxLength) {
        fail('invalid_input', `${fieldName} is too long.`, {
            status: 400,
        });
    }

    return cleaned;
}

function optionalTrimmedString(value, fieldName, maxLength) {
    if (value == null) return null;

    return requireNonEmptyString(value, fieldName, maxLength);
}

function requireUuid(value, fieldName) {
    const cleaned = requireNonEmptyString(value, fieldName, 64);

    if (!UUID_RE.test(cleaned)) {
        fail('invalid_input', `${fieldName} must be a UUID.`, {
            status: 400,
        });
    }

    return cleaned.toLowerCase();
}

function requireInstallationId(value) {
    const cleaned = requireNonEmptyString(
        value,
        'installationId',
        128
    );

    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail(
            'invalid_input',
            'installationId has an invalid format.',
            { status: 400 }
        );
    }

    return cleaned;
}

function normalizeIosVersion(value) {
    if (value == null) return null;

    const cleaned = requireNonEmptyString(
        value,
        'iosVersion',
        64
    );

    if (!IOS_VERSION_RE.test(cleaned)) {
        fail('invalid_input', 'iosVersion has an invalid format.', {
            status: 400,
        });
    }

    return cleaned;
}

function normalizeIosBuild(value) {
    if (value == null) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        fail(
            'invalid_input',
            'iosBuild must be a positive safe integer.',
            { status: 400 }
        );
    }

    return parsed;
}

function normalizeDisplayName(value) {
    if (value == null) return null;

    return requireNonEmptyString(value, 'displayName', 100);
}

function normalizePurpose(value) {
    const purpose = value ?? 'sign_in_with_apple';

    if (typeof purpose !== 'string' || !CHALLENGE_PURPOSES.has(purpose)) {
        fail('invalid_input', 'purpose is not supported.', {
            status: 400,
        });
    }

    return purpose;
}

function requirePositiveDuration(
    value,
    fieldName,
    maximum
) {
    if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > maximum
    ) {
        fail(
            'invalid_configuration',
            `${fieldName} must be between 1 and ${maximum}.`,
            { status: 500 }
        );
    }

    return value;
}

function nowDate(now) {
    const milliseconds = now();

    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        fail('invalid_configuration', 'now() returned an invalid value.', {
            status: 500,
        });
    }

    return new Date(milliseconds);
}

function addSeconds(date, seconds) {
    return new Date(date.getTime() + seconds * 1_000);
}

function sha256Metadata(value, fieldName, maxLength) {
    if (value == null) return null;

    const cleaned = requireNonEmptyString(value, fieldName, maxLength);

    return crypto
        .createHash('sha256')
        .update(cleaned, 'utf8')
        .digest('hex');
}

function constantTimeHexEqual(left, right) {
    if (
        typeof left !== 'string' ||
        typeof right !== 'string' ||
        !SHA256_HEX_RE.test(left) ||
        !SHA256_HEX_RE.test(right)
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(left, 'hex'),
        Buffer.from(right, 'hex')
    );
}

function normalizeChallengeRow(row) {
    if (!row) return null;

    return {
        id: row.id,
        installationId: row.installation_id,
        accountId: row.account_id,
        purpose: row.purpose,
        nonceSha256: row.nonce_sha256,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        consumedAt: row.consumed_at
            ? new Date(row.consumed_at)
            : null,
        failedAttempts: Number(row.failed_attempts),
    };
}

function normalizeAppleIdentityRow(row) {
    if (!row) return null;

    return {
        identityId: row.identity_id,
        accountId: row.account_id,
        issuer: row.issuer,
        audience: row.audience,
        subject: row.subject,
        accountStatus: row.account_status,
        authVersion: Number(row.auth_version),
        displayName: row.display_name,
    };
}

function normalizeInstallationRow(row) {
    if (!row) return null;

    return {
        id: row.id,
        accountId: row.account_id,
        installationId: row.installation_id,
        unlinkedAt: row.unlinked_at
            ? new Date(row.unlinked_at)
            : null,
    };
}

function normalizeRefreshSessionRow(row) {
    if (!row) return null;

    return {
        sessionId: row.session_id,
        accountId: row.account_id,
        accountInstallationId: row.account_installation_id,
        tokenFamilyId: row.token_family_id,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        revokedAt: row.revoked_at
            ? new Date(row.revoked_at)
            : null,
        revocationReason: row.revocation_reason,
        accountStatus: row.account_status,
        authVersion: Number(row.auth_version),
        installationId: row.installation_id,
        installationUnlinkedAt: row.unlinked_at
            ? new Date(row.unlinked_at)
            : null,
    };
}

function normalizeAuthorizationRow(row) {
    if (!row) return null;

    return {
        sessionId: row.session_id,
        accountId: row.account_id,
        accountStatus: row.account_status,
        authVersion: Number(row.auth_version),
        sessionExpiresAt: new Date(row.session_expires_at),
        sessionRevokedAt: row.session_revoked_at
            ? new Date(row.session_revoked_at)
            : null,
        installationId: row.installation_id,
        installationUnlinkedAt: row.installation_unlinked_at
            ? new Date(row.installation_unlinked_at)
            : null,
        displayName: row.display_name,
    };
}

function mapAppleFailure(error) {
    if (!(error instanceof AppleSignInError)) {
        return error;
    }

    if (error.retryable || error.status >= 500) {
        return new AccountAuthError(
            'apple_authentication_unavailable',
            'Sign in with Apple is temporarily unavailable.',
            {
                status: 503,
                retryable: true,
                cause: error,
            }
        );
    }

    return new AccountAuthError(
        'invalid_apple_credential',
        'The Apple sign-in credential could not be verified.',
        {
            status: 401,
            retryable: false,
            cause: error,
        }
    );
}

function mapAccessTokenFailure(error) {
    if (error instanceof AccountCryptoError) {
        return new AccountAuthError(
            'invalid_access_token',
            'The access token is invalid or expired.',
            {
                status: 401,
                retryable: false,
                cause: error,
            }
        );
    }

    return error;
}

function mapUnexpectedFailure(error) {
    if (
        error instanceof AccountAuthError ||
        error instanceof AppleSignInError ||
        error instanceof AccountCryptoError
    ) {
        return error;
    }

    return new AccountAuthError(
        'account_authentication_unavailable',
        'Account authentication is temporarily unavailable.',
        {
            status: 503,
            retryable: true,
            cause: error,
        }
    );
}

function assertActiveAccount(status) {
    if (status === 'active') return;

    if (status === 'locked') {
        fail('account_locked', 'This account is locked.', {
            status: 403,
        });
    }

    if (status === 'deletion_pending') {
        fail(
            'account_deletion_pending',
            'This account is pending deletion.',
            { status: 403 }
        );
    }

    fail('account_unavailable', 'This account is unavailable.', {
        status: 403,
    });
}

function appleRefreshTokenBinding(identity) {
    return {
        identityId: identity.identityId,
        accountId: identity.accountId,
        issuer: identity.issuer,
        audience: identity.audience,
        subject: identity.subject,
    };
}

export function createPostgresAccountAuthRepository(pool) {
    if (!pool || typeof pool.query !== 'function') {
        fail(
            'invalid_configuration',
            'A PostgreSQL pool is required.',
            { status: 500 }
        );
    }

    async function query(target, text, values = []) {
        return target.query(text, values);
    }

    return Object.freeze({
        async withTransaction(work) {
            if (typeof pool.connect !== 'function') {
                fail(
                    'invalid_configuration',
                    'The PostgreSQL pool must support connect().',
                    { status: 500 }
                );
            }

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
        },

        async createChallenge({
            installationId,
            accountId,
            purpose,
            nonceSha256,
            createdAt,
            expiresAt,
        }) {
            const result = await query(
                pool,
                `
                    /* account-auth:create-challenge */
                    INSERT INTO account_auth_challenges (
                        installation_id,
                        account_id,
                        purpose,
                        nonce_sha256,
                        created_at,
                        expires_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING
                        id,
                        installation_id,
                        account_id,
                        purpose,
                        nonce_sha256,
                        created_at,
                        expires_at,
                        consumed_at,
                        failed_attempts
                `,
                [
                    installationId,
                    accountId,
                    purpose,
                    nonceSha256,
                    createdAt,
                    expiresAt,
                ]
            );

            return normalizeChallengeRow(result.rows[0]);
        },

        async findChallengeForUpdate(tx, challengeId) {
            const result = await query(
                tx,
                `
                    /* account-auth:find-challenge-for-update */
                    SELECT
                        id,
                        installation_id,
                        account_id,
                        purpose,
                        nonce_sha256,
                        created_at,
                        expires_at,
                        consumed_at,
                        failed_attempts
                    FROM account_auth_challenges
                    WHERE id = $1
                    FOR UPDATE
                `,
                [challengeId]
            );

            return normalizeChallengeRow(result.rows[0]);
        },

        async recordChallengeFailure(tx, challengeId, attemptedAt) {
            await query(
                tx,
                `
                    /* account-auth:record-challenge-failure */
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
                [challengeId, attemptedAt, MAX_CHALLENGE_FAILURES]
            );
        },

        async consumeChallenge(tx, challengeId, consumedAt) {
            const result = await query(
                tx,
                `
                    /* account-auth:consume-challenge */
                    UPDATE account_auth_challenges
                    SET consumed_at = $2
                    WHERE id = $1
                      AND consumed_at IS NULL
                    RETURNING id
                `,
                [challengeId, consumedAt]
            );

            return result.rowCount === 1;
        },

        async acquireAppleIdentityLock(
            tx,
            { issuer, audience, subject }
        ) {
            await query(
                tx,
                `
                    /* account-auth:lock-apple-identity */
                    SELECT pg_advisory_xact_lock(
                        hashtextextended($1, 0)
                    )
                `,
                [JSON.stringify(['apple', issuer, audience, subject])]
            );
        },

        async findAppleIdentityForUpdate(
            tx,
            { issuer, audience, subject }
        ) {
            const result = await query(
                tx,
                `
                    /* account-auth:find-apple-identity-for-update */
                    SELECT
                        ai.id AS identity_id,
                        ai.account_id,
                        ai.issuer,
                        ai.audience,
                        ai.subject,
                        a.status AS account_status,
                        a.auth_version,
                        a.display_name
                    FROM account_apple_identities ai
                    JOIN accounts a
                      ON a.id = ai.account_id
                    WHERE ai.issuer = $1
                      AND ai.audience = $2
                      AND ai.subject = $3
                    FOR UPDATE OF ai, a
                `,
                [issuer, audience, subject]
            );

            return normalizeAppleIdentityRow(result.rows[0]);
        },

        async createAccount(tx, { displayName, createdAt }) {
            const result = await query(
                tx,
                `
                    /* account-auth:create-account */
                    INSERT INTO accounts (
                        display_name,
                        created_at,
                        updated_at,
                        last_authenticated_at
                    )
                    VALUES ($1, $2, $2, $2)
                    RETURNING
                        id,
                        status,
                        auth_version,
                        display_name
                `,
                [displayName, createdAt]
            );

            const row = result.rows[0];

            return {
                id: row.id,
                status: row.status,
                authVersion: Number(row.auth_version),
                displayName: row.display_name,
            };
        },

        async createAppleIdentity(
            tx,
            {
                accountId,
                issuer,
                audience,
                subject,
                email,
                emailVerified,
                isPrivateEmail,
                createdAt,
            }
        ) {
            const result = await query(
                tx,
                `
                    /* account-auth:create-apple-identity */
                    INSERT INTO account_apple_identities (
                        account_id,
                        issuer,
                        audience,
                        subject,
                        email,
                        email_verified,
                        is_private_email,
                        created_at,
                        updated_at,
                        last_authenticated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $8, $8
                    )
                    RETURNING id
                `,
                [
                    accountId,
                    issuer,
                    audience,
                    subject,
                    email,
                    emailVerified,
                    isPrivateEmail,
                    createdAt,
                ]
            );

            return {
                identityId: result.rows[0].id,
                accountId,
                issuer,
                audience,
                subject,
            };
        },

        async updateAppleIdentityCredential(
            tx,
            {
                identityId,
                email,
                emailVerified,
                isPrivateEmail,
                encryptedRefreshToken,
                refreshTokenHash,
                encryptionKeyVersion,
                authenticatedAt,
            }
        ) {
            await query(
                tx,
                `
                    /* account-auth:update-apple-identity-credential */
                    UPDATE account_apple_identities
                    SET
                        email = COALESCE($2, email),
                        email_verified = COALESCE($3, email_verified),
                        is_private_email = COALESCE($4, is_private_email),
                        authorization_status = 'active',
                        apple_refresh_token_encrypted = $5,
                        apple_refresh_token_hash = $6,
                        token_encryption_key_version = $7,
                        refresh_token_received_at = $8,
                        refresh_token_last_validated_at = $8,
                        credential_revoked_at = NULL,
                        updated_at = $8,
                        last_authenticated_at = $8
                    WHERE id = $1
                `,
                [
                    identityId,
                    email,
                    emailVerified,
                    isPrivateEmail,
                    encryptedRefreshToken,
                    refreshTokenHash,
                    encryptionKeyVersion,
                    authenticatedAt,
                ]
            );
        },

        async updateAccountAuthenticated(
            tx,
            { accountId, displayName, authenticatedAt }
        ) {
            await query(
                tx,
                `
                    /* account-auth:update-account-authenticated */
                    UPDATE accounts
                    SET
                        display_name = COALESCE(display_name, $2),
                        last_authenticated_at = $3,
                        updated_at = $3
                    WHERE id = $1
                `,
                [accountId, displayName, authenticatedAt]
            );
        },

        async acquireInstallationLock(tx, installationId) {
            await query(
                tx,
                `
                    /* account-auth:lock-installation */
                    SELECT pg_advisory_xact_lock(
                        hashtextextended($1, 0)
                    )
                `,
                [JSON.stringify(['installation', installationId])]
            );
        },

        async findActiveInstallationForUpdate(tx, installationId) {
            const result = await query(
                tx,
                `
                    /* account-auth:find-installation-for-update */
                    SELECT
                        id,
                        account_id,
                        installation_id,
                        unlinked_at
                    FROM account_installations
                    WHERE installation_id = $1
                      AND unlinked_at IS NULL
                    FOR UPDATE
                `,
                [installationId]
            );

            return normalizeInstallationRow(result.rows[0]);
        },

        async revokeActiveSessionsForInstallation(
            tx,
            { accountInstallationId, revokedAt, reason }
        ) {
            await query(
                tx,
                `
                    /* account-auth:revoke-installation-sessions */
                    UPDATE account_sessions
                    SET
                        revoked_at = $2,
                        revocation_reason = $3,
                        last_used_at = GREATEST(last_used_at, $2)
                    WHERE account_installation_id = $1
                      AND revoked_at IS NULL
                `,
                [accountInstallationId, revokedAt, reason]
            );
        },

        async unlinkInstallation(
            tx,
            { accountInstallationId, unlinkedAt }
        ) {
            await query(
                tx,
                `
                    /* account-auth:unlink-installation */
                    UPDATE account_installations
                    SET
                        unlinked_at = $2,
                        updated_at = $2
                    WHERE id = $1
                      AND unlinked_at IS NULL
                `,
                [accountInstallationId, unlinkedAt]
            );
        },

        async touchInstallation(
            tx,
            {
                accountInstallationId,
                seenAt,
                iosVersion,
                iosBuild,
            }
        ) {
            await query(
                tx,
                `
                    /* account-auth:touch-installation */
                    UPDATE account_installations
                    SET
                        last_seen_at = $2,
                        last_ios_version = COALESCE($3, last_ios_version),
                        last_ios_build = COALESCE($4, last_ios_build),
                        updated_at = $2
                    WHERE id = $1
                      AND unlinked_at IS NULL
                `,
                [
                    accountInstallationId,
                    seenAt,
                    iosVersion,
                    iosBuild,
                ]
            );
        },

        async createInstallation(
            tx,
            {
                accountId,
                installationId,
                linkSource,
                linkedAt,
                iosVersion,
                iosBuild,
            }
        ) {
            const result = await query(
                tx,
                `
                    /* account-auth:create-installation */
                    INSERT INTO account_installations (
                        account_id,
                        installation_id,
                        link_source,
                        linked_at,
                        last_seen_at,
                        last_ios_version,
                        last_ios_build,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $4, $5, $6, $4, $4
                    )
                    RETURNING
                        id,
                        account_id,
                        installation_id,
                        unlinked_at
                `,
                [
                    accountId,
                    installationId,
                    linkSource,
                    linkedAt,
                    iosVersion,
                    iosBuild,
                ]
            );

            return normalizeInstallationRow(result.rows[0]);
        },

        async createSession(
            tx,
            {
                accountId,
                accountInstallationId,
                tokenFamilyId,
                refreshTokenHash,
                rotatedFromSessionId,
                createdAt,
                expiresAt,
                ipAddressHash,
                userAgentHash,
            }
        ) {
            const result = await query(
                tx,
                `
                    /* account-auth:create-session */
                    INSERT INTO account_sessions (
                        account_id,
                        account_installation_id,
                        token_family_id,
                        refresh_token_hash,
                        rotated_from_session_id,
                        created_at,
                        last_used_at,
                        expires_at,
                        ip_address_hash,
                        user_agent_hash
                    )
                    VALUES (
                        $1, $2, COALESCE($3, gen_random_uuid()),
                        $4, $5, $6, $6, $7, $8, $9
                    )
                    RETURNING
                        id,
                        token_family_id,
                        expires_at
                `,
                [
                    accountId,
                    accountInstallationId,
                    tokenFamilyId,
                    refreshTokenHash,
                    rotatedFromSessionId,
                    createdAt,
                    expiresAt,
                    ipAddressHash,
                    userAgentHash,
                ]
            );

            return {
                id: result.rows[0].id,
                tokenFamilyId: result.rows[0].token_family_id,
                expiresAt: new Date(result.rows[0].expires_at),
            };
        },

        async findRefreshSessionForUpdate(tx, refreshTokenHash) {
            const result = await query(
                tx,
                `
                    /* account-auth:find-refresh-session-for-update */
                    SELECT
                        s.id AS session_id,
                        s.account_id,
                        s.account_installation_id,
                        s.token_family_id,
                        s.created_at,
                        s.expires_at,
                        s.revoked_at,
                        s.revocation_reason,
                        a.status AS account_status,
                        a.auth_version,
                        ai.installation_id,
                        ai.unlinked_at
                    FROM account_sessions s
                    JOIN accounts a
                      ON a.id = s.account_id
                    JOIN account_installations ai
                      ON ai.id = s.account_installation_id
                     AND ai.account_id = s.account_id
                    WHERE s.refresh_token_hash = $1
                    FOR UPDATE OF s, a, ai
                `,
                [refreshTokenHash]
            );

            return normalizeRefreshSessionRow(result.rows[0]);
        },

        async hasReplacementSession(tx, sessionId) {
            const result = await query(
                tx,
                `
                    /* account-auth:has-replacement-session */
                    SELECT EXISTS (
                        SELECT 1
                        FROM account_sessions
                        WHERE rotated_from_session_id = $1
                    ) AS has_replacement
                `,
                [sessionId]
            );

            return Boolean(result.rows[0]?.has_replacement);
        },

        async revokeSession(
            tx,
            { sessionId, revokedAt, reason }
        ) {
            await query(
                tx,
                `
                    /* account-auth:revoke-session */
                    UPDATE account_sessions
                    SET
                        revoked_at = COALESCE(revoked_at, $2),
                        revocation_reason = COALESCE(revocation_reason, $3),
                        last_used_at = GREATEST(last_used_at, $2)
                    WHERE id = $1
                `,
                [sessionId, revokedAt, reason]
            );
        },

        async revokeSessionFamily(
            tx,
            { tokenFamilyId, revokedAt, reason }
        ) {
            await query(
                tx,
                `
                    /* account-auth:revoke-session-family */
                    UPDATE account_sessions
                    SET
                        revoked_at = $2,
                        revocation_reason = $3,
                        last_used_at = GREATEST(last_used_at, $2)
                    WHERE token_family_id = $1
                      AND revoked_at IS NULL
                `,
                [tokenFamilyId, revokedAt, reason]
            );
        },

        async markSessionRotated(tx, { sessionId, rotatedAt }) {
            const result = await query(
                tx,
                `
                    /* account-auth:mark-session-rotated */
                    UPDATE account_sessions
                    SET
                        revoked_at = $2,
                        revocation_reason = $3,
                        last_used_at = GREATEST(last_used_at, $2)
                    WHERE id = $1
                      AND revoked_at IS NULL
                    RETURNING id
                `,
                [
                    sessionId,
                    rotatedAt,
                    SESSION_REVOCATION_REASON_ROTATED,
                ]
            );

            return result.rowCount === 1;
        },

        async findAuthorizationState({ accountId, sessionId }) {
            const result = await query(
                pool,
                `
                    /* account-auth:find-authorization-state */
                    SELECT
                        s.id AS session_id,
                        s.account_id,
                        s.expires_at AS session_expires_at,
                        s.revoked_at AS session_revoked_at,
                        a.status AS account_status,
                        a.auth_version,
                        a.display_name,
                        ai.installation_id,
                        ai.unlinked_at AS installation_unlinked_at
                    FROM account_sessions s
                    JOIN accounts a
                      ON a.id = s.account_id
                    JOIN account_installations ai
                      ON ai.id = s.account_installation_id
                     AND ai.account_id = s.account_id
                    WHERE s.id = $1
                      AND s.account_id = $2
                `,
                [sessionId, accountId]
            );

            return normalizeAuthorizationRow(result.rows[0]);
        },
    });
}

export function createAccountAuthService({
    pool = null,
    repository = null,
    appleConfig = null,
    accountCryptoConfig = null,
    verifyAppleIdentityToken = null,
    exchangeAuthorizationCode = exchangeAppleAuthorizationCode,
    now = () => Date.now(),
    challengeLifetimeSeconds = DEFAULT_CHALLENGE_LIFETIME_SECONDS,
    accessTokenLifetimeSeconds = DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
    refreshSessionLifetimeSeconds =
        DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS,
} = {}) {
    const repo = repository ?? createPostgresAccountAuthRepository(pool);

    if (!repo || typeof repo.withTransaction !== 'function') {
        fail(
            'invalid_configuration',
            'A valid account authentication repository is required.',
            { status: 500 }
        );
    }

    const resolvedAppleConfig = appleConfig ?? loadAppleSignInConfig();
    const resolvedCryptoConfig =
        accountCryptoConfig ?? loadAccountCryptoConfig();

    const verifyIdentityToken =
        verifyAppleIdentityToken ??
        createAppleIdentityTokenVerifier({
            config: resolvedAppleConfig,
            now,
        });

    if (typeof verifyIdentityToken !== 'function') {
        fail(
            'invalid_configuration',
            'verifyAppleIdentityToken must be a function.',
            { status: 500 }
        );
    }

    if (typeof exchangeAuthorizationCode !== 'function') {
        fail(
            'invalid_configuration',
            'exchangeAuthorizationCode must be a function.',
            { status: 500 }
        );
    }

    const challengeTtl = requirePositiveDuration(
        challengeLifetimeSeconds,
        'challengeLifetimeSeconds',
        MAX_CHALLENGE_LIFETIME_SECONDS
    );

    const accessTokenTtl = requirePositiveDuration(
        accessTokenLifetimeSeconds,
        'accessTokenLifetimeSeconds',
        60 * 60
    );

    const refreshSessionTtl = requirePositiveDuration(
        refreshSessionLifetimeSeconds,
        'refreshSessionLifetimeSeconds',
        MAX_REFRESH_SESSION_LIFETIME_SECONDS
    );

    async function createAppleChallenge(input) {
        try {
            const values = requireObject(input, 'input');
            const installationId = requireInstallationId(
                values.installationId
            );
            const purpose = normalizePurpose(values.purpose);
            const accountId = values.accountId == null
                ? null
                : requireUuid(values.accountId, 'accountId');

            if (
                purpose === 'sign_in_with_apple' &&
                accountId !== null
            ) {
                fail(
                    'invalid_input',
                    'Sign-in challenges must not include accountId.',
                    { status: 400 }
                );
            }

            if (
                purpose !== 'sign_in_with_apple' &&
                accountId === null
            ) {
                fail(
                    'invalid_input',
                    'Reauthentication and deletion challenges require accountId.',
                    { status: 400 }
                );
            }

            const createdAt = nowDate(now);
            const expiresAt = addSeconds(createdAt, challengeTtl);
            const rawNonce = crypto.randomBytes(32).toString('base64url');
            const nonceSha256 = hashToken(rawNonce);

            const challenge = await repo.createChallenge({
                installationId,
                accountId,
                purpose,
                nonceSha256,
                createdAt,
                expiresAt,
            });

            return Object.freeze({
                challengeId: challenge.id,
                purpose: challenge.purpose,
                rawNonce,
                nonceSha256,
                expiresAt: challenge.expiresAt,
            });
        } catch (error) {
            throw mapUnexpectedFailure(error);
        }
    }

    async function consumeSignInChallenge({
        challengeId,
        installationId,
        rawNonce,
    }) {
        const normalizedChallengeId = requireUuid(
            challengeId,
            'challengeId'
        );
        const normalizedInstallationId = requireInstallationId(
            installationId
        );
        const normalizedRawNonce = requireNonEmptyString(
            rawNonce,
            'rawNonce',
            512
        );
        const attemptedAt = nowDate(now);
        const presentedHash = hashToken(normalizedRawNonce);

        const decision = await repo.withTransaction(async (tx) => {
            const challenge = await repo.findChallengeForUpdate(
                tx,
                normalizedChallengeId
            );

            if (!challenge) {
                return {
                    error: new AccountAuthError(
                        'invalid_challenge',
                        'The authentication challenge is invalid.',
                        { status: 401 }
                    ),
                };
            }

            if (
                challenge.installationId !== normalizedInstallationId ||
                challenge.purpose !== 'sign_in_with_apple' ||
                challenge.accountId !== null
            ) {
                return {
                    error: new AccountAuthError(
                        'invalid_challenge',
                        'The authentication challenge is invalid.',
                        { status: 401 }
                    ),
                };
            }

            if (challenge.consumedAt) {
                return {
                    error: new AccountAuthError(
                        'challenge_already_used',
                        'The authentication challenge has already been used.',
                        { status: 409 }
                    ),
                };
            }

            if (
                challenge.failedAttempts >= MAX_CHALLENGE_FAILURES ||
                challenge.expiresAt.getTime() <= attemptedAt.getTime()
            ) {
                return {
                    error: new AccountAuthError(
                        'challenge_expired',
                        'The authentication challenge has expired.',
                        { status: 401 }
                    ),
                };
            }

            if (
                !constantTimeHexEqual(
                    challenge.nonceSha256,
                    presentedHash
                )
            ) {
                await repo.recordChallengeFailure(
                    tx,
                    challenge.id,
                    attemptedAt
                );

                return {
                    error: new AccountAuthError(
                        'invalid_challenge',
                        'The authentication challenge is invalid.',
                        { status: 401 }
                    ),
                };
            }

            const consumed = await repo.consumeChallenge(
                tx,
                challenge.id,
                attemptedAt
            );

            if (!consumed) {
                return {
                    error: new AccountAuthError(
                        'challenge_already_used',
                        'The authentication challenge has already been used.',
                        { status: 409 }
                    ),
                };
            }

            return { challenge };
        });

        if (decision.error) {
            throw decision.error;
        }

        return decision.challenge;
    }

    async function signInWithApple(input) {
        try {
            const values = requireObject(input, 'input');
            const installationId = requireInstallationId(
                values.installationId
            );
            const iosVersion = normalizeIosVersion(values.iosVersion);
            const iosBuild = normalizeIosBuild(values.iosBuild);
            const displayName = normalizeDisplayName(values.displayName);
            const identityToken = requireNonEmptyString(
                values.identityToken,
                'identityToken',
                32_768
            );
            const authorizationCode = requireNonEmptyString(
                values.authorizationCode,
                'authorizationCode',
                8_192
            );
            const ipAddressHash = sha256Metadata(
                values.ipAddress,
                'ipAddress',
                256
            );
            const userAgentHash = sha256Metadata(
                values.userAgent,
                'userAgent',
                2_048
            );

            const challenge = await consumeSignInChallenge({
                challengeId: values.challengeId,
                installationId,
                rawNonce: values.rawNonce,
            });

            let credentialIdentity;
            let tokenResponse;
            let exchangedIdentity;

            try {
                credentialIdentity = await verifyIdentityToken(
                    identityToken,
                    {
                        expectedNonceHash: challenge.nonceSha256,
                    }
                );

                tokenResponse = await exchangeAuthorizationCode({
                    authorizationCode,
                    config: resolvedAppleConfig,
                });

                exchangedIdentity = await verifyIdentityToken(
                    tokenResponse.identityToken,
                    {
                        expectedSubject: credentialIdentity.subject,
                    }
                );
            } catch (error) {
                throw mapAppleFailure(error);
            }

            if (
                credentialIdentity.issuer !== exchangedIdentity.issuer ||
                credentialIdentity.audience !== exchangedIdentity.audience ||
                credentialIdentity.subject !== exchangedIdentity.subject
            ) {
                fail(
                    'invalid_apple_credential',
                    'The Apple sign-in credential could not be verified.',
                    { status: 401 }
                );
            }

            const authenticatedAt = nowDate(now);
            const sessionExpiresAt = addSeconds(
                authenticatedAt,
                refreshSessionTtl
            );
            const email =
                credentialIdentity.email ?? exchangedIdentity.email ?? null;
            const emailVerified =
                credentialIdentity.emailVerified ??
                exchangedIdentity.emailVerified ??
                null;
            const isPrivateEmail =
                credentialIdentity.isPrivateEmail ??
                exchangedIdentity.isPrivateEmail ??
                null;

            const result = await repo.withTransaction(async (tx) => {
                await repo.acquireAppleIdentityLock(tx, {
                    issuer: credentialIdentity.issuer,
                    audience: credentialIdentity.audience,
                    subject: credentialIdentity.subject,
                });

                await repo.acquireInstallationLock(tx, installationId);

                let identity = await repo.findAppleIdentityForUpdate(
                    tx,
                    {
                        issuer: credentialIdentity.issuer,
                        audience: credentialIdentity.audience,
                        subject: credentialIdentity.subject,
                    }
                );

                let account;
                let isNewAccount = false;

                if (identity) {
                    assertActiveAccount(identity.accountStatus);

                    account = {
                        id: identity.accountId,
                        status: identity.accountStatus,
                        authVersion: identity.authVersion,
                        displayName: identity.displayName,
                    };
                } else {
                    account = await repo.createAccount(tx, {
                        displayName,
                        createdAt: authenticatedAt,
                    });

                    identity = await repo.createAppleIdentity(tx, {
                        accountId: account.id,
                        issuer: credentialIdentity.issuer,
                        audience: credentialIdentity.audience,
                        subject: credentialIdentity.subject,
                        email,
                        emailVerified,
                        isPrivateEmail,
                        createdAt: authenticatedAt,
                    });

                    isNewAccount = true;
                }

                const binding = appleRefreshTokenBinding(identity);
                const encryptedAppleRefreshToken =
                    encryptAppleRefreshToken(
                        tokenResponse.refreshToken,
                        resolvedCryptoConfig,
                        binding
                    );

                await repo.updateAppleIdentityCredential(tx, {
                    identityId: identity.identityId,
                    email,
                    emailVerified,
                    isPrivateEmail,
                    encryptedRefreshToken: encryptedAppleRefreshToken,
                    refreshTokenHash: hashToken(
                        tokenResponse.refreshToken
                    ),
                    encryptionKeyVersion:
                        resolvedCryptoConfig.appleRefreshTokenEncryption
                            .activeVersion,
                    authenticatedAt,
                });

                await repo.updateAccountAuthenticated(tx, {
                    accountId: account.id,
                    displayName,
                    authenticatedAt,
                });

                let installation =
                    await repo.findActiveInstallationForUpdate(
                        tx,
                        installationId
                    );

                if (
                    installation &&
                    installation.accountId !== account.id
                ) {
                    await repo.revokeActiveSessionsForInstallation(tx, {
                        accountInstallationId: installation.id,
                        revokedAt: authenticatedAt,
                        reason: SESSION_REVOCATION_REASON_RELINKED,
                    });

                    await repo.unlinkInstallation(tx, {
                        accountInstallationId: installation.id,
                        unlinkedAt: authenticatedAt,
                    });

                    installation = null;
                }

                if (installation) {
                    await repo.revokeActiveSessionsForInstallation(tx, {
                        accountInstallationId: installation.id,
                        revokedAt: authenticatedAt,
                        reason: SESSION_REVOCATION_REASON_REAUTHENTICATED,
                    });

                    await repo.touchInstallation(tx, {
                        accountInstallationId: installation.id,
                        seenAt: authenticatedAt,
                        iosVersion,
                        iosBuild,
                    });
                } else {
                    installation = await repo.createInstallation(tx, {
                        accountId: account.id,
                        installationId,
                        linkSource: 'sign_in_with_apple',
                        linkedAt: authenticatedAt,
                        iosVersion,
                        iosBuild,
                    });
                }

                const agoraRefreshToken = generateAgoraRefreshToken();
                const session = await repo.createSession(tx, {
                    accountId: account.id,
                    accountInstallationId: installation.id,
                    tokenFamilyId: null,
                    refreshTokenHash: hashToken(agoraRefreshToken),
                    rotatedFromSessionId: null,
                    createdAt: authenticatedAt,
                    expiresAt: sessionExpiresAt,
                    ipAddressHash,
                    userAgentHash,
                });

                const access = issueAgoraAccessToken(
                    {
                        accountId: account.id,
                        sessionId: session.id,
                        installationId,
                        authVersion: account.authVersion,
                    },
                    resolvedCryptoConfig,
                    {
                        nowMilliseconds: authenticatedAt.getTime(),
                        expiresInSeconds: accessTokenTtl,
                    }
                );

                return {
                    account: {
                        id: account.id,
                        status: account.status,
                        authVersion: account.authVersion,
                        displayName:
                            account.displayName ?? displayName ?? null,
                        isNewAccount,
                    },
                    session: {
                        id: session.id,
                        expiresAt: session.expiresAt,
                    },
                    accessToken: access.token,
                    accessTokenExpiresAt: access.expiresAt,
                    refreshToken: agoraRefreshToken,
                };
            });

            return Object.freeze({
                account: Object.freeze(result.account),
                session: Object.freeze(result.session),
                accessToken: result.accessToken,
                accessTokenExpiresAt: result.accessTokenExpiresAt,
                refreshToken: result.refreshToken,
            });
        } catch (error) {
            if (error instanceof AppleSignInError) {
                throw mapAppleFailure(error);
            }

            if (error instanceof AccountCryptoError) {
                throw new AccountAuthError(
                    'account_authentication_failed',
                    'Account authentication could not be completed.',
                    {
                        status: 500,
                        retryable: false,
                        cause: error,
                    }
                );
            }

            throw mapUnexpectedFailure(error);
        }
    }

    async function refreshSession(input) {
        try {
            const values = requireObject(input, 'input');
            const installationId = requireInstallationId(
                values.installationId
            );
            const refreshToken = requireNonEmptyString(
                values.refreshToken,
                'refreshToken',
                1_024
            );
            const iosVersion = normalizeIosVersion(values.iosVersion);
            const iosBuild = normalizeIosBuild(values.iosBuild);
            const ipAddressHash = sha256Metadata(
                values.ipAddress,
                'ipAddress',
                256
            );
            const userAgentHash = sha256Metadata(
                values.userAgent,
                'userAgent',
                2_048
            );
            const refreshTokenHash = hashToken(refreshToken);
            const refreshedAt = nowDate(now);

            const decision = await repo.withTransaction(async (tx) => {
                const current = await repo.findRefreshSessionForUpdate(
                    tx,
                    refreshTokenHash
                );

                if (!current) {
                    return {
                        error: new AccountAuthError(
                            'invalid_refresh_token',
                            'The refresh token is invalid or expired.',
                            { status: 401 }
                        ),
                    };
                }

                const hasReplacement =
                    await repo.hasReplacementSession(
                        tx,
                        current.sessionId
                    );

                if (
                    current.revokedAt ||
                    hasReplacement
                ) {
                    if (
                        hasReplacement ||
                        current.revocationReason ===
                            SESSION_REVOCATION_REASON_ROTATED
                    ) {
                        await repo.revokeSessionFamily(tx, {
                            tokenFamilyId: current.tokenFamilyId,
                            revokedAt: refreshedAt,
                            reason: SESSION_REVOCATION_REASON_REUSE,
                        });

                        return {
                            error: new AccountAuthError(
                                'refresh_token_reuse_detected',
                                'The refresh session is no longer valid.',
                                { status: 401 }
                            ),
                        };
                    }

                    return {
                        error: new AccountAuthError(
                            'invalid_refresh_token',
                            'The refresh token is invalid or expired.',
                            { status: 401 }
                        ),
                    };
                }

                if (
                    current.installationId !== installationId ||
                    current.installationUnlinkedAt
                ) {
                    return {
                        error: new AccountAuthError(
                            'invalid_refresh_token',
                            'The refresh token is invalid or expired.',
                            { status: 401 }
                        ),
                    };
                }

                if (
                    current.expiresAt.getTime() <=
                    refreshedAt.getTime()
                ) {
                    await repo.revokeSession(tx, {
                        sessionId: current.sessionId,
                        revokedAt: refreshedAt,
                        reason: SESSION_REVOCATION_REASON_EXPIRED,
                    });

                    return {
                        error: new AccountAuthError(
                            'invalid_refresh_token',
                            'The refresh token is invalid or expired.',
                            { status: 401 }
                        ),
                    };
                }

                if (current.accountStatus !== 'active') {
                    return {
                        error: new AccountAuthError(
                            'account_unavailable',
                            'This account is unavailable.',
                            { status: 403 }
                        ),
                    };
                }

                const rotated = await repo.markSessionRotated(tx, {
                    sessionId: current.sessionId,
                    rotatedAt: refreshedAt,
                });

                if (!rotated) {
                    return {
                        error: new AccountAuthError(
                            'invalid_refresh_token',
                            'The refresh token is invalid or expired.',
                            { status: 401 }
                        ),
                    };
                }

                const nextRefreshToken = generateAgoraRefreshToken();
                const nextSession = await repo.createSession(tx, {
                    accountId: current.accountId,
                    accountInstallationId:
                        current.accountInstallationId,
                    tokenFamilyId: current.tokenFamilyId,
                    refreshTokenHash: hashToken(nextRefreshToken),
                    rotatedFromSessionId: current.sessionId,
                    createdAt: refreshedAt,
                    expiresAt: addSeconds(
                        refreshedAt,
                        refreshSessionTtl
                    ),
                    ipAddressHash,
                    userAgentHash,
                });

                await repo.touchInstallation(tx, {
                    accountInstallationId:
                        current.accountInstallationId,
                    seenAt: refreshedAt,
                    iosVersion,
                    iosBuild,
                });

                const access = issueAgoraAccessToken(
                    {
                        accountId: current.accountId,
                        sessionId: nextSession.id,
                        installationId,
                        authVersion: current.authVersion,
                    },
                    resolvedCryptoConfig,
                    {
                        nowMilliseconds: refreshedAt.getTime(),
                        expiresInSeconds: accessTokenTtl,
                    }
                );

                return {
                    accountId: current.accountId,
                    session: {
                        id: nextSession.id,
                        expiresAt: nextSession.expiresAt,
                    },
                    accessToken: access.token,
                    accessTokenExpiresAt: access.expiresAt,
                    refreshToken: nextRefreshToken,
                };
            });

            if (decision.error) {
                throw decision.error;
            }

            return Object.freeze({
                accountId: decision.accountId,
                session: Object.freeze(decision.session),
                accessToken: decision.accessToken,
                accessTokenExpiresAt:
                    decision.accessTokenExpiresAt,
                refreshToken: decision.refreshToken,
            });
        } catch (error) {
            if (error instanceof AccountCryptoError) {
                throw new AccountAuthError(
                    'invalid_refresh_token',
                    'The refresh token is invalid or expired.',
                    {
                        status: 401,
                        cause: error,
                    }
                );
            }

            throw mapUnexpectedFailure(error);
        }
    }

    async function authorizeAccessToken(input) {
        try {
            const values = requireObject(input, 'input');
            const installationId = requireInstallationId(
                values.installationId
            );
            const accessToken = requireNonEmptyString(
                values.accessToken,
                'accessToken',
                16_384
            );
            const checkedAt = nowDate(now);

            let claims;

            try {
                claims = verifyAgoraAccessToken(
                    accessToken,
                    resolvedCryptoConfig,
                    {
                        nowMilliseconds: checkedAt.getTime(),
                    }
                );
            } catch (error) {
                throw mapAccessTokenFailure(error);
            }

            if (claims.installationId !== installationId) {
                fail(
                    'invalid_access_token',
                    'The access token is invalid or expired.',
                    { status: 401 }
                );
            }

            const state = await repo.findAuthorizationState({
                accountId: claims.accountId,
                sessionId: claims.sessionId,
            });

            if (
                !state ||
                state.accountId !== claims.accountId ||
                state.sessionId !== claims.sessionId ||
                state.installationId !== installationId ||
                state.installationUnlinkedAt ||
                state.sessionRevokedAt ||
                state.sessionExpiresAt.getTime() <= checkedAt.getTime() ||
                state.accountStatus !== 'active' ||
                state.authVersion !== claims.authVersion
            ) {
                fail(
                    'invalid_access_token',
                    'The access token is invalid or expired.',
                    { status: 401 }
                );
            }

            return Object.freeze({
                accountId: claims.accountId,
                sessionId: claims.sessionId,
                installationId,
                authVersion: claims.authVersion,
                displayName: state.displayName ?? null,
                accessTokenExpiresAt: claims.expiresAt,
                sessionExpiresAt: state.sessionExpiresAt,
            });
        } catch (error) {
            throw mapUnexpectedFailure(error);
        }
    }

    async function decryptStoredAppleRefreshToken({
        encryptedRefreshToken,
        identityId,
        accountId,
        issuer,
        audience,
        subject,
    }) {
        try {
            return decryptAppleRefreshToken(
                encryptedRefreshToken,
                resolvedCryptoConfig,
                {
                    identityId: requireUuid(identityId, 'identityId'),
                    accountId: requireUuid(accountId, 'accountId'),
                    issuer: requireNonEmptyString(issuer, 'issuer', 255),
                    audience: requireNonEmptyString(
                        audience,
                        'audience',
                        255
                    ),
                    subject: requireNonEmptyString(
                        subject,
                        'subject',
                        255
                    ),
                }
            );
        } catch (error) {
            if (error instanceof AccountCryptoError) {
                throw new AccountAuthError(
                    'apple_credential_unavailable',
                    'The stored Apple credential is unavailable.',
                    {
                        status: 500,
                        cause: error,
                    }
                );
            }

            throw mapUnexpectedFailure(error);
        }
    }

    return Object.freeze({
        createAppleChallenge,
        signInWithApple,
        refreshSession,
        authorizeAccessToken,
        decryptStoredAppleRefreshToken,
    });
}

export const accountAuthConstants = Object.freeze({
    challengeLifetimeSeconds: DEFAULT_CHALLENGE_LIFETIME_SECONDS,
    accessTokenLifetimeSeconds: DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
    refreshSessionLifetimeSeconds:
        DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS,
    maximumChallengeFailures: MAX_CHALLENGE_FAILURES,
    sessionRevocationReasons: Object.freeze({
        rotated: SESSION_REVOCATION_REASON_ROTATED,
        reuse: SESSION_REVOCATION_REASON_REUSE,
        expired: SESSION_REVOCATION_REASON_EXPIRED,
        installationRelinked: SESSION_REVOCATION_REASON_RELINKED,
        reauthenticated: SESSION_REVOCATION_REASON_REAUTHENTICATED,
    }),
});
