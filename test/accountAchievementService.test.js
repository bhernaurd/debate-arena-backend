import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountAchievementError,
    accountAchievementConstants,
    createAccountAchievementService,
} from '../lib/accountAchievementService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID =
    '22222222-2222-4222-8222-222222222222';
const SESSION_ID =
    '33333333-3333-4333-8333-333333333333';

function expectedError(code) {
    return (error) => {
        assert.ok(
            error instanceof
                AccountAchievementError
        );
        assert.equal(
            error.code,
            code
        );
        return true;
    };
}

function makeRecord(
    overrides = {}
) {
    return {
        achievementId:
            'entered_agora',
        unlockedAt:
            '2026-07-20T12:00:00.000Z',
        ...overrides,
    };
}

function makeService({
    repositoryOverrides = {},
    authorizeOverride = null,
    now = () =>
        Date.UTC(
            2026,
            6,
            29,
            17,
            0,
            0
        ),
} = {}) {
    const calls = [];

    const repository = {
        async withTransaction(work) {
            calls.push(['BEGIN']);

            try {
                const result =
                    await work({
                        query() {},
                    });
                calls.push(['COMMIT']);
                return result;
            } catch (error) {
                calls.push(['ROLLBACK']);
                throw error;
            }
        },

        async upsertUnlock(
            _client,
            input
        ) {
            calls.push([
                'upsertUnlock',
                input,
            ]);

            return {
                achievementId:
                    input.record
                        .achievementId,
                unlockedAt:
                    new Date(
                        input.record
                            .unlockedAt
                    ),
                lastSyncedAt:
                    input.syncedAt,
            };
        },

        async listUnlocks(
            _client,
            input
        ) {
            calls.push([
                'listUnlocks',
                input,
            ]);

            return [
                {
                    achievementId:
                        'entered_agora',
                    unlockedAt:
                        new Date(
                            '2026-07-20T12:00:00.000Z'
                        ),
                    lastSyncedAt:
                        new Date(
                            '2026-07-29T17:00:00.000Z'
                        ),
                },
            ];
        },

        ...repositoryOverrides,
    };

    const accountAuthService = {
        async authorizeAccessToken(
            input
        ) {
            calls.push([
                'authorizeAccessToken',
                input,
            ]);

            if (authorizeOverride) {
                return authorizeOverride(
                    input
                );
            }

            return {
                accountId:
                    ACCOUNT_ID,
                installationId:
                    INSTALLATION_ID,
                sessionId:
                    SESSION_ID,
            };
        },
    };

    const service =
        createAccountAchievementService({
            repository,
            accountAuthService,
            now,
        });

    return {
        service,
        calls,
    };
}

test('authenticates before writing achievement unlocks', async () => {
    const { service, calls } =
        makeService();

    const result =
        await service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [
                makeRecord(),
            ],
        });

    assert.equal(
        result.accountId,
        ACCOUNT_ID
    );
    assert.equal(
        result.installationId,
        INSTALLATION_ID
    );
    assert.equal(
        result.submittedCount,
        1
    );
    assert.equal(
        result.records.length,
        1
    );

    const authIndex =
        calls.findIndex(
            ([name]) =>
                name ===
                'authorizeAccessToken'
        );
    const beginIndex =
        calls.findIndex(
            ([name]) =>
                name === 'BEGIN'
        );
    const upsertIndex =
        calls.findIndex(
            ([name]) =>
                name ===
                'upsertUnlock'
        );

    assert.ok(
        authIndex < beginIndex
    );
    assert.ok(
        beginIndex < upsertIndex
    );
});

test('allows an empty upload so a new device can download canonical unlocks', async () => {
    const { service, calls } =
        makeService();

    const result =
        await service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [],
        });

    assert.equal(
        result.submittedCount,
        0
    );
    assert.equal(
        calls.some(
            ([name]) =>
                name ===
                'upsertUnlock'
        ),
        false
    );
    assert.equal(
        result.records[0]
            .achievementId,
        'entered_agora'
    );
});

test('normalizes achievement ids and ISO timestamps', async () => {
    const { service, calls } =
        makeService();

    await service.syncUnlocks({
        installationId:
            INSTALLATION_ID,
        accessToken:
            'header.payload.signature',
        schemaVersion: 1,
        records: [
            makeRecord({
                unlockedAt:
                    '2026-07-20T07:00:00-05:00',
            }),
        ],
    });

    const input =
        calls.find(
            ([name]) =>
                name ===
                'upsertUnlock'
        )[1];

    assert.equal(
        input.record.achievementId,
        'entered_agora'
    );
    assert.equal(
        input.record.unlockedAt,
        '2026-07-20T12:00:00.000Z'
    );
});

test('rejects duplicate achievement ids in one batch', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [
                makeRecord(),
                makeRecord(),
            ],
        }),
        expectedError(
            'duplicate_achievement_id'
        )
    );
});

test('rejects unsupported schema versions', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 2,
            records: [],
        }),
        expectedError(
            'unsupported_achievement_schema'
        )
    );
});

test('rejects invalid achievement identifiers', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [
                makeRecord({
                    achievementId:
                        'Philosopher Stone!',
                }),
            ],
        }),
        expectedError(
            'invalid_achievement_payload'
        )
    );
});

test('rejects invalid unlock timestamps', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [
                makeRecord({
                    unlockedAt:
                        'not-a-date',
                }),
            ],
        }),
        expectedError(
            'invalid_achievement_payload'
        )
    );
});

test('rejects batches above the configured maximum', async () => {
    const { service } =
        makeService();

    const records = Array.from(
        {
            length:
                accountAchievementConstants
                    .maxRecords + 1,
        },
        (_, index) =>
            makeRecord({
                achievementId:
                    `achievement_${index}`,
            })
    );

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records,
        }),
        expectedError(
            'achievement_batch_too_large'
        )
    );
});

test('normalizes account authorization failures', async () => {
    const { service } =
        makeService({
            authorizeOverride() {
                const error =
                    new Error(
                        'Session expired.'
                    );
                error.code =
                    'invalid_access_token';
                error.status = 401;
                throw error;
            },
        });

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [],
        }),
        (error) => {
            assert.equal(
                error.code,
                'invalid_access_token'
            );
            assert.equal(
                error.status,
                401
            );
            return true;
        }
    );
});

test('rolls back the complete batch when persistence fails', async () => {
    const { service, calls } =
        makeService({
            repositoryOverrides: {
                async upsertUnlock() {
                    throw new Error(
                        'database unavailable'
                    );
                },
            },
        });

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [
                makeRecord(),
            ],
        }),
        expectedError(
            'achievement_sync_unavailable'
        )
    );

    assert.equal(
        calls.some(
            ([name]) =>
                name === 'ROLLBACK'
        ),
        true
    );
});

test('rejects invalid server time configuration', async () => {
    const { service } =
        makeService({
            now: () => NaN,
        });

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [],
        }),
        expectedError(
            'invalid_achievement_configuration'
        )
    );
});

test('rejects duplicate canonical rows returned by storage', async () => {
    const duplicate = {
        achievementId:
            'entered_agora',
        unlockedAt:
            new Date(
                '2026-07-20T12:00:00.000Z'
            ),
        lastSyncedAt:
            new Date(
                '2026-07-29T17:00:00.000Z'
            ),
    };

    const { service } =
        makeService({
            repositoryOverrides: {
                async listUnlocks() {
                    return [
                        duplicate,
                        duplicate,
                    ];
                },
            },
        });

    await assert.rejects(
        service.syncUnlocks({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            records: [],
        }),
        expectedError(
            'achievement_storage_invalid'
        )
    );
});
