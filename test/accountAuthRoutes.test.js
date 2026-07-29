import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';

import express from 'express';

import {
    AccountAuthError,
} from '../lib/accountAuthService.js';

import {
    accountAuthRouteConstants,
    createAccountAuthRouter,
    createPostgresAccountSessionRevoker,
} from '../accountAuthRoutes.js';

const INSTALLATION_ID = 'version-check-client-001';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const NOW_MS = Date.UTC(2026, 6, 28, 19, 0, 0);

function makeService(overrides = {}) {
    return {
        async createAppleChallenge(input) {
            return {
                challengeId: CHALLENGE_ID,
                purpose: 'sign_in_with_apple',
                rawNonce: 'raw-nonce-value',
                nonceSha256: 'a'.repeat(64),
                expiresAt: new Date(NOW_MS + 600_000),
                input,
            };
        },

        async signInWithApple() {
            return {
                account: {
                    id: ACCOUNT_ID,
                    status: 'active',
                    authVersion: 1,
                    displayName: 'Agora User',
                    isNewAccount: true,
                },
                session: {
                    id: SESSION_ID,
                    expiresAt: new Date(NOW_MS + 2_592_000_000),
                },
                accessToken: ACCESS_TOKEN,
                accessTokenExpiresAt: new Date(NOW_MS + 900_000),
                refreshToken: 'refresh-token-value',
            };
        },

        async refreshSession() {
            return {
                accountId: ACCOUNT_ID,
                session: {
                    id: SESSION_ID,
                    expiresAt: new Date(NOW_MS + 2_592_000_000),
                },
                accessToken: ACCESS_TOKEN,
                accessTokenExpiresAt: new Date(NOW_MS + 900_000),
                refreshToken: 'rotated-refresh-token',
            };
        },

        async authorizeAccessToken() {
            return {
                accountId: ACCOUNT_ID,
                sessionId: SESSION_ID,
                installationId: INSTALLATION_ID,
                authVersion: 1,
                displayName: 'Agora User',
                accessTokenExpiresAt: new Date(NOW_MS + 900_000),
                sessionExpiresAt: new Date(NOW_MS + 2_592_000_000),
            };
        },

        ...overrides,
    };
}

async function startServer({
    service = makeService(),
    pool = { query: async () => ({ rowCount: 1, rows: [{ id: SESSION_ID }] }) },
    revokeSession = async () => true,
    logger = { error() {} },
} = {}) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account',
        createAccountAuthRouter(pool, {
            service,
            revokeSession,
            logger,
            now: () => NOW_MS,
        })
    );

    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    return {
        baseUrl,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}

function authHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        'X-iOS-Version': '3.8',
        'X-iOS-Build': '1',
        'User-Agent': 'TheAgoraTests/1.0',
        ...extra,
    };
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test('creates an installation-bound Apple sign-in challenge', async (t) => {
    let captured;
    const server = await startServer({
        service: makeService({
            async createAppleChallenge(input) {
                captured = input;
                return {
                    challengeId: CHALLENGE_ID,
                    purpose: 'sign_in_with_apple',
                    rawNonce: 'raw-nonce-value',
                    nonceSha256: 'a'.repeat(64),
                    expiresAt: new Date(NOW_MS + 600_000),
                };
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/challenge`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: '{}',
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 201);
    assert.deepEqual(captured, {
        installationId: INSTALLATION_ID,
        purpose: 'sign_in_with_apple',
    });
    assert.equal(body.challengeId, CHALLENGE_ID);
    assert.equal(body.rawNonce, 'raw-nonce-value');
    assert.equal(body.nonceSha256, 'a'.repeat(64));
    assert.equal(
        body.expiresAt,
        new Date(NOW_MS + 600_000).toISOString()
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
});

test('does not expose reauthentication or deletion challenge purposes publicly', async (t) => {
    let captured;
    const server = await startServer({
        service: makeService({
            async createAppleChallenge(input) {
                captured = input;
                return {
                    challengeId: CHALLENGE_ID,
                    purpose: input.purpose,
                    rawNonce: 'raw-nonce-value',
                    nonceSha256: 'a'.repeat(64),
                    expiresAt: new Date(NOW_MS + 600_000),
                };
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/challenge`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                purpose: 'delete_account',
                accountId: ACCOUNT_ID,
            }),
        }
    );

    assert.equal(response.status, 201);
    assert.deepEqual(captured, {
        installationId: INSTALLATION_ID,
        purpose: 'sign_in_with_apple',
    });
});

test('creates a new account from an Apple sign-in request', async (t) => {
    let captured;
    const service = makeService({
        async signInWithApple(input) {
            captured = input;
            return makeService().signInWithApple();
        },
    });
    const server = await startServer({ service });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/sign-in`,
        {
            method: 'POST',
            headers: authHeaders({
                'X-Forwarded-For': '203.0.113.10',
            }),
            body: JSON.stringify({
                challengeId: CHALLENGE_ID,
                rawNonce: 'raw-nonce-value',
                identityToken: 'apple-identity-token',
                authorizationCode: 'apple-authorization-code',
                displayName: 'Agora User',
            }),
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 201);
    assert.equal(captured.installationId, INSTALLATION_ID);
    assert.equal(captured.iosVersion, '3.8');
    assert.equal(captured.iosBuild, '1');
    assert.equal(captured.challengeId, CHALLENGE_ID);
    assert.equal(captured.displayName, 'Agora User');
    assert.equal(captured.ipAddress, '203.0.113.10');
    assert.equal(body.account.id, ACCOUNT_ID);
    assert.equal(body.account.isNewAccount, true);
    assert.equal(body.session.id, SESSION_ID);
    assert.equal(body.tokenType, 'Bearer');
    assert.equal(body.accessToken, ACCESS_TOKEN);
    assert.equal(body.refreshToken, 'refresh-token-value');
});

test('returns 200 when an existing Apple account signs in', async (t) => {
    const server = await startServer({
        service: makeService({
            async signInWithApple() {
                const result = await makeService().signInWithApple();
                result.account.isNewAccount = false;
                return result;
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/sign-in`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                challengeId: CHALLENGE_ID,
                rawNonce: 'raw-nonce-value',
                identityToken: 'apple-identity-token',
                authorizationCode: 'apple-authorization-code',
            }),
        }
    );

    assert.equal(response.status, 200);
});

test('rotates a refresh token and forwards installation metadata', async (t) => {
    let captured;
    const server = await startServer({
        service: makeService({
            async refreshSession(input) {
                captured = input;
                return makeService().refreshSession();
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session/refresh`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                refreshToken: 'current-refresh-token',
            }),
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(captured.installationId, INSTALLATION_ID);
    assert.equal(captured.refreshToken, 'current-refresh-token');
    assert.equal(captured.iosVersion, '3.8');
    assert.equal(captured.iosBuild, '1');
    assert.equal(body.account.id, ACCOUNT_ID);
    assert.equal(body.refreshToken, 'rotated-refresh-token');
});

test('verifies the current database-backed session', async (t) => {
    let captured;
    const server = await startServer({
        service: makeService({
            async authorizeAccessToken(input) {
                captured = input;
                return makeService().authorizeAccessToken();
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session`,
        {
            headers: authHeaders({
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            }),
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(captured, {
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });
    assert.equal(body.authenticated, true);
    assert.equal(body.account.id, ACCOUNT_ID);
    assert.equal(body.session.id, SESSION_ID);
});

test('signs out by authorizing and revoking the exact session', async (t) => {
    let capturedRevocation;
    const server = await startServer({
        revokeSession: async (input) => {
            capturedRevocation = input;
            return true;
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session/sign-out`,
        {
            method: 'POST',
            headers: authHeaders({
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            }),
            body: '{}',
        }
    );

    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(capturedRevocation.accountId, ACCOUNT_ID);
    assert.equal(capturedRevocation.sessionId, SESSION_ID);
    assert.equal(
        capturedRevocation.installationId,
        INSTALLATION_ID
    );
    assert.equal(
        capturedRevocation.revokedAt.toISOString(),
        new Date(NOW_MS).toISOString()
    );
});

test('rejects a request that omits X-Installation-ID', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/challenge`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'missing_installation_id');
});

test('rejects a missing or malformed Bearer token', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const missing = await fetch(
        `${server.baseUrl}/api/account/session`,
        { headers: authHeaders() }
    );
    const missingBody = await readJson(missing);

    assert.equal(missing.status, 401);
    assert.equal(missingBody.error.code, 'missing_access_token');

    const malformed = await fetch(
        `${server.baseUrl}/api/account/session`,
        {
            headers: authHeaders({
                Authorization: 'Basic not-a-token',
            }),
        }
    );
    const malformedBody = await readJson(malformed);

    assert.equal(malformed.status, 401);
    assert.equal(malformedBody.error.code, 'invalid_access_token');
});

test('requires JSON objects for sign-in and refresh requests', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session/refresh`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify(['not-an-object']),
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'invalid_request');
});

test('maps account service validation failures without exposing causes', async (t) => {
    const server = await startServer({
        service: makeService({
            async signInWithApple() {
                throw new AccountAuthError(
                    'invalid_apple_credential',
                    'The Apple sign-in credential could not be verified.',
                    {
                        status: 401,
                        cause: new Error('secret authorization code'),
                    }
                );
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/sign-in`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                challengeId: CHALLENGE_ID,
                rawNonce: 'raw-nonce-value',
                identityToken: 'apple-identity-token',
                authorizationCode: 'secret authorization code',
            }),
        }
    );
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'invalid_apple_credential');
    assert.equal(text.includes('secret authorization code'), false);
});

test('maps internal failures to a generic retryable 503 response', async (t) => {
    const logs = [];
    const server = await startServer({
        service: makeService({
            async refreshSession() {
                throw new Error('database password should not escape');
            },
        }),
        logger: {
            error(message, details) {
                logs.push({ message, details });
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session/refresh`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ refreshToken: 'refresh-token' }),
        }
    );
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 503);
    assert.equal(
        body.error.code,
        'account_authentication_unavailable'
    );
    assert.equal(body.error.retryable, true);
    assert.equal(text.includes('database password'), false);
    assert.equal(logs.length, 1);
    assert.equal(
        JSON.stringify(logs).includes('database password'),
        false
    );
});

test('returns a generic 503 for service-side 500 errors', async (t) => {
    const server = await startServer({
        service: makeService({
            async createAppleChallenge() {
                throw new AccountAuthError(
                    'invalid_configuration',
                    'APPLE_PRIVATE_KEY is missing.',
                    { status: 500 }
                );
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/apple/challenge`,
        {
            method: 'POST',
            headers: authHeaders(),
            body: '{}',
        }
    );
    const text = await response.text();
    const body = JSON.parse(text);

    assert.equal(response.status, 503);
    assert.equal(
        body.error.code,
        'account_authentication_unavailable'
    );
    assert.equal(text.includes('APPLE_PRIVATE_KEY'), false);
});

test('rejects sign-out when the database session was not revoked', async (t) => {
    const server = await startServer({
        revokeSession: async () => false,
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/session/sign-out`,
        {
            method: 'POST',
            headers: authHeaders({
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            }),
            body: '{}',
        }
    );
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'invalid_access_token');
});

test('PostgreSQL session revocation targets the exact account, session, and installation', async () => {
    let captured;
    const pool = {
        async query(text, values) {
            captured = { text, values };
            return {
                rowCount: 1,
                rows: [{ id: SESSION_ID }],
            };
        },
    };

    const revoke = createPostgresAccountSessionRevoker(pool);
    const revokedAt = new Date(NOW_MS);
    const result = await revoke({
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        installationId: INSTALLATION_ID,
        revokedAt,
    });

    assert.equal(result, true);
    assert.match(captured.text, /UPDATE account_sessions AS s/);
    assert.match(captured.text, /ai\.installation_id = \$3/);
    assert.match(captured.text, /s\.revoked_at IS NULL/);
    assert.deepEqual(captured.values, [
        SESSION_ID,
        ACCOUNT_ID,
        INSTALLATION_ID,
        revokedAt,
        accountAuthRouteConstants.signOutReason,
    ]);
});
