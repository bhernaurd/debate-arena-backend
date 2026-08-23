import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    AccountProAccessError,
} from '../lib/accountProAccessService.js';
import { createAccountAuthRouter } from '../accountAuthRoutes.js';

const INSTALLATION_ID = 'android-entitlement-client-001';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const NOW = new Date('2026-08-23T06:00:00.000Z');

function makeAuthService(overrides = {}) {
    return {
        async createAppleChallenge() {
            throw new Error('not used');
        },
        async signInWithApple() {
            throw new Error('not used');
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
                sessionId: SESSION_ID,
                installationId: INSTALLATION_ID,
                authVersion: 1,
                displayName: null,
                accessTokenExpiresAt: new Date(NOW.getTime() + 900_000),
                sessionExpiresAt: new Date(NOW.getTime() + 86_400_000),
            };
        },
        async deleteAccount() {
            throw new Error('not used');
        },
        ...overrides,
    };
}

function makeGoogleService() {
    return {
        async signInWithGoogle() {
            throw new Error('not used');
        },
    };
}

function makeProAccessService(resultFactory) {
    return {
        async getCurrentAccess(input) {
            assert.deepEqual(input, { accountId: ACCOUNT_ID });
            return resultFactory();
        },
    };
}

async function startServer({
    service = makeAuthService(),
    proAccessService,
} = {}) {
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account',
        createAccountAuthRouter(
            { query: async () => ({ rows: [], rowCount: 0 }) },
            {
                service,
                googleService: makeGoogleService(),
                proAccessService,
                revokeSession: async () => true,
                logger: { error() {} },
                now: () => NOW.getTime(),
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
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}

function requestHeaders(overrides = {}) {
    return {
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...overrides,
    };
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test('returns authenticated account Pro access without store ownership identifiers', async (t) => {
    const server = await startServer({
        proAccessService: makeProAccessService(() => ({
            hasProAccess: true,
            accountId: ACCOUNT_ID,
            checkedAt: NOW,
            entitlement: {
                originalTransactionId: 'google-play:secret-token-hash',
                environment: 'GooglePlay',
                productId: 'agora_pro_yearly',
                status: 'active',
                isTrial: false,
                accessExpiresAt: new Date('2027-08-23T06:00:00.000Z'),
                expiresAt: new Date('2027-08-23T06:00:00.000Z'),
                gracePeriodExpiresAt: null,
                lastSignedAt: NOW,
            },
        })),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement`,
        { headers: requestHeaders() }
    );
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
        success: true,
        accountId: ACCOUNT_ID,
        isPro: true,
        checkedAt: NOW.toISOString(),
        entitlement: {
            productId: 'agora_pro_yearly',
            status: 'active',
            isTrial: false,
            accessExpiresAt: '2027-08-23T06:00:00.000Z',
            source: 'google_play',
        },
    });
    assert.equal(JSON.stringify(body).includes('secret-token-hash'), false);
    assert.equal('originalTransactionId' in body.entitlement, false);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('returns a normal Free response when the authenticated account has no Pro entitlement', async (t) => {
    const server = await startServer({
        proAccessService: makeProAccessService(() => ({
            hasProAccess: false,
            accountId: ACCOUNT_ID,
            checkedAt: NOW,
            entitlement: null,
        })),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement`,
        { headers: requestHeaders() }
    );
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.accountId, ACCOUNT_ID);
    assert.equal(body.isPro, false);
    assert.equal(body.entitlement, null);
});

test('maps App Store entitlements to the public app_store source', async (t) => {
    const server = await startServer({
        proAccessService: makeProAccessService(() => ({
            hasProAccess: true,
            accountId: ACCOUNT_ID,
            checkedAt: NOW,
            entitlement: {
                originalTransactionId: '550003097549367',
                environment: 'Production',
                productId: 'agora_pro_monthly',
                status: 'trial',
                isTrial: true,
                accessExpiresAt: new Date('2026-08-30T06:00:00.000Z'),
            },
        })),
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement`,
        { headers: requestHeaders() }
    );
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.entitlement.source, 'app_store');
    assert.equal(body.entitlement.isTrial, true);
    assert.equal(JSON.stringify(body).includes('550003097549367'), false);
});

test('requires both the installation id and Agora bearer token', async (t) => {
    const proAccessService = {
        async getCurrentAccess() {
            assert.fail('entitlement lookup must not run without authentication');
        },
    };
    const server = await startServer({ proAccessService });
    t.after(server.close);

    const missingInstallation = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement`,
        { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    assert.equal(missingInstallation.status, 400);

    const missingBearer = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement`,
        { headers: { 'X-Installation-ID': INSTALLATION_ID } }
    );
    assert.equal(missingBearer.status, 401);
});

test('never accepts a caller-selected account id and normalizes entitlement lookup failures', async (t) => {
    let authorized = false;
    const service = makeAuthService({
        async authorizeAccessToken(input) {
            authorized = true;
            assert.deepEqual(input, {
                installationId: INSTALLATION_ID,
                accessToken: ACCESS_TOKEN,
            });
            return {
                accountId: ACCOUNT_ID,
                sessionId: SESSION_ID,
                installationId: INSTALLATION_ID,
                authVersion: 1,
                accessTokenExpiresAt: new Date(NOW.getTime() + 900_000),
                sessionExpiresAt: new Date(NOW.getTime() + 86_400_000),
            };
        },
    });
    const proAccessService = {
        async getCurrentAccess(input) {
            assert.deepEqual(input, { accountId: ACCOUNT_ID });
            throw new AccountProAccessError(
                'pro_access_unavailable',
                'Internal entitlement state is unavailable.',
                { status: 503, retryable: true }
            );
        },
    };
    const server = await startServer({ service, proAccessService });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/subscription/entitlement?accountId=${OTHER_ACCOUNT_ID}`,
        { headers: requestHeaders() }
    );
    const body = await readJson(response);

    assert.equal(authorized, true);
    assert.equal(response.status, 503);
    assert.deepEqual(body, {
        error: {
            code: 'subscription_entitlement_unavailable',
            message: 'Subscription entitlement is temporarily unavailable.',
            retryable: true,
        },
    });
});