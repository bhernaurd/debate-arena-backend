import assert from 'node:assert/strict';
import test from 'node:test';

import {
    GooglePlaySubscriptionError,
    createGooglePlaySubscriptionService,
} from '../lib/googlePlaySubscriptionService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PURCHASE_TOKEN = 'play-token-secret-value';
const PRODUCT_ID = 'agora_pro_monthly';
const KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

function activeResponse({
    accountId = ACCOUNT_ID,
    state = 'SUBSCRIPTION_STATE_ACTIVE',
    expiryTime = '2026-09-22T12:00:00Z',
    acknowledgementState = 'ACKNOWLEDGEMENT_STATE_PENDING',
} = {}) {
    return {
        subscriptionState: state,
        acknowledgementState,
        externalAccountIdentifiers: {
            obfuscatedExternalAccountId: accountId,
        },
        latestOrderId: 'GPA.1234-5678-9012-34567',
        lineItems: [
            {
                productId: PRODUCT_ID,
                expiryTime,
                offerDetails: {
                    basePlanId: 'monthly',
                    offerId: 'founding-trial',
                },
            },
        ],
    };
}

function createMemoryRepository(initialRows = []) {
    const rows = new Map(
        initialRows.map((row) => [
            row.purchase_token_hash,
            { ...row },
        ])
    );

    return {
        rows,
        async withTransaction(work) {
            return work({});
        },
        async findByTokenHashForUpdate(_client, tokenHash) {
            const row = rows.get(tokenHash);
            return row
                ? { account_id: row.account_id }
                : null;
        },
        async upsert(_client, record) {
            const existing = rows.get(record.tokenHash);
            const row = {
                ...(existing || {}),
                account_id: record.accountId,
                package_name: record.packageName,
                purchase_token_hash: record.tokenHash,
                purchase_token_encrypted: record.encryptedToken,
                product_id: record.productId,
                base_plan_id: record.basePlanId,
                offer_id: record.offerId,
                pricing_cohort_hint: record.pricingCohortHint,
                paywall_session_id: record.paywallSessionId,
                subscription_state: record.subscriptionState,
                entitlement_status: record.entitlementStatus,
                is_pro: record.isPro,
                in_free_trial: record.inFreeTrial,
                expiry_time: record.expiryTime,
                acknowledgement_state: record.acknowledgementState,
                acknowledged_at: record.acknowledgedAt,
                latest_order_id: record.latestOrderId,
                linked_purchase_token_hash: record.linkedPurchaseTokenHash,
                first_verified_at:
                    existing?.first_verified_at ?? record.verifiedAt,
                last_verified_at: record.verifiedAt,
                created_at:
                    existing?.created_at ?? record.verifiedAt,
                updated_at: record.verifiedAt,
            };
            rows.set(record.tokenHash, row);
            return { ...row };
        },
        async markAcknowledged(tokenHash, acknowledgedAt) {
            const row = rows.get(tokenHash);
            if (!row) return null;
            row.acknowledgement_state =
                'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
            row.acknowledged_at = acknowledgedAt;
            row.updated_at = acknowledgedAt;
            return { ...row };
        },
        async findBestCurrentForAccount(accountId, checkedAt) {
            return [...rows.values()]
                .filter((row) =>
                    row.account_id === accountId &&
                    row.is_pro === true &&
                    new Date(row.expiry_time).getTime() >
                        new Date(checkedAt).getTime()
                )
                .sort((left, right) =>
                    new Date(right.expiry_time).getTime() -
                    new Date(left.expiry_time).getTime()
                )[0] ?? null;
        },
    };
}

function createService({
    response = activeResponse(),
    repository = createMemoryRepository(),
    nowRef = { value: Date.parse('2026-08-22T12:00:00Z') },
    acknowledgeFails = false,
} = {}) {
    let currentResponse = response;
    const calls = {
        get: 0,
        acknowledge: 0,
    };
    const googleClient = {
        async getSubscription() {
            calls.get += 1;
            return currentResponse;
        },
        async acknowledgeSubscription() {
            calls.acknowledge += 1;
            if (acknowledgeFails) {
                throw new Error('ack unavailable');
            }
            return true;
        },
    };

    const service = createGooglePlaySubscriptionService({
        repository,
        googleClient,
        env: {
            GOOGLE_PLAY_PACKAGE_NAME: PACKAGE_NAME,
            GOOGLE_PLAY_PURCHASE_TOKEN_ENCRYPTION_KEY: KEY,
            GOOGLE_PLAY_ENTITLEMENT_MAX_VERIFICATION_AGE_SECONDS: '300',
        },
        now: () => nowRef.value,
    });

    return {
        service,
        repository,
        calls,
        nowRef,
        setResponse(value) {
            currentResponse = value;
        },
    };
}

async function sync(service) {
    return service.syncPurchase({
        accountId: ACCOUNT_ID,
        packageName: PACKAGE_NAME,
        purchaseToken: PURCHASE_TOKEN,
        productId: PRODUCT_ID,
        basePlanId: 'monthly',
        offerId: 'founding-trial',
        pricingCohortHint: 'founding_2026',
        paywallSessionId: 'paywall-session-1',
    });
}

test('active Google Play purchase grants Pro, binds account, encrypts token, and acknowledges', async () => {
    const fixture = createService();
    const result = await sync(fixture.service);

    assert.equal(result.entitlement.isPro, true);
    assert.equal(result.entitlement.entitlementStatus, 'active');
    assert.equal(result.acknowledged, true);
    assert.equal(fixture.calls.get, 1);
    assert.equal(fixture.calls.acknowledge, 1);

    const stored = [...fixture.repository.rows.values()][0];
    assert.equal(stored.account_id, ACCOUNT_ID);
    assert.equal(stored.product_id, PRODUCT_ID);
    assert.equal(stored.entitlement_status, 'active');
    assert.equal(stored.is_pro, true);
    assert.equal(
        stored.acknowledgement_state,
        'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
    );
    assert.ok(stored.purchase_token_encrypted.startsWith('agoraplay.1.'));
    assert.equal(
        stored.purchase_token_encrypted.includes(PURCHASE_TOKEN),
        false
    );
    assert.notEqual(stored.purchase_token_hash, PURCHASE_TOKEN);
});

test('purchase must be bound by Google to the currently authenticated Agora account', async () => {
    const fixture = createService({
        response: activeResponse({
            accountId: OTHER_ACCOUNT_ID,
        }),
    });

    await assert.rejects(
        () => sync(fixture.service),
        (error) => {
            assert.ok(error instanceof GooglePlaySubscriptionError);
            assert.equal(error.code, 'google_play_account_mismatch');
            assert.equal(error.status, 403);
            return true;
        }
    );
    assert.equal(fixture.repository.rows.size, 0);
});

test('canceled subscription stays entitled only through its Google expiry time', async () => {
    const fixture = createService({
        response: activeResponse({
            state: 'SUBSCRIPTION_STATE_CANCELED',
            expiryTime: '2026-08-25T12:00:00Z',
        }),
    });
    const current = await sync(fixture.service);
    assert.equal(current.entitlement.isPro, true);
    assert.equal(
        current.entitlement.entitlementStatus,
        'canceled_active'
    );

    fixture.setResponse(activeResponse({
        state: 'SUBSCRIPTION_STATE_CANCELED',
        expiryTime: '2026-08-21T12:00:00Z',
    }));
    const expired = await sync(fixture.service);
    assert.equal(expired.entitlement.isPro, false);
    assert.equal(expired.entitlement.entitlementStatus, 'expired');
});

test('on-hold subscription never grants Pro even when its line item has a future expiry', async () => {
    const fixture = createService({
        response: activeResponse({
            state: 'SUBSCRIPTION_STATE_ON_HOLD',
        }),
    });
    const result = await sync(fixture.service);
    assert.equal(result.entitlement.isPro, false);
    assert.equal(result.entitlement.entitlementStatus, 'on_hold');
    assert.equal(fixture.calls.acknowledge, 0);
});

test('acknowledgement outage preserves verified entitlement and reports false for Android fallback acknowledgement', async () => {
    const fixture = createService({
        acknowledgeFails: true,
    });
    const result = await sync(fixture.service);
    assert.equal(result.entitlement.isPro, true);
    assert.equal(result.acknowledged, false);
    const stored = [...fixture.repository.rows.values()][0];
    assert.equal(stored.is_pro, true);
    assert.equal(
        stored.acknowledgement_state,
        'ACKNOWLEDGEMENT_STATE_PENDING'
    );
});

test('stale stored entitlement is reverified with Google before account Pro access is reused', async () => {
    const fixture = createService();
    await sync(fixture.service);
    assert.equal(fixture.calls.get, 1);

    fixture.setResponse(activeResponse({
        state: 'SUBSCRIPTION_STATE_ON_HOLD',
    }));
    fixture.nowRef.value += 301_000;

    const access = await fixture.service.getCurrentAccess({
        accountId: ACCOUNT_ID,
    });
    assert.equal(fixture.calls.get, 2);
    assert.equal(access.hasProAccess, false);

    const stored = [...fixture.repository.rows.values()][0];
    assert.equal(stored.entitlement_status, 'on_hold');
    assert.equal(stored.is_pro, false);
});

test('same Google Play token cannot be reassigned to a second Agora account', async () => {
    const fixture = createService();
    await sync(fixture.service);
    const stored = [...fixture.repository.rows.values()][0];
    stored.account_id = OTHER_ACCOUNT_ID;
    fixture.repository.rows.set(
        stored.purchase_token_hash,
        stored
    );

    await assert.rejects(
        () => sync(fixture.service),
        (error) => {
            assert.ok(error instanceof GooglePlaySubscriptionError);
            assert.equal(
                error.code,
                'google_play_purchase_owner_conflict'
            );
            assert.equal(error.status, 409);
            return true;
        }
    );
});
