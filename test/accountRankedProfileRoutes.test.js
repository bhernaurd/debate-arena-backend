import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import {
    AccountRankedProfileError,
} from '../lib/accountRankedProfileService.js';

import {
    createAccountRankedProfileRouter,
} from '../accountRankedProfileRoutes.js';

const INSTALLATION_ID =
    'ranked-route-installation-001';
const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN =
    'aaa.bbb.ccc';
const NOW_MS =
    Date.UTC(2026, 6, 29, 22, 30, 0);

function placementTrials() {
    const modes = [
        'guided',
        'balanced',
        'balanced',
        'relentless',
        'relentless',
    ];
    const weights = [
        1500,
        2000,
        2000,
        2000,
        2500,
    ];

    return modes.map((requiredMode, index) => ({
        trialNumber: index + 1,
        requiredMode,
        weightBasisPoints:
            weights[index],
        status: 'pending',
        rankedDebateId: null,
        philosopherId: null,
        philosopherName: null,
        topicFingerprint: null,
        finalScoreValue: null,
        weightedScoreContribution: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date(NOW_MS),
        updatedAt: new Date(NOW_MS),
    }));
}

function rankTiers() {
    return [
        ['initiate', 'Initiate'],
        ['student', 'Student'],
        ['dialectician', 'Dialectician'],
        ['logician', 'Logician'],
        ['scholar', 'Scholar'],
        ['sage', 'Sage'],
        ['philosopher', 'Philosopher'],
        ['alchemist', 'The Alchemist'],
    ].map(([key, displayName], index) => ({
        key,
        order: index + 1,
        displayName,
        supportsDivisions:
            key !== 'alchemist',
        populationLimitedCapable:
            key === 'philosopher' ||
            key === 'alchemist',
    }));
}

function bootstrapResult({
    profileCreated = true,
} = {}) {
    return {
        schemaVersion: 1,
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        bootstrappedAt:
            new Date(NOW_MS),
        profileCreated,
        configuration: {
            isEnabled: false,
            allowNewDebates: false,
            allowResumeActiveDebates: true,
            placementsEnabled: false,
            ladderEnabled: false,
            leaderboardEnabled: false,
            populationLimitsEnabled: false,
            rankedRulesVersion: null,
            philosopherPromptVersion: null,
            scoringPromptVersion: null,
            reportPromptVersion: null,
            topicGeneratorVersion: null,
            rpFormulaVersion: null,
            updatedAt:
                new Date(NOW_MS),
        },
        profile: {
            accountId: ACCOUNT_ID,
            placementStatus: 'not_started',
            placementTrialsCompleted: 0,
            placementWeightedScore: null,
            currentRankKey: null,
            currentDivision: null,
            currentRP: null,
            peakRankKey: null,
            peakDivision: null,
            peakReachedAt: null,
            demotionProtectionDebatesRemaining: 0,
            demotionProtectionReason: null,
            demotionProtectionGrantedAt: null,
            rankedDebatesCompleted: 0,
            rankedForfeits: 0,
            rankedInvalidResults: 0,
            lastRankedDebateCompletedAt: null,
            stateVersion: 1,
            createdAt:
                new Date(NOW_MS),
            updatedAt:
                new Date(NOW_MS),
        },
        placementTrials:
            placementTrials(),
        rankTiers:
            rankTiers(),
        activeDebate: null,
    };
}

function makeService(overrides = {}) {
    return {
        async bootstrapProfile() {
            return bootstrapResult();
        },
        ...overrides,
    };
}

async function startServer({
    service = makeService(),
    logger = { error() {} },
} = {}) {
    const app = express();

    app.use(
        express.json({
            limit: '50kb',
        })
    );

    app.use(
        '/api/account/ranked',
        createAccountRankedProfileRouter({
            service,
            logger,
        })
    );

    const server =
        http.createServer(app);

    await new Promise(
        (resolve, reject) => {
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
                (resolve, reject) => {
                    server.close(
                        (error) => {
                            if (error) {
                                reject(error);
                            } else {
                                resolve();
                            }
                        }
                    );
                }
            ),
    };
}

function headers(extra = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID':
            INSTALLATION_ID,
        Authorization:
            `Bearer ${ACCESS_TOKEN}`,
        ...extra,
    };
}

async function readJson(response) {
    const text =
        await response.text();

    return text
        ? JSON.parse(text)
        : null;
}

test(
    'bootstraps a new Ranked profile and returns 201',
    async (t) => {
        let captured;

        const server =
            await startServer({
                service: makeService({
                    async bootstrapProfile(input) {
                        captured = input;
                        return bootstrapResult({
                            profileCreated: true,
                        });
                    },
                }),
            });

        t.after(server.close);

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: headers(),
                    body: '{}',
                }
            );

        const body =
            await readJson(response);

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
            }
        );
        assert.equal(
            body.success,
            true
        );
        assert.equal(
            body.profileCreated,
            true
        );
        assert.equal(
            body.accountId,
            ACCOUNT_ID
        );
        assert.equal(
            body.configuration.isEnabled,
            false
        );
        assert.equal(
            body.configuration
                .allowResumeActiveDebates,
            true
        );
        assert.equal(
            body.configuration.ladderEnabled,
            false
        );
        assert.equal(
            body.profile.placementStatus,
            'not_started'
        );
        assert.equal(
            body.placementTrials.length,
            5
        );
        assert.equal(
            body.rankTiers.length,
            8
        );
        assert.equal(
            body.activeDebate,
            null
        );
        assert.equal(
            body.bootstrappedAt,
            new Date(NOW_MS).toISOString()
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
    }
);

test(
    'returns 200 when the Ranked profile already exists',
    async (t) => {
        const server =
            await startServer({
                service: makeService({
                    async bootstrapProfile() {
                        return bootstrapResult({
                            profileCreated: false,
                        });
                    },
                }),
            });

        t.after(server.close);

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: headers(),
                    body: '{}',
                }
            );

        const body =
            await readJson(response);

        assert.equal(
            response.status,
            200
        );
        assert.equal(
            body.profileCreated,
            false
        );
    }
);

test(
    'rejects a missing installation id',
    async (t) => {
        const server =
            await startServer();

        t.after(server.close);

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                        Authorization:
                            `Bearer ${ACCESS_TOKEN}`,
                    },
                    body: '{}',
                }
            );

        const body =
            await readJson(response);

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
    'rejects a missing or malformed access token',
    async (t) => {
        const server =
            await startServer();

        t.after(server.close);

        const missing =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/json',
                        'X-Installation-ID':
                            INSTALLATION_ID,
                    },
                    body: '{}',
                }
            );

        const missingBody =
            await readJson(missing);

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
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: headers({
                        Authorization:
                            'Basic not-a-token',
                    }),
                    body: '{}',
                }
            );

        const malformedBody =
            await readJson(malformed);

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
    'maps public Ranked profile service errors',
    async (t) => {
        const server =
            await startServer({
                service: makeService({
                    async bootstrapProfile() {
                        throw new AccountRankedProfileError(
                            'invalid_access_token',
                            'The Agora account session is invalid or expired.',
                            {
                                status: 401,
                            }
                        );
                    },
                }),
            });

        t.after(server.close);

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: headers(),
                    body: '{}',
                }
            );

        const body =
            await readJson(response);

        assert.equal(
            response.status,
            401
        );
        assert.equal(
            body.error.code,
            'invalid_access_token'
        );
    }
);

test(
    'hides internal Ranked profile failures',
    async (t) => {
        const logs = [];

        const server =
            await startServer({
                service: makeService({
                    async bootstrapProfile() {
                        throw new Error(
                            'database password must not escape'
                        );
                    },
                }),
                logger: {
                    error(message, details) {
                        logs.push({
                            message,
                            details,
                        });
                    },
                },
            });

        t.after(server.close);

        const response =
            await fetch(
                `${server.baseUrl}/api/account/ranked/profile/bootstrap`,
                {
                    method: 'POST',
                    headers: headers(),
                    body: '{}',
                }
            );

        const text =
            await response.text();
        const body =
            JSON.parse(text);

        assert.equal(
            response.status,
            503
        );
        assert.equal(
            body.error.code,
            'ranked_profile_unavailable'
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
            logs.length,
            1
        );
        assert.equal(
            JSON.stringify(logs).includes(
                'database password'
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
                createAccountRankedProfileRouter({
                    service: {},
                }),
            /valid account Ranked profile service/
        );
    }
);
