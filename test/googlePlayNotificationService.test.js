import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createGooglePlayNotificationService,
} from '../lib/googlePlayNotificationService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PRODUCT_ID = 'agora_pro_yearly';
const PURCHASE_TOKEN = 'rtdn-current-purchase-token';
const LINKED_TOKEN = 'rtdn-linked-purchase-token';
const NOW_MS = Date.UTC(2026, 7, 23, 6, 30, 0);
const EXPIRY = '2027-08-23T06:30:00Z';

function sha256(value) {
    return crypto.createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function ownerRow(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        pricing_cohort: 'founding_2026',
        paywall_session_id: 'paywall-session-1',
        obfuscated_external_account_id: sha256(ACCOUNT_ID),
        is_trial: false,
        ...overrides,
    };
}

function makePublisher(overrides = {}) {
    const calls = { get: [], acknowledge: [] };
    return {
        calls,
        service: {
            async getSubscription(input) {
                calls.get.push(input);
                return {
                    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                    startTime: '2026-08-23T06:30:00Z',
                    externalAccountIdentifiers: {
                        obfuscatedExternalAccountId: sha256(ACCOUNT_ID),
                    },
                    lineItems: [{
                        productId: PRODUCT_ID,
                        expiryTime: EXPIRY,
                        autoRenewingPlan: { autoRenewEnabled: true },
                        offerDetails: {
                            basePlanId: 'yearly',
                            offerId: 'founding',
                        },
                        latestSuccessfulOrderId: 'GPA.1234-5678',
                    }],
                };
            },
            async acknowledgeSubscription(input) {
                calls.acknowledge.push(input);
                return true;
            },
            ...overrides,
        },
    };
}

function makePool({ owners = {} } = {}) {
    const queries = [];
    const client = {
        async query(sql, params = []) {
            const text = String(sql);
            queries.push({ scope: 'client', text, params });
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
                return { rows: [], rowCount: 0 };
            }
            if (text.includes('pg_advisory_xact_lock')) {
                return { rows: [{}], rowCount: 1 };
            }
            if (
                text.includes('FROM google_play_subscription_entitlements') &&
                text.includes('FOR UPDATE')
            ) {
                const row = owners[params[0]] ?? null;
                return {
                    rows: row ? [row] : [],
                    rowCount: row ? 1 : 0,
                };
            }
            if (text.includes('INSERT INTO google_play_subscription_entitlements')) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected client SQL: ${text}`);
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
            throw new Error(`Unexpected pool SQL: ${text}`);
        },
    };
}

function input(overrides = {}) {
    return {
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
        subscriptionId: PRODUCT_ID,
        ...overrides,
    };
}

test('re-queries Google and immediately removes Pro for an on-hold subscription', async () => {
    const currentHash = sha256(PURCHASE_TOKEN);
    const pool = makePool({
        owners: { [currentHash]: ownerRow() },
    });
    const publisher = makePublisher({
        async getSubscription(input) {
            publisher.calls.get.push(input);
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD',
                acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: sha256(ACCOUNT_ID),
                },
                lineItems: [{
                    productId: PRODUCT_ID,
                    expiryTime: EXPIRY,
                    offerDetails: { basePlanId: 'yearly' },
                }],
            };
        },
    });
    const service = createGooglePlayNotificationService({
        pool,
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.processSubscriptionNotification(input());

    assert.equal(result.processed, true);
    assert.equal(result.status, 'on_hold');
    assert.equal(result.isPro, false);
    assert.deepEqual(publisher.calls.get, [{
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
    }]);
    assert.equal(publisher.calls.acknowledge.length, 0);

    const insert = pool.queries.find((query) =>
        query.text.includes('INSERT INTO google_play_subscription_entitlements')
    );
    assert.ok(insert);
    assert.equal(insert.params[0], currentHash);
    assert.equal(insert.params[1], ACCOUNT_ID);
    assert.equal(insert.params[7], 'on_hold');
    assert.equal(insert.params.includes(PURCHASE_TOKEN), false);
});

test('cannot establish ownership from an RTDN token that was never account-bound', async () => {
    const pool = makePool();
    const publisher = makePublisher();
    const service = createGooglePlayNotificationService({
        pool,
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.processSubscriptionNotification(input());

    assert.deepEqual(result, {
        processed: false,
        reason: 'unowned_purchase',
    });
    assert.equal(
        pool.queries.some((query) =>
            query.text.includes('INSERT INTO google_play_subscription_entitlements')
        ),
        false
    );
});

test('carries authenticated ownership forward through a verified linked purchase token', async () => {
    const currentHash = sha256(PURCHASE_TOKEN);
    const linkedHash = sha256(LINKED_TOKEN);
    const pool = makePool({
        owners: { [linkedHash]: ownerRow() },
    });
    const publisher = makePublisher({
        async getSubscription(input) {
            publisher.calls.get.push(input);
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                linkedPurchaseToken: LINKED_TOKEN,
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: sha256(ACCOUNT_ID),
                },
                lineItems: [{
                    productId: PRODUCT_ID,
                    expiryTime: EXPIRY,
                    offerDetails: { basePlanId: 'yearly' },
                }],
            };
        },
    });
    const service = createGooglePlayNotificationService({
        pool,
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.processSubscriptionNotification(input());

    assert.equal(result.processed, true);
    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.isPro, true);
    const insert = pool.queries.find((query) =>
        query.text.includes('INSERT INTO google_play_subscription_entitlements')
    );
    assert.ok(insert);
    assert.equal(insert.params[0], currentHash);
    assert.equal(insert.params[1], ACCOUNT_ID);
    assert.equal(insert.params[14], linkedHash);
});

test('rejects verified external-account drift without mutating ownership', async () => {
    const currentHash = sha256(PURCHASE_TOKEN);
    const pool = makePool({
        owners: { [currentHash]: ownerRow() },
    });
    const publisher = makePublisher({
        async getSubscription(input) {
            publisher.calls.get.push(input);
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: sha256('different-account'),
                },
                lineItems: [{
                    productId: PRODUCT_ID,
                    expiryTime: EXPIRY,
                }],
            };
        },
    });
    const service = createGooglePlayNotificationService({
        pool,
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.processSubscriptionNotification(input());

    assert.equal(result.processed, false);
    assert.equal(result.reason, 'external_account_mismatch');
    assert.equal(
        pool.queries.some((query) =>
            query.text.includes('INSERT INTO google_play_subscription_entitlements')
        ),
        false
    );
});

test('persists an entitled purchase before acknowledgement and never stores the raw token', async () => {
    const currentHash = sha256(PURCHASE_TOKEN);
    const pool = makePool({
        owners: { [currentHash]: ownerRow() },
    });
    const publisher = makePublisher({
        async getSubscription(input) {
            publisher.calls.get.push(input);
            return {
                subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
                acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: sha256(ACCOUNT_ID),
                },
                lineItems: [{
                    productId: PRODUCT_ID,
                    expiryTime: EXPIRY,
                }],
            };
        },
    });
    const service = createGooglePlayNotificationService({
        pool,
        publisherService: publisher.service,
        now: () => NOW_MS,
    });

    const result = await service.processSubscriptionNotification(input());

    assert.equal(result.processed, true);
    assert.equal(result.acknowledged, true);
    assert.deepEqual(publisher.calls.acknowledge, [{
        packageName: PACKAGE_NAME,
        productId: PRODUCT_ID,
        purchaseToken: PURCHASE_TOKEN,
    }]);
    const commitIndex = pool.queries.findIndex((query) => query.text === 'COMMIT');
    const acknowledgementUpdateIndex = pool.queries.findIndex((query) =>
        query.scope === 'pool' &&
        query.text.includes('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED')
    );
    assert.ok(commitIndex >= 0);
    assert.ok(acknowledgementUpdateIndex > commitIndex);
    assert.equal(
        pool.queries.some((query) => query.params.includes(PURCHASE_TOKEN)),
        false
    );
});
