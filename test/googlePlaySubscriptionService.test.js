import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    GooglePlaySubscriptionError,
    createGooglePlaySubscriptionService,
} from '../lib/googlePlaySubscriptionService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID =
    '22222222-2222-4222-8222-222222222222';
const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PRODUCT_ID = 'agora_pro_monthly';
const PURCHASE_TOKEN = 'google-play-secret-purchase-token';
const NOW = Date.parse('2026-08-31T02:00:00.000Z');
const FUTURE_EXPIRY = '2026-09-30T02:00:00.000Z';

function sha256(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function verifiedSnapshot({
    accountId = ACCOUNT_ID,
    subscriptionState = 'SUBSCRIPTION_STATE_ACTIVE',
    acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    expiryTime = FUTURE_EXPIRY,
    productId = PRODUCT_ID,
    basePlanId = 'monthly',
    offerId = null,
    freeTrial = false,
    autoRenewEnabled = true,
    linkedPurchaseToken = null,
} = {}) {
    return {
        subscriptionState,
        acknowledgementState,
        startTime: '2026-08-30T02:00:00.000Z',
        regionCode: 'US',
        externalAccountIdentifiers: {
            obfuscatedExternalAccountId:
                sha256(accountId.toLowerCase()),
        },
        ...(linkedPurchaseToken
            ? { linkedPurchaseToken }
            : {}),
        lineItems: [
            {
                productId,
                expiryTime,
                latestSuccessfulOrderId:
                    'GPA.1234-5678-9012-34567',
                offerDetails: {
                    basePlanId,
                    ...(offerId ? { offerId } : {}),
                },
                autoRenewingPlan: {
                    autoRenewEnabled,
                },
                ...(freeTrial
                    ? { offerPhase: { freeTrial: {} } }
                    : {}),
            },
        ],
    };
}

function createFakePool({
    existingAccounts = new Map(),
} = {}) {
    const events = [];
    const ownership = new Map(existingAccounts);
    let lastInsertValues = null;

    const client = {
        async query(text, values = []) {
            const normalized = String(text).trim();

            if (normalized === 'BEGIN') {
                events.push('begin');
                return { rows: [] };
            }
            if (normalized === 'COMMIT') {
                events.push('commit');
                return { rows: [] };
            }
            if (normalized === 'ROLLBACK') {
                events.push('rollback');
                return { rows: [] };
            }
            if (normalized.includes('pg_advisory_xact_lock')) {
                events.push('lock');
                return { rows: [] };
            }
            if (
                normalized.includes('SELECT account_id') &&
                normalized.includes('google_play_subscription_entitlements')
            ) {
                const accountId = ownership.get(values[0]);
                return {
                    rows: accountId
                        ? [{ account_id: accountId }]
                        : [],
                };
            }
            if (
                normalized.includes(
                    'INSERT INTO google_play_subscription_entitlements'
                )
            ) {
                events.push('insert');
                lastInsertValues = values;
                ownership.set(
                    values[0],
                    String(values[1]).toLowerCase()
                );
                return { rows: [], rowCount: 1 };
            }
            if (
                normalized.includes(
                    'UPDATE google_play_subscription_entitlements'
                )
            ) {
                events.push('replace-linked');
                return { rows: [], rowCount: 1 };
            }

            throw new Error(
                `Unexpected transactional SQL in test: ${normalized.slice(0, 80)}`
            );
        },
        release() {
            events.push('release');
        },
    };

    return {
        events,
        ownership,
        get lastInsertValues() {
            return lastInsertValues;
        },
        pool: {
            async connect() {
                return client;
            },
            async query(text) {
                if (
                    String(text).includes(
                        'UPDATE google_play_subscription_entitlements'
                    )
                ) {
                    events.push('persist-ack');
                    return { rows: [], rowCount: 1 };
                }

                throw new Error('Unexpected pool.query() in test.');
            },
        },
    };
}

function createService({
    snapshot = verifiedSnapshot(),
    existingAccounts,
    acknowledge = async () => true,
} = {}) {
    const database = createFakePool({
        existingAccounts,
    });

    const publisherClient = {
        async getSubscription() {
            database.events.push('google-get');
            return snapshot;
        },
        async acknowledgeSubscription() {
            database.events.push('google-ack');
            return acknowledge();
        },
    };

    const service = createGooglePlaySubscriptionService({
        pool: database.pool,
        publisherClient,
        expectedPackageName: PACKAGE_NAME,
        now: () => NOW,
    });

    return {
        service,
        database,
    };
}

function sync(service, overrides = {}) {
    return service.syncVerifiedPurchase({
        authorization: {
            accountId: ACCOUNT_ID,
        },
        requestedPackageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
        productId: PRODUCT_ID,
        basePlanId: 'monthly',
        pricingCohortHint: 'standard',
        ...overrides,
    });
}

test(
    'active verified subscription grants Pro and never persists the raw token',
    async () => {
        const { service, database } = createService({
            snapshot: verifiedSnapshot({
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
            }),
        });

        const result = await sync(service);

        assert.equal(result.entitlement.isPro, true);
        assert.equal(
            result.entitlement.productId,
            PRODUCT_ID
        );
        assert.equal(result.acknowledged, true);
        assert.equal(
            result.accountOwnership.accountId,
            ACCOUNT_ID
        );

        const tokenHash = sha256(PURCHASE_TOKEN);
        assert.equal(
            database.lastInsertValues[0],
            tokenHash
        );
        assert.doesNotMatch(
            JSON.stringify(database.lastInsertValues),
            new RegExp(PURCHASE_TOKEN)
        );

        assert.ok(
            database.events.indexOf('commit') <
            database.events.indexOf('google-ack'),
            'Google acknowledgement must happen only after the entitlement commit.'
        );
        assert.ok(
            database.events.indexOf('google-ack') <
            database.events.indexOf('persist-ack'),
            'The diagnostic acknowledgement state is written after Google confirms acknowledgement.'
        );
    }
);

test(
    'canceled but unexpired Google subscription remains Pro through expiry',
    async () => {
        const { service } = createService({
            snapshot: verifiedSnapshot({
                subscriptionState:
                    'SUBSCRIPTION_STATE_CANCELED',
                autoRenewEnabled: false,
            }),
        });

        const result = await sync(service);

        assert.equal(result.entitlement.isPro, true);
        assert.equal(
            result.entitlement.expiryTime,
            FUTURE_EXPIRY
        );
    }
);

test(
    'free-trial phase is classified from the verified Google line item',
    async () => {
        const { service } = createService({
            snapshot: verifiedSnapshot({
                freeTrial: true,
            }),
        });

        const result = await sync(service);

        assert.equal(result.entitlement.isPro, true);
        assert.equal(result.entitlement.inFreeTrial, true);
    }
);

test(
    'expired, paused, and on-hold subscriptions do not grant Pro',
    async () => {
        for (const subscriptionState of [
            'SUBSCRIPTION_STATE_EXPIRED',
            'SUBSCRIPTION_STATE_PAUSED',
            'SUBSCRIPTION_STATE_ON_HOLD',
        ]) {
            const { service } = createService({
                snapshot: verifiedSnapshot({
                    subscriptionState,
                }),
            });

            const result = await sync(service);
            assert.equal(
                result.entitlement.isPro,
                false,
                subscriptionState
            );
        }
    }
);

test(
    'verified Google account binding must match the authenticated Agora account',
    async () => {
        const { service } = createService({
            snapshot: verifiedSnapshot({
                accountId: OTHER_ACCOUNT_ID,
            }),
        });

        await assert.rejects(
            sync(service),
            (error) =>
                error instanceof
                    GooglePlaySubscriptionError &&
                error.code ===
                    'google_play_account_mismatch' &&
                error.status === 409
        );
    }
);

test(
    'verified Google product and base plan must match the requested purchase',
    async () => {
        const productMismatch = createService({
            snapshot: verifiedSnapshot({
                productId: 'another_product',
            }),
        }).service;

        await assert.rejects(
            sync(productMismatch),
            (error) =>
                error instanceof
                    GooglePlaySubscriptionError &&
                error.code ===
                    'google_play_product_mismatch'
        );

        const basePlanMismatch = createService({
            snapshot: verifiedSnapshot({
                basePlanId: 'yearly',
            }),
        }).service;

        await assert.rejects(
            sync(basePlanMismatch),
            (error) =>
                error instanceof
                    GooglePlaySubscriptionError &&
                error.code ===
                    'google_play_base_plan_mismatch'
        );
    }
);

test(
    'a purchase token already linked to another Agora account cannot be reclaimed',
    async () => {
        const tokenHash = sha256(PURCHASE_TOKEN);
        const existingAccounts = new Map([
            [tokenHash, OTHER_ACCOUNT_ID],
        ]);
        const { service } = createService({
            existingAccounts,
        });

        await assert.rejects(
            sync(service),
            (error) =>
                error instanceof
                    GooglePlaySubscriptionError &&
                error.code ===
                    'google_play_subscription_already_claimed' &&
                error.status === 409
        );
    }
);

test(
    'server acknowledgement failure does not roll back verified Pro access',
    async () => {
        const { service, database } = createService({
            snapshot: verifiedSnapshot({
                acknowledgementState:
                    'ACKNOWLEDGEMENT_STATE_PENDING',
            }),
            acknowledge: async () => {
                throw new Error('temporary Google acknowledgement outage');
            },
        });

        const result = await sync(service);

        assert.equal(result.entitlement.isPro, true);
        assert.equal(result.acknowledged, false);
        assert.ok(database.events.includes('commit'));
        assert.ok(database.events.includes('google-ack'));
        assert.equal(
            database.events.includes('persist-ack'),
            false
        );
    }
);
