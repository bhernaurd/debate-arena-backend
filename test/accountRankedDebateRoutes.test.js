import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    createAccountRankedDebateRouter,
} from '../accountRankedDebateRoutes.js';

import {
    AccountRankedDebateError,
    accountRankedDebateConstants,
} from '../lib/accountRankedDebateService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';

const DEBATE_ID =
    '22222222-2222-4222-8222-222222222222';

const SECOND_DEBATE_ID =
    '99999999-9999-4999-8999-999999999999';

const START_REQUEST_ID =
    '33333333-3333-4333-8333-333333333333';

const OPENING_REQUEST_ID =
    '44444444-4444-4444-8444-444444444444';

const TURN_REQUEST_ID =
    '55555555-5555-4555-8555-555555555555';

const OPENING_MESSAGE_ID =
    '66666666-6666-4666-8666-666666666666';

const USER_MESSAGE_ID =
    '77777777-7777-4777-8777-777777777777';

const ASSISTANT_MESSAGE_ID =
    '88888888-8888-4888-8888-888888888888';

const INSTALLATION_ID =
    'ranked-route-test-installation';

const ACCESS_TOKEN =
    'header.payload.signature';

const NOW =
    new Date('2026-07-30T11:15:00.000Z');

const TOPIC =
    'Is a life without examination still capable of genuine wisdom?';

function openingMessage(
    overrides = {}
) {
    return {
        id:
            OPENING_MESSAGE_ID,
        requestId:
            OPENING_REQUEST_ID,
        role:
            'assistant',
        kind:
            'opening',
        content:
            'I would first ask what you mean by a life that is never examined.',
        roundNumber:
            0,
        scoreText:
            null,
        scoreValue:
            null,
        createdAt:
            NOW,
        completedAt:
            NOW,
        ...overrides,
    };
}

function userMessage(
    overrides = {}
) {
    return {
        id:
            USER_MESSAGE_ID,
        requestId:
            TURN_REQUEST_ID,
        role:
            'user',
        kind:
            'turn',
        content:
            'A person may act wisely through habit even without examining every belief.',
        roundNumber:
            1,
        scoreText:
            null,
        scoreValue:
            null,
        createdAt:
            NOW,
        completedAt:
            NOW,
        ...overrides,
    };
}

function assistantMessage(
    overrides = {}
) {
    return {
        id:
            ASSISTANT_MESSAGE_ID,
        requestId:
            TURN_REQUEST_ID,
        role:
            'assistant',
        kind:
            'turn',
        content:
            'But can habit deserve the name wisdom when the person cannot explain why the habit is good?',
        roundNumber:
            1,
        scoreText:
            null,
        scoreValue:
            null,
        createdAt:
            NOW,
        completedAt:
            NOW,
        ...overrides,
    };
}

function activeDebate(
    overrides = {}
) {
    return {
        id:
            DEBATE_ID,
        accountId:
            ACCOUNT_ID,
        startRequestId:
            START_REQUEST_ID,
        debateKind:
            'placement',
        placementTrialNumber:
            1,
        status:
            'active',
        philosopherId:
            'socrates',
        philosopherName:
            'Socrates',
        debateMode:
            'guided',
        topic:
            TOPIC,
        topicFingerprint:
            'a'.repeat(64),
        topicTheme:
            'The examined life',
        topicModelProvider:
            'anthropic',
        topicModelName:
            'claude-haiku-4-5-20251001',
        topicGeneratedAt:
            NOW,
        messages: [
            openingMessage(),
        ],
        pendingGeneration:
            null,
        currentScoreText:
            null,
        currentScoreValue:
            null,
        roundCount:
            0,
        rankedRulesVersion:
            'ranked-rules-v1',
        philosopherPromptVersion:
            'ranked-philosophers-v1',
        scoringPromptVersion:
            'ranked-scoring-v1',
        reportPromptVersion:
            'ranked-report-v1',
        topicGeneratorVersion:
            'ranked-topic-v1',
        rpFormulaVersion:
            'ranked-rp-v1',
        modelProvider:
            'anthropic',
        modelName:
            'claude-sonnet-4-5-20250929',
        stateVersion:
            2,
        startedAt:
            NOW,
        lastActivityAt:
            NOW,
        updatedAt:
            NOW,
        ...overrides,
    };
}

function resumeResult(
    overrides = {}
) {
    return {
        schemaVersion:
            accountRankedDebateConstants
                .schemaVersion,
        accountId:
            ACCOUNT_ID,
        installationId:
            INSTALLATION_ID,
        resumedAt:
            NOW,
        debate:
            activeDebate(),
        ...overrides,
    };
}

function generationResult({
    created = true,
    requestId =
        OPENING_REQUEST_ID,
    debate =
        activeDebate(),
    reply =
        openingMessage(),
    ...overrides
} = {}) {
    return {
        schemaVersion:
            accountRankedDebateConstants
                .schemaVersion,
        accountId:
            ACCOUNT_ID,
        installationId:
            INSTALLATION_ID,
        requestId,
        created,
        debate,
        reply,
        ...overrides,
    };
}

function turnResult({
    created = true,
    ...overrides
} = {}) {
    const reply =
        assistantMessage();

    const debate =
        activeDebate({
            messages: [
                openingMessage(),
                userMessage(),
                reply,
            ],
            roundCount:
                1,
            stateVersion:
                4,
        });

    return generationResult({
        created,
        requestId:
            TURN_REQUEST_ID,
        debate,
        reply,
        ...overrides,
    });
}

function resolvedIndexResult(
    overrides = {}
) {
    return {
        schemaVersion:
            accountRankedDebateConstants
                .schemaVersion,
        accountId:
            ACCOUNT_ID,
        installationId:
            INSTALLATION_ID,
        retrievedAt:
            NOW,
        debates: [
            {
                id:
                    DEBATE_ID,
                debateKind:
                    'placement',
                status:
                    'completed',
                completedAt:
                    NOW,
                updatedAt:
                    NOW,
            },
            {
                id:
                    SECOND_DEBATE_ID,
                debateKind:
                    'ladder',
                status:
                    'forfeited',
                completedAt:
                    new Date(
                        '2026-07-29T11:15:00.000Z'
                    ),
                updatedAt:
                    new Date(
                        '2026-07-29T11:16:00.000Z'
                    ),
            },
        ],
        nextCursor:
            'next-page-token',
        hasMore:
            true,
        ...overrides,
    };
}

function makeService(
    overrides = {}
) {
    return {
        async resumeActiveDebate() {
            return resumeResult();
        },

        async listResolvedDebates() {
            return resolvedIndexResult();
        },

        async getResolvedDebateResult() {
            return {
                success: true,
            };
        },

        async generateOpening() {
            return generationResult();
        },

        async submitTurn() {
            return turnResult();
        },

        async completeDebate() {
            return {
                success: true,
            };
        },

        async forfeitDebate() {
            return {
                success: true,
            };
        },

        ...overrides,
    };
}

async function startServer({
    service = makeService(),
    logger = {
        error() {},
    },
} = {}) {
    const app =
        express();

    app.use(
        express.json({
            limit:
                '50kb',
        })
    );

    app.use(
        '/api/account/ranked',
        createAccountRankedDebateRouter({
            service,
            logger,
        })
    );

    const server =
        http.createServer(
            app
        );

    await new Promise(
        (
            resolve,
            reject
        ) => {
            server.once(
                'error',
                reject
            );

            server.listen(
                0,
                '127.0.0.1',
                resolve
            );
        }
    );

    const address =
        server.address();

    return {
        baseUrl:
            `http://127.0.0.1:${address.port}`,

        close: () =>
            new Promise(
                (
                    resolve,
                    reject
                ) => {
                    server.close(
                        (error) => {
                            if (error) {
                                reject(
                                    error
                                );
                            } else {
                                resolve();
                            }
                        }
                    );
                }
            ),
    };
}

function headers(
    extra = {}
) {
    return {
        'Content-Type':
            'application/json',
        'X-Installation-ID':
            INSTALLATION_ID,
        Authorization:
            `Bearer ${ACCESS_TOKEN}`,
        ...extra,
    };
}

async function readJson(
    response
) {
    const text =
        await response.text();

    return text
        ? JSON.parse(text)
        : null;
}

test(
    'resumes the active Ranked debate',
    async (t) => {
        let captured;

        const server =
            await startServer({
                service:
                    makeService({
                        async resumeActiveDebate(
                            input
                        ) {
                            captured =
                                input;

                            return resumeResult();
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers:
                        headers(),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            200
        );

        assert.deepEqual(
            captured,
            {
                installationId:
                    INSTALLATION_ID,
                accessToken:
                    ACCESS_TOKEN,
            }
        );

        assert.equal(
            body.success,
            true
        );

        assert.equal(
            body.accountId,
            ACCOUNT_ID
        );

        assert.equal(
            body.debate.id,
            DEBATE_ID
        );

        assert.equal(
            body.debate.messages.length,
            1
        );

        assert.equal(
            body.debate.messages[0]
                .role,
            'assistant'
        );

        assert.equal(
            body.resumedAt,
            NOW.toISOString()
        );

        assert.equal(
            response.headers.get(
                'cache-control'
            ),
            'no-store'
        );

        assert.equal(
            response.headers.get(
                'pragma'
            ),
            'no-cache'
        );

        assert.equal(
            response.headers.get(
                'x-content-type-options'
            ),
            'nosniff'
        );
    }
);

test(
    'lists resolved Ranked debates with stable pagination metadata',
    async (t) => {
        let captured;

        const server =
            await startServer({
                service:
                    makeService({
                        async listResolvedDebates(
                            input
                        ) {
                            captured =
                                input;

                            return resolvedIndexResult();
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/resolved?limit=25&cursor=previous-page-token`,
                {
                    headers:
                        headers(),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            200
        );

        assert.deepEqual(
            captured,
            {
                installationId:
                    INSTALLATION_ID,
                accessToken:
                    ACCESS_TOKEN,
                limit:
                    '25',
                cursor:
                    'previous-page-token',
            }
        );

        assert.equal(
            body.success,
            true
        );
        assert.equal(
            body.debates.length,
            2
        );
        assert.equal(
            body.debates[0].id,
            DEBATE_ID
        );
        assert.equal(
            body.debates[0].debateKind,
            'placement'
        );
        assert.equal(
            body.debates[1].status,
            'forfeited'
        );
        assert.equal(
            body.debates[1].completedAt,
            '2026-07-29T11:15:00.000Z'
        );
        assert.equal(
            body.nextCursor,
            'next-page-token'
        );
        assert.equal(
            body.hasMore,
            true
        );
        assert.equal(
            body.retrievedAt,
            NOW.toISOString()
        );
    }
);

test(
    'generates a new opening and returns 201',
    async (t) => {
        let captured;

        const server =
            await startServer({
                service:
                    makeService({
                        async generateOpening(
                            input
                        ) {
                            captured =
                                input;

                            return generationResult({
                                created:
                                    true,
                            });
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID.toUpperCase()}/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                OPENING_REQUEST_ID
                                    .toUpperCase(),
                            expectedStateVersion:
                                1,
                        }),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            201
        );

        assert.deepEqual(
            captured,
            {
                installationId:
                    INSTALLATION_ID,
                accessToken:
                    ACCESS_TOKEN,
                debateId:
                    DEBATE_ID,
                requestId:
                    OPENING_REQUEST_ID,
                expectedStateVersion:
                    1,
            }
        );

        assert.equal(
            body.success,
            true
        );

        assert.equal(
            body.created,
            true
        );

        assert.equal(
            body.requestId,
            OPENING_REQUEST_ID
        );

        assert.equal(
            body.reply.kind,
            'opening'
        );

        assert.equal(
            body.reply.scoreValue,
            null
        );
    }
);

test(
    'returns 200 for an idempotent existing opening',
    async (t) => {
        const server =
            await startServer({
                service:
                    makeService({
                        async generateOpening() {
                            return generationResult({
                                created:
                                    false,
                            });
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                OPENING_REQUEST_ID,
                            expectedStateVersion:
                                1,
                        }),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            200
        );

        assert.equal(
            body.created,
            false
        );

        assert.equal(
            body.reply.requestId,
            OPENING_REQUEST_ID
        );
    }
);

test(
    'submits a new Ranked turn and returns 201',
    async (t) => {
        let captured;

        const content =
            'A person may act wisely through habit even without examining every belief.';

        const server =
            await startServer({
                service:
                    makeService({
                        async submitTurn(
                            input
                        ) {
                            captured =
                                input;

                            return turnResult({
                                created:
                                    true,
                            });
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                TURN_REQUEST_ID,
                            expectedStateVersion:
                                2,
                            content:
                                `  ${content}  `,
                        }),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            201
        );

        assert.deepEqual(
            captured,
            {
                installationId:
                    INSTALLATION_ID,
                accessToken:
                    ACCESS_TOKEN,
                debateId:
                    DEBATE_ID,
                requestId:
                    TURN_REQUEST_ID,
                expectedStateVersion:
                    2,
                content,
            }
        );

        assert.equal(
            body.created,
            true
        );

        assert.equal(
            body.debate.roundCount,
            1
        );

        assert.equal(
            body.debate.messages.length,
            3
        );

        assert.equal(
            body.reply.role,
            'assistant'
        );
    }
);

test(
    'returns 200 for an idempotent existing turn',
    async (t) => {
        const server =
            await startServer({
                service:
                    makeService({
                        async submitTurn() {
                            return turnResult({
                                created:
                                    false,
                            });
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                TURN_REQUEST_ID,
                            expectedStateVersion:
                                2,
                            content:
                                'A valid argument.',
                        }),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            200
        );

        assert.equal(
            body.created,
            false
        );

        assert.equal(
            body.requestId,
            TURN_REQUEST_ID
        );
    }
);

test(
    'rejects a missing installation id',
    async (t) => {
        const server =
            await startServer();

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers: {
                        Authorization:
                            `Bearer ${ACCESS_TOKEN}`,
                    },
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            400
        );

        assert.equal(
            body.error.code,
            'missing_installation_id'
        );
    }
);

test(
    'rejects missing and malformed access tokens',
    async (t) => {
        const server =
            await startServer();

        t.after(
            server.close
        );

        const missing =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers: {
                        'X-Installation-ID':
                            INSTALLATION_ID,
                    },
                }
            );

        const missingBody =
            await readJson(
                missing
            );

        assert.equal(
            missing.status,
            401
        );

        assert.equal(
            missingBody.error.code,
            'missing_access_token'
        );

        const malformed =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers:
                        headers({
                            Authorization:
                                'Basic bad-token',
                        }),
                }
            );

        const malformedBody =
            await readJson(
                malformed
            );

        assert.equal(
            malformed.status,
            401
        );

        assert.equal(
            malformedBody.error.code,
            'invalid_access_token'
        );
    }
);

test(
    'rejects an invalid debate id',
    async (t) => {
        const server =
            await startServer();

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/not-a-uuid/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                OPENING_REQUEST_ID,
                            expectedStateVersion:
                                1,
                        }),
                }
            );

        const body =
            await readJson(
                response
            );

        assert.equal(
            response.status,
            400
        );

        assert.equal(
            body.error.code,
            'invalid_ranked_debate_id'
        );
    }
);

test(
    'rejects malformed opening input',
    async (t) => {
        const server =
            await startServer();

        t.after(
            server.close
        );

        const missingRequest =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            expectedStateVersion:
                                1,
                        }),
                }
            );

        const missingRequestBody =
            await readJson(
                missingRequest
            );

        assert.equal(
            missingRequest.status,
            400
        );

        assert.equal(
            missingRequestBody.error.code,
            'missing_ranked_request_id'
        );

        const invalidVersion =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                OPENING_REQUEST_ID,
                            expectedStateVersion:
                                0,
                        }),
                }
            );

        const invalidVersionBody =
            await readJson(
                invalidVersion
            );

        assert.equal(
            invalidVersion.status,
            400
        );

        assert.equal(
            invalidVersionBody.error.code,
            'invalid_ranked_state_version'
        );
    }
);

test(
    'rejects missing, empty, and oversized turn content',
    async (t) => {
        const server =
            await startServer();

        t.after(
            server.close
        );

        const requestBody = {
            requestId:
                TURN_REQUEST_ID,
            expectedStateVersion:
                2,
        };

        const missing =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify(
                            requestBody
                        ),
                }
            );

        const missingBody =
            await readJson(
                missing
            );

        assert.equal(
            missing.status,
            400
        );

        assert.equal(
            missingBody.error.code,
            'missing_ranked_turn_content'
        );

        const empty =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            ...requestBody,
                            content:
                                '   ',
                        }),
                }
            );

        const emptyBody =
            await readJson(
                empty
            );

        assert.equal(
            empty.status,
            400
        );

        assert.equal(
            emptyBody.error.code,
            'invalid_ranked_turn_content'
        );

        const oversized =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            ...requestBody,
                            content:
                                'x'.repeat(
                                    accountRankedDebateConstants
                                        .maxUserMessageLength +
                                    1
                                ),
                        }),
                }
            );

        const oversizedBody =
            await readJson(
                oversized
            );

        assert.equal(
            oversized.status,
            413
        );

        assert.equal(
            oversizedBody.error.code,
            'ranked_turn_content_too_long'
        );
    }
);

test(
    'preserves safe Ranked state-conflict details',
    async (t) => {
        const server =
            await startServer({
                service:
                    makeService({
                        async submitTurn() {
                            throw new AccountRankedDebateError(
                                'ranked_state_conflict',
                                'The Ranked debate changed before this request was applied.',
                                {
                                    status:
                                        409,
                                    retryable:
                                        true,
                                    details: {
                                        expectedStateVersion:
                                            2,
                                        currentStateVersion:
                                            3,
                                        requestId:
                                            TURN_REQUEST_ID,
                                        secret:
                                            'must-not-escape',
                                    },
                                }
                            );
                        },
                    }),
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/turns`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                TURN_REQUEST_ID,
                            expectedStateVersion:
                                2,
                            content:
                                'A valid argument.',
                        }),
                }
            );

        const text =
            await response.text();

        const body =
            JSON.parse(
                text
            );

        assert.equal(
            response.status,
            409
        );

        assert.equal(
            body.error.code,
            'ranked_state_conflict'
        );

        assert.equal(
            body.error.retryable,
            true
        );

        assert.deepEqual(
            body.error.details,
            {
                expectedStateVersion:
                    2,
                currentStateVersion:
                    3,
                requestId:
                    TURN_REQUEST_ID,
            }
        );

        assert.equal(
            text.includes(
                'must-not-escape'
            ),
            false
        );
    }
);

test(
    'preserves disabled rollout and resume states',
    async (t) => {
        const disabledServer =
            await startServer({
                service:
                    makeService({
                        async resumeActiveDebate() {
                            throw new AccountRankedDebateError(
                                'ranked_disabled',
                                'Ranked is not currently available.',
                                {
                                    status:
                                        503,
                                    retryable:
                                        false,
                                }
                            );
                        },
                    }),
            });

        t.after(
            disabledServer.close
        );

        const disabled =
            await fetch(
                `${disabledServer.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers:
                        headers(),
                }
            );

        const disabledBody =
            await readJson(
                disabled
            );

        assert.equal(
            disabled.status,
            503
        );

        assert.equal(
            disabledBody.error.code,
            'ranked_disabled'
        );

        assert.equal(
            disabledBody.error.retryable,
            false
        );

        const resumeServer =
            await startServer({
                service:
                    makeService({
                        async resumeActiveDebate() {
                            throw new AccountRankedDebateError(
                                'ranked_resume_disabled',
                                'Active Ranked debates are temporarily unavailable.',
                                {
                                    status:
                                        503,
                                    retryable:
                                        true,
                                }
                            );
                        },
                    }),
            });

        t.after(
            resumeServer.close
        );

        const resume =
            await fetch(
                `${resumeServer.baseUrl}/api/account/ranked/debates/active`,
                {
                    headers:
                        headers(),
                }
            );

        const resumeBody =
            await readJson(
                resume
            );

        assert.equal(
            resume.status,
            503
        );

        assert.equal(
            resumeBody.error.code,
            'ranked_resume_disabled'
        );

        assert.equal(
            resumeBody.error.retryable,
            true
        );
    }
);

test(
    'hides unexpected internal failures and sensitive data',
    async (t) => {
        const logs = [];

        const server =
            await startServer({
                service:
                    makeService({
                        async generateOpening() {
                            throw new Error(
                                'database password must not escape'
                            );
                        },
                    }),
                logger: {
                    error(
                        message,
                        details
                    ) {
                        logs.push({
                            message,
                            details,
                        });
                    },
                },
            });

        t.after(
            server.close
        );

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/debates/${DEBATE_ID}/opening`,
                {
                    method:
                        'POST',
                    headers:
                        headers(),
                    body:
                        JSON.stringify({
                            requestId:
                                OPENING_REQUEST_ID,
                            expectedStateVersion:
                                1,
                        }),
                }
            );

        const text =
            await response.text();

        const body =
            JSON.parse(
                text
            );

        assert.equal(
            response.status,
            503
        );

        assert.equal(
            body.error.code,
            'ranked_debate_unavailable'
        );

        assert.equal(
            body.error.retryable,
            true
        );

        assert.equal(
            text.includes(
                'database password'
            ),
            false
        );

        assert.equal(
            text.includes(
                ACCESS_TOKEN
            ),
            false
        );

        assert.equal(
            logs.length,
            1
        );

        assert.equal(
            JSON.stringify(
                logs
            ).includes(
                'database password'
            ),
            false
        );

        assert.equal(
            JSON.stringify(
                logs
            ).includes(
                ACCESS_TOKEN
            ),
            false
        );
    }
);

test(
    'rejects an invalid service at router creation',
    () => {
        assert.throws(
            () =>
                createAccountRankedDebateRouter({
                    service: {},
                }),
            /valid account Ranked debate service/
        );
    }
);
