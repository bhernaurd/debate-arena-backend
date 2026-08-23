import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createGooglePlayNotificationRouter } from '../googlePlayNotificationRoutes.js';
import { GooglePlayNotificationError } from '../lib/googlePlayNotificationService.js';

const AUDIENCE = 'https://backend.example.test/api/account/google-play/notifications';
const SERVICE_ACCOUNT_EMAIL = 'play-rtdn@example-project.iam.gserviceaccount.com';
const TOKEN = 'aaa.bbb.ccc';
const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PURCHASE_TOKEN = 'rtdn-sensitive-token';
const PRODUCT_ID = 'agora_pro_yearly';

function pubSubBody(payload) {
    return {
        message: {
            messageId: 'pubsub-message-1',
            data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
        },
        subscription: 'projects/test/subscriptions/play-rtdn',
    };
}

function subscriptionPayload(overrides = {}) {
    return {
        version: '1.0',
        packageName: PACKAGE_NAME,
        eventTimeMillis: '1787455800000',
        subscriptionNotification: {
            version: '1.0',
            notificationType: 2,
            purchaseToken: PURCHASE_TOKEN,
            subscriptionId: PRODUCT_ID,
        },
        ...overrides,
    };
}

async function startServer({
    verifyOidcToken = async () => ({
        email: SERVICE_ACCOUNT_EMAIL,
        emailVerified: true,
    }),
    notificationService = null,
} = {}) {
    const calls = [];
    const service = notificationService ?? {
        async processSubscriptionNotification(input) {
            calls.push(input);
            return { processed: true };
        },
    };
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account/google-play',
        createGooglePlayNotificationRouter(
            { connect: async () => { throw new Error('not used'); } },
            {
                notificationService: service,
                verifyOidcToken,
                audience: AUDIENCE,
                serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
                logger: { warn() {}, error() {} },
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
        calls,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

async function post(server, body, headers = {}) {
    return fetch(
        `${server.baseUrl}/api/account/google-play/notifications`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${TOKEN}`,
                ...headers,
            },
            body: JSON.stringify(body),
        }
    );
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test('authenticates Pub/Sub OIDC before passing only decoded subscription data to reconciliation', async (t) => {
    let presentedToken = null;
    const server = await startServer({
        verifyOidcToken: async (token) => {
            presentedToken = token;
            return {
                email: SERVICE_ACCOUNT_EMAIL,
                emailVerified: true,
            };
        },
    });
    t.after(server.close);

    const response = await post(server, pubSubBody(subscriptionPayload()));

    assert.equal(response.status, 204);
    assert.equal(presentedToken, TOKEN);
    assert.deepEqual(server.calls, [{
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
        subscriptionId: PRODUCT_ID,
    }]);
});

test('rejects a different Google service-account identity before reading entitlement data', async (t) => {
    const server = await startServer({
        verifyOidcToken: async () => ({
            email: 'attacker@example-project.iam.gserviceaccount.com',
            emailVerified: true,
        }),
    });
    t.after(server.close);

    const response = await post(server, pubSubBody(subscriptionPayload()));
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'invalid_google_pubsub_identity');
    assert.equal(server.calls.length, 0);
});

test('requires a syntactically valid OIDC bearer token', async (t) => {
    let verifierCalls = 0;
    const server = await startServer({
        verifyOidcToken: async () => {
            verifierCalls += 1;
            return {
                email: SERVICE_ACCOUNT_EMAIL,
                emailVerified: true,
            };
        },
    });
    t.after(server.close);

    const response = await post(
        server,
        pubSubBody(subscriptionPayload()),
        { Authorization: 'Bearer invalid-token' }
    );

    assert.equal(response.status, 401);
    assert.equal(verifierCalls, 0);
    assert.equal(server.calls.length, 0);
});

test('acknowledges an authenticated malformed or Pub/Sub test notification without mutation', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const malformed = await post(server, {
        message: { data: 'not base64 !!!' },
    });
    assert.equal(malformed.status, 204);

    const testNotification = await post(
        server,
        pubSubBody({ testNotification: { version: '1.0' } })
    );
    assert.equal(testNotification.status, 204);
    assert.equal(server.calls.length, 0);
});

test('returns retryable 503 when authenticated reconciliation cannot reach its authority', async (t) => {
    const server = await startServer({
        notificationService: {
            async processSubscriptionNotification() {
                throw new GooglePlayNotificationError(
                    'google_play_api_unavailable',
                    'Google Play is unavailable.',
                    { status: 503, retryable: true }
                );
            },
        },
    });
    t.after(server.close);

    const response = await post(server, pubSubBody(subscriptionPayload()));
    const body = await readJson(response);

    assert.equal(response.status, 503);
    assert.deepEqual(body, {
        error: {
            code: 'google_play_notification_unavailable',
            message: 'Google Play notification processing is temporarily unavailable.',
            retryable: true,
        },
    });
});
