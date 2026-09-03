import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    AccountAuthError,
} from '../lib/accountAuthService.js';
import { createGoogleAccountAuthService } from '../lib/googleAccountAuthService.js';
import { createAccountAuthRouter } from '../accountAuthRoutes.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const IDENTITY_ID = '55555555-5555-4555-8555-555555555555';
const INSTALLATION_ID = 'android-installation-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const NOW_MS = Date.UTC(2026, 7, 22, 22, 30, 0);
const GOOGLE_AUDIENCE = 'android-web-client.apps.googleusercontent.com';
const GOOGLE_SUBJECT = 'google-subject-123';

function makeAuthorizationService(overrides = {}) {
    return {
        async createAppleChallenge() {
            return {
                challengeId: CHALLENGE_ID,
                purpose: 'sign_in_with_apple',
                rawNonce: 'apple-nonce',
                nonceSha256: 'a'.repeat(64),
                expiresAt: new Date(NOW_MS + 600_000),
            };
        },
        async signInWithApple() {
            throw new Error('not used');
        },
        async refreshSession() {
            throw new Error('not used');
        },
        async authorizeAccessToken() {
            return {
                accountId: ACCOUNT_ID,
                sessionId: SESSION_ID,
                installationId: INSTALLATION_ID,
                authVersion: 1,
                displayName: 'Android User',
                accessTokenExpiresAt: new Date(NOW_MS + 900_000),
                sessionExpiresAt: new Date(NOW_MS + 2_592_000_000),
            };
        },
        async deleteAccount() {
            throw new Error('not used');
        },
        ...overrides,
    };
}

function makeGoogleRouteService(overrides = {}) {
    return {
        async signInWithGoogle() {
            throw new Error('not used');
        },
        async createDeletionChallenge() {
            return {
                challengeId: CHALLENGE_ID,
                purpose: 'delete_account',
                rawNonce: 'google-deletion-nonce',
                nonceSha256: 'b'.repeat(64),
                expiresAt: new Date(NOW_MS + 600_000),
            };
        },
        async deleteAccount() {
            return {
                accountId: ACCOUNT_ID,
                status: 'deleted',
                deletedAt: new Date(NOW_MS + 1_000),
                appleRevocationStatus: 'not_required',
            };
        },
        ...overrides,
    };
}

async function startServer({
    service = makeAuthorizationService(),
    googleService = makeGoogleRouteService(),
} = {}) {
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account',
        createAccountAuthRouter(
            { query: async () => ({ rowCount: 1, rows: [{ id: SESSION_ID }] }) },
            {
                service,
                googleService,
                revokeSession: async () => true,
                logger: { error() {} },
                now: () => NOW_MS,
            }
        )
    );

    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'User-Agent': 'TheAgoraAndroidTests/1.0',
    };
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test('Google deletion routes authorize the current Agora account and ignore client account IDs', async (t) => {
    const calls = { authorize: [], challenge: [], delete: [] };
    const service = makeAuthorizationService({
        async authorizeAccessToken(input) {
            calls.authorize.push(input);
            return makeAuthorizationService().authorizeAccessToken();
        },
    });
    const googleService = makeGoogleRouteService({
        async createDeletionChallenge(input) {
            calls.challenge.push(input);
            return makeGoogleRouteService().createDeletionChallenge();
        },
        async deleteAccount(input) {
            calls.delete.push(input);
            return makeGoogleRouteService().deleteAccount();
        },
    });
    const server = await startServer({ service, googleService });
    t.after(server.close);

    const challengeResponse = await fetch(
        `${server.baseUrl}/api/account/google/deletion/challenge`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                accountId: '99999999-9999-4999-8999-999999999999',
            }),
        }
    );
    const challengeBody = await readJson(challengeResponse);
    assert.equal(challengeResponse.status, 201);
    assert.deepEqual(calls.challenge, [{
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
    }]);
    assert.equal(challengeBody.challengeId, CHALLENGE_ID);
    assert.equal(challengeBody.rawNonce, 'google-deletion-nonce');

    const confirmResponse = await fetch(
        `${server.baseUrl}/api/account/google/deletion/confirm`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                accountId: '99999999-9999-4999-8999-999999999999',
                challengeId: CHALLENGE_ID,
                rawNonce: 'google-deletion-nonce',
                idToken: 'fresh-google-id-token',
            }),
        }
    );
    const confirmBody = await readJson(confirmResponse);
    assert.equal(confirmResponse.status, 200);
    assert.deepEqual(calls.delete, [{
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        challengeId: CHALLENGE_ID,
        rawNonce: 'google-deletion-nonce',
        idToken: 'fresh-google-id-token',
    }]);
    assert.equal(confirmBody.deleted, true);
    assert.equal(confirmBody.account.id, ACCOUNT_ID);
    assert.equal(confirmBody.appleRevocationStatus, 'not_required');
    assert.equal(calls.authorize.length, 2);
});

test('Google deletion routes do not create or confirm deletion without a valid Agora session', async (t) => {
    const calls = { challenge: 0, delete: 0 };
    const server = await startServer({
        service: makeAuthorizationService({
            async authorizeAccessToken() {
                throw new AccountAuthError(
                    'invalid_access_token',
                    'The access token is invalid or expired.',
                    { status: 401 }
                );
            },
        }),
        googleService: makeGoogleRouteService({
            async createDeletionChallenge() {
                calls.challenge += 1;
                throw new Error('must not be called');
            },
            async deleteAccount() {
                calls.delete += 1;
                throw new Error('must not be called');
            },
        }),
    });
    t.after(server.close);

    const challengeResponse = await fetch(
        `${server.baseUrl}/api/account/google/deletion/challenge`,
        { method: 'POST', headers: authHeaders(), body: '{}' }
    );
    assert.equal(challengeResponse.status, 401);

    const confirmResponse = await fetch(
        `${server.baseUrl}/api/account/google/deletion/confirm`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                challengeId: CHALLENGE_ID,
                rawNonce: 'nonce',
                idToken: 'token',
            }),
        }
    );
    assert.equal(confirmResponse.status, 401);
    assert.equal(calls.challenge, 0);
    assert.equal(calls.delete, 0);
});

function makeDeletionHarness({ verifiedSubject = GOOGLE_SUBJECT } = {}) {
    let challenge = null;
    const calls = {
        verification: [],
        markPending: [],
        revokeSessions: [],
        failedDeletion: [],
        sql: [],
    };

    const tx = {
        async query(text, values = []) {
            const sql = String(text);
            calls.sql.push({ sql, values });

            if (sql.includes('find-deletion-identity-for-update')) {
                return {
                    rowCount: 1,
                    rows: [{
                        identity_id: IDENTITY_ID,
                        account_id: ACCOUNT_ID,
                        subject: GOOGLE_SUBJECT,
                        account_status: 'active',
                        auth_version: 1,
                        account_display_name: 'Android User',
                    }],
                };
            }
            if (sql.includes('create-deletion-request')) {
                return { rowCount: 1, rows: [{ id: REQUEST_ID }] };
            }
            if (sql.includes('lock-account-for-deletion-finalize')) {
                return { rowCount: 1, rows: [{ id: ACCOUNT_ID }] };
            }
            if (sql.includes("UPDATE accounts\n                SET")) {
                return { rowCount: 1, rows: [{ id: ACCOUNT_ID }] };
            }
            if (sql.includes('UPDATE account_deletion_requests')) {
                return { rowCount: 1, rows: [{ id: REQUEST_ID }] };
            }
            return { rowCount: 1, rows: [] };
        },
    };

    const repository = {
        async withTransaction(work) {
            return work(tx);
        },
        async createChallenge(input) {
            challenge = {
                id: CHALLENGE_ID,
                installationId: input.installationId,
                accountId: input.accountId,
                purpose: input.purpose,
                nonceSha256: input.nonceSha256,
                createdAt: input.createdAt,
                expiresAt: input.expiresAt,
                consumedAt: null,
                failedAttempts: 0,
            };
            return challenge;
        },
        async findChallengeForUpdate() {
            return challenge;
        },
        async recordChallengeFailure() {
            if (challenge) challenge.failedAttempts += 1;
        },
        async consumeChallenge() {
            if (!challenge || challenge.consumedAt) return false;
            challenge.consumedAt = new Date(NOW_MS);
            return true;
        },
        async markAccountDeletionPending(_tx, input) {
            calls.markPending.push(input);
            return true;
        },
        async revokeAllAccountSessions(_tx, input) {
            calls.revokeSessions.push(input);
        },
        async failAccountDeletion(_tx, input) {
            calls.failedDeletion.push(input);
        },
    };

    const service = createGoogleAccountAuthService({
        pool: { query: tx.query.bind(tx) },
        repository,
        verifyGoogleIdToken: async (idToken, options) => {
            calls.verification.push({ idToken, options });
            return {
                issuer: 'https://accounts.google.com',
                audience: GOOGLE_AUDIENCE,
                subject: verifiedSubject,
                email: 'android@example.com',
                emailVerified: true,
                displayName: 'Android User',
                pictureUrl: null,
            };
        },
        now: () => NOW_MS,
    });

    return { service, calls };
}

test('Google deletion service consumes a server nonce, verifies the same Google subject, revokes sessions, and removes account data', async () => {
    const { service, calls } = makeDeletionHarness();
    const challenge = await service.createDeletionChallenge({
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
    });

    const result = await service.deleteAccount({
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        challengeId: challenge.challengeId,
        rawNonce: challenge.rawNonce,
        idToken: 'fresh-google-id-token',
    });

    assert.equal(result.status, 'deleted');
    assert.equal(result.appleRevocationStatus, 'not_required');
    assert.deepEqual(calls.verification, [{
        idToken: 'fresh-google-id-token',
        options: { expectedNonce: challenge.rawNonce },
    }]);
    assert.equal(calls.markPending.length, 1);
    assert.equal(calls.revokeSessions.length, 1);
    assert.equal(
        calls.revokeSessions[0].reason,
        'account_deletion'
    );

    const sql = calls.sql.map((entry) => entry.sql).join('\n');
    assert.match(sql, /DELETE FROM account_google_identities/);
    assert.match(sql, /DELETE FROM account_ranked_profiles/);
    assert.match(sql, /DELETE FROM account_debate_history/);
    assert.match(sql, /DELETE FROM account_achievement_unlocks/);
    assert.match(sql, /DELETE FROM account_daily_challenge_progress/);
    assert.match(sql, /DELETE FROM affiliate_account_referrals/);
    assert.match(sql, /UPDATE affiliate_subscription_attributions SET account_id = NULL/);
    assert.match(sql, /UPDATE affiliate_referral_handoffs SET account_id = NULL/);
});

test('Google deletion service rejects a fresh credential for a different Google subject before account deletion begins', async () => {
    const { service, calls } = makeDeletionHarness({
        verifiedSubject: 'different-google-subject',
    });
    const challenge = await service.createDeletionChallenge({
        installationId: INSTALLATION_ID,
        accountId: ACCOUNT_ID,
    });

    await assert.rejects(
        service.deleteAccount({
            accountId: ACCOUNT_ID,
            installationId: INSTALLATION_ID,
            challengeId: challenge.challengeId,
            rawNonce: challenge.rawNonce,
            idToken: 'other-google-id-token',
        }),
        (error) => {
            assert.equal(error.code, 'invalid_google_credential');
            assert.equal(error.status, 401);
            return true;
        }
    );

    assert.equal(calls.markPending.length, 0);
    assert.equal(calls.revokeSessions.length, 0);
});

test('Google account deletion migration allows android_app without changing the iOS source value', async () => {
    const sql = await readFile(
        new URL('../migrations/025_google_account_deletion.sql', import.meta.url),
        'utf8'
    );
    assert.match(sql, /'android_app'/);
    assert.match(sql, /'ios_app'/);
    assert.match(sql, /account_deletion_requests_request_source_check/);
});
