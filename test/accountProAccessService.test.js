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

function manualGrantRow(overrides = {}) {
    return activeRow({
        original_transaction_id:
            'manual-pro:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        environment:
            'Manual',
        product_id:
            'agora_pro_lifetime',
        expires_date:
            null,
        ...overrides,
    });
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
    'manual lifetime grant is permanent Pro access',
    async () => {
        const service =
            createAccountProAccessService({
                repository:
                    makeRepository(
                        manualGrantRow()
                    ),
                now: () => CHECKED_AT,
            });

        const result =
            await service.requireCurrentProAccess({
                accountId: ACCOUNT_ID,
            });

        assert.equal(result.hasProAccess, true);
        assert.equal(result.entitlement.environment, 'Manual');
        assert.equal(result.entitlement.productId, 'agora_pro_lifetime');
        assert.equal(result.entitlement.isLifetime, true);
        assert.equal(result.entitlement.isRecurring, false);
        assert.equal(result.entitlement.accessExpiresAt, null);
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
    'PostgreSQL repository checks manual grant, App Store, then Google Play',
    async () => {
        const captured = [];

        const pool = {
            async query(text, values) {
                captured.push({
                    text,
                    values,
                });

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

        assert.equal(result, null);
        assert.equal(captured.length, 3);

        const [manualQuery, appStoreQuery, playQuery] = captured;

        assert.match(
            manualQuery.text,
            /account_manual_pro_grants/
        );
        assert.match(
            manualQuery.text,
            /grant\.revoked_at IS NULL/
        );
        assert.match(
            manualQuery.text,
            /account\.status = 'active'/
        );
        assert.equal(manualQuery.values[0], ACCOUNT_ID);
        assert.equal(manualQuery.values[1], 'agora_pro_lifetime');

        assert.match(
            appStoreQuery.text,
            /account_subscription_ownership/
        );
        assert.match(
            appStoreQuery.text,
            /subscription_entitlements/
        );
        assert.match(
            appStoreQuery.text,
            /ownership_status = 'active'/
        );
        assert.match(
            appStoreQuery.text,
            /entitlement\.status IN/
        );
        assert.match(
            appStoreQuery.text,
            /grace_period_expires_date > \$3/
        );
        assert.equal(
            appStoreQuery.values[0],
            ACCOUNT_ID
        );
        assert.ok(
            Array.isArray(
                appStoreQuery.values[1]
            )
        );
        assert.equal(
            appStoreQuery.values[2],
            CHECKED_AT
        );

        assert.match(
            playQuery.text,
            /google_play_subscription_entitlements/
        );
        assert.match(
            playQuery.text,
            /normalized_status IN/
        );
        assert.match(
            playQuery.text,
            /expires_date > \$3/
        );
        assert.equal(
            playQuery.values[0],
            ACCOUNT_ID
        );
        assert.equal(
            playQuery.values[2],
            CHECKED_AT
        );
    }
);

test(
    'PostgreSQL repository returns an active manual grant before store lookup',
    async () => {
        let queryCount = 0;
        const pool = {
            async query() {
                queryCount += 1;
                return {
                    rows: [manualGrantRow()],
                };
            },
        };

        const repository =
            createPostgresAccountProAccessRepository(pool);
        const result = await repository.findCurrentAccess({
            accountId: ACCOUNT_ID,
            checkedAt: CHECKED_AT,
        });

        assert.equal(queryCount, 1);
        assert.equal(result.environment, 'Manual');
        assert.equal(result.product_id, 'agora_pro_lifetime');
    }
);

test(
    'missing manual-grant migration preserves existing App Store access',
    async () => {
        let queryCount = 0;
        const pool = {
            async query() {
                queryCount += 1;
                if (queryCount === 1) {
                    const error = new Error('relation does not exist');
                    error.code = '42P01';
                    throw error;
                }
                return { rows: [activeRow()] };
            },
        };

        const repository =
            createPostgresAccountProAccessRepository(pool);
        const result = await repository.findCurrentAccess({
            accountId: ACCOUNT_ID,
            checkedAt: CHECKED_AT,
        });

        assert.equal(queryCount, 2);
        assert.equal(result.environment, 'Production');
    }
);

test(
    'PostgreSQL repository normalizes a current Google Play entitlement',
    async () => {
        let queryCount = 0;

        const pool = {
            async query() {
                queryCount += 1;
                if (queryCount <= 2) {
                    return { rows: [] };
                }

                return {
                    rows: [
                        activeRow({
                            original_transaction_id:
                                'google-play:' + 'a'.repeat(64),
                            environment:
                                'GooglePlay',
                            last_signed_date:
                                new Date(
                                    '2026-07-30T04:10:00.000Z'
                                ),
                        }),
                    ],
                };
            },
        };

        const service =
            createAccountProAccessService({
                repository:
                    createPostgresAccountProAccessRepository(
                        pool
                    ),
                now: () =>
                    CHECKED_AT,
            });

        const result =
            await service.getCurrentAccess({
                accountId: ACCOUNT_ID,
            });

        assert.equal(queryCount, 3);
        assert.equal(result.hasProAccess, true);
        assert.equal(
            result.entitlement.environment,
            'GooglePlay'
        );
        assert.equal(
            result.entitlement.productId,
            PRODUCT_ID
        );
    }
);

test(
    'missing Google Play migration preserves the prior free result',
    async () => {
        let queryCount = 0;

        const pool = {
            async query() {
                queryCount += 1;
                if (queryCount <= 2) {
                    return { rows: [] };
                }

                const error = new Error('relation does not exist');
                error.code = '42P01';
                throw error;
            },
        };

        const repository =
            createPostgresAccountProAccessRepository(
                pool
            );
        const result =
            await repository.findCurrentAccess({
                accountId: ACCOUNT_ID,
                checkedAt: CHECKED_AT,
            });

        assert.equal(result, null);
        assert.equal(queryCount, 3);
    }
);
