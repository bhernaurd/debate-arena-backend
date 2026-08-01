import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    AccountRankedProfileError,
    accountRankedProfileConstants,
    createAccountRankedProfileService,
} from '../lib/accountRankedProfileService.js';

const ACCOUNT_ID =
    '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'install-device-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const NOW_MS = Date.UTC(2026, 6, 29, 22, 30, 0);

function cloneState(state) {
    return structuredClone(state);
}

function rankTiers() {
    return [
        ['initiate', 1, 'Initiate', true, false],
        ['student', 2, 'Student', true, false],
        ['dialectician', 3, 'Dialectician', true, false],
        ['logician', 4, 'Logician', true, false],
        ['scholar', 5, 'Scholar', true, false],
        ['sage', 6, 'Sage', true, false],
        ['philosopher', 7, 'Philosopher', true, true],
        ['alchemist', 8, 'The Alchemist', false, true],
    ].map((item) => ({
        rank_key: item[0],
        rank_order: item[1],
        display_name: item[2],
        supports_divisions: item[3],
        population_limited_capable: item[4],
    }));
}

class MemoryRankedProfileRepository {
    constructor() {
        this.state = {
            profiles: new Map(),
            trials: new Map(),
            activeDebates: new Map(),
        };

        this.configuration = {
            configuration_key: 'global',
            is_enabled: false,
            allow_new_debates: false,
            allow_resume_active_debates: true,
            placements_enabled: false,
            ladder_enabled: false,
            leaderboard_enabled: false,
            population_limits_enabled: false,
            ranked_rules_version: null,
            philosopher_prompt_version: null,
            scoring_prompt_version: null,
            report_prompt_version: null,
            topic_generator_version: null,
            rp_formula_version: null,
            updated_at: new Date(NOW_MS),
        };

        this.tiers = rankTiers();
    }

    async withTransaction(work) {
        const transaction = {
            state: cloneState(this.state),
        };

        const result = await work(transaction);
        this.state = transaction.state;
        return result;
    }

    async ensureProfile(
        transaction,
        {
            accountId,
            bootstrappedAt,
        }
    ) {
        if (transaction.state.profiles.has(accountId)) {
            return false;
        }

        transaction.state.profiles.set(accountId, {
            account_id: accountId,
            placement_status: 'not_started',
            placement_trials_completed: 0,
            placement_weighted_score: null,
            current_rank_key: null,
            current_division: null,
            current_rp: null,
            peak_rank_key: null,
            peak_division: null,
            peak_reached_at: null,
            demotion_protection_debates_remaining: 0,
            demotion_protection_reason: null,
            demotion_protection_granted_at: null,
            ranked_debates_completed: 0,
            ranked_forfeits: 0,
            ranked_invalid_results: 0,
            last_ranked_debate_completed_at: null,
            state_version: 1,
            created_at: new Date(bootstrappedAt),
            updated_at: new Date(bootstrappedAt),
        });

        return true;
    }

    async ensurePlacementTrials(
        transaction,
        {
            accountId,
            bootstrappedAt,
        }
    ) {
        for (
            const trial of
                accountRankedProfileConstants.placementSequence
        ) {
            const key = `${accountId}:${trial.trialNumber}`;

            if (transaction.state.trials.has(key)) {
                continue;
            }

            transaction.state.trials.set(key, {
                account_id: accountId,
                trial_number: trial.trialNumber,
                required_mode: trial.requiredMode,
                weight_basis_points:
                    trial.weightBasisPoints,
                status: 'pending',
                ranked_debate_id: null,
                philosopher_id: null,
                philosopher_name: null,
                topic_fingerprint: null,
                final_score_value: null,
                weighted_score_contribution: null,
                started_at: null,
                completed_at: null,
                created_at: new Date(bootstrappedAt),
                updated_at: new Date(bootstrappedAt),
            });
        }
    }

    async loadSnapshot(transaction, { accountId }) {
        return {
            configuration: structuredClone(
                this.configuration
            ),
            profile: structuredClone(
                transaction.state.profiles.get(accountId)
            ),
            placementTrials: [
                ...transaction.state.trials.values(),
            ]
                .filter(
                    (trial) =>
                        trial.account_id === accountId
                )
                .sort(
                    (left, right) =>
                        left.trial_number -
                        right.trial_number
                ),
            rankTiers: structuredClone(this.tiers),
            activeDebate: structuredClone(
                transaction.state.activeDebates.get(accountId) ??
                    null
            ),
        };
    }
}

function makeFixture({ repository } = {}) {
    const repo =
        repository ??
        new MemoryRankedProfileRepository();
    const authorizationCalls = [];

    const accountAuthService = {
        async authorizeAccessToken(input) {
            authorizationCalls.push(input);

            return {
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
                sessionId:
                    '22222222-2222-4222-8222-222222222222',
                authVersion: 1,
            };
        },
    };

    const service = createAccountRankedProfileService({
        repository: repo,
        accountAuthService,
        now: () => NOW_MS,
    });

    return {
        repository: repo,
        authorizationCalls,
        service,
    };
}

function expectRankedError(code, status) {
    return (error) => {
        assert.ok(error instanceof AccountRankedProfileError);
        assert.equal(error.code, code);

        if (status != null) {
            assert.equal(error.status, status);
        }

        return true;
    };
}

test('bootstraps a new account-owned Ranked profile and fixed five-trial placement sequence', async () => {
    const fixture = makeFixture();

    const result = await fixture.service.bootstrapProfile({
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.installationId, INSTALLATION_ID);
    assert.equal(result.profileCreated, true);
    assert.equal(result.bootstrappedAt.getTime(), NOW_MS);

    assert.equal(result.configuration.isEnabled, false);
    assert.equal(
        result.configuration.allowNewDebates,
        false
    );
    assert.equal(
        result.configuration.allowResumeActiveDebates,
        true
    );
    assert.equal(
        result.configuration.placementsEnabled,
        false
    );
    assert.equal(
        result.configuration.ladderEnabled,
        false
    );

    assert.equal(
        result.profile.placementStatus,
        'not_started'
    );
    assert.equal(
        result.profile.placementTrialsCompleted,
        0
    );
    assert.equal(result.profile.currentRankKey, null);
    assert.equal(result.profile.currentRP, null);

    assert.deepEqual(
        result.placementTrials.map((trial) => [
            trial.trialNumber,
            trial.requiredMode,
            trial.weightBasisPoints,
            trial.status,
        ]),
        [
            [1, 'guided', 1500, 'pending'],
            [2, 'balanced', 2000, 'pending'],
            [3, 'balanced', 2000, 'pending'],
            [4, 'relentless', 2000, 'pending'],
            [5, 'relentless', 2500, 'pending'],
        ]
    );

    assert.equal(result.rankTiers.length, 8);
    assert.deepEqual(
        result.rankTiers.map((tier) => tier.key),
        [
            'initiate',
            'student',
            'dialectician',
            'logician',
            'scholar',
            'sage',
            'philosopher',
            'alchemist',
        ]
    );
    assert.equal(result.activeDebate, null);

    assert.deepEqual(fixture.authorizationCalls, [
        {
            installationId: INSTALLATION_ID,
            accessToken: ACCESS_TOKEN,
        },
    ]);
});

test('bootstrap is idempotent and never duplicates placement trials', async () => {
    const fixture = makeFixture();

    const first = await fixture.service.bootstrapProfile({
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });
    const second = await fixture.service.bootstrapProfile({
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });

    assert.equal(first.profileCreated, true);
    assert.equal(second.profileCreated, false);
    assert.equal(
        fixture.repository.state.profiles.size,
        1
    );
    assert.equal(
        fixture.repository.state.trials.size,
        5
    );
    assert.deepEqual(
        second.placementTrials.map(
            (trial) => trial.trialNumber
        ),
        [1, 2, 3, 4, 5]
    );
});

test('returns an existing active Ranked debate summary without starting a new debate', async () => {
    const fixture = makeFixture();

    await fixture.service.bootstrapProfile({
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });

    fixture.repository.state.activeDebates.set(
        ACCOUNT_ID,
        {
            id: crypto.randomUUID(),
            account_id: ACCOUNT_ID,
            debate_kind: 'placement',
            placement_trial_number: 1,
            status: 'active',
            philosopher_id: 'socrates',
            philosopher_name: 'Socrates',
            debate_mode: 'guided',
            topic: 'What makes a belief worth defending?',
            current_score_text: '7.0',
            current_score_value: 7,
            round_count: 2,
            last_activity_at: new Date(NOW_MS),
            state_version: 3,
        }
    );

    const result = await fixture.service.bootstrapProfile({
        installationId: INSTALLATION_ID,
        accessToken: ACCESS_TOKEN,
    });

    assert.equal(
        result.activeDebate.philosopherName,
        'Socrates'
    );
    assert.equal(result.activeDebate.debateMode, 'guided');
    assert.equal(result.activeDebate.roundCount, 2);
    assert.equal(result.activeDebate.stateVersion, 3);
});

test('maps account authorization failures without exposing implementation details', async () => {
    const repository = new MemoryRankedProfileRepository();

    const service = createAccountRankedProfileService({
        repository,
        accountAuthService: {
            async authorizeAccessToken() {
                const error = new Error('secret token detail');
                error.code = 'invalid_access_token';
                error.status = 401;
                throw error;
            },
        },
        now: () => NOW_MS,
    });

    await assert.rejects(
        () => service.bootstrapProfile({
            installationId: INSTALLATION_ID,
            accessToken: ACCESS_TOKEN,
        }),
        (error) => {
            assert.ok(
                error instanceof AccountRankedProfileError
            );
            assert.equal(error.code, 'invalid_access_token');
            assert.equal(error.status, 401);
            assert.equal(
                error.message.includes('secret token detail'),
                false
            );
            return true;
        }
    );
});

test('rejects malformed installation identifiers before authorization', async () => {
    const fixture = makeFixture();

    await assert.rejects(
        () => fixture.service.bootstrapProfile({
            installationId: 'bad',
            accessToken: ACCESS_TOKEN,
        }),
        expectRankedError(
            'invalid_ranked_profile_request',
            400
        )
    );

    assert.equal(fixture.authorizationCalls.length, 0);
});

test('rejects an incomplete or corrupted placement sequence', async () => {
    const repository = new MemoryRankedProfileRepository();
    const originalLoadSnapshot =
        repository.loadSnapshot.bind(repository);

    repository.loadSnapshot = async (...args) => {
        const snapshot = await originalLoadSnapshot(...args);
        snapshot.placementTrials =
            snapshot.placementTrials.slice(0, 4);
        return snapshot;
    };

    const fixture = makeFixture({ repository });

    await assert.rejects(
        () => fixture.service.bootstrapProfile({
            installationId: INSTALLATION_ID,
            accessToken: ACCESS_TOKEN,
        }),
        expectRankedError(
            'ranked_profile_unavailable',
            503
        )
    );

    assert.equal(
        fixture.repository.state.profiles.size,
        0,
        'the transaction must roll back when snapshot validation fails'
    );
    assert.equal(
        fixture.repository.state.trials.size,
        0,
        'placement trial inserts must roll back with the profile'
    );
});
