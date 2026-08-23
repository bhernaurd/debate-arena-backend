import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGORA_PRO_LIFETIME_PRODUCT_ID,
    AGORA_PRO_MONTHLY_PRODUCT_ID,
    AGORA_PRO_PRODUCT_IDS,
    AGORA_PRO_YEARLY_PRODUCT_ID,
    AGORA_RECURRING_PRO_PRODUCT_IDS,
    classifyAgoraProProduct,
} from '../lib/agoraProProducts.js';

import {
    AccountProAccessError,
    createAccountProAccessService,
    createPostgresAccountProAccessRepository,
} from '../lib/accountProAccessService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';

const CHECKED_AT =
    new Date('2026-08-23T19:00:00.000Z');

function lifetimeRow(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        original_transaction_id: '3000000000000001',
        environment: 'Production',
        product_id: AGORA_PRO_LIFETIME_PRODUCT_ID,
        status: 'active',
        is_trial: false,
        expires_date: null,
        grace_period_expires_date: null,
        revocation_date: null,
        last_signed_date:
            new Date('2026-08-23T18:55:00.000Z'),
        ...overrides,
    };
}

function repositoryReturning(row) {
    return {
        async findCurrentAccess() {
            return row;
        },
    };
}

test(
    'Agora Pro product model distinguishes recurring and Lifetime access',
    () => {
        assert.deepEqual(
            classifyAgoraProProduct(
                AGORA_PRO_MONTHLY_PRODUCT_ID
            ),
            {
                productId: AGORA_PRO_MONTHLY_PRODUCT_ID,
                accessSource: 'monthly',
                isRecurring: true,
                isLifetime: false,
            }
        );

        assert.deepEqual(
            classifyAgoraProProduct(
                AGORA_PRO_YEARLY_PRODUCT_ID
            ),
            {
                productId: AGORA_PRO_YEARLY_PRODUCT_ID,
                accessSource: 'annual',
                isRecurring: true,
                isLifetime: false,
            }
        );

        assert.deepEqual(
            classifyAgoraProProduct(
                AGORA_PRO_LIFETIME_PRODUCT_ID
            ),
            {
                productId: AGORA_PRO_LIFETIME_PRODUCT_ID,
                accessSource: 'lifetime',
                isRecurring: false,
                isLifetime: true,
            }
        );

        assert.equal(
            AGORA_PRO_PRODUCT_IDS.has(
                AGORA_PRO_LIFETIME_PRODUCT_ID
            ),
            true
        );
        assert.equal(
            AGORA_RECURRING_PRO_PRODUCT_IDS.has(
                AGORA_PRO_LIFETIME_PRODUCT_ID
            ),
            false
        );
    }
);

test(
    'Lifetime Pro grants permanent account access without an expiration date',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    repositoryReturning(
                        lifetimeRow()
                    ),
                now: () => CHECKED_AT,
            });

        const result =
            await service.getCurrentAccess({
                accountId: ACCOUNT_ID,
            });

        assert.equal(result.hasProAccess, true);
        assert.equal(
            result.entitlement.productId,
            AGORA_PRO_LIFETIME_PRODUCT_ID
        );
        assert.equal(
            result.entitlement.entitlementSource,
            'lifetime'
        );
        assert.equal(
            result.entitlement.isLifetime,
            true
        );
        assert.equal(
            result.entitlement.isRecurring,
            false
        );
        assert.equal(
            result.entitlement.isTrial,
            false
        );
        assert.equal(
            result.entitlement.expiresAt,
            null
        );
        assert.equal(
            result.entitlement.accessExpiresAt,
            null
        );
    }
);

test(
    'revoked Lifetime Pro does not grant account access',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    repositoryReturning(
                        lifetimeRow({
                            status: 'revoked',
                            revocation_date:
                                new Date(
                                    '2026-08-23T18:59:00.000Z'
                                ),
                        })
                    ),
                now: () => CHECKED_AT,
            });

        await assert.rejects(
            service.getCurrentAccess({
                accountId: ACCOUNT_ID,
            }),
            (error) =>
                error instanceof
                    AccountProAccessError &&
                error.code ===
                    'pro_access_unavailable'
        );
    }
);

test(
    'PostgreSQL account access query includes permanent Lifetime Pro and prioritizes it',
    async () => {
        let captured;

        const pool = {
            async query(text, values) {
                captured = { text, values };
                return { rows: [] };
            },
        };

        const repository =
            createPostgresAccountProAccessRepository(
                pool
            );

        await repository.findCurrentAccess({
            accountId: ACCOUNT_ID,
            checkedAt: CHECKED_AT,
        });

        assert.match(
            captured.text,
            /entitlement\.product_id = \$4/
        );
        assert.match(
            captured.text,
            /entitlement\.status = 'active'/
        );
        assert.match(
            captured.text,
            /THEN 0/
        );
        assert.equal(
            captured.values[3],
            AGORA_PRO_LIFETIME_PRODUCT_ID
        );
        assert.equal(
            captured.values[1].includes(
                AGORA_PRO_LIFETIME_PRODUCT_ID
            ),
            true
        );
    }
);
