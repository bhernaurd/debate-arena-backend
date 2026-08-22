import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    createGooglePlaySubscriptionRouter,
} from '../googlePlaySubscriptionRoutes.js';

const INSTALLATION_ID = 'android-play-route-001';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 'aaa.bbb.ccc';

async function startServer({
    service,
    accountAuthService,
} = {}) {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/account',
        createGooglePlaySubscriptionRouter({
            service: service ?? {
                async syncPurchase() {
                    return {
                        acknowledged: true,
                        entitlement: {
                            isPro: true,
                            productId: 'agora_pro_monthly',
                            basePlanId: 'monthly',
                            offerId: null,
                            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                            expiryTime: new Date('2026-09-22T12:00:00Z'),
                            inFreeTrial: false,
                        },
                    };
                },
            },
            accountAuthService: accountAuthService ?? {
                async authorizeAccessToken() {
                    return {
                        accountId: ACCOUNT_ID,
                        installationId: INSTALLATION_ID,
                    };
                },
            },
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
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function requestHeaders(overrides = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...overrides,
    };
}

function requestBody(overrides = {}) {
    return {
        packageName: 'com.bhernaurd.theagora',
        purchaseToken: 'google-play-purchase-token',
        productId: 'agora_pro_monthly',
        basePlanId: 'monthly',
        offerId: null,
        pricingCohortHint: 'standard',
        paywallSessionId: 'paywall-session-1',
        ...overrides,
    };
}

test('Google Play sync is authenticated and binds the service call to the authorized Agora account', async (t) => {
    let authorizedInput = null;
    let syncInput = null;
    const server = await startServer({
        accountAuthService: {
            async authorizeAccessToken(input) {
                authorizedInput = input;
                return {
                    accountId: ACCOUNT_ID,
                    installationId: INSTALLATION_ID,
                };
            },
        },
        service: {
            async syncPurchase(input) {
                syncInput = input;
                return {
                    acknowledged: false,
                    entitlement: {
                        isPro: true,
                        productId: 'agora_pro_monthly',
                        basePlanId: 'monthly',
                        offerId: null,
                        subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                        expiryTime: new Date('2026-09-22T12:00:00Z'),
                        inFreeTrial: false,
                    },
                };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify(requestBody()),
        }
    );
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(authorizedInput, {
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });
    assert.equal(syncInput.accountId, ACCOUNT_ID);
    assert.equal(syncInput.purchaseToken, 'google-play-purchase-token');
    assert.equal(syncInput.productId, 'agora_pro_monthly');
    assert.equal(payload.success, true);
    assert.equal(payload.acknowledged, false);
    assert.equal(payload.accountOwnership.linked, true);
    assert.equal(payload.accountOwnership.accountId, ACCOUNT_ID);
    assert.equal(
        payload.accountOwnership.claimSource,
        'google_play_obfuscated_account_id'
    );
    assert.equal(payload.entitlement.isPro, true);
    assert.equal(
        payload.entitlement.expiryTime,
        '2026-09-22T12:00:00.000Z'
    );
});

test('Google Play sync rejects requests without Agora bearer authentication', async (t) => {
    let authorized = false;
    const server = await startServer({
        accountAuthService: {
            async authorizeAccessToken() {
                authorized = true;
                return { accountId: ACCOUNT_ID };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: requestHeaders({ Authorization: '' }),
            body: JSON.stringify(requestBody()),
        }
    );
    const payload = await response.json();

    assert.equal(response.status, 401);
    assert.equal(payload.success, false);
    assert.equal(payload.errorCode, 'missing_access_token');
    assert.equal(authorized, false);
});

test('client-supplied account identifiers are ignored in favor of the authenticated account', async (t) => {
    let syncInput = null;
    const server = await startServer({
        service: {
            async syncPurchase(input) {
                syncInput = input;
                return {
                    acknowledged: true,
                    entitlement: {
                        isPro: false,
                        productId: 'agora_pro_monthly',
                        basePlanId: 'monthly',
                        offerId: null,
                        subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD',
                        expiryTime: new Date('2026-09-22T12:00:00Z'),
                        inFreeTrial: false,
                    },
                };
            },
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({
                ...requestBody(),
                accountId: '22222222-2222-4222-8222-222222222222',
            }),
        }
    );

    assert.equal(response.status, 200);
    assert.equal(syncInput.accountId, ACCOUNT_ID);
});
