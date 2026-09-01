import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    classifyFcmFailure,
    createFcmPushService,
} from '../lib/fcmPushService.js';

function jsonResponse(status, body, headers = {}) {
    const normalizedHeaders = new Map(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)])
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return normalizedHeaders.get(String(name).toLowerCase()) || null;
            },
        },
        async json() {
            return body;
        },
    };
}

function testCredentials() {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    return {
        clientEmail: 'firebase-messaging@example-project.iam.gserviceaccount.com',
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        privateKeyId: 'test-key-id',
        projectId: 'example-project',
    };
}

test('FCM sender mints an OAuth token and sends a high-priority data message to the Android package', async () => {
    const calls = [];
    const credentials = testCredentials();
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('oauth2.googleapis.com/token')) {
            return jsonResponse(200, {
                access_token: 'test-access-token',
                expires_in: 3600,
            });
        }
        return jsonResponse(200, {
            name: 'projects/example-project/messages/message-1',
        });
    };

    const service = createFcmPushService({
        fetchImpl,
        now: () => Date.UTC(2026, 8, 1, 22, 0, 0),
        credentialsProvider: () => credentials,
        androidPackageName: 'com.bhernaurd.theagora',
    });

    const result = await service.sendPush(
        'fcm-token:abc_DEF-123456789012345678901234567890',
        'Socrates enters the Agora.',
        'Today’s question is waiting.',
        {
            challengeId: 'daily-2026-09-01',
            challengeDate: '2026-09-01',
            philosopherId: 'socrates',
        }
    );

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'fcm');
    assert.equal(calls.length, 2);

    const tokenRequest = calls[0];
    assert.match(tokenRequest.url, /oauth2\.googleapis\.com\/token$/);
    assert.equal(tokenRequest.options.method, 'POST');
    assert.match(String(tokenRequest.options.body), /grant_type=/);
    assert.match(String(tokenRequest.options.body), /assertion=/);

    const sendRequest = calls[1];
    assert.equal(
        sendRequest.url,
        'https://fcm.googleapis.com/v1/projects/example-project/messages:send'
    );
    assert.equal(
        sendRequest.options.headers.Authorization,
        'Bearer test-access-token'
    );

    const payload = JSON.parse(sendRequest.options.body);
    assert.equal(payload.message.android.priority, 'HIGH');
    assert.equal(payload.message.android.ttl, '3600s');
    assert.equal(
        payload.message.android.restricted_package_name,
        'com.bhernaurd.theagora'
    );
    assert.equal(payload.message.data.type, 'daily_challenge');
    assert.equal(payload.message.data.deepLink, 'theagora://daily-challenge');
    assert.equal(payload.message.data.challengeId, 'daily-2026-09-01');
    assert.equal(payload.message.data.title, 'Socrates enters the Agora.');
    assert.equal(payload.message.data.body, 'Today’s question is waiting.');
    assert.equal(payload.message.notification, undefined);
});

test('FCM classifies unregistered tokens as permanent failures', () => {
    const failure = classifyFcmFailure(404, {
        error: {
            status: 'NOT_FOUND',
            details: [{
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
            }],
        },
    });

    assert.equal(failure.code, 'UNREGISTERED');
    assert.equal(failure.permanent, true);
    assert.equal(failure.retryable, false);
});

test('FCM classifies quota and service failures as retryable without disabling the token', () => {
    const quota = classifyFcmFailure(429, {
        error: { status: 'RESOURCE_EXHAUSTED' },
    });
    assert.equal(quota.permanent, false);
    assert.equal(quota.retryable, true);

    const unavailable = classifyFcmFailure(503, {
        error: { status: 'UNAVAILABLE' },
    });
    assert.equal(unavailable.permanent, false);
    assert.equal(unavailable.retryable, true);
});

test('FCM refreshes its OAuth token once when Google rejects a send with 401', async () => {
    const credentials = testCredentials();
    let tokenCalls = 0;
    let sendCalls = 0;

    const service = createFcmPushService({
        credentialsProvider: () => credentials,
        fetchImpl: async (url) => {
            if (String(url).includes('oauth2.googleapis.com/token')) {
                tokenCalls += 1;
                return jsonResponse(200, {
                    access_token: `token-${tokenCalls}`,
                    expires_in: 3600,
                });
            }
            sendCalls += 1;
            if (sendCalls === 1) {
                return jsonResponse(401, {
                    error: { status: 'UNAUTHENTICATED' },
                });
            }
            return jsonResponse(200, {
                name: 'projects/example-project/messages/retried-message',
            });
        },
    });

    const result = await service.sendPush(
        'fcm-token:abc_DEF-123456789012345678901234567890',
        'Title',
        'Body'
    );

    assert.equal(result.ok, true);
    assert.equal(tokenCalls, 2);
    assert.equal(sendCalls, 2);
});

test('FCM retries one explicit 503 after the required backoff instead of failing the delivery immediately', async () => {
    const credentials = testCredentials();
    const delays = [];
    let sendCalls = 0;

    const service = createFcmPushService({
        credentialsProvider: () => credentials,
        now: () => Date.UTC(2026, 8, 1, 22, 0, 0),
        random: () => 0,
        sleepImpl: async delayMs => {
            delays.push(delayMs);
        },
        fetchImpl: async (url) => {
            if (String(url).includes('oauth2.googleapis.com/token')) {
                return jsonResponse(200, {
                    access_token: 'token-1',
                    expires_in: 3600,
                });
            }

            sendCalls += 1;
            if (sendCalls === 1) {
                return jsonResponse(503, {
                    error: { status: 'UNAVAILABLE' },
                });
            }

            return jsonResponse(200, {
                name: 'projects/example-project/messages/recovered-message',
            });
        },
    });

    const result = await service.sendPush(
        'fcm-token:abc_DEF-123456789012345678901234567890',
        'Title',
        'Body'
    );

    assert.equal(result.ok, true);
    assert.equal(sendCalls, 2);
    assert.deepEqual(delays, [10_000]);
});

test('FCM honors Retry-After for one quota retry', async () => {
    const credentials = testCredentials();
    const delays = [];
    let sendCalls = 0;

    const service = createFcmPushService({
        credentialsProvider: () => credentials,
        now: () => Date.UTC(2026, 8, 1, 22, 0, 0),
        sleepImpl: async delayMs => {
            delays.push(delayMs);
        },
        fetchImpl: async (url) => {
            if (String(url).includes('oauth2.googleapis.com/token')) {
                return jsonResponse(200, {
                    access_token: 'token-1',
                    expires_in: 3600,
                });
            }

            sendCalls += 1;
            if (sendCalls === 1) {
                return jsonResponse(
                    429,
                    { error: { status: 'RESOURCE_EXHAUSTED' } },
                    { 'Retry-After': '75' }
                );
            }

            return jsonResponse(200, {
                name: 'projects/example-project/messages/quota-recovered-message',
            });
        },
    });

    const result = await service.sendPush(
        'fcm-token:abc_DEF-123456789012345678901234567890',
        'Title',
        'Body'
    );

    assert.equal(result.ok, true);
    assert.equal(sendCalls, 2);
    assert.deepEqual(delays, [75_000]);
});
