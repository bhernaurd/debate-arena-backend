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

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_REFRESH_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_DELETION_CHALLENGE_LIFETIME_SECONDS = 10 * 60;
const MAX_DELETION_CHALLENGE_LIFETIME_SECONDS = 15 * 60;
const MAX_CHALLENGE_FAILURES = 20;
const SESSION_REVOCATION_REASON_RELINKED = 'installation_relinked';
const SESSION_REVOCATION_REASON_REAUTHENTICATED = 'reauthenticated';
const SESSION_REVOCATION_REASON_ACCOUNT_DELETION = 'account_deletion';
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

function requireUuid(value, name) {
    const cleaned = requireString(value, name, 64);
    if (!UUID_RE.test(cleaned)) {
        fail('invalid_input', `${name} must be a UUID.`);
    }
    return cleaned.toLowerCase();
}

function requireInstallationId(value) {
    const cleaned = requireString(value, 'installationId', 128);
    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail('invalid_input', 'installationId has an invalid format.');
    }
    return cleaned;
}

function requirePositiveDuration(value, name, maximum) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        fail(
            'invalid_configuration',
            `${name} must be between 1 and ${maximum}.`,
            { status: 500 }
        );
    }
    return value;
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

function constantTimeStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    return leftBuffer.length === rightBuffer.length &&
        crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
        subject: row.subject ?? null,
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
    deletionChallengeLifetimeSeconds = DEFAULT_DELETION_CHALLENGE_LIFETIME_SECONDS,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        fail('invalid_configuration', 'A PostgreSQL pool is required.', { status: 500 });
    }
    const repo = repository ?? createPostgresAccountAuthRepository(pool);
    let resolvedCryptoConfig = accountCryptoConfig;
    const verify = verifyGoogleIdToken ?? createGoogleIdTokenVerifier({
        clientId: googleClientId,
        now,
    });
    const deletionChallengeTtl = requirePositiveDuration(
        deletionChallengeLifetimeSeconds,
        'deletionChallengeLifetimeSeconds',
        MAX_DELETION_CHALLENGE_LIFETIME_SECONDS
    );

    function cryptoConfig() {
        if (resolvedCryptoConfig == null) {
            resolvedCryptoConfig = loadAccountCryptoConfig();
        }
        return resolvedCryptoConfig;
    }

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
                    gi.subject,
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

    async function findDeletionIdentityForUpdate(tx, { accountId, audience }) {
        const result = await tx.query(
            `
                /* google-account-auth:find-deletion-identity-for-update */
                SELECT
                    gi.id AS identity_id,
                    gi.account_id,
                    gi.subject,
                    a.status AS account_status,
                    a.auth_version,
                    a.display_name AS account_display_name
                FROM account_google_identities gi
                JOIN accounts a ON a.id = gi.account_id
                WHERE gi.account_id = $1
                  AND gi.issuer = $2
                  AND gi.audience = $3
                FOR UPDATE OF gi, a
            `,
            [accountId, CANONICAL_GOOGLE_ISSUER, audience]
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
            subject: identity.subject,
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

    async function createGoogleDeletionRequest(tx, { accountId, requestedAt }) {
        const result = await tx.query(
            `
                /* google-account-auth:create-deletion-request */
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
        if (result.rowCount !== 1) return null;
        return { id: result.rows[0].id, accountId };
    }

    async function finalizeGoogleAccountDeletion(
        tx,
        { accountId, requestId, completedAt }
    ) {
        const accountResult = await tx.query(
            `
                /* google-account-auth:lock-account-for-deletion-finalize */
                SELECT id
                FROM accounts
                WHERE id = $1
                  AND status = 'deletion_pending'
                FOR UPDATE
            `,
            [accountId]
        );
        if (accountResult.rowCount !== 1) return false;

        await tx.query(
            `
                /* google-account-auth:release-subscription-ownership */
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
            [accountId, completedAt]
        );

        await tx.query(
            `DELETE FROM affiliate_account_referrals WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `UPDATE affiliate_subscription_attributions SET account_id = NULL WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `UPDATE affiliate_referral_handoffs SET account_id = NULL WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_achievement_unlocks WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_daily_challenge_progress WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_debate_history WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_ranked_profiles WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_sessions WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
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
        await tx.query(
            `DELETE FROM account_installations WHERE account_id = $1`,
            [accountId]
        );
        await tx.query(
            `DELETE FROM account_google_identities WHERE account_id = $1`,
            [accountId]
        );

        const deletedAccount = await tx.query(
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
            [accountId, completedAt]
        );
        if (deletedAccount.rowCount !== 1) return false;

        const requestResult = await tx.query(
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
            [requestId, accountId, completedAt]
        );
        return requestResult.rowCount === 1;
    }

    async function consumeDeletionChallenge({
        challengeId,
        installationId,
        accountId,
        rawNonce,
    }) {
        const normalizedChallengeId = requireUuid(challengeId, 'challengeId');
        const normalizedInstallationId = requireInstallationId(installationId);
        const normalizedAccountId = requireUuid(accountId, 'accountId');
        const normalizedRawNonce = requireString(rawNonce, 'rawNonce', 512);
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
                challenge.accountId !== normalizedAccountId ||
                challenge.purpose !== 'delete_account'
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
            if (!constantTimeHexEqual(challenge.nonceSha256, presentedHash)) {
                await repo.recordChallengeFailure(tx, challenge.id, attemptedAt);
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

        if (decision.error) throw decision.error;
        return decision.challenge;
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
                cryptoConfig(),
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

    async function createDeletionChallenge(input) {
        const values = requireObject(input, 'input');
        const installationId = requireInstallationId(values.installationId);
        const accountId = requireUuid(values.accountId, 'accountId');
        const createdAt = nowDate(now);
        const expiresAt = addSeconds(createdAt, deletionChallengeTtl);
        const rawNonce = crypto.randomBytes(32).toString('base64url');
        const nonceSha256 = hashToken(rawNonce);
        const challenge = await repo.createChallenge({
            installationId,
            accountId,
            purpose: 'delete_account',
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
    }

    async function deleteAccount(input) {
        let deletionContext = null;
        try {
            const values = requireObject(input, 'input');
            const accountId = requireUuid(values.accountId, 'accountId');
            const installationId = requireInstallationId(values.installationId);
            const idToken = requireString(values.idToken, 'idToken', 32_768);
            const rawNonce = requireString(values.rawNonce, 'rawNonce', 512);

            await consumeDeletionChallenge({
                challengeId: values.challengeId,
                installationId,
                accountId,
                rawNonce,
            });

            let credentialIdentity;
            try {
                credentialIdentity = await verify(idToken, {
                    expectedNonce: rawNonce,
                });
            } catch (error) {
                throw mapGoogleFailure(error);
            }

            const requestedAt = nowDate(now);
            deletionContext = await repo.withTransaction(async (tx) => {
                const identity = await findDeletionIdentityForUpdate(tx, {
                    accountId,
                    audience: credentialIdentity.audience,
                });
                if (!identity) {
                    fail(
                        'account_identity_unavailable',
                        'The Google identity for this account is unavailable.',
                        { status: 409 }
                    );
                }
                assertActiveAccount(identity.accountStatus);
                if (
                    identity.accountId !== accountId ||
                    !constantTimeStringEqual(
                        identity.subject,
                        credentialIdentity.subject
                    )
                ) {
                    fail(
                        'invalid_google_credential',
                        'The Google sign-in credential could not be verified.',
                        { status: 401 }
                    );
                }

                const request = await createGoogleDeletionRequest(tx, {
                    accountId,
                    requestedAt,
                });
                if (!request) {
                    fail(
                        'account_deletion_in_progress',
                        'Account deletion is already in progress.',
                        { status: 409 }
                    );
                }

                const markedPending = await repo.markAccountDeletionPending(
                    tx,
                    { accountId, requestedAt }
                );
                if (!markedPending) {
                    fail(
                        'account_unavailable',
                        'This account is unavailable.',
                        { status: 403 }
                    );
                }

                await repo.revokeAllAccountSessions(tx, {
                    accountId,
                    revokedAt: requestedAt,
                    reason: SESSION_REVOCATION_REASON_ACCOUNT_DELETION,
                });

                return {
                    accountId,
                    requestId: request.id,
                    requestedAt,
                };
            });

            const completedAt = nowDate(now);
            try {
                await repo.withTransaction(async (tx) => {
                    const finalized = await finalizeGoogleAccountDeletion(tx, {
                        accountId,
                        requestId: deletionContext.requestId,
                        completedAt,
                    });
                    if (!finalized) {
                        throw new AccountAuthError(
                            'account_deletion_conflict',
                            'Account deletion could not be completed.',
                            { status: 503, retryable: true }
                        );
                    }
                });
            } catch (error) {
                try {
                    await repo.withTransaction(async (tx) => {
                        await repo.failAccountDeletion(tx, {
                            accountId,
                            requestId: deletionContext.requestId,
                            failedAt: nowDate(now),
                            appleRevocationStatus: 'not_required',
                            errorCode: 'account_deletion_finalize_failed',
                            errorMessage: 'Account deletion finalization failed.',
                        });
                    });
                } catch {
                    // Preserve the finalization failure for support recovery.
                }
                throw new AccountAuthError(
                    'account_deletion_unavailable',
                    'Account deletion could not be completed. Please try again.',
                    { status: 503, retryable: true, cause: error }
                );
            }

            return Object.freeze({
                accountId,
                status: 'deleted',
                deletedAt: completedAt,
                appleRevocationStatus: 'not_required',
            });
        } catch (error) {
            if (error instanceof AccountAuthError) throw error;
            if (error instanceof GoogleSignInError) throw mapGoogleFailure(error);
            throw new AccountAuthError(
                'account_authentication_unavailable',
                'Account authentication is temporarily unavailable.',
                { status: 503, retryable: true, cause: error }
            );
        }
    }

    return Object.freeze({
        signInWithGoogle,
        createDeletionChallenge,
        deleteAccount,
    });
}
