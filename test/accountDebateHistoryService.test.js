import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountDebateHistoryError,
    accountDebateHistoryConstants,
    createAccountDebateHistoryService,
} from '../lib/accountDebateHistoryService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID =
    '22222222-2222-4222-8222-222222222222';
const SESSION_ID =
    '33333333-3333-4333-8333-333333333333';
const DEBATE_ID =
    '44444444-4444-4444-8444-444444444444';
const MESSAGE_ID =
    '55555555-5555-4555-8555-555555555555';
const ROUND_ID =
    '66666666-6666-4666-8666-666666666666';

function makeDebate(overrides = {}) {
    return {
        id: DEBATE_ID,
        analyticsDebateId: 'analytics-debate-1',
        philosopherName: 'Socrates',
        philosopherInitials: 'SO',
        philosopherColorHex: '#C8A96B',
        topic: 'What is justice?',
        date: '2026-07-28T20:00:00.000Z',
        messages: [
            {
                id: MESSAGE_ID,
                role: 'user',
                content: 'Justice is giving each person their due.',
                timestamp: '2026-07-28T20:00:01.000Z',
                scoreUpdate: {
                    score: '7/10',
                    note: 'A clear opening definition.',
                },
            },
        ],
        finalScore: '8/10',
        finalScoreValue: 8,
        hasBeenAnalyzed: true,
        report: {
            overallScore: '8/10',
            verdict: 'A disciplined argument.',
            arc: 'The argument moved from definition to qualification.',
            roundScores: [
                {
                    id: ROUND_ID,
                    round: 1,
                    score: 8,
                    justification: 'The definition was defended clearly.',
                },
            ],
            strengths: ['Clear definition'],
            weaknesses: ['Needed a counterexample'],
            improvements: ['Test the definition against edge cases'],
            perfectArgument: 'Define justice, test it, and answer objections.',
            rematchFocus: 'Use a concrete counterexample.',
            philosopherName: 'Socrates',
            generatedAt: '2026-07-28T20:05:00.000Z',
            shareCardQuote: 'Justice gives each person their due.',
            shareCardQuoteSpeaker: 'You',
            shareCardQuoteLabel: 'Your strongest line',
        },
        isDailyChallenge: false,
        dailyChallengeId: null,
        dailyChallengeDate: null,
        debateModeRawValue: 'balanced',
        contentUpdatedAt: '2026-07-28T20:05:00.000Z',
        ...overrides,
    };
}

function expectedError(code) {
    return (error) => {
        assert.ok(error instanceof AccountDebateHistoryError);
        assert.equal(error.code, code);
        return true;
    };
}

function makeService({
    repositoryOverrides = {},
    authorizeOverride = null,
} = {}) {
    const calls = [];

    const repository = {
        async withTransaction(work) {
            calls.push(['BEGIN']);

            try {
                const result = await work({ query() {} });
                calls.push(['COMMIT']);
                return result;
            } catch (error) {
                calls.push(['ROLLBACK']);
                throw error;
            }
        },

        async upsertDebate(_client, input) {
            calls.push(['upsertDebate', input]);
            return {
                savedDebateId: input.debate.savedDebateId,
                status: 'synced',
                contentUpdatedAt:
                    input.debate.contentUpdatedAt,
                lastSyncedAt: input.syncedAt,
            };
        },

        ...repositoryOverrides,
    };

    const accountAuthService = {
        async authorizeAccessToken(input) {
            calls.push(['authorizeAccessToken', input]);

            if (authorizeOverride) {
                return authorizeOverride(input);
            }

            return {
                accountId: ACCOUNT_ID,
                sessionId: SESSION_ID,
                installationId: INSTALLATION_ID,
                authVersion: 1,
            };
        },
    };

    const service = createAccountDebateHistoryService({
        repository,
        accountAuthService,
        now: () => Date.UTC(2026, 6, 29, 3, 30, 0),
    });

    return { service, calls };
}

test('authenticates and upserts a complete SavedDebate snapshot', async () => {
    const { service, calls } = makeService();

    const result = await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [makeDebate()],
    });

    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.installationId, INSTALLATION_ID);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'synced');

    const authorizationIndex = calls.findIndex(
        ([name]) => name === 'authorizeAccessToken'
    );
    const transactionIndex = calls.findIndex(
        ([name]) => name === 'BEGIN'
    );
    const upsertIndex = calls.findIndex(
        ([name]) => name === 'upsertDebate'
    );

    assert.ok(authorizationIndex < transactionIndex);
    assert.ok(transactionIndex < upsertIndex);
});

test('preserves ordered message and report identifiers', async () => {
    const { service, calls } = makeService();

    await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [makeDebate()],
    });

    const input = calls.find(
        ([name]) => name === 'upsertDebate'
    )[1];

    assert.equal(input.debate.savedDebateId, DEBATE_ID);
    assert.equal(input.debate.messages[0].id, MESSAGE_ID);
    assert.equal(
        input.debate.report.roundScores[0].id,
        ROUND_ID
    );
    assert.match(input.debate.contentSha256, /^[0-9a-f]{64}$/);
});

test('accepts an older debate without analytics, score, report, daily challenge, or mode', async () => {
    const { service } = makeService();

    const result = await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [
            makeDebate({
                analyticsDebateId: null,
                finalScore: null,
                finalScoreValue: null,
                hasBeenAnalyzed: false,
                report: null,
                dailyChallengeId: null,
                dailyChallengeDate: null,
                debateModeRawValue: null,
                contentUpdatedAt:
                    '2026-07-28T20:00:01.000Z',
            }),
        ],
    });

    assert.equal(result.results[0].status, 'synced');
});

test('returns a stale ignored result without treating it as a sync failure', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async upsertDebate(_client, input) {
                return {
                    savedDebateId:
                        input.debate.savedDebateId,
                    status: 'stale_ignored',
                    contentUpdatedAt:
                        '2026-07-28T21:00:00.000Z',
                    lastSyncedAt:
                        new Date('2026-07-29T03:30:00.000Z'),
                };
            },
        },
    });

    const result = await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [makeDebate()],
    });

    assert.equal(result.results[0].status, 'stale_ignored');
});

test('rejects an unsupported history schema version', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 2,
            debates: [makeDebate()],
        }),
        expectedError('unsupported_debate_history_schema')
    );
});

test('rejects duplicate SavedDebate identifiers in one batch', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [makeDebate(), makeDebate()],
        }),
        expectedError('duplicate_saved_debate_id')
    );
});

test('rejects duplicate message identifiers in a debate', async () => {
    const { service } = makeService();
    const first = makeDebate().messages[0];

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [
                makeDebate({
                    messages: [first, { ...first }],
                }),
            ],
        }),
        expectedError('duplicate_message_id')
    );
});

test('rejects an unsupported message role', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [
                makeDebate({
                    messages: [
                        {
                            ...makeDebate().messages[0],
                            role: 'system',
                        },
                    ],
                }),
            ],
        }),
        expectedError('invalid_debate_history_payload')
    );
});

test('rejects out-of-range final and round scores', async (t) => {
    const { service } = makeService();

    await t.test('final score', async () => {
        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [makeDebate({ finalScoreValue: 11 })],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });

    await t.test('round score', async () => {
        const report = makeDebate().report;

        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [
                    makeDebate({
                        report: {
                            ...report,
                            roundScores: [
                                {
                                    ...report.roundScores[0],
                                    score: 12,
                                },
                            ],
                        },
                    }),
                ],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });
});

test('rejects a batch above the configured maximum', async () => {
    const { service } = makeService();
    const debates = Array.from(
        {
            length:
                accountDebateHistoryConstants.maxBatchSize + 1,
        },
        (_, index) => makeDebate({
            id: `44444444-4444-4444-8444-${String(index).padStart(12, '0')}`,
        })
    );

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates,
        }),
        expectedError('invalid_debate_history_payload')
    );
});

test('normalizes account authorization failures', async () => {
    const { service } = makeService({
        authorizeOverride() {
            const error = new Error('Session expired.');
            error.code = 'token_expired';
            error.status = 401;
            throw error;
        },
    });

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [makeDebate()],
        }),
        expectedError('token_expired')
    );
});

test('rolls back the whole batch when an upsert fails', async () => {
    const { service, calls } = makeService({
        repositoryOverrides: {
            async upsertDebate() {
                throw new Error('database unavailable');
            },
        },
    });

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [makeDebate()],
        }),
        expectedError('debate_history_sync_unavailable')
    );

    assert.ok(calls.some(([name]) => name === 'ROLLBACK'));
    assert.ok(!calls.some(([name]) => name === 'COMMIT'));
});


test('preserves meaningful whitespace in debate content and report text', async () => {
    const { service, calls } = makeService();
    const debate = makeDebate({
        topic: '  What is justice?  ',
        messages: [
            {
                ...makeDebate().messages[0],
                content: '  Justice begins with attention.\n',
                scoreUpdate: {
                    score: '7/10',
                    note: '  Preserve this note exactly.  ',
                },
            },
        ],
        report: {
            ...makeDebate().report,
            perfectArgument: '  Preserve the full argument.\n',
        },
    });

    await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [debate],
    });

    const input = calls.find(
        ([name]) => name === 'upsertDebate'
    )[1];

    assert.equal(input.debate.topic, debate.topic);
    assert.equal(
        input.debate.messages[0].content,
        debate.messages[0].content
    );
    assert.equal(
        input.debate.messages[0].scoreUpdate.note,
        debate.messages[0].scoreUpdate.note
    );
    assert.equal(
        input.debate.report.perfectArgument,
        debate.report.perfectArgument
    );
});

test('rejects an impossible Daily Challenge calendar date', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.syncDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            schemaVersion: 1,
            debates: [
                makeDebate({
                    isDailyChallenge: true,
                    dailyChallengeId: 'daily-1',
                    dailyChallengeDate: '2026-02-30',
                }),
            ],
        }),
        expectedError('invalid_debate_history_payload')
    );
});
