import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    createAccountAIJobRouter,
} from '../accountAIJobRoutes.js';
import {
    AccountProAccessError,
} from '../lib/accountProAccessService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'android-ai-route-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';

function fakePool() {
    const state = {
        insertedMetadata: null,
        insertedPayload: null,
        released: false,
    };
    const client = {
        async query(text, values = []) {
            if (/^\s*BEGIN\s*$/i.test(text)) return { rows: [] };
            if (/^\s*COMMIT\s*$/i.test(text)) return { rows: [] };
            if (/^\s*ROLLBACK\s*$/i.test(text)) return { rows: [] };
            if (/SELECT \*\s+FROM ai_generation_jobs/i.test(text)) {
                return { rows: [] };
            }
            if (/INSERT INTO ai_generation_jobs/i.test(text)) {
                state.insertedPayload = JSON.parse(values[4]);
                state.insertedMetadata = JSON.parse(values[5]);
                return {
                    rows: [{
                        id: 'job-1',
                        client_request_id: values[0],
                        job_type: values[1],
                        debate_id: values[2],
                        user_id: values[3],
                        status: 'pending',
                        result_text: null,
                        error_message: null,
                        attempts: 0,
                        max_attempts: 3,
                        created_at: new Date('2026-08-22T12:00:00Z'),
                        updated_at: new Date('2026-08-22T12:00:00Z'),
                        processing_started_at: null,
                        completed_at: null,
                        failed_at: null,
                    }],
                };
            }
            throw new Error(`Unexpected query: ${text}`);
        },
        release() {
            state.released = true;
        },
    };
    return {
        state,
        async connect() {
            return client;
        },
    };
}

async function startServer({
    pool = fakePool(),
    proAccessService,
    accountAuthService,
} = {}) {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/account',
        createAccountAIJobRouter({
            pool,
            accountAuthService: accountAuthService ?? {
                async authorizeAccessToken() {
                    return {
                        accountId: ACCOUNT_ID,
                        installationId: INSTALLATION_ID,
                    };
                },
            },
            proAccessService: proAccessService ?? {
                async getCurrentAccess() {
                    return {
                        hasProAccess: true,
                        accountId: ACCOUNT_ID,
                        source: 'google_play',
                        entitlement: {
                            productId: 'agora_pro_monthly',
                            status: 'active',
                            isTrial: false,
                            accessExpiresAt: new Date('2026-09-22T12:00:00Z'),
                        },
                    };
                },
            },
            processJob: async () => null,
            logger: { error() {} },
        })
    );

    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        pool,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function headers(overrides = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...overrides,
    };
}

function body(overrides = {}) {
    return {
        clientRequestId: 'android-ai-request-1',
        jobType: 'debate_opening',
        debateId: 'debate-1',
        userId: INSTALLATION_ID,
        messages: [{ role: 'user', content: 'Begin.' }],
        systemPrompt: 'Debate carefully.',
        metadata: {
            philosopherId: 'socrates',
            accessTier: 'pro',
            isPro: 'true',
            serverVerifiedPro: 'false-client-spoof',
        },
        ...overrides,
    };
}

test('authenticated Google Play Pro creates a persistent job with backend-owned Pro metadata', async (t) => {
    let authInput = null;
    const pool = fakePool();
    const server = await startServer({
        pool,
        accountAuthService: {
            async authorizeAccessToken(input) {
                authInput = input;
                return {
                    accountId: ACCOUNT_ID,
                    installationId: INSTALLATION_ID,
                };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/ai-jobs`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body()),
        }
    );
    const payload = await response.json();

    assert.equal(response.status, 202);
    assert.equal(payload.success, true);
    assert.deepEqual(authInput, {
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });
    assert.equal(pool.state.insertedMetadata.serverVerifiedPro, true);
    assert.equal(
        pool.state.insertedMetadata.authenticatedAccountId,
        ACCOUNT_ID
    );
    assert.equal(
        pool.state.insertedMetadata.proVerificationReason,
        'verified_account_google_play'
    );
    assert.equal(
        pool.state.insertedMetadata.proVerificationSource,
        'account_google_play'
    );
    assert.equal(
        pool.state.insertedMetadata.analyticsTierSource,
        'server_verified_google_play_account'
    );
    assert.equal(pool.state.released, true);
});

test('client Pro metadata cannot create server-verified Pro when the account has no entitlement', async (t) => {
    const pool = fakePool();
    const server = await startServer({
        pool,
        proAccessService: {
            async getCurrentAccess() {
                return {
                    hasProAccess: false,
                    accountId: ACCOUNT_ID,
                    source: null,
                    entitlement: null,
                };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/ai-jobs`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body()),
        }
    );

    assert.equal(response.status, 202);
    assert.equal(pool.state.insertedMetadata.serverVerifiedPro, false);
    assert.equal(
        pool.state.insertedMetadata.proVerificationReason,
        'no_verified_account_entitlement'
    );
    assert.equal(
        pool.state.insertedMetadata.analyticsAccessTier,
        'free'
    );
});

test('temporary store verification outage downgrades a standard debate instead of taking AI offline', async (t) => {
    const pool = fakePool();
    const server = await startServer({
        pool,
        proAccessService: {
            async getCurrentAccess() {
                throw new AccountProAccessError(
                    'pro_access_unavailable',
                    'Store temporarily unavailable.',
                    { status: 503, retryable: true }
                );
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/ai-jobs`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(body()),
        }
    );

    assert.equal(response.status, 202);
    assert.equal(pool.state.insertedMetadata.serverVerifiedPro, false);
    assert.equal(
        pool.state.insertedMetadata.proVerificationReason,
        'account_entitlement_verification_unavailable'
    );
    assert.equal(
        pool.state.insertedMetadata.analyticsAccessTier,
        'free'
    );
});

test('account AI creation rejects missing bearer auth before touching the job database', async (t) => {
    const pool = fakePool();
    let authorized = false;
    const server = await startServer({
        pool,
        accountAuthService: {
            async authorizeAccessToken() {
                authorized = true;
                return { accountId: ACCOUNT_ID };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/ai-jobs`,
        {
            method: 'POST',
            headers: headers({ Authorization: '' }),
            body: JSON.stringify(body()),
        }
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.code, 'missing_access_token');
    assert.equal(authorized, false);
    assert.equal(pool.state.insertedMetadata, null);
});
