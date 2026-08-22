import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountProAccessError,
    createAccountProAccessService,
} from '../lib/accountProAccessService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-08-22T12:00:00Z');

function noAppStoreRepository() {
    return {
        async findCurrentAccess() {
            return null;
        },
    };
}

function playAccess({
    hasProAccess = true,
    status = 'active',
    isTrial = false,
} = {}) {
    return {
        hasProAccess,
        accountId: ACCOUNT_ID,
        source: 'google_play',
        checkedAt: new Date(NOW),
        entitlement: hasProAccess ? {
            productId: 'agora_pro_yearly',
            basePlanId: 'yearly',
            offerId: null,
            subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
            status,
            isTrial,
            accessExpiresAt: new Date('2027-08-22T12:00:00Z'),
            expiryTime: new Date('2027-08-22T12:00:00Z'),
            lastVerifiedAt: new Date(NOW),
        } : null,
    };
}

test('unified account Pro gate falls back to verified Google Play when App Store ownership is absent', async () => {
    let requestedAccountId = null;
    const service = createAccountProAccessService({
        repository: noAppStoreRepository(),
        googlePlayService: {
            async getCurrentAccess({ accountId }) {
                requestedAccountId = accountId;
                return playAccess();
            },
        },
        now: () => NOW,
    });

    const result = await service.requireCurrentProAccess({
        accountId: ACCOUNT_ID,
    });

    assert.equal(requestedAccountId, ACCOUNT_ID);
    assert.equal(result.hasProAccess, true);
    assert.equal(result.source, 'google_play');
    assert.equal(result.entitlement.productId, 'agora_pro_yearly');
});

test('valid App Store entitlement wins without unnecessary Google Play lookup', async () => {
    let playCalled = false;
    const service = createAccountProAccessService({
        repository: {
            async findCurrentAccess() {
                return {
                    account_id: ACCOUNT_ID,
                    original_transaction_id: '2000000000000001',
                    environment: 'Production',
                    product_id: 'agora_pro_monthly',
                    status: 'active',
                    is_trial: false,
                    expires_date: new Date('2026-09-22T12:00:00Z'),
                    grace_period_expires_date: null,
                    revocation_date: null,
                    last_signed_date: new Date(NOW),
                };
            },
        },
        googlePlayService: {
            async getCurrentAccess() {
                playCalled = true;
                return playAccess();
            },
        },
        now: () => NOW,
    });

    const result = await service.getCurrentAccess({
        accountId: ACCOUNT_ID,
    });

    assert.equal(result.hasProAccess, true);
    assert.equal(result.source, 'app_store');
    assert.equal(playCalled, false);
});

test('unified account Pro gate denies access when neither store has a current entitlement', async () => {
    const service = createAccountProAccessService({
        repository: noAppStoreRepository(),
        googlePlayService: {
            async getCurrentAccess() {
                return playAccess({ hasProAccess: false });
            },
        },
        now: () => NOW,
    });

    const result = await service.getCurrentAccess({
        accountId: ACCOUNT_ID,
    });
    assert.equal(result.hasProAccess, false);
    assert.equal(result.source, null);

    await assert.rejects(
        () => service.requireCurrentProAccess({ accountId: ACCOUNT_ID }),
        (error) => {
            assert.ok(error instanceof AccountProAccessError);
            assert.equal(error.code, 'ranked_pro_required');
            assert.equal(error.status, 403);
            return true;
        }
    );
});

test('Google Play verification outages fail closed instead of trusting client Pro metadata', async () => {
    const service = createAccountProAccessService({
        repository: noAppStoreRepository(),
        googlePlayService: {
            async getCurrentAccess() {
                const error = new Error('Google unavailable');
                error.name = 'GooglePlaySubscriptionError';
                throw error;
            },
        },
        now: () => NOW,
    });

    await assert.rejects(
        () => service.getCurrentAccess({ accountId: ACCOUNT_ID }),
        (error) => {
            assert.ok(error instanceof AccountProAccessError);
            assert.equal(error.code, 'pro_access_unavailable');
            assert.equal(error.status, 503);
            return true;
        }
    );
});
