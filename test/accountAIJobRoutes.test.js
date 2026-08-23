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
    let storedJob = null;

    const execute = async (sql, params = []) => {
        const text = String(sql);
        queries.push({ text, params });

        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
            return { rows: [], rowCount: 0 };
        }

        if (
            text.includes('SELECT *') &&
            text.includes('FROM ai_generation_jobs')
        ) {
            if (!storedJob) return { rows: [], rowCount: 0 };

            if (
                text.includes('client_request_id = $1') &&
                params[0] !== storedJob.client_request_id
            ) {
                return { rows: [], rowCount: 0 };
            }
            if (
                !text.includes('client_request_id = $1') &&
                text.includes('id = $1') &&
                params[0] !== storedJob.id
            ) {
                return { rows: [], rowCount: 0 };
            }
            if (
                text.includes('account_id = $2') &&
                params[1] !== storedJob.account_id
            ) {
                return { rows: [], rowCount: 0 };
            }
            if (
                text.includes("status = 'failed'") &&
                storedJob.status !== 'failed'
            ) {
                return { rows: [], rowCount: 0 };
            }

            return { rows: [storedJob], rowCount: 1 };
        }

        if (text.includes('INSERT INTO ai_generation_jobs')) {
            storedJob = {
                id: JOB_ID,
                client_request_id: params[0],
                job_type: params[1],
                debate_id: params[2],
                user_id: params[3],
                account_id: params[4],
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
                metadata: JSON.parse(params[6]),
            };
            return { rows: [storedJob], rowCount: 1 };
        }

        throw new Error(`Unexpected test SQL: ${text}`);
    };

    const client = {
        query: execute,
        release() {},
    };

    return {
        queries,
        async connect() {
            return client;
        },
        query: execute,
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

function authHeaders(overrides = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...overrides,
    };
}

async function post(server, body, headers = {}) {
    return fetch(`${server.baseUrl}/api/account/ai-jobs`, {
        method: 'POST',
        headers: authHeaders(headers),
        body: JSON.stringify(body),
    });
}

function insertedQuery(server) {
    const insert = server.pool.queries.find((query) =>
        query.text.includes('INSERT INTO ai_generation_jobs')
    );
    assert.ok(insert, 'expected AI job insert');
    return insert;
}

function insertedMetadata(server) {
    return JSON.parse(insertedQuery(server).params[6]);
}

test('exact /api/account/ai-jobs route overrides forged client Pro metadata for a Free account', async (t) => {
    const server = await startServer({ isPro: false });
    t.after(server.close);

    const response = await post(server, requestBody());
    const body = await response.json();

    assert.equal(response.status, 202);
    assert.equal(body.success, true);
    assert.equal(body.job.id, JOB_ID);

    const insert = insertedQuery(server);
    assert.equal(insert.params[4], ACCOUNT_ID);

    const metadata = insertedMetadata(server);
    assert.equal(metadata.serverVerifiedPro, false);
    assert.equal(metadata.analyticsAccessTier, 'free');
    assert.equal(metadata.analyticsTierSource, 'authenticated_account_entitlement');
    assert.equal(metadata.proVerificationReason, 'authenticated_account_free');
    assert.equal(metadata.authenticatedAccountId, undefined);
    assert.equal(JSON.stringify(metadata).includes(ACCOUNT_ID), false);
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
    assert.equal(
        JSON.stringify(metadata).includes('client-value-must-not-be-trusted'),
        false
    );
});

test('account-authenticated recovery reads a created job by backend id and client request id', async (t) => {
    const server = await startServer({ isPro: true });
    t.after(server.close);

    const created = await post(server, requestBody());
    assert.equal(created.status, 202);

    const byId = await fetch(
        `${server.baseUrl}/api/account/ai-jobs/${JOB_ID}`,
        { headers: authHeaders() }
    );
    const byIdBody = await byId.json();
    assert.equal(byId.status, 200);
    assert.equal(byIdBody.success, true);
    assert.equal(byIdBody.job.id, JOB_ID);

    const byClient = await fetch(
        `${server.baseUrl}/api/account/ai-jobs/client/${CLIENT_REQUEST_ID}`,
        { headers: authHeaders() }
    );
    const byClientBody = await byClient.json();
    assert.equal(byClient.status, 200);
    assert.equal(byClientBody.success, true);
    assert.equal(byClientBody.job.clientRequestId, CLIENT_REQUEST_ID);

    const accountReads = server.pool.queries.filter((query) =>
        query.text.includes('FROM ai_generation_jobs') &&
        query.text.includes('account_id = $2')
    );
    assert.ok(accountReads.length >= 2);
    assert.ok(accountReads.every((query) => query.params[1] === ACCOUNT_ID));
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

test('requires a strict bearer account session and does not fall back to legacy client Pro metadata', async (t) => {
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
