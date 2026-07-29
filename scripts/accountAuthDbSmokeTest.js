// scripts/accountAuthDbSmokeTest.js
//
// Runs the real PostgreSQL account-auth repository queries against the
// configured database inside one transaction, then always rolls everything
// back. No test account, identity, challenge, installation, or session is
// retained after a successful run.

import '../env.js';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

import {
    createPostgresAccountAuthRepository,
} from '../lib/accountAuthService.js';

import {
    decryptAppleRefreshToken,
    encryptAppleRefreshToken,
    generateAgoraRefreshToken,
    hashToken,
    issueAgoraAccessToken,
    loadAccountCryptoConfig,
    verifyAgoraAccessToken,
} from '../lib/accountCrypto.js';

const { Pool } = pg;

const APPLE_ISSUER = 'https://appleid.apple.com';
const TEST_DISPLAY_NAME = 'Agora Auth DB Smoke Test';
const ROLLBACK_SENTINEL = Symbol('account-auth-smoke-test-rollback');

function requireDatabaseUrl() {
    const value = process.env.DATABASE_URL?.trim();

    if (!value) {
        throw new Error('DATABASE_URL is required.');
    }

    return value;
}

function createPool() {
    const connectionString = requireDatabaseUrl();

    return new Pool({
        connectionString,
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 1,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 10_000,
    });
}

function createTransactionBoundPool(client) {
    return {
        query(text, values) {
            return client.query(text, values);
        },

        async connect() {
            throw new Error(
                'Nested transactions are not supported by this smoke test.'
            );
        },
    };
}

function assertUuid(value, fieldName) {
    assert.match(
        value,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        `${fieldName} must be a UUID.`
    );
}

async function runSmokeTest() {
    const pool = createPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SET LOCAL lock_timeout = '5s'");

        const cryptoConfig = loadAccountCryptoConfig(process.env);
        const repository = createPostgresAccountAuthRepository(
            createTransactionBoundPool(client)
        );

        const uniqueSuffix = crypto.randomUUID();
        const installationId = `auth-smoke-${uniqueSuffix}`;
        const appleSubject = `auth-smoke-subject-${uniqueSuffix}`;
        const audience = process.env.APPLE_SIGN_IN_CLIENT_ID?.trim();

        assert.ok(
            audience,
            'APPLE_SIGN_IN_CLIENT_ID is required.'
        );

        const createdAt = new Date();
        const challengeExpiresAt = new Date(
            createdAt.getTime() + 10 * 60 * 1000
        );
        const challengeConsumedAt = new Date(
            createdAt.getTime() + 1_000
        );

        const signInChallenge = await repository.createChallenge({
            installationId,
            accountId: null,
            purpose: 'sign_in_with_apple',
            nonceSha256: crypto.randomBytes(32).toString('hex'),
            createdAt,
            expiresAt: challengeExpiresAt,
        });

        assertUuid(signInChallenge.id, 'challenge ID');
        assert.equal(
            signInChallenge.installationId,
            installationId
        );
        assert.equal(
            signInChallenge.purpose,
            'sign_in_with_apple'
        );
        assert.equal(signInChallenge.consumedAt, null);

        const lockedChallenge =
            await repository.findChallengeForUpdate(
                client,
                signInChallenge.id
            );

        assert.equal(lockedChallenge.id, signInChallenge.id);
        assert.equal(
            lockedChallenge.nonceSha256,
            signInChallenge.nonceSha256
        );

        assert.equal(
            await repository.consumeChallenge(
                client,
                signInChallenge.id,
                challengeConsumedAt
            ),
            true
        );
        assert.equal(
            await repository.consumeChallenge(
                client,
                signInChallenge.id,
                new Date(challengeConsumedAt.getTime() + 1_000)
            ),
            false
        );

        await repository.acquireAppleIdentityLock(client, {
            issuer: APPLE_ISSUER,
            audience,
            subject: appleSubject,
        });

        assert.equal(
            await repository.findAppleIdentityForUpdate(client, {
                issuer: APPLE_ISSUER,
                audience,
                subject: appleSubject,
            }),
            null
        );

        const account = await repository.createAccount(client, {
            displayName: TEST_DISPLAY_NAME,
            createdAt,
        });

        assertUuid(account.id, 'account ID');
        assert.equal(account.status, 'active');
        assert.equal(account.authVersion, 1);

        const identity = await repository.createAppleIdentity(
            client,
            {
                accountId: account.id,
                issuer: APPLE_ISSUER,
                audience,
                subject: appleSubject,
                email: 'auth-smoke@example.invalid',
                emailVerified: true,
                isPrivateEmail: false,
                createdAt,
            }
        );

        assertUuid(identity.identityId, 'Apple identity ID');
        assert.equal(identity.accountId, account.id);

        const identityBinding = {
            identityId: identity.identityId,
            accountId: account.id,
            issuer: APPLE_ISSUER,
            audience,
            subject: appleSubject,
        };

        const plaintextAppleRefreshToken =
            `apple-refresh-smoke-${uniqueSuffix}`;
        const encryptedAppleRefreshToken =
            encryptAppleRefreshToken(
                plaintextAppleRefreshToken,
                cryptoConfig,
                identityBinding
            );

        assert.equal(
            decryptAppleRefreshToken(
                encryptedAppleRefreshToken,
                cryptoConfig,
                identityBinding
            ),
            plaintextAppleRefreshToken
        );

        await repository.updateAppleIdentityCredential(client, {
            identityId: identity.identityId,
            email: 'auth-smoke@example.invalid',
            emailVerified: true,
            isPrivateEmail: false,
            encryptedRefreshToken: encryptedAppleRefreshToken,
            refreshTokenHash: hashToken(
                plaintextAppleRefreshToken
            ),
            encryptionKeyVersion:
                cryptoConfig.appleRefreshTokenEncryption
                    .activeVersion,
            authenticatedAt: createdAt,
        });

        await repository.updateAccountAuthenticated(client, {
            accountId: account.id,
            displayName: TEST_DISPLAY_NAME,
            authenticatedAt: createdAt,
        });

        const storedIdentity =
            await repository.findAppleIdentityForUpdate(client, {
                issuer: APPLE_ISSUER,
                audience,
                subject: appleSubject,
            });

        assert.equal(storedIdentity.identityId, identity.identityId);
        assert.equal(storedIdentity.accountId, account.id);
        assert.equal(storedIdentity.accountStatus, 'active');

        const reauthenticationChallenge =
            await repository.createChallenge({
                installationId,
                accountId: account.id,
                purpose: 'reauthenticate',
                nonceSha256: crypto.randomBytes(32).toString('hex'),
                createdAt,
                expiresAt: challengeExpiresAt,
            });

        assert.equal(
            reauthenticationChallenge.accountId,
            account.id
        );
        assert.equal(
            reauthenticationChallenge.purpose,
            'reauthenticate'
        );

        await repository.acquireInstallationLock(
            client,
            installationId
        );

        assert.equal(
            await repository.findActiveInstallationForUpdate(
                client,
                installationId
            ),
            null
        );

        const installation = await repository.createInstallation(
            client,
            {
                accountId: account.id,
                installationId,
                linkSource: 'sign_in_with_apple',
                linkedAt: createdAt,
                iosVersion: '3.8',
                iosBuild: 1,
            }
        );

        assertUuid(
            installation.id,
            'account installation ID'
        );
        assert.equal(installation.accountId, account.id);
        assert.equal(
            installation.installationId,
            installationId
        );

        const firstRefreshToken = generateAgoraRefreshToken();
        const firstSessionExpiresAt = new Date(
            createdAt.getTime() + 30 * 24 * 60 * 60 * 1000
        );

        const firstSession = await repository.createSession(
            client,
            {
                accountId: account.id,
                accountInstallationId: installation.id,
                tokenFamilyId: null,
                refreshTokenHash: hashToken(firstRefreshToken),
                rotatedFromSessionId: null,
                createdAt,
                expiresAt: firstSessionExpiresAt,
                ipAddressHash: hashToken('127.0.0.1'),
                userAgentHash: hashToken(
                    'Agora account-auth DB smoke test'
                ),
            }
        );

        assertUuid(firstSession.id, 'first session ID');
        assertUuid(
            firstSession.tokenFamilyId,
            'token family ID'
        );

        const refreshState =
            await repository.findRefreshSessionForUpdate(
                client,
                hashToken(firstRefreshToken)
            );

        assert.equal(refreshState.sessionId, firstSession.id);
        assert.equal(refreshState.accountId, account.id);
        assert.equal(
            refreshState.installationId,
            installationId
        );
        assert.equal(refreshState.revokedAt, null);
        assert.equal(
            await repository.hasReplacementSession(
                client,
                firstSession.id
            ),
            false
        );

        const firstAccessToken = issueAgoraAccessToken(
            {
                accountId: account.id,
                sessionId: firstSession.id,
                installationId,
                authVersion: account.authVersion,
            },
            cryptoConfig,
            {
                nowMilliseconds: createdAt.getTime(),
                expiresInSeconds: 15 * 60,
            }
        );

        const verifiedFirstAccessToken = verifyAgoraAccessToken(
            firstAccessToken.token,
            cryptoConfig,
            { nowMilliseconds: createdAt.getTime() }
        );

        assert.equal(
            verifiedFirstAccessToken.sessionId,
            firstSession.id
        );

        const firstAuthorizationState =
            await repository.findAuthorizationState({
                accountId: account.id,
                sessionId: firstSession.id,
            });

        assert.equal(
            firstAuthorizationState.sessionId,
            firstSession.id
        );
        assert.equal(
            firstAuthorizationState.accountStatus,
            'active'
        );
        assert.equal(
            firstAuthorizationState.installationId,
            installationId
        );

        const rotationTime = new Date(
            createdAt.getTime() + 2_000
        );

        assert.equal(
            await repository.markSessionRotated(client, {
                sessionId: firstSession.id,
                rotatedAt: rotationTime,
            }),
            true
        );

        const secondRefreshToken = generateAgoraRefreshToken();
        const secondSession = await repository.createSession(
            client,
            {
                accountId: account.id,
                accountInstallationId: installation.id,
                tokenFamilyId: firstSession.tokenFamilyId,
                refreshTokenHash: hashToken(secondRefreshToken),
                rotatedFromSessionId: firstSession.id,
                createdAt: rotationTime,
                expiresAt: new Date(
                    rotationTime.getTime() +
                    30 * 24 * 60 * 60 * 1000
                ),
                ipAddressHash: hashToken('127.0.0.1'),
                userAgentHash: hashToken(
                    'Agora account-auth DB smoke test'
                ),
            }
        );

        assertUuid(secondSession.id, 'replacement session ID');
        assert.equal(
            secondSession.tokenFamilyId,
            firstSession.tokenFamilyId
        );
        assert.equal(
            await repository.hasReplacementSession(
                client,
                firstSession.id
            ),
            true
        );

        const secondAuthorizationState =
            await repository.findAuthorizationState({
                accountId: account.id,
                sessionId: secondSession.id,
            });

        assert.equal(
            secondAuthorizationState.sessionId,
            secondSession.id
        );
        assert.equal(
            secondAuthorizationState.sessionRevokedAt,
            null
        );
        assert.equal(
            secondAuthorizationState.installationUnlinkedAt,
            null
        );

        const tableCounts = await client.query(
            `
                SELECT
                    (SELECT COUNT(*)::int
                     FROM accounts
                     WHERE id = $1) AS accounts,
                    (SELECT COUNT(*)::int
                     FROM account_apple_identities
                     WHERE account_id = $1) AS identities,
                    (SELECT COUNT(*)::int
                     FROM account_installations
                     WHERE account_id = $1) AS installations,
                    (SELECT COUNT(*)::int
                     FROM account_sessions
                     WHERE account_id = $1) AS sessions,
                    (SELECT COUNT(*)::int
                     FROM account_auth_challenges
                     WHERE installation_id = $2) AS challenges
            `,
            [account.id, installationId]
        );

        assert.deepEqual(tableCounts.rows[0], {
            accounts: 1,
            identities: 1,
            installations: 1,
            sessions: 2,
            challenges: 2,
        });

        console.log('✓ challenge creation, locking, and one-time consumption');
        console.log('✓ account and Apple identity persistence');
        console.log('✓ identity-bound Apple refresh-token encryption');
        console.log('✓ installation ownership and constraints');
        console.log('✓ refresh session creation and rotation chain');
        console.log('✓ access-token claims and database authorization state');
        console.log('✓ exact PostgreSQL repository queries match migration 002');

        throw ROLLBACK_SENTINEL;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error(
                'Account-auth DB smoke test could not roll back:',
                rollbackError
            );
            throw rollbackError;
        }

        if (error !== ROLLBACK_SENTINEL) {
            throw error;
        }

        console.log('✓ transaction rolled back; no smoke-test data was retained');
        console.log('All account-auth PostgreSQL smoke checks passed.');
    } finally {
        client.release();
        await pool.end();
    }
}

runSmokeTest().catch((error) => {
    console.error('Account-auth PostgreSQL smoke test failed.');
    console.error(
        error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
    );
    process.exitCode = 1;
});
