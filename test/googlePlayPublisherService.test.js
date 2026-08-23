import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createGooglePlayPublisherService,
} from '../lib/googlePlayPublisherService.js';

const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PURCHASE_TOKEN = 'play-purchase-token-123';
const PRODUCT_ID = 'agora_pro_yearly';
const NOW_MS = Date.UTC(2026, 7, 23, 4, 0, 0);

function testConfig() {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem',
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem',
        },
    });

    return {
        clientEmail: 'publisher@test-project.iam.gserviceaccount.com',
        privateKey,
        tokenUri: 'https://oauth.example.test/token',
        packageName: PACKAGE_NAME,
    };
}

function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

test('verifies subscriptionsv2 with a service-account OAuth token', async () => {
    const calls = [];
    const service = createGooglePlayPublisherService({
        config: testConfig(),
        now: () => NOW_MS,
        fetchImpl: async (url, options = {}) => {
            calls.push({ url: String(url), options });
            if (String(url) === 'https://oauth.example.test/token') {
                return jsonResponse(200, {
                    access_token: 'publisher-access-token',
                    expires_in: 3600,
                });
            }

            return jsonResponse(200, {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
                lineItems: [
                    {
                        productId: PRODUCT_ID,
                        expiryTime: '2027-08-23T04:00:00Z',
                    },
                ],
            });
        },
    });

    const result = await service.getSubscription({
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
    });

    assert.equal(
        result.subscriptionState,
        'SUBSCRIPTION_STATE_ACTIVE'
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://oauth.example.test/token');
    assert.match(
        String(calls[0].options.body),
        /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/
    );
    assert.equal(
        calls[1].url,
        'https://androidpublisher.googleapis.com/androidpublisher/v3/' +
        `applications/${PACKAGE_NAME}/purchases/subscriptionsv2/tokens/` +
        encodeURIComponent(PURCHASE_TOKEN)
    );
    assert.equal(
        calls[1].options.headers.Authorization,
        'Bearer publisher-access-token'
    );
});

test('acknowledges a verified subscription and reuses the cached OAuth token', async () => {
    const calls = [];
    const service = createGooglePlayPublisherService({
        config: testConfig(),
        now: () => NOW_MS,
        fetchImpl: async (url, options = {}) => {
            calls.push({ url: String(url), options });
            if (String(url) === 'https://oauth.example.test/token') {
                return jsonResponse(200, {
                    access_token: 'publisher-access-token',
                    expires_in: 3600,
                });
            }
            if (String(url).includes('subscriptionsv2')) {
                return jsonResponse(200, {
                    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                    lineItems: [{ productId: PRODUCT_ID }],
                });
            }
            return jsonResponse(200, {});
        },
    });

    await service.getSubscription({
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
    });
    const acknowledged = await service.acknowledgeSubscription({
        packageName: PACKAGE_NAME,
        productId: PRODUCT_ID,
        purchaseToken: PURCHASE_TOKEN,
    });

    assert.equal(acknowledged, true);
    assert.equal(
        calls.filter((call) =>
            call.url === 'https://oauth.example.test/token'
        ).length,
        1
    );
    const acknowledgeCall = calls.at(-1);
    assert.equal(
        acknowledgeCall.url,
        'https://androidpublisher.googleapis.com/androidpublisher/v3/' +
        `applications/${PACKAGE_NAME}/purchases/subscriptions/` +
        `${PRODUCT_ID}/tokens/${encodeURIComponent(PURCHASE_TOKEN)}:acknowledge`
    );
    assert.equal(acknowledgeCall.options.method, 'POST');
});

test('rejects a package mismatch before sending the purchase token', async () => {
    let calls = 0;
    const service = createGooglePlayPublisherService({
        config: testConfig(),
        now: () => NOW_MS,
        fetchImpl: async () => {
            calls += 1;
            throw new Error('must not be called');
        },
    });

    await assert.rejects(
        service.getSubscription({
            packageName: 'com.example.notagora',
            purchaseToken: PURCHASE_TOKEN,
        }),
        (error) => {
            assert.equal(error.code, 'google_play_package_mismatch');
            assert.equal(error.status, 400);
            return true;
        }
    );
    assert.equal(calls, 0);
});
