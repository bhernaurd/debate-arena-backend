import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    createAccountRankedLadderRouter,
} from '../accountRankedLadderRoutes.js';

const INSTALLATION_ID = 'ranked-access-route-installation-001';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';
const DEBATE_ID = '33333333-3333-4333-8333-333333333333';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const NOW = new Date('2026-09-08T18:00:00.000Z');

function configuration() {
    return {
        isEnabled: true,
        allowNewDebates: true,
        allowResumeActiveDebates: true,
        placementsEnabled: true,
        ladderEnabled: true,
        rankedRulesVersion: 'ranked-rules-v1',
        philosopherPromptVersion: 'philosopher-v1',
        scoringPromptVersion: 'scoring-v1',
        reportPromptVersion: 'report-v1',
        topicGeneratorVersion: 'ranked-topic-v2-kierkegaard',
        rpFormulaVersion: 'rp-v1',
        debateModelProvider: 'anthropic',
        debateModelName: 'claude-sonnet',
    };
}

function profile() {
    return {
        accountId: ACCOUNT_ID,
        placementStatus: 'completed',
        placementTrialsCompleted: 5,
        placementWeightedScore: 7.2,
        currentRankKey: 'student',
        currentDivision: 3,
        currentRP: 42,
        peakRankKey: 'student',
        peakDivision: 3,
        peakReachedAt: NOW,
        demotionProtectionDebatesRemaining: 0,
        demotionProtectionReason: null,
        rankedDebatesCompleted: 8,
        rankedForfeits: 0,
        rankedInvalidResults: 0,
        stateVersion: 9,
        updatedAt: NOW,
    };
}

function debate() {
    return {
        id: DEBATE_ID,
        accountId: ACCOUNT_ID,
        startRequestId: REQUEST_ID,
        debateKind: 'ladder',
        placementTrialNumber: null,
        status: 'active',
        philosopherId: 'socrates',
        philosopherName: 'Socrates',
        debateMode: 'balanced',
        topic: 'What does it mean to know yourself?',
        displayTopic: null,
        languageCode: 'en',
        topicFingerprint: 'a'.repeat(64),
        topicTheme: 'self-knowledge',
        topicModelProvider: 'anthropic',
        topicModelName: 'claude-sonnet',
        topicGeneratedAt: NOW,
        messages: [],
        pendingGeneration: null,
        currentScoreText: null,
        currentScoreValue: null,
        finalScoreText: null,
        finalScoreValue: null,
        roundCount: 0,
        startingRankKey: 'student',
        startingDivision: 3,
        startingRP: 42,
        forfeitRPLossPreview: 8,
        rpDelta: null,
        endingRankKey: null,
        endingDivision: null,
        endingRP: null,
        promoted: false,
        demoted: false,
        protectionApplied: false,
        protectionConsumed: false,
        rankedRulesVersion: 'ranked-rules-v1',
        philosopherPromptVersion: 'philosopher-v1',
        scoringPromptVersion: 'scoring-v1',
        reportPromptVersion: 'report-v1',
        topicGeneratorVersion: 'ranked-topic-v2-kierkegaard',
        rpFormulaVersion: 'rp-v1',
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet',
        stateVersion: 1,
        startedAt: NOW,
        lastActivityAt: NOW,
        completedAt: null,
        updatedAt: NOW,
    };
}

function ladderResult() {
    return {
        schemaVersion: 1,
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        requestId: REQUEST_ID,
        created: true,
        configuration: configuration(),
        profile: profile(),
        activeDebate: debate(),
    };
}

function accessSummary({ isPro = false, available = true } = {}) {
    return {
        tier: isPro ? 'pro' : 'free',
        isPro,
        timezone: 'America/Chicago',
        challengeDate: '2026-09-08',
        dailyPhilosopherId: 'socrates',
        dailyPhilosopherName: 'Socrates',
        freeLadderStartAvailable: available,
        windowStartsAt: '2026-09-08T10:00:00.000Z',
        windowExpiresAt: '2026-09-09T09:59:59.000Z',
    };
}

function makeService(overrides = {}) {
    return {
        async startLadderDebate() {
            return ladderResult();
        },
        ...overrides,
    };
}

function makeAccessPolicy(overrides = {}) {
    return {
        async authorizeAndGetAccess() {
            return {
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
                access: accessSummary(),
            };
        },
        async authorizeAndReserveLadderStart() {
            return {
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
                reservation: {
                    tier: 'free',
                    isPro: false,
                    reserved: true,
                    challengeDate: '2026-09-08',
                },
            };
        },
        ...overrides,
    };
}

async function startServer({
    service = makeService(),
    accessPolicy = makeAccessPolicy(),
    freeAccessEnabled,
} = {}) {
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account/ranked',
        createAccountRankedLadderRouter({
            service,
            accessPolicy,
            freeAccessEnabled,
            logger: { error() {} },
        })
    );

    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        }),
    };
}

function headers() {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
    };
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test(
    'feature flag off preserves the existing ladder start path without consulting free-access policy',
    async (t) => {
        let policyCalls = 0;
        let capturedStart = null;

        const server = await startServer({
            freeAccessEnabled: false,
            accessPolicy: makeAccessPolicy({
                async authorizeAndReserveLadderStart() {
                    policyCalls += 1;
                    throw new Error('must not be called');
                },
            }),
            service: makeService({
                async startLadderDebate(input) {
                    capturedStart = input;
                    return ladderResult();
                },
            }),
        });
        t.after(server.close);

        const response = await fetch(
            `${server.baseUrl}/api/account/ranked/ladder/start`,
            {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                    requestId: REQUEST_ID,
                    philosopherId: 'socrates',
                    debateMode: 'balanced',
                }),
            }
        );

        assert.equal(response.status, 201);
        assert.equal(policyCalls, 0);
        assert.equal(capturedStart.installationId, INSTALLATION_ID);
        assert.equal(capturedStart.accessToken, ACCESS_TOKEN);
        assert.equal(capturedStart.requestId, REQUEST_ID);
        assert.equal(capturedStart.philosopherId, 'socrates');
        assert.equal(capturedStart.debateMode, 'balanced');
    }
);

test(
    'feature flag on reserves free access before starting a ladder debate and forwards timezone',
    async (t) => {
        const order = [];
        let capturedReservation = null;

        const server = await startServer({
            freeAccessEnabled: true,
            accessPolicy: makeAccessPolicy({
                async authorizeAndReserveLadderStart(input) {
                    order.push('reserve');
                    capturedReservation = input;
                    return {
                        accountId: ACCOUNT_ID,
                        installationId: INSTALLATION_ID,
                        reservation: {
                            tier: 'free',
                            isPro: false,
                            reserved: true,
                            challengeDate: '2026-09-08',
                        },
                    };
                },
            }),
            service: makeService({
                async startLadderDebate() {
                    order.push('start');
                    return ladderResult();
                },
            }),
        });
        t.after(server.close);

        const response = await fetch(
            `${server.baseUrl}/api/account/ranked/ladder/start`,
            {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                    requestId: REQUEST_ID,
                    philosopherId: 'socrates',
                    debateMode: 'balanced',
                    timezone: 'America/Chicago',
                }),
            }
        );

        assert.equal(response.status, 201);
        assert.deepEqual(order, ['reserve', 'start']);
        assert.equal(capturedReservation.requestId, REQUEST_ID);
        assert.equal(capturedReservation.philosopherId, 'socrates');
        assert.equal(capturedReservation.timezone, 'America/Chicago');
    }
);

test(
    'access endpoint stays closed for free ladder starts until rollout flag is enabled',
    async (t) => {
        const server = await startServer({
            freeAccessEnabled: false,
            accessPolicy: makeAccessPolicy({
                async authorizeAndGetAccess() {
                    return {
                        accountId: ACCOUNT_ID,
                        installationId: INSTALLATION_ID,
                        access: accessSummary({
                            isPro: false,
                            available: true,
                        }),
                    };
                },
            }),
        });
        t.after(server.close);

        const response = await fetch(
            `${server.baseUrl}/api/account/ranked/access`,
            {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                    timezone: 'America/Chicago',
                }),
            }
        );
        const body = await readJson(response);

        assert.equal(response.status, 200);
        assert.equal(body.access.tier, 'free');
        assert.equal(body.access.isPro, false);
        assert.equal(body.access.freeLadderStartAvailable, false);
    }
);

test(
    'access endpoint exposes the free daily start only after rollout flag is enabled',
    async (t) => {
        const server = await startServer({
            freeAccessEnabled: true,
            accessPolicy: makeAccessPolicy({
                async authorizeAndGetAccess() {
                    return {
                        accountId: ACCOUNT_ID,
                        installationId: INSTALLATION_ID,
                        access: accessSummary({
                            isPro: false,
                            available: true,
                        }),
                    };
                },
            }),
        });
        t.after(server.close);

        const response = await fetch(
            `${server.baseUrl}/api/account/ranked/access`,
            {
                method: 'POST',
                headers: headers(),
                body: JSON.stringify({
                    timezone: 'America/Chicago',
                }),
            }
        );
        const body = await readJson(response);

        assert.equal(response.status, 200);
        assert.equal(body.access.freeLadderStartAvailable, true);
        assert.equal(body.access.dailyPhilosopherId, 'socrates');
    }
);