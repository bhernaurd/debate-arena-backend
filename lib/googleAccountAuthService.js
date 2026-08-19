import crypto from 'crypto';

import {
    AccountAuthError,
    createPostgresAccountAuthRepository,
} from './accountAuthService.js';
import {
    generateAgoraRefreshToken,
    hashToken,
    issueAgoraAccessToken,
    loadAccountCryptoConfig,
} from './accountCrypto.js';
import {
    GoogleSignInError,
    createGoogleIdTokenVerifier,
} from './googleSignIn.js';

const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SESSION_REVOCATION_REASON_RELINKED = 'installation_relinked';
const SESSION_REVOCATION_REASON_REAUTHENTICATED = 'reauthenticated';
const CANONICAL_GOOGLE_ISSUER = 'https://accounts.google.com';

function fail(code, message, { status = 400, retryable = false, cause } = {}) {
    throw new AccountAuthError(code, message, { status, retryable, cause });
}

function requireObject(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('invalid_input', `${name} must be an object.`);
    }
    return value;
}

function requireString(value, name, maximum) {
    if (typeof value !== 'string') fail('invalid_input', `${name} must be a string.`);
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) {
        fail('invalid_input', `${name} is invalid.`);
    }
    return cleaned;
}

function requireInstallationId(value) {
    const cleaned = requireString(value, 'installationId', 128);
    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail('invalid_input', 'installationId has an invalid format.');
    }
    return cleaned;
}

function nowDate(now) {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
        fail('invalid_configuration', 'now() returned an invalid value.', { status: 500 });
    }
    return new Date(value);
}

function addSeconds(date, seconds) {
    return new Date(date.getTime() + seconds * 1000);
}

function metadataHash(value, maximum) {
    if (value == null || typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return crypto.createHash('sha256').update(cleaned, 'utf8').digest('hex');
}

function assertActiveAccount(status) {
    if (status === 'active') return;
    if (status === 'locked') fail('account_locked', 'This account is locked.', { status: 403 });
    if (status === 'deletion_pending') {
        fail('account_deletion_pending', 'This account is pending deletion.', { status: 403 });
    }
    fail('account_unavailable', 'This account is unavailable.', { status: 403 });
}

function mapGoogleFailure(error) {
    if (!(error instanceof GoogleSignInError)) return error;
    return new AccountAuthError(
        error.code || 'invalid_google_credential',
        error.status >= 500
            ? 'Google authentication is temporarily unavailable.'
            : 'The Google sign-in credential could not be verified.',
        {
            status: error.status,
            retryable: error.retryable,
            cause: error,
        }
    );
}

function normalizeIdentityRow(row) {
    if (!row) return null;
    return {
        identityId: row.identity_id,
        accountId: row.account_id,
        accountStatus: row.account_status,
        authVersion: Number(row.auth_version),
        displayName: row.account_display_name,
    };
}

/**
 * Google-only Android auth. Apple identities are deliberately never queried,
 * matched by email, or merged here. The sole provider key is Google's verified
 * OpenID Connect `sub` under the configured audience.
 */
export function createGoogleAccountAuthService({
    pool,
    repository = null,
    verifyGoogleIdToken = null,
    googleClientId = process.env.GOOGLE_ANDROID_WEB_CLIENT_ID ?? '',
    accountCryptoConfig = null,
    now = () => Date.now(),
    accessTokenLifetimeSeconds = DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
    refreshSessionLifetimeSeconds = DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        fail('invalid_configuration', 'A PostgreSQL pool is required.', { status: 500 });
    }
    const repo = repository ?? createPostgresAccountAuthRepository(pool);
    const cryptoConfig = accountCryptoConfig ?? loadAccountCryptoConfig();
    const verify = verifyGoogleIdToken ?? createGoogleIdTokenVerifier({
        clientId: googleClientId,
        now,
    });

    async function acquireIdentityLock(tx, { audience, subject }) {
        await tx.query(
            `
                /* google-account-auth:lock-identity */
                SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
            `,
            [JSON.stringify(['google', CANONICAL_GOOGLE_ISSUER, audience, subject])]
        );
    }

    async function findIdentityForUpdate(tx, { audience, subject }) {
        const result = await tx.query(
            `
                /* google-account-auth:find-identity-for-update */
                SELECT
                    gi.id AS identity_id,
                    gi.account_id,
                    a.status AS account_status,
                    a.auth_version,
                    a.display_name AS account_display_name
                FROM account_google_identities gi
                JOIN accounts a ON a.id = gi.account_id
                WHERE gi.issuer = $1
                  AND gi.audience = $2
                  AND gi.subject = $3
                FOR UPDATE OF gi, a
            `,
            [CANONICAL_GOOGLE_ISSUER, audience, subject]
        );
        return normalizeIdentityRow(result.rows[0]);
    }

    async function createIdentity(tx, { accountId, identity, authenticatedAt }) {
        const result = await tx.query(
            `
                /* google-account-auth:create-identity */
                INSERT INTO account_google_identities (
                    account_id,
                    issuer,
                    audience,
                    subject,
                    email,
                    email_verified,
                    display_name,
                    picture_url,
                    created_at,
                    updated_at,
                    last_authenticated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)
                RETURNING id
            `,
            [
                accountId,
                CANONICAL_GOOGLE_ISSUER,
                identity.audience,
                identity.subject,
                identity.email,
                identity.emailVerified,
                identity.displayName,
                identity.pictureUrl,
                authenticatedAt,
            ]
        );
        return {
            identityId: result.rows[0].id,
            accountId,
            accountStatus: 'active',
            authVersion: 1,
            displayName: identity.displayName,
        };
    }

    async function touchIdentity(tx, { identityId, identity, authenticatedAt }) {
        await tx.query(
            `
                /* google-account-auth:touch-identity */
                UPDATE account_google_identities
                SET
                    email = COALESCE($2, email),
                    email_verified = COALESCE($3, email_verified),
                    display_name = COALESCE($4, display_name),
                    picture_url = COALESCE($5, picture_url),
                    last_authenticated_at = $6,
                    updated_at = $6
                WHERE id = $1
            `,
            [
                identityId,
                identity.email,
                identity.emailVerified,
                identity.displayName,
                identity.pictureUrl,
                authenticatedAt,
            ]
        );
    }

    async function signInWithGoogle(input) {
        const values = requireObject(input, 'input');
        const installationId = requireInstallationId(values.installationId);
        const idToken = requireString(values.idToken, 'idToken', 32_768);
        const nonce = requireString(values.nonce, 'nonce', 1024);
        const ipAddressHash = metadataHash(values.ipAddress, 256);
        const userAgentHash = metadataHash(values.userAgent, 2048);

        let identity;
        try {
            identity = await verify(idToken, { expectedNonce: nonce });
        } catch (error) {
            throw mapGoogleFailure(error);
        }

        const authenticatedAt = nowDate(now);
        const sessionExpiresAt = addSeconds(authenticatedAt, refreshSessionLifetimeSeconds);

        return repo.withTransaction(async (tx) => {
            await acquireIdentityLock(tx, identity);
            await repo.acquireInstallationLock(tx, installationId);

            let providerIdentity = await findIdentityForUpdate(tx, identity);
            let account;
            let isNewAccount = false;

            if (providerIdentity) {
                assertActiveAccount(providerIdentity.accountStatus);
                account = {
                    id: providerIdentity.accountId,
                    status: providerIdentity.accountStatus,
                    authVersion: providerIdentity.authVersion,
                    displayName: providerIdentity.displayName,
                };
            } else {
                account = await repo.createAccount(tx, {
                    displayName: identity.displayName,
                    createdAt: authenticatedAt,
                });
                providerIdentity = await createIdentity(tx, {
                    accountId: account.id,
                    identity,
                    authenticatedAt,
                });
                isNewAccount = true;
            }

            await touchIdentity(tx, {
                identityId: providerIdentity.identityId,
                identity,
                authenticatedAt,
            });
            await repo.updateAccountAuthenticated(tx, {
                accountId: account.id,
                displayName: identity.displayName,
                authenticatedAt,
            });

            let installation = await repo.findActiveInstallationForUpdate(tx, installationId);
            if (installation && installation.accountId !== account.id) {
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
                    iosVersion: null,
                    iosBuild: null,
                });
            } else {
                installation = await repo.createInstallation(tx, {
                    accountId: account.id,
                    installationId,
                    linkSource: 'sign_in_with_google',
                    linkedAt: authenticatedAt,
                    iosVersion: null,
                    iosBuild: null,
                });
            }

            const refreshToken = generateAgoraRefreshToken();
            const session = await repo.createSession(tx, {
                accountId: account.id,
                accountInstallationId: installation.id,
                tokenFamilyId: null,
                refreshTokenHash: hashToken(refreshToken),
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
                cryptoConfig,
                {
                    nowMilliseconds: authenticatedAt.getTime(),
                    expiresInSeconds: accessTokenLifetimeSeconds,
                }
            );

            return Object.freeze({
                account: Object.freeze({
                    id: account.id,
                    status: account.status,
                    authVersion: account.authVersion,
                    displayName: account.displayName ?? identity.displayName ?? null,
                    isNewAccount,
                }),
                session: Object.freeze({
                    id: session.id,
                    expiresAt: session.expiresAt,
                }),
                accessToken: access.token,
                accessTokenExpiresAt: access.expiresAt,
                refreshToken,
            });
        });
    }

    return Object.freeze({ signInWithGoogle });
}
