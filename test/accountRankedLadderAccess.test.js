import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import express from 'express';

import {
    AccountRankedLadderError,
    createAccountRankedLadderService,
} from '../lib/accountRankedLadderService.js';
import {
    createAccountRankedLadderRouter,
} from '../accountRankedLadderRoutes.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'installation-1234';

function profileRow() {
    return {
        account_id: ACCOUNT_ID,
        placement_status: 'completed',
        placement_trials_completed: 5,
        placement_weighted_score: 8.2,
        current_rank_key: 'student',
        current_division: 2,
        current_rp: 45,
        peak_rank_key: 'student',
        peak_division: 2,
        peak_reached_at: new Date('2026-09-01T00:00:00.000Z'),
        demotion_protection_debates_remaining: 0,
        demotion_protection_reason: null,
        ranked_debates_completed: 3,
        ranked_forfeits: 0,
        ranked_invalid_results: 0,
        state_version: 4,
        updated_at: new Date('2026-09-01T00:00:00.000Z'),
    };
}

function configurationRow() {
    return {
        configuration_key: 'global',
        is_enabled: true,
        allow_new_debates: true,
        allow_resume_active_debates: true,
        placements_enabled: true,
        ladder_enabled: true,
        ranked_rules_version: 'ranked-v1',
        philosopher_prompt_version: 'philosopher-v1',
        scoring_prompt_version: 'score-v1',
        report_prompt_version: 'report-v1',
        topic_generator_version: 'topic-v1',
        rp_formula_version: 'rp-v1',
        debate_model_provider: 'anthropic',
        debate_model_name: 'test-model',
    };
}

function repository({ dailyUsed = false } = {}) {
    return {
        async withTransaction(operation) { return operation({}); },
        async lockProfile() { return profileRow(); },
        async loadConfiguration() { return configurationRow(); },
        async findStartRequestForUpdate() { return null; },
        async findOtherInFlightRequestForUpdate() { return null; },
        async findActiveDebate() { return null; },
        async findDebateByStartRequest() { return null; },
        async loadDailyChallenge() {
            return {
                philosopher_id: 'socrates',
                philosopher_name: 'Socrates',
            };
        },
        async hasLadderDebateInWindow() { return dailyUsed; },
        async listRecentTopics() { return []; },
        async insertStartRequest() { throw new Error('not expected'); },
        async reviveStartRequest() { throw new Error('not expected'); },
        async markStartRequestFailed() { return true; },
        async storeGeneratedTopic() { throw new Error('not expected'); },
        async insertLadderDebate() { throw new Error('not expected'); },
        async completeStartRequest() { throw new Error('not expected'); },
    };
}

function service({ isPro = false, dailyUsed = false, now } = {}) {
    return createAccountRankedLadderService({
        repository: repository({ dailyUsed }),
        accountAuthService: {
            async authorizeAccessToken() {
                return { accountId: ACCOUNT_ID, installationId: INSTALLATION_ID };
            },
        },
        proAccessService: {
            async getCurrentAccess() {
                return { accountId: ACCOUNT_ID, hasProAccess: isPro };
            },
        },
        topicGeneratorService: {
            async generateTopic() { throw new Error('not expected'); },
        },
        ratingService: {
            previewForfeit() { return { rpLoss: 5 }; },
        },
        now,
    });
}

async function startRouteServer(routeService) {
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(
        '/api/account/ranked',
        createAccountRankedLadderRouter({
            service: routeService,
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
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

test('free access exposes the Daily Philosopher and one available match', async () => {
    const ranked = service({
        now: () => new Date('2026-09-09T15:00:00.000Z'),
    });
    const result = await ranked.getRankedAccess({
        installationId: INSTALLATION_ID,
        accessToken: 'token',
        timezone: 'America/Chicago',
    });

    assert.equal(result.access.tier, 'free');
    assert.equal(result.access.isPro, false);
    assert.equal(result.access.challengeDate, '2026-09-09');
    assert.equal(result.access.dailyPhilosopherId, 'socrates');
    assert.equal(result.access.dailyPhilosopherName, 'Socrates');
    assert.equal(result.access.freeLadderStartAvailable, true);
    assert.equal(result.access.windowStartsAt.toISOString(), '2026-09-09T10:00:00.000Z');
    assert.equal(result.access.windowExpiresAt.toISOString(), '2026-09-10T10:00:00.000Z');
});

test('the Ranked day rolls over at 5 AM in the supplied IANA timezone', async () => {
    const ranked = service({
        now: () => new Date('2026-09-09T09:59:59.000Z'),
    });
    const result = await ranked.getRankedAccess({
        installationId: INSTALLATION_ID,
        accessToken: 'token',
        timezone: 'America/Chicago',
    });

    assert.equal(result.access.challengeDate, '2026-09-08');
    assert.equal(result.access.windowStartsAt.toISOString(), '2026-09-08T10:00:00.000Z');
    assert.equal(result.access.windowExpiresAt.toISOString(), '2026-09-09T10:00:00.000Z');
});

test('a completed free match is unavailable until the next Ranked day', async () => {
    const ranked = service({
        dailyUsed: true,
        now: () => new Date('2026-09-09T15:00:00.000Z'),
    });
    const result = await ranked.getRankedAccess({
        installationId: INSTALLATION_ID,
        accessToken: 'token',
        timezone: 'America/Chicago',
    });

    assert.equal(result.access.freeLadderStartAvailable, false);
});

test('Pro access remains unlimited and does not expose a free-match allowance', async () => {
    const ranked = service({
        isPro: true,
        dailyUsed: true,
        now: () => new Date('2026-09-09T15:00:00.000Z'),
    });
    const result = await ranked.getRankedAccess({
        installationId: INSTALLATION_ID,
        accessToken: 'token',
        timezone: 'America/Chicago',
    });

    assert.equal(result.access.tier, 'pro');
    assert.equal(result.access.isPro, true);
    assert.equal(result.access.freeLadderStartAvailable, false);
});

test('a free ladder start rejects any philosopher other than the Daily Philosopher', async () => {
    const ranked = service({
        now: () => new Date('2026-09-09T15:00:00.000Z'),
    });

    await assert.rejects(
        ranked.startLadderDebate({
            installationId: INSTALLATION_ID,
            accessToken: 'token',
            requestId: '22222222-2222-4222-8222-222222222222',
            philosopherId: 'plato',
            debateMode: 'guided',
            timezone: 'America/Chicago',
        }),
        (error) => {
            assert.ok(error instanceof AccountRankedLadderError);
            assert.equal(error.code, 'ranked_daily_philosopher_required');
            assert.equal(error.status, 403);
            return true;
        }
    );
});

test('invalid timezones fail before access is evaluated', async () => {
    const ranked = service({ now: () => new Date('2026-09-09T15:00:00.000Z') });

    await assert.rejects(
        ranked.getRankedAccess({
            installationId: INSTALLATION_ID,
            accessToken: 'token',
            timezone: 'Not/A_Timezone',
        }),
        (error) => error.code === 'invalid_ranked_timezone' && error.status === 400
    );
});

test('POST /access forwards authentication and returns the exact mobile contract', async (t) => {
    let captured;
    const routeService = {
        async getRankedAccess(input) {
            captured = input;
            return {
                schemaVersion: 1,
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
                access: {
                    tier: 'free',
                    isPro: false,
                    timeZone: 'America/Chicago',
                    challengeDate: '2026-09-09',
                    dailyPhilosopherId: 'socrates',
                    dailyPhilosopherName: 'Socrates',
                    freeLadderStartAvailable: true,
                    windowStartsAt: new Date('2026-09-09T10:00:00.000Z'),
                    windowExpiresAt: new Date('2026-09-10T10:00:00.000Z'),
                },
            };
        },
        async startLadderDebate() {
            throw new Error('not expected');
        },
    };
    const server = await startRouteServer(routeService);
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/api/account/ranked/access`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Installation-ID': INSTALLATION_ID,
            Authorization: 'Bearer aaa.bbb.ccc',
        },
        body: JSON.stringify({ timezone: 'America/Chicago' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(captured, {
        installationId: INSTALLATION_ID,
        accessToken: 'aaa.bbb.ccc',
        timezone: 'America/Chicago',
    });
    assert.deepEqual(await response.json(), {
        success: true,
        schemaVersion: 1,
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        access: {
            tier: 'free',
            isPro: false,
            timezone: 'America/Chicago',
            challengeDate: '2026-09-09',
            dailyPhilosopherId: 'socrates',
            dailyPhilosopherName: 'Socrates',
            freeLadderStartAvailable: true,
            windowStartsAt: '2026-09-09T10:00:00.000Z',
            windowExpiresAt: '2026-09-10T10:00:00.000Z',
        },
    });
});
