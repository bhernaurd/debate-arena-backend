import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createAccountAuthRouter } from '../accountAuthRoutes.js';
import { GoogleAccountDeletionError } from '../lib/googleAccountDeletionService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'android-installation-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const CHALLENGE_ID = '22222222-2222-4222-8222-222222222222';
const RAW_NONCE = 'google-deletion-nonce';
const NONCE_SHA = 'a'.repeat(64);

function accountService() {
    return {
        async createAppleChallenge() {
            throw new Error('Apple path not used');
        },
        async signInWithApple() {
            throw new Error('Apple path not used');
        },
        async refreshSession() {
            throw new Error('not used');
        },
        async authorizeAccessToken(input) {
            assert.deepEqual(input, {
                installationId: INSTALLATION_ID,
                accessToken: ACCESS_TOKEN,
            });
            return {
                accountId: ACCOUNT_ID,
                sessionId: '33333333-3333-4333-8333-333333333333',
            };
        },
        async deleteAccount() {
            throw new Error('Apple path not used');
        },
    };
}

async function startServer(googleDeletionService) {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/account',
        createAccountAuthRouter(
            {
                async query() {
                    return { rows: [], rowCount: 0 };
                },
            },
            {
                service: accountService(),
                googleService: {
                    async signInWithGoogle() {
                        throw new Error('not used');
                    },
                },
                googleDeletionService,
                revokeSession: async () => true,
                logger: { error() {} },
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

function headers() {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
    };
}

test('challenge route binds the destructive request to authenticated account and installation', async (t) => {
    let captured;
    const server = await startServer({
        async createChallenge(input) {
            captured = input;
            return {
                challengeId: CHALLENGE_ID,
                purpose: 'delete_account',
                rawNonce: RAW_NONCE,
                nonceSha256: NONCE_SHA,
                expiresAt: new Date('2026-08-23T05:10:00.000Z'),
            };
        },
        async deleteAccount() {
            throw new Error('not used');
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google/deletion/challenge`,
        { method: 'POST', headers: headers(), body: '{}' }
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.deepEqual(captured, {
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
    });
    assert.equal(body.challengeId, CHALLENGE_ID);
    assert.equal(body.purpose, 'delete_account');
    assert.equal(body.rawNonce, RAW_NONCE);
    assert.equal(body.nonceSha256, NONCE_SHA);
    assert.equal(body.expiresAt, '2026-08-23T05:10:00.000Z');
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('confirm route ignores attacker account IDs and uses authenticated ownership', async (t) => {
    let captured;
    const server = await startServer({
        async createChallenge() {
            throw new Error('not used');
        },
        async deleteAccount(input) {
            captured = input;
            return {
                accountId: ACCOUNT_ID,
                status: 'deleted',
                deletedAt: new Date('2026-08-23T05:00:00.000Z'),
                appleRevocationStatus: 'not_required',
            };
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google/deletion/confirm`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
                accountId: '99999999-9999-4999-8999-999999999999',
                challengeId: CHALLENGE_ID,
                rawNonce: RAW_NONCE,
                idToken: 'fresh-google-id-token',
            }),
        }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(captured, {
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        challengeId: CHALLENGE_ID,
        rawNonce: RAW_NONCE,
        idToken: 'fresh-google-id-token',
    });
    assert.deepEqual(body, {
        deleted: true,
        account: {
            id: ACCOUNT_ID,
            status: 'deleted',
        },
        deletedAt: '2026-08-23T05:00:00.000Z',
        appleRevocationStatus: 'not_required',
    });
});

test('Google deletion errors preserve safe client-visible challenge failures', async (t) => {
    const server = await startServer({
        async createChallenge() {
            throw new Error('not used');
        },
        async deleteAccount() {
            throw new GoogleAccountDeletionError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.',
                { status: 401, retryable: false }
            );
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google/deletion/confirm`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
                challengeId: CHALLENGE_ID,
                rawNonce: RAW_NONCE,
                idToken: 'wrong-google-id-token',
            }),
        }
    );
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, {
        error: {
            code: 'invalid_google_credential',
            message: 'The Google sign-in credential could not be verified.',
            retryable: false,
        },
    });
});

test('Google deletion routes require both bearer session and installation identity', async (t) => {
    let deletionCalls = 0;
    const server = await startServer({
        async createChallenge() {
            deletionCalls += 1;
            throw new Error('must not be called');
        },
        async deleteAccount() {
            deletionCalls += 1;
            throw new Error('must not be called');
        },
    });
    t.after(server.close);

    const noInstallation = await fetch(
        `${server.baseUrl}/api/account/google/deletion/challenge`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            },
            body: '{}',
        }
    );
    assert.equal(noInstallation.status, 400);

    const noAuthorization = await fetch(
        `${server.baseUrl}/api/account/google/deletion/challenge`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Installation-ID': INSTALLATION_ID,
            },
            body: '{}',
        }
    );
    assert.equal(noAuthorization.status, 401);
    assert.equal(deletionCalls, 0);
});
