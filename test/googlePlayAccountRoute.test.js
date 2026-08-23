import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    createAccountAuthRouter,
} from '../accountAuthRoutes.js';
import {
    GooglePlaySubscriptionError,
} from '../lib/googlePlaySubscriptionService.js';

const INSTALLATION_ID = 'android-installation-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

function accountService() {
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
        async authorizeAccessToken() {
            return {
                accountId: ACCOUNT_ID,
            };
        },
        async deleteAccount() {
            throw new Error('not used');
        },
    };
}

async function startServer(googlePlayService) {
    const app = express();
    app.use(express.json());
    app.use(
        '/api/account',
        createAccountAuthRouter(
            {
                async query() {
                    return { rows: [], rowCount: 0 };
                },
            },
            {
                service: accountService(),
                googleService: {
                    async signInWithGoogle() {
                        throw new Error('not used');
                    },
                },
                googlePlayService,
                revokeSession: async () => true,
                logger: { error() {} },
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

function headers() {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
    };
}

test('forwards authenticated Play purchase data to the verification service', async (t) => {
    let captured;
    const server = await startServer({
        async syncPurchase(input) {
            captured = input;
            return {
                success: true,
                acknowledged: true,
                accountOwnership: {
                    linked: true,
                    accountId: ACCOUNT_ID,
                    migratedLegacyOwnership: false,
                    claimSource: 'authenticated_google_play_sync',
                },
                entitlement: {
                    isPro: true,
                    productId: 'agora_pro_yearly',
                    basePlanId: 'yearly',
                    offerId: 'founding',
                    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                    expiryTime: '2027-08-23T04:00:00.000Z',
                    inFreeTrial: null,
                },
            };
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
                packageName: 'com.bhernaurd.theagora',
                purchaseToken: 'purchase-token',
                productId: 'agora_pro_yearly',
                basePlanId: 'yearly',
                offerId: 'founding',
                pricingCohortHint: 'founding_2026',
                paywallSessionId: 'paywall-1',
                accountId: 'attacker-controlled-id-is-ignored',
            }),
        }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.entitlement.isPro, true);
    assert.deepEqual(captured, {
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
        packageName: 'com.bhernaurd.theagora',
        purchaseToken: 'purchase-token',
        productId: 'agora_pro_yearly',
        basePlanId: 'yearly',
        offerId: 'founding',
        pricingCohortHint: 'founding_2026',
        paywallSessionId: 'paywall-1',
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('returns the Android top-level error contract for verification failures', async (t) => {
    const server = await startServer({
        async syncPurchase() {
            throw new GooglePlaySubscriptionError(
                'google_play_account_mismatch',
                'This Google Play subscription is linked to a different Agora account.',
                { status: 409, retryable: false }
            );
        },
    });
    t.after(server.close);

    const response = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({
                packageName: 'com.bhernaurd.theagora',
                purchaseToken: 'purchase-token',
                productId: 'agora_pro_yearly',
            }),
        }
    );
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
        success: false,
        error: 'This Google Play subscription is linked to a different Agora account.',
        errorCode: 'google_play_account_mismatch',
        retryable: false,
    });
});

test('requires both Agora bearer authentication and installation identity', async (t) => {
    let calls = 0;
    const server = await startServer({
        async syncPurchase() {
            calls += 1;
            throw new Error('must not be called');
        },
    });
    t.after(server.close);

    const noInstallation = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ACCESS_TOKEN}`,
            },
            body: JSON.stringify({
                packageName: 'com.bhernaurd.theagora',
                purchaseToken: 'purchase-token',
                productId: 'agora_pro_yearly',
            }),
        }
    );
    assert.equal(noInstallation.status, 400);

    const noAuthorization = await fetch(
        `${server.baseUrl}/api/account/google-play/sync-purchase`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Installation-ID': INSTALLATION_ID,
            },
            body: JSON.stringify({
                packageName: 'com.bhernaurd.theagora',
                purchaseToken: 'purchase-token',
                productId: 'agora_pro_yearly',
            }),
        }
    );
    assert.equal(noAuthorization.status, 401);
    assert.equal(calls, 0);
});
