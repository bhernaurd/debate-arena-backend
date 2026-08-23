import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    FcmServiceError,
    createFcmService,
    loadFcmServiceAccountConfig,
} from '../lib/fcmService.js';

const NOW_MS = Date.UTC(2026, 7, 22, 23, 0, 0);

function serviceAccountConfig() {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return {
        clientEmail: 'firebase-adminsdk@example-project.iam.gserviceaccount.com',
        privateKey,
        projectId: 'example-project',
        tokenUri: 'https://oauth2.googleapis.com/token',
    };
}

function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        },
    };
}

test('FCM service obtains OAuth once and sends HTTP v1 messages with string data', async () => {
    const calls = [];
    const service = createFcmService({
        config: serviceAccountConfig(),
        now: () => NOW_MS,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url === 'https://oauth2.googleapis.com/token') {
                return jsonResponse(200, {
                    access_token: 'oauth-token-1',
                    expires_in: 3600,
                });
            }
            return jsonResponse(200, {
                name: `projects/example-project/messages/${calls.length}`,
            });
        },
    });

    const first = await service.send({
        token: 'fcm-token-abcdefghijklmnopqrstuvwxyz0123456789',
        title: 'Socrates enters the Agora.',
        body: 'A new question is waiting.',
        data: {
            type: 'daily_challenge',
            challengeId: 123,
            completed: false,
            omitted: null,
        },
    });
    const second = await service.send({
        token: 'fcm-token-abcdefghijklmnopqrstuvwxyz0123456789',
        title: 'Socrates is waiting.',
        body: 'Return to the Agora.',
        data: { timeOfDay: 'afternoon' },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(calls.length, 3, 'OAuth access token should be reused for the second send');
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.match(String(calls[0].options.body), /grant_type=urn%3Aietf-params%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    assert.equal(
        calls[1].url,
        'https://fcm.googleapis.com/v1/projects/example-project/messages:send'
    );
    assert.equal(calls[1].options.headers.Authorization, 'Bearer oauth-token-1');

    const messageBody = JSON.parse(calls[1].options.body);
    assert.equal(messageBody.message.token, 'fcm-token-abcdefghijklmnopqrstuvwxyz0123456789');
    assert.deepEqual(messageBody.message.notification, {
        title: 'Socrates enters the Agora.',
        body: 'A new question is waiting.',
    });
    assert.deepEqual(messageBody.message.data, {
        type: 'daily_challenge',
        challengeId: '123',
        completed: 'false',
    });
    assert.equal(
        messageBody.message.android.notification.channel_id,
        'agora_daily_challenge'
    );
});

test('FCM UNREGISTERED failure is permanent and should disable the token', async () => {
    let call = 0;
    const service = createFcmService({
        config: serviceAccountConfig(),
        now: () => NOW_MS,
        fetchImpl: async () => {
            call += 1;
            if (call === 1) {
                return jsonResponse(200, {
                    access_token: 'oauth-token-1',
                    expires_in: 3600,
                });
            }
            return jsonResponse(404, {
                error: {
                    status: 'NOT_FOUND',
                    message: 'Requested entity was not found.',
                    details: [{ errorCode: 'UNREGISTERED' }],
                },
            });
        },
    });

    const outcome = await service.send({
        token: 'fcm-token-abcdefghijklmnopqrstuvwxyz0123456789',
        title: 'The Agora',
        body: 'Question',
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'UNREGISTERED');
    assert.equal(outcome.permanent, true);
    assert.equal(outcome.retryable, false);
});

test('FCM service outages remain retryable and do not permanently disable tokens', async () => {
    let call = 0;
    const service = createFcmService({
        config: serviceAccountConfig(),
        now: () => NOW_MS,
        fetchImpl: async () => {
            call += 1;
            if (call === 1) {
                return jsonResponse(200, {
                    access_token: 'oauth-token-1',
                    expires_in: 3600,
                });
            }
            return jsonResponse(503, {
                error: {
                    status: 'UNAVAILABLE',
                    message: 'Service temporarily unavailable.',
                },
            });
        },
    });

    const outcome = await service.send({
        token: 'fcm-token-abcdefghijklmnopqrstuvwxyz0123456789',
        title: 'The Agora',
        body: 'Question',
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'UNAVAILABLE');
    assert.equal(outcome.permanent, false);
    assert.equal(outcome.retryable, true);
});

test('missing Firebase server credentials fail lazily with an explicit configuration error', () => {
    assert.throws(
        () => loadFcmServiceAccountConfig({}),
        (error) => {
            assert.ok(error instanceof FcmServiceError);
            assert.equal(error.code, 'firebase_not_configured');
            assert.equal(error.retryable, false);
            return true;
        }
    );
});
