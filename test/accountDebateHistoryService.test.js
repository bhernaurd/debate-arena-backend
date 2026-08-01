import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountDebateHistoryError,
    accountDebateHistoryConstants,
    createAccountDebateHistoryService,
    createPostgresAccountDebateHistoryRepository,
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
        rankedDebateId: null,
        rankedDebateKindRawValue: null,
        rankedOutcomeRawValue: null,
        rankedReportContext: null,
        contentUpdatedAt: '2026-07-28T20:05:00.000Z',
        ...overrides,
    };
}


function makeDatabaseRow(overrides = {}) {
    const debate = makeDebate();

    return {
        account_id: ACCOUNT_ID,
        saved_debate_id: debate.id,
        analytics_debate_id: debate.analyticsDebateId,
        philosopher_name: debate.philosopherName,
        philosopher_initials: debate.philosopherInitials,
        philosopher_color_hex: debate.philosopherColorHex,
        topic: debate.topic,
        debate_date: debate.date,
        messages: debate.messages,
        final_score_text: debate.finalScore,
        final_score_value: debate.finalScoreValue,
        has_been_analyzed: debate.hasBeenAnalyzed,
        report: debate.report,
        is_daily_challenge: debate.isDailyChallenge,
        daily_challenge_id: debate.dailyChallengeId,
        daily_challenge_date: debate.dailyChallengeDate,
        debate_mode_raw_value: debate.debateModeRawValue,
        ranked_debate_id: debate.rankedDebateId,
        ranked_debate_kind: debate.rankedDebateKindRawValue,
        ranked_outcome: debate.rankedOutcomeRawValue,
        ranked_report_context: debate.rankedReportContext,
        source_schema_version: 1,
        content_updated_at: debate.contentUpdatedAt,
        ...overrides,
    };
}

function makeRankedDebate(overrides = {}) {
    return makeDebate({
        id: DEBATE_ID,
        philosopherName: 'Nietzsche',
        philosopherInitials: 'NZ',
        topic: 'Are the values you defend truly your own?',
        finalScore: '8.4/10',
        finalScoreValue: 8.4,
        debateModeRawValue: 'guided',
        rankedDebateId: DEBATE_ID,
        rankedDebateKindRawValue: 'ladder',
        rankedOutcomeRawValue: 'completed',
        rankedReportContext: {
            kind: 'ladder',
            modeName: 'Guided',
            finalScoreText: '8.4/10',
            scoredRoundCount: 3,
            placement: null,
            ladder: {
                rpDelta: 14,
                beforeRankText: 'Student II',
                beforeRP: 86,
                afterRankText: 'Student I',
                afterRP: 0,
                promoted: true,
                demoted: false,
                protectionApplied: false,
                protectionConsumed: false,
            },
        },
        ...overrides,
    });
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

        async listDebates(input) {
            calls.push(['listDebates', input]);

            return {
                rows: [],
                hasMore: false,
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

test('PostgreSQL repository writes and reads Ranked history columns without changing the schema version', async () => {
    const queries = [];
    const client = {
        async query(sql, values = []) {
            queries.push({ sql: String(sql), values });

            if (String(sql).includes('account-history:upsert-saved-debate')) {
                return {
                    rows: [
                        {
                            saved_debate_id: DEBATE_ID,
                            status: 'synced',
                            content_updated_at:
                                '2026-07-28T20:05:00.000Z',
                            last_synced_at:
                                '2026-07-29T03:30:00.000Z',
                        },
                    ],
                };
            }

            return { rows: [] };
        },
        release() {},
    };
    const pool = {
        async connect() {
            return client;
        },
        async query(sql, values = []) {
            queries.push({ sql: String(sql), values });
            return { rows: [] };
        },
    };
    const repository =
        createPostgresAccountDebateHistoryRepository(pool);
    const ranked = makeRankedDebate();
    const normalized = {
        savedDebateId: ranked.id,
        analyticsDebateId: ranked.analyticsDebateId,
        philosopherName: ranked.philosopherName,
        philosopherInitials: ranked.philosopherInitials,
        philosopherColorHex: ranked.philosopherColorHex,
        topic: ranked.topic,
        date: ranked.date,
        debateModeRawValue: ranked.debateModeRawValue,
        rankedDebateId: ranked.rankedDebateId,
        rankedDebateKindRawValue:
            ranked.rankedDebateKindRawValue,
        rankedOutcomeRawValue:
            ranked.rankedOutcomeRawValue,
        rankedReportContext:
            ranked.rankedReportContext,
        isDailyChallenge: ranked.isDailyChallenge,
        dailyChallengeId: ranked.dailyChallengeId,
        dailyChallengeDate: ranked.dailyChallengeDate,
        finalScore: ranked.finalScore,
        finalScoreValue: ranked.finalScoreValue,
        hasBeenAnalyzed: ranked.hasBeenAnalyzed,
        messages: ranked.messages,
        report: ranked.report,
        contentUpdatedAt: ranked.contentUpdatedAt,
        contentSha256: 'a'.repeat(64),
    };

    await repository.withTransaction((transaction) =>
        repository.upsertDebate(transaction, {
            accountId: ACCOUNT_ID,
            installationId: INSTALLATION_ID,
            schemaVersion: 1,
            debate: normalized,
            syncedAt: '2026-07-29T03:30:00.000Z',
        })
    );

    const upsert = queries.find(({ sql }) =>
        sql.includes('account-history:upsert-saved-debate')
    );

    assert.ok(upsert);
    assert.equal(upsert.values.length, 27);
    assert.match(upsert.sql, /ranked_debate_id/);
    assert.match(upsert.sql, /ranked_debate_kind/);
    assert.match(upsert.sql, /ranked_outcome/);
    assert.match(upsert.sql, /ranked_report_context/);
    assert.match(
        upsert.sql,
        /COALESCE\([\s\S]*?EXCLUDED\.ranked_report_context/
    );
    assert.equal(upsert.values[10], DEBATE_ID);
    assert.equal(upsert.values[11], 'ladder');
    assert.equal(upsert.values[12], 'completed');
    assert.equal(
        JSON.parse(upsert.values[13]).ladder.afterRankText,
        'Student I'
    );
    assert.equal(upsert.values[23], 1);
});

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


test('preserves complete Ranked ladder metadata during sync', async () => {
    const { service, calls } = makeService();

    await service.syncDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        schemaVersion: 1,
        debates: [makeRankedDebate()],
    });

    const input = calls.find(
        ([name]) => name === 'upsertDebate'
    )[1];

    assert.equal(input.debate.rankedDebateId, DEBATE_ID);
    assert.equal(
        input.debate.rankedDebateKindRawValue,
        'ladder'
    );
    assert.equal(input.debate.rankedOutcomeRawValue, 'completed');
    assert.equal(input.debate.rankedReportContext.kind, 'ladder');
    assert.equal(
        input.debate.rankedReportContext.ladder.rpDelta,
        14
    );
});

test('rejects incomplete or inconsistent Ranked metadata', async (t) => {
    const { service } = makeService();

    await t.test('missing report context', async () => {
        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [
                    makeRankedDebate({
                        rankedReportContext: null,
                    }),
                ],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });

    await t.test('SavedDebate identity mismatch', async () => {
        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [
                    makeRankedDebate({
                        rankedDebateId:
                            '77777777-7777-4777-8777-777777777777',
                    }),
                ],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });

    await t.test('result kind mismatch', async () => {
        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [
                    makeRankedDebate({
                        rankedDebateKindRawValue: 'placement',
                    }),
                ],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });

    await t.test('Ranked Daily Challenge overlap', async () => {
        await assert.rejects(
            () => service.syncDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                schemaVersion: 1,
                debates: [
                    makeRankedDebate({
                        isDailyChallenge: true,
                        dailyChallengeId: 'daily-1',
                        dailyChallengeDate: '2026-07-28',
                    }),
                ],
            }),
            expectedError('invalid_debate_history_payload')
        );
    });
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

test('authenticates before downloading account-owned history', async () => {
    const { service, calls } = makeService({
        repositoryOverrides: {
            async listDebates(input) {
                calls.push(['listDebates', input]);

                return {
                    rows: [makeDatabaseRow()],
                    hasMore: false,
                };
            },
        },
    });

    const result = await service.listDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
    });

    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.installationId, INSTALLATION_ID);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.debates.length, 1);
    assert.equal(result.debates[0].id, DEBATE_ID);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, null);

    const authorizationIndex = calls.findIndex(
        ([name]) => name === 'authorizeAccessToken'
    );
    const listIndex = calls.findIndex(
        ([name]) => name === 'listDebates'
    );

    assert.ok(authorizationIndex < listIndex);
    assert.equal(
        calls[listIndex][1].accountId,
        ACCOUNT_ID
    );
});

test('returns Ranked metadata unchanged during account-history download', async () => {
    const ranked = makeRankedDebate();
    const { service } = makeService({
        repositoryOverrides: {
            async listDebates() {
                return {
                    rows: [
                        makeDatabaseRow({
                            saved_debate_id: ranked.id,
                            philosopher_name: ranked.philosopherName,
                            philosopher_initials: ranked.philosopherInitials,
                            topic: ranked.topic,
                            final_score_text: ranked.finalScore,
                            final_score_value: ranked.finalScoreValue,
                            debate_mode_raw_value: ranked.debateModeRawValue,
                            ranked_debate_id: ranked.rankedDebateId,
                            ranked_debate_kind:
                                ranked.rankedDebateKindRawValue,
                            ranked_outcome:
                                ranked.rankedOutcomeRawValue,
                            ranked_report_context:
                                ranked.rankedReportContext,
                        }),
                    ],
                    hasMore: false,
                };
            },
        },
    });

    const result = await service.listDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
    });

    assert.equal(result.debates[0].rankedDebateId, DEBATE_ID);
    assert.equal(
        result.debates[0].rankedDebateKindRawValue,
        'ladder'
    );
    assert.equal(
        result.debates[0].rankedReportContext.ladder.afterRankText,
        'Student I'
    );
});

test('returns a bounded opaque cursor for the next stable page', async () => {
    const SECOND_DEBATE_ID =
        '77777777-7777-4777-8777-777777777777';

    const { service, calls } = makeService({
        repositoryOverrides: {
            async listDebates(input) {
                calls.push(['listDebates', input]);

                if (input.cursor == null) {
                    return {
                        rows: [
                            makeDatabaseRow(),
                            makeDatabaseRow({
                                saved_debate_id:
                                    SECOND_DEBATE_ID,
                                debate_date:
                                    '2026-07-27T20:00:00.000Z',
                                content_updated_at:
                                    '2026-07-27T20:05:00.000Z',
                            }),
                        ],
                        hasMore: true,
                    };
                }

                return {
                    rows: [],
                    hasMore: false,
                };
            },
        },
    });

    const firstPage = await service.listDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        limit: '2',
    });

    assert.equal(firstPage.debates.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.match(firstPage.nextCursor, /^[A-Za-z0-9_-]+$/);
    assert.ok(firstPage.nextCursor.length <= 512);

    const secondPage = await service.listDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        limit: 2,
        cursor: firstPage.nextCursor,
    });

    assert.equal(secondPage.debates.length, 0);
    assert.equal(secondPage.hasMore, false);

    const listCalls = calls.filter(
        ([name]) => name === 'listDebates'
    );

    assert.equal(
        listCalls[1][1].cursor.savedDebateId,
        SECOND_DEBATE_ID
    );
    assert.equal(
        listCalls[1][1].cursor.debateDate,
        '2026-07-27T20:00:00.000Z'
    );
});

test('rejects malformed download cursors before querying history', async () => {
    const { service, calls } = makeService();

    await assert.rejects(
        () => service.listDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
            cursor: 'not+a+base64url+cursor',
        }),
        expectedError('invalid_debate_history_cursor')
    );

    assert.ok(
        !calls.some(([name]) => name === 'listDebates')
    );
});

test('rejects download limits outside the configured bounds', async (t) => {
    const { service } = makeService();

    await t.test('zero', async () => {
        await assert.rejects(
            () => service.listDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                limit: 0,
            }),
            expectedError('invalid_debate_history_page_limit')
        );
    });

    await t.test('above maximum', async () => {
        await assert.rejects(
            () => service.listDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
                limit:
                    accountDebateHistoryConstants
                        .maxDownloadPageSize + 1,
            }),
            expectedError('invalid_debate_history_page_limit')
        );
    });
});

test('rejects a database row belonging to another account', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async listDebates() {
                return {
                    rows: [
                        makeDatabaseRow({
                            account_id:
                                '88888888-8888-4888-8888-888888888888',
                        }),
                    ],
                    hasMore: false,
                };
            },
        },
    });

    await assert.rejects(
        () => service.listDebates({
            installationId: INSTALLATION_ID,
            accessToken: 'header.payload.signature',
        }),
        expectedError('debate_history_account_mismatch')
    );
});

test('rejects unstable or duplicate database ordering', async (t) => {
    const SECOND_DEBATE_ID =
        '77777777-7777-4777-8777-777777777777';

    await t.test('out of order', async () => {
        const { service } = makeService({
            repositoryOverrides: {
                async listDebates() {
                    return {
                        rows: [
                            makeDatabaseRow({
                                debate_date:
                                    '2026-07-27T20:00:00.000Z',
                                content_updated_at:
                                    '2026-07-27T20:05:00.000Z',
                            }),
                            makeDatabaseRow({
                                saved_debate_id:
                                    SECOND_DEBATE_ID,
                                debate_date:
                                    '2026-07-28T20:00:00.000Z',
                            }),
                        ],
                        hasMore: false,
                    };
                },
            },
        });

        await assert.rejects(
            () => service.listDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
            }),
            expectedError(
                'debate_history_download_unavailable'
            )
        );
    });

    await t.test('duplicate', async () => {
        const { service } = makeService({
            repositoryOverrides: {
                async listDebates() {
                    return {
                        rows: [
                            makeDatabaseRow(),
                            makeDatabaseRow(),
                        ],
                        hasMore: false,
                    };
                },
            },
        });

        await assert.rejects(
            () => service.listDebates({
                installationId: INSTALLATION_ID,
                accessToken: 'header.payload.signature',
            }),
            expectedError(
                'debate_history_download_unavailable'
            )
        );
    });
});

test('preserves full SavedDebate fields in download responses', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async listDebates() {
                return {
                    rows: [
                        makeDatabaseRow({
                            messages:
                                JSON.stringify(
                                    makeDebate().messages
                                ),
                            report:
                                JSON.stringify(
                                    makeDebate().report
                                ),
                        }),
                    ],
                    hasMore: false,
                };
            },
        },
    });

    const result = await service.listDebates({
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
    });

    const debate = result.debates[0];

    assert.equal(debate.id, DEBATE_ID);
    assert.equal(debate.messages[0].id, MESSAGE_ID);
    assert.equal(
        debate.report.roundScores[0].id,
        ROUND_ID
    );
    assert.equal(
        debate.contentUpdatedAt,
        '2026-07-28T20:05:00.000Z'
    );
});

