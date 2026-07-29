import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    AccountAuthError,
    accountAuthConstants,
    createAccountAuthService,
} from '../lib/accountAuthService.js';

import {
    hashToken,
    loadAccountCryptoConfig,
} from '../lib/accountCrypto.js';

import { AppleSignInError } from '../lib/appleSignIn.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_AUDIENCE = 'com.bhernaurd.TheAgora';
const NOW_MS = Date.UTC(2026, 6, 28, 18, 0, 0);

function cloneState(state) {
    return structuredClone(state);
}

class MemoryAccountAuthRepository {
    constructor() {
        this.state = {
            challenges: new Map(),
            accounts: new Map(),
            identities: new Map(),
            installations: new Map(),
            sessions: new Map(),
            deletionRequests: new Map(),
            subscriptionOwnership: new Map(),
            achievementUnlocks: new Map(),
            debateHistory: new Map(),
            dailyChallengeProgress: new Map(),
        };
    }

    async withTransaction(work) {
        const transaction = {
            state: cloneState(this.state),
        };

        const result = await work(transaction);
        this.state = transaction.state;
        return result;
    }

    async createChallenge({
        installationId,
        accountId,
        purpose,
        nonceSha256,
        createdAt,
        expiresAt,
    }) {
        const id = crypto.randomUUID();
        const row = {
            id,
            installationId,
            accountId,
            purpose,
            nonceSha256,
            createdAt: new Date(createdAt),
            expiresAt: new Date(expiresAt),
            consumedAt: null,
            failedAttempts: 0,
        };

        this.state.challenges.set(id, row);
        return cloneState(row);
    }

    async findChallengeForUpdate(tx, challengeId) {
        const row = tx.state.challenges.get(challengeId);
        return row ? cloneState(row) : null;
    }

    async recordChallengeFailure(tx, challengeId, attemptedAt) {
        const row = tx.state.challenges.get(challengeId);
        row.failedAttempts = Math.min(
            row.failedAttempts + 1,
            accountAuthConstants.maximumChallengeFailures
        );

        if (
            row.failedAttempts >=
            accountAuthConstants.maximumChallengeFailures
        ) {
            row.consumedAt = new Date(attemptedAt);
        }
    }

    async consumeChallenge(tx, challengeId, consumedAt) {
        const row = tx.state.challenges.get(challengeId);

        if (!row || row.consumedAt) return false;

        row.consumedAt = new Date(consumedAt);
        return true;
    }

    async acquireAppleIdentityLock() {}

    async acquireInstallationLock() {}

    async findAppleIdentityForUpdate(
        tx,
        { issuer, audience, subject }
    ) {
        const identity = [...tx.state.identities.values()].find(
            (candidate) =>
                candidate.issuer === issuer &&
                candidate.audience === audience &&
                candidate.subject === subject
        );

        if (!identity) return null;

        const account = tx.state.accounts.get(identity.accountId);

        return {
            identityId: identity.identityId,
            accountId: identity.accountId,
            issuer: identity.issuer,
            audience: identity.audience,
            subject: identity.subject,
            accountStatus: account.status,
            authVersion: account.authVersion,
            displayName: account.displayName,
        };
    }

    async createAccount(tx, { displayName, createdAt }) {
        const id = crypto.randomUUID();
        const account = {
            id,
            status: 'active',
            authVersion: 1,
            displayName,
            createdAt: new Date(createdAt),
            updatedAt: new Date(createdAt),
            lastAuthenticatedAt: new Date(createdAt),
        };

        tx.state.accounts.set(id, account);
        return cloneState(account);
    }

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
        const identityId = crypto.randomUUID();
        const identity = {
            identityId,
            accountId,
            issuer,
            audience,
            subject,
            email,
            emailVerified,
            isPrivateEmail,
            authorizationStatus: 'active',
            encryptedRefreshToken: null,
            refreshTokenHash: null,
            encryptionKeyVersion: null,
            createdAt: new Date(createdAt),
            updatedAt: new Date(createdAt),
            lastAuthenticatedAt: new Date(createdAt),
        };

        tx.state.identities.set(identityId, identity);

        return {
            identityId,
            accountId,
            issuer,
            audience,
            subject,
        };
    }

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
        const identity = tx.state.identities.get(identityId);

        if (email != null) identity.email = email;
        if (emailVerified != null) {
            identity.emailVerified = emailVerified;
        }
        if (isPrivateEmail != null) {
            identity.isPrivateEmail = isPrivateEmail;
        }

        identity.authorizationStatus = 'active';
        identity.encryptedRefreshToken = encryptedRefreshToken;
        identity.refreshTokenHash = refreshTokenHash;
        identity.encryptionKeyVersion = encryptionKeyVersion;
        identity.refreshTokenReceivedAt = new Date(authenticatedAt);
        identity.refreshTokenLastValidatedAt = new Date(authenticatedAt);
        identity.credentialRevokedAt = null;
        identity.updatedAt = new Date(authenticatedAt);
        identity.lastAuthenticatedAt = new Date(authenticatedAt);
    }

    async updateAccountAuthenticated(
        tx,
        { accountId, displayName, authenticatedAt }
    ) {
        const account = tx.state.accounts.get(accountId);

        if (account.displayName == null && displayName != null) {
            account.displayName = displayName;
        }

        account.lastAuthenticatedAt = new Date(authenticatedAt);
        account.updatedAt = new Date(authenticatedAt);
    }

    async findActiveInstallationForUpdate(tx, installationId) {
        const row = [...tx.state.installations.values()].find(
            (candidate) =>
                candidate.installationId === installationId &&
                candidate.unlinkedAt == null
        );

        return row ? cloneState(row) : null;
    }

    async revokeActiveSessionsForInstallation(
        tx,
        { accountInstallationId, revokedAt, reason }
    ) {
        for (const session of tx.state.sessions.values()) {
            if (
                session.accountInstallationId === accountInstallationId &&
                session.revokedAt == null
            ) {
                session.revokedAt = new Date(revokedAt);
                session.revocationReason = reason;
                session.lastUsedAt = new Date(revokedAt);
            }
        }
    }

    async unlinkInstallation(
        tx,
        { accountInstallationId, unlinkedAt }
    ) {
        const row = tx.state.installations.get(accountInstallationId);
        row.unlinkedAt = new Date(unlinkedAt);
        row.updatedAt = new Date(unlinkedAt);
    }

    async touchInstallation(
        tx,
        {
            accountInstallationId,
            seenAt,
            iosVersion,
            iosBuild,
        }
    ) {
        const row = tx.state.installations.get(accountInstallationId);
        row.lastSeenAt = new Date(seenAt);
        row.updatedAt = new Date(seenAt);
        if (iosVersion != null) row.lastIosVersion = iosVersion;
        if (iosBuild != null) row.lastIosBuild = iosBuild;
    }

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
        const id = crypto.randomUUID();
        const row = {
            id,
            accountId,
            installationId,
            linkSource,
            linkedAt: new Date(linkedAt),
            lastSeenAt: new Date(linkedAt),
            unlinkedAt: null,
            lastIosVersion: iosVersion,
            lastIosBuild: iosBuild,
            createdAt: new Date(linkedAt),
            updatedAt: new Date(linkedAt),
        };

        tx.state.installations.set(id, row);
        return cloneState(row);
    }

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
        const id = crypto.randomUUID();
        const familyId = tokenFamilyId ?? crypto.randomUUID();
        const row = {
            id,
            accountId,
            accountInstallationId,
            tokenFamilyId: familyId,
            refreshTokenHash,
            rotatedFromSessionId,
            createdAt: new Date(createdAt),
            lastUsedAt: new Date(createdAt),
            expiresAt: new Date(expiresAt),
            revokedAt: null,
            revocationReason: null,
            ipAddressHash,
            userAgentHash,
        };

        tx.state.sessions.set(id, row);

        return {
            id,
            tokenFamilyId: familyId,
            expiresAt: new Date(expiresAt),
        };
    }

    async findRefreshSessionForUpdate(tx, refreshTokenHash) {
        const session = [...tx.state.sessions.values()].find(
            (candidate) =>
                candidate.refreshTokenHash === refreshTokenHash
        );

        if (!session) return null;

        const account = tx.state.accounts.get(session.accountId);
        const installation = tx.state.installations.get(
            session.accountInstallationId
        );

        return {
            sessionId: session.id,
            accountId: session.accountId,
            accountInstallationId: session.accountInstallationId,
            tokenFamilyId: session.tokenFamilyId,
            createdAt: new Date(session.createdAt),
            expiresAt: new Date(session.expiresAt),
            revokedAt: session.revokedAt
                ? new Date(session.revokedAt)
                : null,
            revocationReason: session.revocationReason,
            accountStatus: account.status,
            authVersion: account.authVersion,
            installationId: installation.installationId,
            installationUnlinkedAt: installation.unlinkedAt
                ? new Date(installation.unlinkedAt)
                : null,
        };
    }

    async hasReplacementSession(tx, sessionId) {
        return [...tx.state.sessions.values()].some(
            (candidate) =>
                candidate.rotatedFromSessionId === sessionId
        );
    }

    async revokeSession(tx, { sessionId, revokedAt, reason }) {
        const session = tx.state.sessions.get(sessionId);

        if (session.revokedAt == null) {
            session.revokedAt = new Date(revokedAt);
            session.revocationReason = reason;
        }

        session.lastUsedAt = new Date(revokedAt);
    }

    async revokeSessionFamily(
        tx,
        { tokenFamilyId, revokedAt, reason }
    ) {
        for (const session of tx.state.sessions.values()) {
            if (
                session.tokenFamilyId === tokenFamilyId &&
                session.revokedAt == null
            ) {
                session.revokedAt = new Date(revokedAt);
                session.revocationReason = reason;
                session.lastUsedAt = new Date(revokedAt);
            }
        }
    }

    async markSessionRotated(tx, { sessionId, rotatedAt }) {
        const session = tx.state.sessions.get(sessionId);

        if (!session || session.revokedAt) return false;

        session.revokedAt = new Date(rotatedAt);
        session.revocationReason = 'rotated';
        session.lastUsedAt = new Date(rotatedAt);
        return true;
    }


    async findDeletionIdentityForUpdate(
        tx,
        { accountId, issuer, audience }
    ) {
        const identity = [...tx.state.identities.values()].find(
            (candidate) =>
                candidate.accountId === accountId &&
                candidate.issuer === issuer &&
                candidate.audience === audience
        );

        if (!identity) return null;

        const account = tx.state.accounts.get(accountId);

        return {
            identityId: identity.identityId,
            accountId: identity.accountId,
            issuer: identity.issuer,
            audience: identity.audience,
            subject: identity.subject,
            encryptedRefreshToken: identity.encryptedRefreshToken,
            accountStatus: account.status,
            authVersion: account.authVersion,
            displayName: account.displayName,
        };
    }

    async createDeletionRequest(
        tx,
        { accountId, requestedAt }
    ) {
        const active = [...tx.state.deletionRequests.values()].find(
            (candidate) =>
                candidate.accountId === accountId &&
                ['pending', 'processing'].includes(candidate.status)
        );

        if (active) return null;

        const id = crypto.randomUUID();
        const row = {
            id,
            accountId,
            status: 'processing',
            requestSource: 'ios_app',
            appleRevocationStatus: 'pending',
            requestedAt: new Date(requestedAt),
            processingStartedAt: new Date(requestedAt),
            completedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            createdAt: new Date(requestedAt),
            updatedAt: new Date(requestedAt),
        };

        tx.state.deletionRequests.set(id, row);

        return {
            id,
            accountId,
        };
    }

    async markAccountDeletionPending(
        tx,
        { accountId, requestedAt }
    ) {
        const account = tx.state.accounts.get(accountId);

        if (!account || account.status !== 'active') {
            return false;
        }

        account.status = 'deletion_pending';
        account.authVersion += 1;
        account.deletionRequestedAt = new Date(requestedAt);
        account.updatedAt = new Date(requestedAt);
        return true;
    }

    async revokeAllAccountSessions(
        tx,
        { accountId, revokedAt, reason }
    ) {
        for (const session of tx.state.sessions.values()) {
            if (session.accountId !== accountId) continue;

            if (session.revokedAt == null) {
                session.revokedAt = new Date(revokedAt);
                session.revocationReason = reason;
            }

            session.lastUsedAt = new Date(revokedAt);
        }
    }

    async failAccountDeletion(
        tx,
        {
            accountId,
            requestId,
            failedAt,
            appleRevocationStatus,
            errorCode,
            errorMessage,
        }
    ) {
        const request = tx.state.deletionRequests.get(requestId);

        if (
            request &&
            request.accountId === accountId &&
            request.status === 'processing'
        ) {
            request.status = 'failed';
            request.appleRevocationStatus = appleRevocationStatus;
            request.lastErrorCode = errorCode;
            request.lastErrorMessage = errorMessage;
            request.updatedAt = new Date(failedAt);
        }

        const account = tx.state.accounts.get(accountId);

        if (account?.status === 'deletion_pending') {
            account.status = 'active';
            account.authVersion += 1;
            account.deletionRequestedAt = null;
            account.updatedAt = new Date(failedAt);
        }
    }

    async finalizeAccountDeletion(
        tx,
        {
            accountId,
            requestId,
            completedAt,
            appleRevocationStatus,
        }
    ) {
        const account = tx.state.accounts.get(accountId);
        const request = tx.state.deletionRequests.get(requestId);

        if (
            !account ||
            account.status !== 'deletion_pending' ||
            !request ||
            request.accountId !== accountId ||
            request.status !== 'processing'
        ) {
            return false;
        }

        const installationIds = new Set(
            [...tx.state.installations.values()]
                .filter((row) => row.accountId === accountId)
                .map((row) => row.installationId)
        );

        for (const ownership of tx.state.subscriptionOwnership.values()) {
            if (
                ownership.accountId === accountId &&
                ownership.ownershipStatus !== 'released'
            ) {
                ownership.ownershipStatus = 'released';
                ownership.releasedAt =
                    ownership.releasedAt ?? new Date(completedAt);
                ownership.claimedFromInstallationId = null;
                ownership.observedAppAccountToken = null;
                ownership.updatedAt = new Date(completedAt);
            }
        }

        for (const [key, row] of tx.state.achievementUnlocks) {
            if (row.accountId === accountId) {
                tx.state.achievementUnlocks.delete(key);
            }
        }

        for (const [key, row] of tx.state.debateHistory) {
            if (row.accountId === accountId) {
                tx.state.debateHistory.delete(key);
            }
        }

        for (const [key, row] of tx.state.dailyChallengeProgress) {
            if (row.accountId === accountId) {
                tx.state.dailyChallengeProgress.delete(key);
            }
        }

        for (const [key, row] of tx.state.sessions) {
            if (row.accountId === accountId) {
                tx.state.sessions.delete(key);
            }
        }

        for (const [key, row] of tx.state.challenges) {
            if (
                row.accountId === accountId ||
                installationIds.has(row.installationId)
            ) {
                tx.state.challenges.delete(key);
            }
        }

        for (const [key, row] of tx.state.installations) {
            if (row.accountId === accountId) {
                tx.state.installations.delete(key);
            }
        }

        for (const [key, row] of tx.state.identities) {
            if (row.accountId === accountId) {
                tx.state.identities.delete(key);
            }
        }

        account.status = 'deleted';
        account.authVersion += 1;
        account.displayName = null;
        account.lastAuthenticatedAt = null;
        account.deletedAt = new Date(completedAt);
        account.updatedAt = new Date(completedAt);

        request.status = 'completed';
        request.appleRevocationStatus = appleRevocationStatus;
        request.completedAt = new Date(completedAt);
        request.lastErrorCode = null;
        request.lastErrorMessage = null;
        request.updatedAt = new Date(completedAt);

        return true;
    }

    async findAuthorizationState({ accountId, sessionId }) {
        const session = this.state.sessions.get(sessionId);

        if (!session || session.accountId !== accountId) return null;

        const account = this.state.accounts.get(accountId);
        const installation = this.state.installations.get(
            session.accountInstallationId
        );

        return {
            sessionId,
            accountId,
            accountStatus: account.status,
            authVersion: account.authVersion,
            sessionExpiresAt: new Date(session.expiresAt),
            sessionRevokedAt: session.revokedAt
                ? new Date(session.revokedAt)
                : null,
            installationId: installation.installationId,
            installationUnlinkedAt: installation.unlinkedAt
                ? new Date(installation.unlinkedAt)
                : null,
            displayName: account.displayName,
        };
    }
}

function makeCryptoConfig() {
    return loadAccountCryptoConfig({
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION: '1',
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V1:
            crypto.randomBytes(32).toString('base64'),
        AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION: '1',
        AGORA_ACCESS_TOKEN_SIGNING_KEY_V1:
            crypto.randomBytes(64).toString('base64'),
    });
}

function appleIdentity(subject = 'apple-subject-1') {
    return Object.freeze({
        issuer: APPLE_ISSUER,
        audience: APPLE_AUDIENCE,
        subject,
        email: `${subject}@privaterelay.appleid.com`,
        emailVerified: true,
        isPrivateEmail: true,
        issuedAt: Math.floor(NOW_MS / 1_000),
        expiresAt: Math.floor(NOW_MS / 1_000) + 300,
    });
}

function makeAppleDependencies({
    credentialSubject = 'apple-subject-1',
    exchangedSubject = credentialSubject,
    refreshToken = 'apple-refresh-token-1',
    exchangeError = null,
    revokeError = null,
} = {}) {
    const calls = {
        verify: [],
        exchange: [],
        revoke: [],
    };

    const verifyAppleIdentityToken = async (token, options = {}) => {
        calls.verify.push({ token, options });

        const identity = token === 'credential-identity-token'
            ? appleIdentity(credentialSubject)
            : appleIdentity(exchangedSubject);

        if (
            options.expectedSubject != null &&
            options.expectedSubject !== identity.subject
        ) {
            throw new AppleSignInError(
                'identity_subject_mismatch',
                'subject mismatch',
                { status: 401 }
            );
        }

        return identity;
    };

    const exchangeAuthorizationCode = async (input) => {
        calls.exchange.push(input);

        if (exchangeError) throw exchangeError;

        return Object.freeze({
            accessToken: 'temporary-apple-access-token',
            tokenType: 'Bearer',
            expiresIn: 3600,
            refreshToken,
            identityToken: 'exchanged-identity-token',
        });
    };

    const revokeAppleToken = async (input) => {
        calls.revoke.push(input);

        if (revokeError) throw revokeError;

        return { success: true };
    };

    return {
        calls,
        verifyAppleIdentityToken,
        exchangeAuthorizationCode,
        revokeAppleToken,
    };
}

function makeFixture(options = {}) {
    const repository = new MemoryAccountAuthRepository();
    const accountCryptoConfig = makeCryptoConfig();
    const apple = makeAppleDependencies(options.apple);
    let currentTime = options.nowMilliseconds ?? NOW_MS;

    const service = createAccountAuthService({
        repository,
        appleConfig: { clientId: APPLE_AUDIENCE },
        accountCryptoConfig,
        verifyAppleIdentityToken: apple.verifyAppleIdentityToken,
        exchangeAuthorizationCode: apple.exchangeAuthorizationCode,
        revokeToken: apple.revokeAppleToken,
        now: () => currentTime,
        challengeLifetimeSeconds: options.challengeLifetimeSeconds ?? 600,
        accessTokenLifetimeSeconds: options.accessTokenLifetimeSeconds ?? 900,
        refreshSessionLifetimeSeconds:
            options.refreshSessionLifetimeSeconds ?? 30 * 24 * 60 * 60,
    });

    return {
        repository,
        accountCryptoConfig,
        apple,
        service,
        setTime(milliseconds) {
            currentTime = milliseconds;
        },
        advance(milliseconds) {
            currentTime += milliseconds;
        },
    };
}

async function createChallenge(fixture, installationId = 'install-device-001') {
    return fixture.service.createAppleChallenge({
        installationId,
    });
}

async function signIn(
    fixture,
    challenge,
    {
        installationId = 'install-device-001',
        displayName = 'Bhernaurd',
        rawNonce = challenge.rawNonce,
    } = {}
) {
    return fixture.service.signInWithApple({
        installationId,
        challengeId: challenge.challengeId,
        rawNonce,
        identityToken: 'credential-identity-token',
        authorizationCode: 'single-use-authorization-code',
        displayName,
        iosVersion: '3.8',
        iosBuild: 1,
        ipAddress: '203.0.113.10',
        userAgent: 'TheAgora/3.8 iOS',
    });
}


async function createDeletionChallenge(
    fixture,
    signedIn,
    installationId = 'install-device-001'
) {
    return fixture.service.createAppleChallenge({
        installationId,
        purpose: 'delete_account',
        accountId: signedIn.account.id,
    });
}

async function deleteSignedInAccount(
    fixture,
    signedIn,
    challenge,
    {
        installationId = 'install-device-001',
        rawNonce = challenge.rawNonce,
        identityToken = 'credential-identity-token',
        accountId = signedIn.account.id,
    } = {}
) {
    return fixture.service.deleteAccount({
        accountId,
        installationId,
        challengeId: challenge.challengeId,
        rawNonce,
        identityToken,
    });
}

function expectAuthError(code, status) {
    return (error) => {
        assert.ok(error instanceof AccountAuthError);
        assert.equal(error.code, code);
        if (status != null) assert.equal(error.status, status);
        return true;
    };
}

test('creates a short-lived installation-bound Apple challenge', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);
    const stored = fixture.repository.state.challenges.get(
        challenge.challengeId
    );

    assert.match(challenge.challengeId, /^[0-9a-f-]{36}$/i);
    assert.match(challenge.rawNonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge.nonceSha256, hashToken(challenge.rawNonce));
    assert.equal(stored.installationId, 'install-device-001');
    assert.equal(stored.purpose, 'sign_in_with_apple');
    assert.equal(stored.accountId, null);
    assert.equal(stored.consumedAt, null);
    assert.equal(
        challenge.expiresAt.getTime() - NOW_MS,
        600_000
    );
});

test('rejects invalid challenge purpose and account binding combinations', async () => {
    const fixture = makeFixture();

    await assert.rejects(
        () => fixture.service.createAppleChallenge({
            installationId: 'install-device-001',
            purpose: 'sign_in_with_apple',
            accountId: crypto.randomUUID(),
        }),
        expectAuthError('invalid_input', 400)
    );

    await assert.rejects(
        () => fixture.service.createAppleChallenge({
            installationId: 'install-device-001',
            purpose: 'delete_account',
        }),
        expectAuthError('invalid_input', 400)
    );
});

test('records a nonce failure without consuming a usable challenge', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);

    await assert.rejects(
        () => signIn(fixture, challenge, {
            rawNonce: 'incorrect-raw-nonce',
        }),
        expectAuthError('invalid_challenge', 401)
    );

    const storedAfterFailure = fixture.repository.state.challenges.get(
        challenge.challengeId
    );

    assert.equal(storedAfterFailure.failedAttempts, 1);
    assert.equal(storedAfterFailure.consumedAt, null);

    const result = await signIn(fixture, challenge);
    assert.equal(result.account.isNewAccount, true);
});

test('consumes a challenge before Apple verification and rejects replay', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);

    await signIn(fixture, challenge);

    const stored = fixture.repository.state.challenges.get(
        challenge.challengeId
    );
    assert.ok(stored.consumedAt instanceof Date);

    await assert.rejects(
        () => signIn(fixture, challenge),
        expectAuthError('challenge_already_used', 409)
    );

    assert.equal(fixture.apple.calls.exchange.length, 1);
});

test('creates an account, identity, installation, and session without storing plaintext Apple tokens', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);
    const result = await signIn(fixture, challenge);

    assert.equal(result.account.isNewAccount, true);
    assert.equal(result.account.displayName, 'Bhernaurd');
    assert.match(result.refreshToken, /^[A-Za-z0-9_-]{64}$/);
    assert.ok(result.accessToken.includes('.'));
    assert.equal(fixture.repository.state.accounts.size, 1);
    assert.equal(fixture.repository.state.identities.size, 1);
    assert.equal(fixture.repository.state.installations.size, 1);
    assert.equal(fixture.repository.state.sessions.size, 1);

    assert.equal(fixture.apple.calls.verify.length, 2);
    assert.equal(
        fixture.apple.calls.verify[0].options.expectedNonceHash,
        challenge.nonceSha256
    );
    assert.equal(
        fixture.apple.calls.verify[1].options.expectedSubject,
        'apple-subject-1'
    );
    assert.equal(
        fixture.apple.calls.verify[1].options.expectedNonceHash,
        undefined
    );

    const identity = [...fixture.repository.state.identities.values()][0];
    assert.notEqual(
        identity.encryptedRefreshToken,
        'apple-refresh-token-1'
    );
    assert.equal(
        identity.refreshTokenHash,
        hashToken('apple-refresh-token-1')
    );
    assert.equal(
        JSON.stringify(fixture.repository.state).includes(
            'temporary-apple-access-token'
        ),
        false
    );

    const decrypted = await fixture.service.decryptStoredAppleRefreshToken({
        encryptedRefreshToken: identity.encryptedRefreshToken,
        identityId: identity.identityId,
        accountId: identity.accountId,
        issuer: identity.issuer,
        audience: identity.audience,
        subject: identity.subject,
    });

    assert.equal(decrypted, 'apple-refresh-token-1');

    const principal = await fixture.service.authorizeAccessToken({
        installationId: 'install-device-001',
        accessToken: result.accessToken,
    });

    assert.equal(principal.accountId, result.account.id);
    assert.equal(principal.sessionId, result.session.id);
});

test('rejects an Apple subject mismatch after consuming the challenge', async () => {
    const fixture = makeFixture({
        apple: {
            credentialSubject: 'apple-subject-1',
            exchangedSubject: 'apple-subject-2',
        },
    });
    const challenge = await createChallenge(fixture);

    await assert.rejects(
        () => signIn(fixture, challenge),
        expectAuthError('invalid_apple_credential', 401)
    );

    assert.ok(
        fixture.repository.state.challenges.get(challenge.challengeId)
            .consumedAt
    );
    assert.equal(fixture.repository.state.accounts.size, 0);
    assert.equal(fixture.repository.state.sessions.size, 0);
});

test('maps retryable Apple failures to a temporary service error', async () => {
    const fixture = makeFixture({
        apple: {
            exchangeError: new AppleSignInError(
                'apple_code_exchange_failed',
                'temporary Apple failure',
                {
                    status: 503,
                    retryable: true,
                }
            ),
        },
    });
    const challenge = await createChallenge(fixture);

    await assert.rejects(
        () => signIn(fixture, challenge),
        (error) => {
            assert.ok(error instanceof AccountAuthError);
            assert.equal(
                error.code,
                'apple_authentication_unavailable'
            );
            assert.equal(error.status, 503);
            assert.equal(error.retryable, true);
            assert.equal(
                error.message.includes('authorization-code'),
                false
            );
            return true;
        }
    );
});

test('signing in again with the same Apple identity reuses the account and replaces the installation session', async () => {
    const fixture = makeFixture();
    const firstChallenge = await createChallenge(fixture);
    const first = await signIn(fixture, firstChallenge);

    fixture.advance(60_000);
    const secondChallenge = await createChallenge(fixture);
    const second = await signIn(fixture, secondChallenge);

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.account.isNewAccount, false);
    assert.equal(fixture.repository.state.accounts.size, 1);
    assert.equal(fixture.repository.state.installations.size, 1);
    assert.equal(fixture.repository.state.sessions.size, 2);

    const firstSession = fixture.repository.state.sessions.get(
        first.session.id
    );
    assert.ok(firstSession.revokedAt);
    assert.equal(firstSession.revocationReason, 'reauthenticated');

    await assert.rejects(
        () => fixture.service.authorizeAccessToken({
            installationId: 'install-device-001',
            accessToken: first.accessToken,
        }),
        expectAuthError('invalid_access_token', 401)
    );
});

test('signing a different Apple identity into the same installation unlinks the previous account', async () => {
    const fixture = makeFixture();
    const firstChallenge = await createChallenge(fixture);
    const first = await signIn(fixture, firstChallenge);

    fixture.apple.verifyAppleIdentityToken = null;

    const secondApple = makeAppleDependencies({
        credentialSubject: 'apple-subject-2',
        exchangedSubject: 'apple-subject-2',
        refreshToken: 'apple-refresh-token-2',
    });

    const secondService = createAccountAuthService({
        repository: fixture.repository,
        appleConfig: { clientId: APPLE_AUDIENCE },
        accountCryptoConfig: fixture.accountCryptoConfig,
        verifyAppleIdentityToken: secondApple.verifyAppleIdentityToken,
        exchangeAuthorizationCode: secondApple.exchangeAuthorizationCode,
        revokeToken: secondApple.revokeAppleToken,
        now: () => NOW_MS + 120_000,
    });

    const secondChallenge = await secondService.createAppleChallenge({
        installationId: 'install-device-001',
    });

    const second = await secondService.signInWithApple({
        installationId: 'install-device-001',
        challengeId: secondChallenge.challengeId,
        rawNonce: secondChallenge.rawNonce,
        identityToken: 'credential-identity-token',
        authorizationCode: 'second-code',
    });

    assert.notEqual(second.account.id, first.account.id);
    assert.equal(fixture.repository.state.accounts.size, 2);

    const installations = [
        ...fixture.repository.state.installations.values(),
    ];
    const oldInstallation = installations.find(
        (row) => row.accountId === first.account.id
    );
    const newInstallation = installations.find(
        (row) => row.accountId === second.account.id
    );

    assert.ok(oldInstallation.unlinkedAt);
    assert.equal(newInstallation.unlinkedAt, null);
    assert.equal(
        fixture.repository.state.sessions.get(first.session.id)
            .revocationReason,
        'installation_relinked'
    );
});

test('does not create a new session for a locked existing account', async () => {
    const fixture = makeFixture();
    const firstChallenge = await createChallenge(fixture);
    const first = await signIn(fixture, firstChallenge);

    fixture.repository.state.accounts.get(first.account.id).status = 'locked';
    const sessionCount = fixture.repository.state.sessions.size;
    const secondChallenge = await createChallenge(fixture);

    await assert.rejects(
        () => signIn(fixture, secondChallenge),
        expectAuthError('account_locked', 403)
    );

    assert.equal(fixture.repository.state.sessions.size, sessionCount);
});

test('rotates a refresh token atomically and preserves its token family', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, challenge);
    const originalSession = fixture.repository.state.sessions.get(
        signedIn.session.id
    );

    fixture.advance(5 * 60_000);

    const refreshed = await fixture.service.refreshSession({
        installationId: 'install-device-001',
        refreshToken: signedIn.refreshToken,
        iosVersion: '3.8',
        iosBuild: 2,
    });

    const rotatedSession = fixture.repository.state.sessions.get(
        signedIn.session.id
    );
    const nextSession = fixture.repository.state.sessions.get(
        refreshed.session.id
    );

    assert.equal(rotatedSession.revocationReason, 'rotated');
    assert.ok(rotatedSession.revokedAt);
    assert.equal(
        nextSession.tokenFamilyId,
        originalSession.tokenFamilyId
    );
    assert.equal(nextSession.rotatedFromSessionId, signedIn.session.id);
    assert.notEqual(refreshed.refreshToken, signedIn.refreshToken);

    const principal = await fixture.service.authorizeAccessToken({
        installationId: 'install-device-001',
        accessToken: refreshed.accessToken,
    });

    assert.equal(principal.sessionId, refreshed.session.id);
});

test('detects refresh-token reuse and revokes the entire token family', async () => {
    const fixture = makeFixture();
    const challenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, challenge);

    fixture.advance(60_000);
    const refreshed = await fixture.service.refreshSession({
        installationId: 'install-device-001',
        refreshToken: signedIn.refreshToken,
    });

    fixture.advance(1_000);

    await assert.rejects(
        () => fixture.service.refreshSession({
            installationId: 'install-device-001',
            refreshToken: signedIn.refreshToken,
        }),
        expectAuthError('refresh_token_reuse_detected', 401)
    );

    const familySessions = [
        ...fixture.repository.state.sessions.values(),
    ];
    assert.equal(familySessions.length, 2);
    assert.ok(familySessions.every((session) => session.revokedAt));
    assert.equal(
        fixture.repository.state.sessions.get(refreshed.session.id)
            .revocationReason,
        'refresh_token_reuse'
    );

    await assert.rejects(
        () => fixture.service.authorizeAccessToken({
            installationId: 'install-device-001',
            accessToken: refreshed.accessToken,
        }),
        expectAuthError('invalid_access_token', 401)
    );
});

test('rejects an expired refresh session and records its revocation', async () => {
    const fixture = makeFixture({
        refreshSessionLifetimeSeconds: 60,
    });
    const challenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, challenge);

    fixture.advance(61_000);

    await assert.rejects(
        () => fixture.service.refreshSession({
            installationId: 'install-device-001',
            refreshToken: signedIn.refreshToken,
        }),
        expectAuthError('invalid_refresh_token', 401)
    );

    const session = fixture.repository.state.sessions.get(
        signedIn.session.id
    );
    assert.equal(session.revocationReason, 'expired');
});

test('database-backed authorization rejects revoked sessions, auth-version changes, and installation mismatches', async (t) => {
    async function signedInFixture() {
        const fixture = makeFixture();
        const challenge = await createChallenge(fixture);
        const result = await signIn(fixture, challenge);
        return { fixture, result };
    }

    await t.test('revoked session', async () => {
        const { fixture, result } = await signedInFixture();
        const session = fixture.repository.state.sessions.get(
            result.session.id
        );
        session.revokedAt = new Date(NOW_MS + 1_000);
        session.revocationReason = 'manual_revoke';

        await assert.rejects(
            () => fixture.service.authorizeAccessToken({
                installationId: 'install-device-001',
                accessToken: result.accessToken,
            }),
            expectAuthError('invalid_access_token', 401)
        );
    });

    await t.test('auth version change', async () => {
        const { fixture, result } = await signedInFixture();
        fixture.repository.state.accounts.get(
            result.account.id
        ).authVersion += 1;

        await assert.rejects(
            () => fixture.service.authorizeAccessToken({
                installationId: 'install-device-001',
                accessToken: result.accessToken,
            }),
            expectAuthError('invalid_access_token', 401)
        );
    });

    await t.test('installation mismatch', async () => {
        const { fixture, result } = await signedInFixture();

        await assert.rejects(
            () => fixture.service.authorizeAccessToken({
                installationId: 'different-install-999',
                accessToken: result.accessToken,
            }),
            expectAuthError('invalid_access_token', 401)
        );
    });
});

test('expires access tokens independently of the longer refresh session', async () => {
    const fixture = makeFixture({
        accessTokenLifetimeSeconds: 60,
    });
    const challenge = await createChallenge(fixture);
    const result = await signIn(fixture, challenge);

    fixture.advance(91_000);

    await assert.rejects(
        () => fixture.service.authorizeAccessToken({
            installationId: 'install-device-001',
            accessToken: result.accessToken,
        }),
        expectAuthError('invalid_access_token', 401)
    );

    const refreshed = await fixture.service.refreshSession({
        installationId: 'install-device-001',
        refreshToken: result.refreshToken,
    });

    assert.ok(refreshed.accessToken);
});

test('deletes an account after Apple reauthentication and preserves released subscription evidence', async () => {
    const fixture = makeFixture();
    const signInChallenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, signInChallenge);
    const accountId = signedIn.account.id;

    fixture.repository.state.achievementUnlocks.set('achievement-1', {
        accountId,
    });
    fixture.repository.state.debateHistory.set('debate-1', {
        accountId,
    });
    fixture.repository.state.dailyChallengeProgress.set('daily-1', {
        accountId,
    });
    fixture.repository.state.subscriptionOwnership.set(
        'original-transaction-1|Production',
        {
            accountId,
            ownershipStatus: 'active',
            claimedFromInstallationId: 'install-device-001',
            observedAppAccountToken: crypto.randomUUID(),
            releasedAt: null,
            updatedAt: new Date(NOW_MS),
        }
    );

    const deletionChallenge = await createDeletionChallenge(
        fixture,
        signedIn
    );

    fixture.advance(30_000);

    const result = await deleteSignedInAccount(
        fixture,
        signedIn,
        deletionChallenge
    );

    assert.equal(result.accountId, accountId);
    assert.equal(result.status, 'deleted');
    assert.equal(result.appleRevocationStatus, 'succeeded');

    assert.equal(fixture.apple.calls.revoke.length, 1);
    assert.equal(
        fixture.apple.calls.revoke[0].token,
        'apple-refresh-token-1'
    );
    assert.equal(
        fixture.apple.calls.revoke[0].tokenTypeHint,
        'refresh_token'
    );

    const account = fixture.repository.state.accounts.get(accountId);
    assert.equal(account.status, 'deleted');
    assert.equal(account.displayName, null);
    assert.ok(account.deletedAt instanceof Date);
    assert.equal(account.authVersion, 3);

    assert.equal(fixture.repository.state.identities.size, 0);
    assert.equal(fixture.repository.state.installations.size, 0);
    assert.equal(fixture.repository.state.sessions.size, 0);
    assert.equal(fixture.repository.state.challenges.size, 0);
    assert.equal(fixture.repository.state.achievementUnlocks.size, 0);
    assert.equal(fixture.repository.state.debateHistory.size, 0);
    assert.equal(
        fixture.repository.state.dailyChallengeProgress.size,
        0
    );

    const ownership = fixture.repository.state.subscriptionOwnership.get(
        'original-transaction-1|Production'
    );
    assert.equal(ownership.ownershipStatus, 'released');
    assert.ok(ownership.releasedAt instanceof Date);
    assert.equal(ownership.claimedFromInstallationId, null);
    assert.equal(ownership.observedAppAccountToken, null);

    const requests = [
        ...fixture.repository.state.deletionRequests.values(),
    ];
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'completed');
    assert.equal(
        requests[0].appleRevocationStatus,
        'succeeded'
    );

    await assert.rejects(
        () => fixture.service.authorizeAccessToken({
            installationId: 'install-device-001',
            accessToken: signedIn.accessToken,
        }),
        expectAuthError('invalid_access_token', 401)
    );

    await assert.rejects(
        () => fixture.service.refreshSession({
            installationId: 'install-device-001',
            refreshToken: signedIn.refreshToken,
        }),
        expectAuthError('invalid_refresh_token', 401)
    );
});

test('rejects a deletion challenge bound to another installation or account', async () => {
    const fixture = makeFixture();
    const signInChallenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, signInChallenge);
    const deletionChallenge = await createDeletionChallenge(
        fixture,
        signedIn
    );

    await assert.rejects(
        () => deleteSignedInAccount(
            fixture,
            signedIn,
            deletionChallenge,
            {
                installationId: 'different-install-999',
            }
        ),
        expectAuthError('invalid_challenge', 401)
    );

    assert.equal(
        fixture.repository.state.accounts.get(
            signedIn.account.id
        ).status,
        'active'
    );

    const anotherAccountId = crypto.randomUUID();

    await assert.rejects(
        () => deleteSignedInAccount(
            fixture,
            signedIn,
            deletionChallenge,
            {
                accountId: anotherAccountId,
            }
        ),
        expectAuthError('invalid_challenge', 401)
    );
});

test('rejects a mismatched Apple subject without changing account data', async () => {
    const fixture = makeFixture();
    const signInChallenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, signInChallenge);
    const deletionChallenge = await createDeletionChallenge(
        fixture,
        signedIn
    );

    const mismatchedApple = makeAppleDependencies({
        credentialSubject: 'different-apple-subject',
        exchangedSubject: 'different-apple-subject',
    });

    const deletionService = createAccountAuthService({
        repository: fixture.repository,
        appleConfig: { clientId: APPLE_AUDIENCE },
        accountCryptoConfig: fixture.accountCryptoConfig,
        verifyAppleIdentityToken:
            mismatchedApple.verifyAppleIdentityToken,
        exchangeAuthorizationCode:
            mismatchedApple.exchangeAuthorizationCode,
        revokeToken: mismatchedApple.revokeAppleToken,
        now: () => NOW_MS + 30_000,
    });

    await assert.rejects(
        () => deletionService.deleteAccount({
            accountId: signedIn.account.id,
            installationId: 'install-device-001',
            challengeId: deletionChallenge.challengeId,
            rawNonce: deletionChallenge.rawNonce,
            identityToken: 'credential-identity-token',
        }),
        expectAuthError('invalid_apple_credential', 401)
    );

    assert.equal(
        fixture.repository.state.accounts.get(
            signedIn.account.id
        ).status,
        'active'
    );
    assert.equal(fixture.repository.state.identities.size, 1);
    assert.equal(fixture.repository.state.sessions.size, 1);
    assert.equal(
        fixture.repository.state.deletionRequests.size,
        0
    );
});

test('restores the account to active when Apple token revocation fails while invalidating old sessions', async () => {
    const fixture = makeFixture({
        apple: {
            revokeError: new AppleSignInError(
                'apple_token_revocation_failed',
                'temporary Apple failure',
                {
                    status: 503,
                }
            ),
        },
    });
    const signInChallenge = await createChallenge(fixture);
    const signedIn = await signIn(fixture, signInChallenge);
    const deletionChallenge = await createDeletionChallenge(
        fixture,
        signedIn
    );

    await assert.rejects(
        () => deleteSignedInAccount(
            fixture,
            signedIn,
            deletionChallenge
        ),
        (error) => {
            assert.ok(error instanceof AccountAuthError);
            assert.equal(
                error.code,
                'apple_account_revocation_failed'
            );
            assert.equal(error.status, 503);
            assert.equal(error.retryable, true);
            return true;
        }
    );

    const account = fixture.repository.state.accounts.get(
        signedIn.account.id
    );
    assert.equal(account.status, 'active');
    assert.equal(account.authVersion, 3);
    assert.equal(account.deletionRequestedAt, null);

    assert.equal(fixture.repository.state.identities.size, 1);
    assert.equal(fixture.repository.state.installations.size, 1);
    assert.equal(fixture.repository.state.sessions.size, 1);

    const request = [
        ...fixture.repository.state.deletionRequests.values(),
    ][0];
    assert.equal(request.status, 'failed');
    assert.equal(request.appleRevocationStatus, 'failed');
    assert.equal(
        request.lastErrorCode,
        'apple_token_revocation_failed'
    );

    await assert.rejects(
        () => fixture.service.authorizeAccessToken({
            installationId: 'install-device-001',
            accessToken: signedIn.accessToken,
        }),
        expectAuthError('invalid_access_token', 401)
    );

    await assert.rejects(
        () => fixture.service.refreshSession({
            installationId: 'install-device-001',
            refreshToken: signedIn.refreshToken,
        }),
        expectAuthError('invalid_refresh_token', 401)
    );
});
