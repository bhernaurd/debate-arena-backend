import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createAccountAuthRouter } from '../accountAuthRoutes.js';

const INSTALLATION_ID = 'android-ai-job-installation-001';
const OTHER_INSTALLATION_ID = 'android-ai-job-installation-999';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const CLIENT_REQUEST_ID = 'android-ai-job-request-001';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function makePool() {
    const queries = [];
    const client = {
        async query(sql, params = []) {
            const text = String(sql);
            queries.push({ text, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
                return { rows: [], rowCount: 0 };
            }
            if (
                text.includes('SELECT *') &&
                text.includes('FROM ai_generation_jobs')
            ) {
                return { rows: [], rowCount: 0 };
            }
            if (text.includes('INSERT INTO ai_generation_jobs')) {
                return {
                    rows: [{
                        id: JOB_ID,
                        client_request_id: params[0],
                        job_type: params[1],
                        debate_id: params[2],
                        user_id: params[3],
                        status: 'completed',
                        result_text: 'Already completed in the test fixture.',
                        error_message: null,
                        attempts: 1,
                        max_attempts: 3,
                        created_at: new Date('2026-08-23T06:45:00.000Z'),
                        updated_at: new Date('2026-08-23T06:45:00.000Z'),
                        processing_started_at: null,
                        completed_at: new Date('2026-08-23T06:45:01.000Z'),
                        failed_at: null,
                    }],
                    rowCount: 1,
                };
            }
            throw new Error(`Unexpected test SQL: ${text}`);
        },
        release() {},
    };
    return {
        queries,
        async connect() {
            return client;
        },
        async query() {
            return { rows: [], rowCount: 0 };
        },
    };
}

function makeAccountAuthService() {
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
                sessionId: '33333333-3333-4333-8333-333333333333',
                installationId: INSTALLATION_ID,
                authVersion: 1,
            };
        },
        async deleteAccount() {
            throw new Error('not used');
        },
    };
}

function makeGoogleService() {
    return {
        async signInWithGoogle() {
            throw new Error('not used');
        },
    };
}

function makeProAccessService({ isPro }) {
    return {
        async getCurrentAccess(input) {
            assert.deepEqual(input, { accountId: ACCOUNT_ID });
            return isPro
                ? {
                    hasProAccess: true,
                    accountId: ACCOUNT_ID,
                    checkedAt: new Date('2026-08-23T06:45:00.000Z'),
                    entitlement: {
                        environment: 'GooglePlay',
                        productId: 'agora_pro_yearly',
                        status: 'active',
                        isTrial: false,
                        accessExpiresAt: new Date('2027-08-23T06:45:00.000Z'),
                    },
                }
                : {
                    hasProAccess: false,
                    accountId: ACCOUNT_ID,
                    checkedAt: new Date('2026-08-23T06:45:00.000Z'),
                    entitlement: null,
                };
        },
    };
}

async function startServer({ isPro }) {
    const pool = makePool();
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use(
        '/api/account',
        createAccountAuthRouter(pool, {
            service: makeAccountAuthService(),
            googleService: makeGoogleService(),
            proAccessService: makeProAccessService({ isPro }),
            revokeSession: async () => true,
            logger: { warn() {}, error() {} },
        })
    );

    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return {
        pool,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function requestBody(overrides = {}) {
    return {
        clientRequestId: CLIENT_REQUEST_ID,
        jobType: 'debate_report_insight',
        debateId: 'debate-001',
        userId: INSTALLATION_ID,
        messages: [{ role: 'user', content: 'Analyze this debate.' }],
        systemPrompt: 'Return one concise insight.',
        metadata: {
            philosopherId: 'socrates',
            accessTier: 'pro',
            isPro: 'true',
            serverVerifiedPro: 'true',
        },
        proTransactionJWS: 'client-value-must-not-be-trusted',
        ...overrides,
    };
}

async function post(server, body, headers = {}) {
    return fetch(`${server.baseUrl}/api/account/ai-jobs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Installation-ID': INSTALLATION_ID,
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

function insertedMetadata(server) {
    const insert = server.pool.queries.find((query) =>
        query.text.includes('INSERT INTO ai_generation_jobs')
    );
    assert.ok(insert, 'expected AI job insert');
    return JSON.parse(insert.params[5]);
}

test('exact /api/account/ai-jobs route overrides forged client Pro metadata for a Free account', async (t) => {
    const server = await startServer({ isPro: false });
    t.after(server.close);

    const response = await post(server, requestBody());
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.success, true);
    assert.equal(body.job.id, JOB_ID);

    const metadata = insertedMetadata(server);
    assert.equal(metadata.serverVerifiedPro, false);
    assert.equal(metadata.analyticsAccessTier, 'free');
    assert.equal(metadata.analyticsTierSource, 'authenticated_account_entitlement');
    assert.equal(metadata.proVerificationReason, 'authenticated_account_free');
    assert.equal(metadata.authenticatedAccountId, ACCOUNT_ID);
    assert.notEqual(metadata.serverVerifiedPro, 'true');
});

test('verified account-level Google Play Pro becomes serverVerifiedPro for the shared worker path', async (t) => {
    const server = await startServer({ isPro: true });
    t.after(server.close);

    const response = await post(server, requestBody());
    assert.equal(response.status, 202);

    const metadata = insertedMetadata(server);
    assert.equal(metadata.serverVerifiedPro, true);
    assert.equal(metadata.analyticsAccessTier, 'paid_pro');
    assert.equal(metadata.proVerificationSource, 'google_play');
    assert.equal(metadata.proVerificationProductId, 'agora_pro_yearly');
    assert.equal(metadata.proVerificationOriginalTransactionId, null);
    assert.equal(metadata.authenticatedAccountId, ACCOUNT_ID);
    assert.equal(
        JSON.stringify(metadata).includes('client-value-must-not-be-trusted'),
        false
    );
});

test('rejects an installation mismatch before account authorization or persistence', async (t) => {
    const server = await startServer({ isPro: true });
    t.after(server.close);

    const response = await post(
        server,
        requestBody({ userId: OTHER_INSTALLATION_ID })
    );
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.success, false);
    assert.equal(body.code, 'installation_id_mismatch');
    assert.equal(
        server.pool.queries.some((query) =>
            query.text.includes('INSERT INTO ai_generation_jobs')
        ),
        false
    );
});

test('requires a bearer account session and does not fall back to legacy client Pro metadata', async (t) => {
    const server = await startServer({ isPro: true });
    t.after(server.close);

    const response = await post(
        server,
        requestBody(),
        { Authorization: 'Bearer not-a-valid-session' }
    );
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.success, false);
    assert.equal(body.code, 'invalid_access_token');
    assert.equal(
        server.pool.queries.some((query) =>
            query.text.includes('INSERT INTO ai_generation_jobs')
        ),
        false
    );
});
