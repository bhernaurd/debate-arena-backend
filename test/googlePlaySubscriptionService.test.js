import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createGooglePlaySubscriptionService,
} from '../lib/googlePlaySubscriptionService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '99999999-9999-4999-8999-999999999999';
const INSTALLATION_ID = 'android-installation-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PURCHASE_TOKEN = 'purchase-token-sensitive-value';
const PRODUCT_ID = 'agora_pro_yearly';
const NOW_MS = Date.UTC(2026, 7, 23, 4, 0, 0);
const EXPIRY = '2027-08-23T04:00:00.000Z';

function sha256(value) {
    return crypto.createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

const ACCOUNT_PLAY_ID = sha256(ACCOUNT_ID);
const OTHER_ACCOUNT_PLAY_ID = sha256(OTHER_ACCOUNT_ID);

function makeAccountAuthService() {
    return {
        async authorizeAccessToken(input) {
            assert.deepEqual(input, {
                installationId: INSTALLATION_ID,
                accessToken: ACCESS_TOKEN,
            });
            return {
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
            };
        },
    };
}

function makePublisherService(overrides = {}) {
    const calls = {
        get: [],
        acknowledge: [],
    };
    const service = {
        async getSubscription(input) {
            calls.get.push(input);
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
                startTime: '2026-08-23T04:00:00Z',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: ACCOUNT_PLAY_ID,
                },
                lineItems: [
                    {
                        productId: PRODUCT_ID,
                        expiryTime: EXPIRY,
                        autoRenewingPlan: {
                            autoRenewEnabled: true,
                        },
                        offerDetails: {
                            basePlanId: 'yearly',
                            offerId: 'founding',
                        },
                        latestSuccessfulOrderId: 'GPA.1234-5678',
                    },
                ],
            };
        },
        async acknowledgeSubscription(input) {
            calls.acknowledge.push(input);
            return true;
        },
        ...overrides,
    };
    return { service, calls };
}

function makePool({
    existingAccount = null,
    linkedAccount = null,
} = {}) {
    const queries = [];
    let accountLookupCount = 0;

    const client = {
        async query(sql, params = []) {
            const text = String(sql);
            queries.push({ scope: 'client', text, params });

            if (
                text === 'BEGIN' ||
                text === 'COMMIT' ||
                text === 'ROLLBACK'
            ) {
                return { rows: [], rowCount: 0 };
            }
            if (text.includes('pg_advisory_xact_lock')) {
                return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
            }
            if (
                text.includes('SELECT account_id') &&
                text.includes('google_play_subscription_entitlements')
            ) {
                accountLookupCount += 1;
                const account = accountLookupCount === 1
                    ? existingAccount
                    : linkedAccount;
                return {
                    rows: account ? [{ account_id: account }] : [],
                    rowCount: account ? 1 : 0,
                };
            }
            if (text.includes('INSERT INTO google_play_subscription_entitlements')) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected client SQL in test: ${text}`);
        },
        release() {},
    };

    return {
        queries,
        async connect() {
            return client;
        },
        async query(sql, params = []) {
            const text = String(sql);
            queries.push({ scope: 'pool', text, params });
            if (text.includes('UPDATE google_play_subscription_entitlements')) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected pool SQL in test: ${text}`);
        },
    };
}

function syncInput(overrides = {}) {
    return {
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
        productId: PRODUCT_ID,
        basePlanId: 'yearly',
        offerId: 'founding',
        pricingCohortHint: 'founding_2026',
        paywallSessionId: 'paywall-session-1',
        ...overrides,
    };
}

function lifecyclePublisher(subscriptionState) {
    return makePublisherService({
        async getSubscription() {
            return {
                subscriptionState,
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: ACCOUNT_PLAY_ID,
                },
                lineItems: [
                    {
                        productId: PRODUCT_ID,
                        expiryTime: EXPIRY,
                        offerDetails: {
                            basePlanId: 'yearly',
                            offerId: 'founding',
                        },
                    },
                ],
            };
        },
    });
}

test('verifies, persists, then acknowledges an entitled Google Play purchase', async () => {
    const pool = makePool();
    const publisher = makePublisherService();
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.syncPurchase(syncInput());

    assert.equal(result.success, true);
    assert.equal(result.acknowledged, true);
    assert.equal(result.entitlement.isPro, true);
    assert.equal(result.entitlement.productId, PRODUCT_ID);
    assert.equal(result.entitlement.basePlanId, 'yearly');
    assert.equal(result.entitlement.offerId, 'founding');
    assert.equal(result.entitlement.expiryTime, EXPIRY);
    assert.equal(result.accountOwnership.accountId, ACCOUNT_ID);
    assert.equal(
        result.accountOwnership.claimSource,
        'authenticated_google_play_sync'
    );

    assert.deepEqual(publisher.calls.get, [
        {
            packageName: PACKAGE_NAME,
            purchaseToken: PURCHASE_TOKEN,
        },
    ]);
    assert.deepEqual(publisher.calls.acknowledge, [
        {
            packageName: PACKAGE_NAME,
            productId: PRODUCT_ID,
            purchaseToken: PURCHASE_TOKEN,
        },
    ]);

    const insert = pool.queries.find((query) =>
        query.text.includes('INSERT INTO google_play_subscription_entitlements')
    );
    assert.ok(insert);
    assert.match(insert.params[0], /^[0-9a-f]{64}$/);
    assert.equal(insert.params[0], sha256(PURCHASE_TOKEN));
    assert.equal(insert.params[16], ACCOUNT_PLAY_ID);
    assert.equal(insert.params.includes(PURCHASE_TOKEN), false);
    assert.equal(insert.params.includes(ACCOUNT_ID), true);

    const commitIndex = pool.queries.findIndex((query) =>
        query.text === 'COMMIT'
    );
    const acknowledgementUpdateIndex = pool.queries.findIndex((query) =>
        query.scope === 'pool' &&
        query.text.includes('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED')
    );
    assert.ok(commitIndex >= 0);
    assert.ok(acknowledgementUpdateIndex > commitIndex);
});

test('rejects a verified Play purchase linked to a different Agora account', async () => {
    const pool = makePool();
    const publisher = makePublisherService({
        async getSubscription() {
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: OTHER_ACCOUNT_PLAY_ID,
                },
                lineItems: [
                    {
                        productId: PRODUCT_ID,
                        expiryTime: EXPIRY,
                        offerDetails: {
                            basePlanId: 'yearly',
                            offerId: 'founding',
                        },
                    },
                ],
            };
        },
    });
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.syncPurchase(syncInput()),
        (error) => {
            assert.equal(error.code, 'google_play_account_mismatch');
            assert.equal(error.status, 409);
            return true;
        }
    );
    assert.equal(
        pool.queries.some((query) =>
            query.text.includes('INSERT INTO google_play_subscription_entitlements')
        ),
        false
    );
});

test('prevents a verified purchase token from moving to another Agora account', async () => {
    const pool = makePool({
        existingAccount: OTHER_ACCOUNT_ID,
    });
    const publisher = makePublisherService();
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.syncPurchase(syncInput()),
        (error) => {
            assert.equal(
                error.code,
                'google_play_subscription_already_claimed'
            );
            assert.equal(error.status, 409);
            return true;
        }
    );
    assert.equal(publisher.calls.acknowledge.length, 0);
});

test('keeps canceled-but-unexpired Google Play access active through expiry', async () => {
    const pool = makePool();
    const publisher = lifecyclePublisher('SUBSCRIPTION_STATE_CANCELED');
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.syncPurchase(syncInput());

    assert.equal(result.entitlement.isPro, true);
    assert.equal(result.acknowledged, true);
    assert.equal(publisher.calls.acknowledge.length, 1);
});

test('keeps Google Play billing grace-period access active through expiry', async () => {
    const pool = makePool();
    const publisher = lifecyclePublisher('SUBSCRIPTION_STATE_IN_GRACE_PERIOD');
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.syncPurchase(syncInput());

    assert.equal(result.entitlement.isPro, true);
    assert.equal(result.acknowledged, true);
    assert.equal(publisher.calls.acknowledge.length, 1);
});

test('does not grant Pro or acknowledge an on-hold subscription', async () => {
    const pool = makePool();
    const publisher = lifecyclePublisher('SUBSCRIPTION_STATE_ON_HOLD');
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.syncPurchase(syncInput());

    assert.equal(result.entitlement.isPro, false);
    assert.equal(result.acknowledged, false);
    assert.equal(publisher.calls.acknowledge.length, 0);
});

test('rejects overlong purchase tokens before calling Google Play', async () => {
    const pool = makePool();
    const publisher = makePublisherService();
    const service = createGooglePlaySubscriptionService({
        pool,
        accountAuthService: makeAccountAuthService(),
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.syncPurchase(syncInput({
            purchaseToken: 'x'.repeat(4097),
        })),
        (error) => {
            assert.equal(error.code, 'invalid_google_play_purchase');
            assert.equal(error.status, 400);
            return true;
        }
    );
    assert.equal(publisher.calls.get.length, 0);
});
