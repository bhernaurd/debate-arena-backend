import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountProAccessError,
    createAccountProAccessService,
    createPostgresAccountProAccessRepository,
} from '../lib/accountProAccessService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';

const CHECKED_AT =
    new Date('2026-07-30T04:15:00.000Z');

const PRODUCT_ID =
    'agora_pro_monthly';

function activeRow(overrides = {}) {
    return {
        account_id:
            ACCOUNT_ID,
        original_transaction_id:
            '2000000000000001',
        environment:
            'Production',
        product_id:
            PRODUCT_ID,
        status:
            'active',
        is_trial:
            false,
        expires_date:
            new Date(
                '2026-08-30T04:15:00.000Z'
            ),
        grace_period_expires_date:
            null,
        revocation_date:
            null,
        last_signed_date:
            new Date(
                '2026-07-30T04:00:00.000Z'
            ),
        ...overrides,
    };
}

function makeRepository(row) {
    return {
        async findCurrentAccess() {
            return row;
        },
    };
}

test(
    'returns current paid Pro access',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow()
                    ),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        const result =
            await service.getCurrentAccess({
                accountId:
                    ACCOUNT_ID,
            });

        assert.equal(
            result.hasProAccess,
            true
        );
        assert.equal(
            result.entitlement.status,
            'active'
        );
        assert.equal(
            result.entitlement.isTrial,
            false
        );
        assert.equal(
            result.entitlement.accessExpiresAt
                .toISOString(),
            '2026-08-30T04:15:00.000Z'
        );
    }
);

test(
    'allows an unexpired free trial',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow({
                            status:
                                'trial',
                            is_trial:
                                true,
                        })
                    ),
                now: () =>
                    CHECKED_AT,
            });

        const result =
            await service.requireCurrentProAccess({
                accountId:
                    ACCOUNT_ID,
            });

        assert.equal(
            result.hasProAccess,
            true
        );
        assert.equal(
            result.entitlement.status,
            'trial'
        );
        assert.equal(
            result.entitlement.isTrial,
            true
        );
    }
);

test(
    'allows an unexpired billing grace period',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow({
                            status:
                                'grace_period',
                            expires_date:
                                new Date(
                                    '2026-07-29T04:15:00.000Z'
                                ),
                            grace_period_expires_date:
                                new Date(
                                    '2026-08-02T04:15:00.000Z'
                                ),
                        })
                    ),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        const result =
            await service.requireCurrentProAccess({
                accountId:
                    ACCOUNT_ID,
            });

        assert.equal(
            result.hasProAccess,
            true
        );
        assert.equal(
            result.entitlement.status,
            'grace_period'
        );
        assert.equal(
            result.entitlement.accessExpiresAt
                .toISOString(),
            '2026-08-02T04:15:00.000Z'
        );
    }
);

test(
    'returns no access when no current entitlement exists',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(null),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        const result =
            await service.getCurrentAccess({
                accountId:
                    ACCOUNT_ID,
            });

        assert.equal(
            result.hasProAccess,
            false
        );
        assert.equal(
            result.entitlement,
            null
        );

        await assert.rejects(
            service.requireCurrentProAccess({
                accountId:
                    ACCOUNT_ID,
            }),
            (error) =>
                error instanceof
                    AccountProAccessError &&
                error.code ===
                    'ranked_pro_required' &&
                error.status === 403 &&
                error.retryable === false
        );
    }
);

test(
    'rejects stale or revoked rows returned by a repository',
    async () => {
        const expiredService =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow({
                            expires_date:
                                CHECKED_AT,
                        })
                    ),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        await assert.rejects(
            expiredService.getCurrentAccess({
                accountId:
                    ACCOUNT_ID,
            }),
            (error) =>
                error instanceof
                    AccountProAccessError &&
                error.code ===
                    'pro_access_unavailable' &&
                error.status === 503
        );

        const revokedService =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow({
                            revocation_date:
                                new Date(
                                    '2026-07-29T04:15:00.000Z'
                                ),
                        })
                    ),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        await assert.rejects(
            revokedService.getCurrentAccess({
                accountId:
                    ACCOUNT_ID,
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
    'rejects an account mismatch from storage',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        activeRow({
                            account_id:
                                '22222222-2222-4222-8222-222222222222',
                        })
                    ),
                now: () =>
                    CHECKED_AT.getTime(),
            });

        await assert.rejects(
            service.getCurrentAccess({
                accountId:
                    ACCOUNT_ID,
            }),
            (error) =>
                error instanceof
                    AccountProAccessError &&
                error.code ===
                    'pro_access_account_mismatch'
        );
    }
);

test(
    'PostgreSQL repository queries account ownership and current entitlement dates',
    async () => {
        let captured;

        const pool = {
            async query(text, values) {
                captured = {
                    text,
                    values,
                };

                return {
                    rows: [],
                };
            },
        };

        const repository =
            createPostgresAccountProAccessRepository(
                pool
            );

        const result =
            await repository.findCurrentAccess({
                accountId:
                    ACCOUNT_ID,
                checkedAt:
                    CHECKED_AT,
            });

        assert.equal(
            result,
            null
        );
        assert.match(
            captured.text,
            /account_subscription_ownership/
        );
        assert.match(
            captured.text,
            /subscription_entitlements/
        );
        assert.match(
            captured.text,
            /ownership_status = 'active'/
        );
        assert.match(
            captured.text,
            /entitlement\.status IN/
        );
        assert.match(
            captured.text,
            /grace_period_expires_date > \$3/
        );
        assert.deepEqual(
            captured.values[0],
            ACCOUNT_ID
        );
        assert.ok(
            Array.isArray(
                captured.values[1]
            )
        );
        assert.equal(
            captured.values[2],
            CHECKED_AT
        );
    }
);
