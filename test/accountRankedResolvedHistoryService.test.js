import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createAccountRankedUnifiedDebateService,
    createPostgresAccountRankedUnifiedRepository,
} from '../lib/accountRankedUnifiedDebateService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const FIRST_DEBATE_ID =
    '22222222-2222-4222-8222-222222222222';
const SECOND_DEBATE_ID =
    '33333333-3333-4333-8333-333333333333';
const INSTALLATION_ID =
    'resolved-history-test-installation';
const ACCESS_TOKEN =
    'header.payload.signature';
const NOW =
    new Date('2026-08-04T10:00:00.000Z');

function baseService() {
    return {
        async resumeActiveDebate() {},
        async getResolvedDebateResult() {},
        async generateOpening() {},
        async submitTurn() {},
        async completeDebate() {},
        async forfeitDebate() {},
    };
}

function ratingService() {
    return {
        calculateCompletedDebate() {},
        calculateForfeit() {},
    };
}

function makeService({
    repository,
    proAccessService,
} = {}) {
    return createAccountRankedUnifiedDebateService({
        repository,
        baseService: baseService(),
        accountAuthService: {
            async authorizeAccessToken({
                installationId,
                accessToken,
            }) {
                assert.equal(
                    installationId,
                    INSTALLATION_ID
                );
                assert.equal(
                    accessToken,
                    ACCESS_TOKEN
                );

                return {
                    accountId: ACCOUNT_ID,
                    installationId,
                };
            },
        },
        proAccessService:
            proAccessService ?? {
                async requireCurrentProAccess() {
                    throw new Error(
                        'Resolved history must not require Pro access.'
                    );
                },
            },
        ratingService: ratingService(),
        now: () => NOW,
    });
}

test(
    'lists resolved Ranked debates without requiring current Pro access',
    async () => {
        const calls = [];
        const service = makeService({
            repository: {
                async listResolvedDebates(input) {
                    calls.push(input);

                    return [
                        {
                            account_id: ACCOUNT_ID,
                            id: FIRST_DEBATE_ID,
                            debate_kind: 'placement',
                            status: 'completed',
                            completed_at:
                                new Date(
                                    '2026-08-03T12:00:00.000Z'
                                ),
                            updated_at:
                                new Date(
                                    '2026-08-03T12:01:00.000Z'
                                ),
                        },
                        {
                            account_id: ACCOUNT_ID,
                            id: SECOND_DEBATE_ID,
                            debate_kind: 'ladder',
                            status: 'forfeited',
                            completed_at:
                                new Date(
                                    '2026-08-02T12:00:00.000Z'
                                ),
                            updated_at:
                                new Date(
                                    '2026-08-02T12:01:00.000Z'
                                ),
                        },
                    ];
                },
            },
        });

        const result = await service.listResolvedDebates({
            installationId: INSTALLATION_ID,
            accessToken: ACCESS_TOKEN,
            limit: 1,
        });

        assert.equal(
            result.accountId,
            ACCOUNT_ID
        );
        assert.equal(
            result.debates.length,
            1
        );
        assert.equal(
            result.debates[0].id,
            FIRST_DEBATE_ID
        );
        assert.equal(
            result.hasMore,
            true
        );
        assert.equal(
            typeof result.nextCursor,
            'string'
        );
        assert.equal(
            calls[0].limit,
            2
        );
        assert.equal(
            calls[0].cursorCompletedAt,
            null
        );
        assert.equal(
            calls[0].cursorDebateId,
            null
        );

        const secondCalls = [];
        const secondService = makeService({
            repository: {
                async listResolvedDebates(input) {
                    secondCalls.push(input);
                    return [];
                },
            },
        });

        const secondResult =
            await secondService.listResolvedDebates({
                installationId: INSTALLATION_ID,
                accessToken: ACCESS_TOKEN,
                limit: 1,
                cursor: result.nextCursor,
            });

        assert.equal(
            secondResult.hasMore,
            false
        );
        assert.equal(
            secondResult.nextCursor,
            null
        );
        assert.equal(
            secondCalls[0]
                .cursorCompletedAt
                .toISOString(),
            '2026-08-03T12:00:00.000Z'
        );
        assert.equal(
            secondCalls[0].cursorDebateId,
            FIRST_DEBATE_ID
        );
    }
);

test(
    'rejects an invalid resolved Ranked history cursor',
    async () => {
        const service = makeService({
            repository: {
                async listResolvedDebates() {
                    assert.fail(
                        'Repository should not be called for an invalid cursor.'
                    );
                },
            },
        });

        await assert.rejects(
            service.listResolvedDebates({
                installationId: INSTALLATION_ID,
                accessToken: ACCESS_TOKEN,
                cursor: 'not-a-valid-cursor',
            }),
            (error) => {
                assert.equal(
                    error.code,
                    'invalid_ranked_history_cursor'
                );
                assert.equal(
                    error.status,
                    400
                );
                return true;
            }
        );
    }
);

test(
    'PostgreSQL resolved history query uses stable completed-at and UUID pagination',
    async () => {
        let capturedSQL;
        let capturedParameters;

        const pool = {
            async connect() {
                throw new Error(
                    'A transaction is not required for the resolved index.'
                );
            },
            async query(sql, parameters) {
                capturedSQL = sql;
                capturedParameters = parameters;
                return { rows: [] };
            },
        };

        const repository =
            createPostgresAccountRankedUnifiedRepository(
                pool
            );
        const cursorDate =
            new Date(
                '2026-08-03T12:00:00.000Z'
            );

        const rows = await repository.listResolvedDebates({
            accountId: ACCOUNT_ID,
            limit: 51,
            cursorCompletedAt: cursorDate,
            cursorDebateId: FIRST_DEBATE_ID,
        });

        assert.deepEqual(rows, []);
        assert.match(
            capturedSQL,
            /status IN \('completed', 'forfeited'\)/
        );
        assert.match(
            capturedSQL,
            /ORDER BY completed_at DESC, id DESC/
        );
        assert.match(
            capturedSQL,
            /\(completed_at, id\) </
        );
        assert.deepEqual(
            capturedParameters,
            [
                ACCOUNT_ID,
                cursorDate,
                FIRST_DEBATE_ID,
                51,
            ]
        );
    }
);
