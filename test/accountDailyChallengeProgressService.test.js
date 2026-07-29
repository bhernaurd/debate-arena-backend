import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountDailyChallengeProgressError,
    createAccountDailyChallengeProgressService,
    createPostgresAccountDailyChallengeProgressRepository,
} from '../lib/accountDailyChallengeProgressService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID =
    '22222222-2222-4222-8222-222222222222';

function expectedError(code) {
    return (error) => {
        assert.ok(
            error instanceof
                AccountDailyChallengeProgressError
        );
        assert.equal(error.code, code);
        return true;
    };
}

function makeRecord(overrides = {}) {
    return {
        challengeId:
            'daily-2026-07-29',
        challengeDate:
            '2026-07-29',
        challengeTitle:
            'The Daily Challenge',
        challengeQuestion:
            'What makes a life worth living?',
        philosopherId:
            'socrates',
        philosopherName:
            'Socrates',
        analyticsDebateId:
            'analytics-123',
        userOpeningAnswer:
            'A life is worth living when it has meaning.',
        messages: [
            {
                id:
                    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                role: 'user',
                content:
                    'A life is worth living when it has meaning.',
                timestamp:
                    '2026-07-29T12:00:00.000Z',
                scoreUpdate: null,
            },
        ],
        currentScore: null,
        roundCount: 0,
        createdAt:
            '2026-07-29T12:00:00.000Z',
        updatedAt:
            '2026-07-29T12:00:01.000Z',
        ...overrides,
    };
}

function makeService({
    completed = false,
    repositoryOverrides = {},
    now = () =>
        Date.UTC(
            2026,
            6,
            29,
            18,
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
                    await work({});
                calls.push(['COMMIT']);
                return result;
            } catch (error) {
                calls.push(['ROLLBACK']);
                throw error;
            }
        },

        async hasCompletedChallenge(
            _client,
            input
        ) {
            calls.push([
                'hasCompletedChallenge',
                input,
            ]);
            return completed;
        },

        async upsertActive(
            _client,
            input
        ) {
            calls.push([
                'upsertActive',
                input,
            ]);
            return {
                status: 'synced',
            };
        },

        async clearChallenge(
            _client,
            input
        ) {
            calls.push([
                'clearChallenge',
                input,
            ]);
            return {
                status: 'cleared',
            };
        },

        async loadCurrentActive() {
            calls.push([
                'loadCurrentActive',
            ]);
            return null;
        },

        ...repositoryOverrides,
    };

    const accountAuthService = {
        async authorizeAccessToken(input) {
            calls.push([
                'authorizeAccessToken',
                input,
            ]);

            return {
                accountId:
                    ACCOUNT_ID,
                installationId:
                    INSTALLATION_ID,
            };
        },
    };

    return {
        service:
            createAccountDailyChallengeProgressService({
                repository,
                accountAuthService,
                now,
            }),
        calls,
    };
}

test('allows download-only synchronization', async () => {
    const { service, calls } =
        makeService();

    const result =
        await service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: null,
        });

    assert.equal(
        result.mutationStatus,
        'download_only'
    );
    assert.equal(result.current, null);
    assert.equal(
        calls.some(
            ([name]) =>
                name === 'upsertActive'
        ),
        false
    );
});

test('authenticates before applying an active snapshot', async () => {
    const { service, calls } =
        makeService();

    const result =
        await service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord(),
            },
        });

    assert.equal(
        result.mutationStatus,
        'synced'
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
                name === 'upsertActive'
        );

    assert.ok(authIndex < beginIndex);
    assert.ok(beginIndex < upsertIndex);
});

test('turns a completed challenge upload into a tombstone', async () => {
    const { service, calls } =
        makeService({
            completed: true,
        });

    const result =
        await service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord(),
            },
        });

    assert.equal(
        result.mutationStatus,
        'completed_ignored'
    );
    assert.equal(
        calls.some(
            ([name]) =>
                name === 'upsertActive'
        ),
        false
    );
    assert.equal(
        calls.some(
            ([name]) =>
                name === 'clearChallenge'
        ),
        true
    );
});

test('applies explicit clear tombstones', async () => {
    const { service, calls } =
        makeService();

    const result =
        await service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'clear',
                challengeId:
                    'daily-2026-07-29',
                challengeDate:
                    '2026-07-29',
                updatedAt:
                    '2026-07-29T12:30:00.000Z',
            },
        });

    assert.equal(
        result.mutationStatus,
        'cleared'
    );
    assert.equal(
        calls.some(
            ([name]) =>
                name === 'clearChallenge'
        ),
        true
    );
});

test('rejects unsupported schemas', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 2,
            mutation: null,
        }),
        expectedError(
            'unsupported_daily_challenge_progress_schema'
        )
    );
});

test('rejects duplicate message identifiers', async () => {
    const duplicateMessage = {
        id:
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        role: 'assistant',
        content: 'Duplicate.',
        timestamp:
            '2026-07-29T12:00:02.000Z',
        scoreUpdate: null,
    };

    const { service } =
        makeService();

    await assert.rejects(
        service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord({
                    messages: [
                        ...makeRecord().messages,
                        duplicateMessage,
                    ],
                }),
            },
        }),
        expectedError(
            'duplicate_daily_challenge_message_id'
        )
    );
});

test('rejects unsupported message roles', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord({
                    messages: [
                        {
                            ...makeRecord()
                                .messages[0],
                            role: 'system',
                        },
                    ],
                }),
            },
        }),
        expectedError(
            'invalid_daily_challenge_progress_payload'
        )
    );
});

test('rejects updatedAt before createdAt', async () => {
    const { service } =
        makeService();

    await assert.rejects(
        service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord({
                    updatedAt:
                        '2026-07-29T11:59:59.000Z',
                }),
            },
        }),
        expectedError(
            'invalid_daily_challenge_progress_payload'
        )
    );
});

test('rolls back when persistence fails', async () => {
    const { service, calls } =
        makeService({
            repositoryOverrides: {
                async upsertActive() {
                    throw new Error(
                        'database down'
                    );
                },
            },
        });

    await assert.rejects(
        service.syncProgress({
            installationId:
                INSTALLATION_ID,
            accessToken:
                'header.payload.signature',
            schemaVersion: 1,
            mutation: {
                kind: 'upsert',
                record: makeRecord(),
            },
        }),
        expectedError(
            'daily_challenge_progress_sync_unavailable'
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


test('normalizes PostgreSQL Date objects when loading the current snapshot', async () => {
    const expectedCreatedAt =
        new Date('2026-07-29T18:10:20.202Z');
    const expectedUpdatedAt =
        new Date('2026-07-29T18:11:21.303Z');

    const client = {
        async query(sql) {
            assert.match(
                sql,
                /account-daily-progress:load-current-active/
            );

            return {
                rows: [
                    {
                        challenge_id:
                            'daily-2026-07-29',
                        challenge_date:
                            new Date(
                                '2026-07-29T00:00:00.000Z'
                            ),
                        challenge_title:
                            'The Daily Challenge',
                        challenge_question:
                            'What makes a life worth living?',
                        philosopher_id:
                            'socrates',
                        philosopher_name:
                            'Socrates',
                        analytics_debate_id:
                            'analytics-123',
                        user_opening_answer:
                            'A life is worth living when it has meaning.',
                        messages: [
                            {
                                id:
                                    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                                role:
                                    'user',
                                content:
                                    'A life is worth living when it has meaning.',
                                timestamp:
                                    '2026-07-29T18:10:20.202Z',
                                scoreUpdate:
                                    null,
                            },
                        ],
                        current_score:
                            null,
                        round_count:
                            0,
                        session_created_at:
                            expectedCreatedAt,
                        mutation_updated_at:
                            expectedUpdatedAt,
                    },
                ],
            };
        },
    };

    const pool = {
        async connect() {
            return {
                ...client,
                release() {},
            };
        },
    };

    const repository =
        createPostgresAccountDailyChallengeProgressRepository(
            pool
        );

    const record =
        await repository.loadCurrentActive(
            client,
            {
                accountId:
                    ACCOUNT_ID,
            }
        );

    assert.equal(
        record.challengeDate,
        '2026-07-29'
    );
    assert.equal(
        record.createdAt,
        expectedCreatedAt.toISOString()
    );
    assert.equal(
        record.updatedAt,
        expectedUpdatedAt.toISOString()
    );
});
