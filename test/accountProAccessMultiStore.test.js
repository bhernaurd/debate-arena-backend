import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGORA_PRO_LIFETIME_PRODUCT_ID,
    AGORA_PRO_MONTHLY_PRODUCT_ID,
    AGORA_PRO_YEARLY_PRODUCT_ID,
} from '../lib/agoraProProducts.js';
import {
    createAccountProAccessService,
    createPostgresAccountProAccessRepository,
} from '../lib/accountProAccessService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CHECKED_AT = new Date('2026-08-23T20:00:00.000Z');

function googlePlayRow(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        original_transaction_id: 'google-play:0123456789abcdef',
        environment: 'GooglePlayProduction',
        product_id: AGORA_PRO_MONTHLY_PRODUCT_ID,
        status: 'active',
        is_trial: false,
        expires_date: new Date('2026-09-23T20:00:00.000Z'),
        grace_period_expires_date: null,
        revocation_date: null,
        last_signed_date: new Date('2026-08-23T19:59:00.000Z'),
        ...overrides,
    };
}

test('verified recurring Google Play access normalizes through the shared account Pro service', async () => {
    const service = createAccountProAccessService({
        repository: {
            async findCurrentAccess() {
                return googlePlayRow();
            },
        },
        now: () => CHECKED_AT,
    });

    const result = await service.getCurrentAccess({ accountId: ACCOUNT_ID });

    assert.equal(result.hasProAccess, true);
    assert.equal(result.entitlement.environment, 'GooglePlayProduction');
    assert.equal(result.entitlement.productId, AGORA_PRO_MONTHLY_PRODUCT_ID);
    assert.equal(result.entitlement.entitlementSource, 'monthly');
    assert.equal(result.entitlement.isRecurring, true);
    assert.equal(result.entitlement.isLifetime, false);
    assert.equal(result.entitlement.isTrial, false);
    assert.equal(
        result.entitlement.accessExpiresAt.toISOString(),
        '2026-09-23T20:00:00.000Z'
    );
});

test('shared SQL considers App Store Lifetime Pro while limiting Google Play candidates to recurring products', async () => {
    let captured;
    const repository = createPostgresAccountProAccessRepository({
        async query(text, values) {
            captured = { text, values };
            return { rows: [] };
        },
    });

    await repository.findCurrentAccess({
        accountId: ACCOUNT_ID,
        checkedAt: CHECKED_AT,
    });

    assert.match(
        captured.text,
        /FROM google_play_subscription_entitlements AS google_play/
    );
    assert.match(
        captured.text,
        /entitlement\.product_id = \$4/
    );
    assert.equal(captured.values[3], AGORA_PRO_LIFETIME_PRODUCT_ID);
    assert.equal(captured.values[1].includes(AGORA_PRO_LIFETIME_PRODUCT_ID), true);
    assert.deepEqual(
        captured.values[4],
        [AGORA_PRO_MONTHLY_PRODUCT_ID, AGORA_PRO_YEARLY_PRODUCT_ID]
    );
    assert.equal(captured.values[4].includes(AGORA_PRO_LIFETIME_PRODUCT_ID), false);
});
