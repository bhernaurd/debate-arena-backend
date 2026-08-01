import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountRankedPlacementError,
    createAccountRankedPlacementService,
} from '../lib/accountRankedPlacementService.js';

const ACCOUNT_ID = '59fe07dc-6463-4232-8308-b63ee14afffc';
const REQUEST_ID = 'f6757413-b618-45ee-95ad-fb3eff3c0f94';
const OTHER_REQUEST_ID = 'd604c74f-54be-4e45-b2bb-4ba47b4c883a';
const DEBATE_ID = '82bdf6cb-aa4e-4930-b6c7-c31b87f3cafe';
const INSTALLATION_ID = 'ABCDEF12-3456-7890';
const NOW = new Date('2026-07-30T05:00:00.000Z');

function configuration(overrides = {}) {
    return {
        configuration_key: 'global',
        is_enabled: true,
        allow_new_debates: true,
        allow_resume_active_debates: true,
        placements_enabled: true,
        ranked_rules_version: 'ranked-rules-v1',
        philosopher_prompt_version: 'philosopher-prompts-v1',
        scoring_prompt_version: 'ranked-scoring-v1',
        report_prompt_version: 'ranked-report-v1',
        topic_generator_version: 'ranked-topic-v1',
        rp_formula_version: 'ranked-rp-v1',
        debate_model_provider: 'anthropic',
        debate_model_name: 'claude-sonnet-4-5-20250929',
        ...overrides,
    };
}

function profile(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        placement_status: 'not_started',
        placement_trials_completed: 0,
        state_version: 1,
        updated_at: NOW,
        ...overrides,
    };
}

function trial(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        trial_number: 1,
        required_mode: 'guided',
        weight_basis_points: 1500,
        status: 'pending',
        ranked_debate_id: null,
        philosopher_id: null,
        philosopher_name: null,
        topic_fingerprint: null,
        started_at: null,
        updated_at: NOW,
        ...overrides,
    };
}

function requestRow(overrides = {}) {
    return {
        account_id: ACCOUNT_ID,
        request_id: REQUEST_ID,
        debate_kind: 'placement',
        placement_trial_number: 1,
        philosopher_id: 'socrates',
        philosopher_name: 'Socrates',
        debate_mode: 'guided',
        status: 'reserved',
        failure_code: null,
        failure_retryable: null,
        attempt_count: 1,
        created_at: NOW,
        updated_at: NOW,
        completed_at: null,
        ...overrides,
    };
}

function debate(overrides = {}) {
    return {
        id: DEBATE_ID,
        account_id: ACCOUNT_ID,
        start_request_id: REQUEST_ID,
        debate_kind: 'placement',
        placement_trial_number: 1,
        status: 'active',
        philosopher_id: 'socrates',
        philosopher_name: 'Socrates',
        debate_mode: 'guided',
        topic: 'Can a person live well while refusing to examine their deepest beliefs?',
        topic_fingerprint: 'a'.repeat(64),
        topic_theme: 'self-examination',
        topic_model_provider: 'anthropic',
        topic_model_name: 'claude-haiku-4-5-20251001',
        topic_generated_at: NOW,
        model_provider: 'anthropic',
        model_name: 'claude-sonnet-4-5-20250929',
        state_version: 1,
        started_at: NOW,
        last_activity_at: NOW,
        ...overrides,
    };
}

function generatedTopic(overrides = {}) {
    return {
        philosopherId: 'socrates',
        philosopherName: 'Socrates',
        debateMode: 'guided',
        topic: 'Can a person live well while refusing to examine their deepest beliefs?',
        openingQuestion: 'What kind of life do you call good if you refuse to examine the beliefs directing it?',
        topicNormalized: 'can person live well while refusing examine deepest beliefs',
        topicFingerprint: 'a'.repeat(64),
        theme: 'self-examination',
        model: 'claude-haiku-4-5-20251001',
        generatorVersion: 'ranked-topic-v1',
        generatedAt: NOW,
        ...overrides,
    };
}

function createStatefulRepository(options = {}) {
    const state = {
        configuration: configuration(options.configuration),
        profile: profile(options.profile),
        trial: trial(options.trial),
        request: options.request ?? null,
        activeDebate: options.activeDebate ?? null,
        otherInFlight: options.otherInFlight ?? null,
        usedPhilosophers: options.usedPhilosophers ?? [],
        recentTopics: options.recentTopics ?? [],
        markedFailures: [],
        transactionCount: 0,
        generatedTopicStored: false,
        completed: false,
    };

    const repository = {
        async withTransaction(work) {
            state.transactionCount += 1;
            return work({});
        },
        async ensureFoundation() {},
        async lockProfile() {
            return state.profile;
        },
        async loadConfiguration() {
            return state.configuration;
        },
        async findStartRequestForUpdate() {
            return state.request;
        },
        async findOtherInFlightRequestForUpdate() {
            return state.otherInFlight;
        },
        async findActiveDebate() {
            return state.activeDebate;
        },
        async findDebateByStartRequest() {
            return state.activeDebate;
        },
        async findNextPendingTrialForUpdate() {
            return state.trial;
        },
        async findTrialByNumber() {
            return state.trial;
        },
        async findActiveTrial() {
            return options.activeTrial ?? null;
        },
        async listUsedPhilosopherIds() {
            return state.usedPhilosophers;
        },
        async listRecentTopics() {
            return state.recentTopics;
        },
        async insertStartRequest() {
            state.request = requestRow();
            return state.request;
        },
        async reviveStartRequest() {
            state.request = requestRow({
                attempt_count: Number(state.request?.attempt_count ?? 1) + 1,
                updated_at: NOW,
            });
            return state.request;
        },
        async markStartRequestFailed(_client, values) {
            state.markedFailures.push(values);

            if (
                state.request &&
                state.request.request_id === values.requestId
            ) {
                state.request = {
                    ...state.request,
                    status: 'failed',
                    failure_code: values.failureCode,
                    failure_retryable: values.failureRetryable,
                    completed_at: NOW,
                    updated_at: NOW,
                };
            }

            if (
                state.otherInFlight &&
                state.otherInFlight.request_id === values.requestId
            ) {
                state.otherInFlight = null;
            }

            return true;
        },
        async storeGeneratedTopic() {
            state.generatedTopicStored = true;
            state.request = {
                ...state.request,
                status: 'topic_generated',
            };
            return { topic_generated_at: NOW };
        },
        async insertPlacementDebate() {
            state.activeDebate = debate();
            return state.activeDebate;
        },
        async activatePlacementTrial() {
            state.trial = trial({
                status: 'active',
                ranked_debate_id: DEBATE_ID,
                philosopher_id: 'socrates',
                philosopher_name: 'Socrates',
                topic_fingerprint: 'a'.repeat(64),
                started_at: NOW,
            });
            return state.trial;
        },
        async markProfilePlacementStarted() {
            state.profile = profile({
                placement_status: 'in_progress',
                state_version: 2,
            });
            return state.profile;
        },
        async completeStartRequest() {
            state.completed = true;
            state.request = {
                ...state.request,
                status: 'completed',
                completed_at: NOW,
            };
            return true;
        },
    };

    return { repository, state };
}

function dependencies({ repository, topicResult = generatedTopic(), proError = null } = {}) {
    let topicCalls = 0;

    const accountAuthService = {
        async authorizeAccessToken() {
            return {
                accountId: ACCOUNT_ID,
                installationId: INSTALLATION_ID,
            };
        },
    };

    const proAccessService = {
        async requireCurrentProAccess() {
            if (proError) throw proError;
            return { hasProAccess: true };
        },
    };

    const topicGeneratorService = {
        async generateTopic(input) {
            topicCalls += 1;
            topicGeneratorService.lastInput = input;

            if (topicResult instanceof Error) throw topicResult;
            return topicResult;
        },
        lastInput: null,
    };

    const service = createAccountRankedPlacementService({
        repository,
        accountAuthService,
        proAccessService,
        topicGeneratorService,
        now: () => NOW,
    });

    return {
        service,
        topicGeneratorService,
        get topicCalls() {
            return topicCalls;
        },
    };
}

function startInput(overrides = {}) {
    return {
        installationId: INSTALLATION_ID,
        accessToken: 'header.payload.signature',
        requestId: REQUEST_ID,
        philosopherId: 'socrates',
        ...overrides,
    };
}

test('starts placement trial one with its server-required mode and Sonnet debate configuration', async () => {
    const { repository, state } = createStatefulRepository({
        recentTopics: ['Should an unexamined belief guide an important decision?'],
    });
    const deps = dependencies({ repository });

    const result = await deps.service.startPlacement(startInput());

    assert.equal(result.created, true);
    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.placementTrial.trialNumber, 1);
    assert.equal(result.placementTrial.requiredMode, 'guided');
    assert.equal(result.activeDebate.modelName, 'claude-sonnet-4-5-20250929');
    assert.equal(result.activeDebate.philosopherId, 'socrates');
    assert.equal(state.profile.placement_status, 'in_progress');
    assert.equal(state.request.status, 'completed');
    assert.equal(state.generatedTopicStored, true);
    assert.equal(state.completed, true);
    assert.deepEqual(deps.topicGeneratorService.lastInput, {
        philosopherId: 'socrates',
        debateMode: 'guided',
        recentTopics: ['Should an unexamined belief guide an important decision?'],
    });
});

test('returns an existing debate for a completed idempotent request without generating another topic', async () => {
    const existing = debate();
    const { repository } = createStatefulRepository({
        request: requestRow({ status: 'completed', completed_at: NOW }),
        activeDebate: existing,
    });
    const deps = dependencies({ repository });

    const result = await deps.service.startPlacement(startInput());

    assert.equal(result.created, false);
    assert.equal(result.activeDebate.id, DEBATE_ID);
    assert.equal(deps.topicCalls, 0);
});

test('blocks new placement starts while Ranked is disabled', async () => {
    const { repository } = createStatefulRepository({
        configuration: { is_enabled: false },
    });
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_disabled');
            assert.equal(error.status, 503);
            return true;
        }
    );

    assert.equal(deps.topicCalls, 0);
});

test('requires current Agora Pro access before touching Ranked state', async () => {
    const { repository, state } = createStatefulRepository();
    const proError = Object.assign(new Error('Agora Pro is required.'), {
        code: 'ranked_pro_required',
        status: 403,
        retryable: false,
    });
    const deps = dependencies({ repository, proError });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_pro_required');
            assert.equal(error.status, 403);
            return true;
        }
    );

    assert.equal(state.transactionCount, 0);
    assert.equal(deps.topicCalls, 0);
});

test('rejects a philosopher already used in an earlier placement trial', async () => {
    const { repository } = createStatefulRepository({
        usedPhilosophers: ['socrates'],
    });
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_placement_philosopher_already_used');
            assert.equal(error.status, 409);
            return true;
        }
    );

    assert.equal(deps.topicCalls, 0);
});

test('rejects a second start request while another Ranked debate is active', async () => {
    const { repository } = createStatefulRepository({
        activeDebate: debate({ start_request_id: OTHER_REQUEST_ID }),
    });
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_active_debate_exists');
            assert.equal(error.status, 409);
            assert.equal(error.details.activeDebateId, DEBATE_ID);
            return true;
        }
    );

    assert.equal(deps.topicCalls, 0);
});

test('marks a reserved request failed when topic generation fails', async () => {
    const { repository, state } = createStatefulRepository();
    const topicError = Object.assign(new Error('model timeout'), {
        code: 'ranked_topic_generation_failed',
        status: 503,
        retryable: true,
    });
    const deps = dependencies({ repository, topicResult: topicError });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_topic_generation_failed');
            assert.equal(error.retryable, true);
            return true;
        }
    );

    assert.equal(state.markedFailures.length, 1);
    assert.equal(state.markedFailures[0].failureCode, 'ranked_topic_generation_failed');
    assert.equal(state.markedFailures[0].failureRetryable, true);
});

test('blocks a topic generated under a version different from the active configuration', async () => {
    const { repository, state } = createStatefulRepository();
    const deps = dependencies({
        repository,
        topicResult: generatedTopic({ generatorVersion: 'ranked-topic-v2' }),
    });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_topic_version_mismatch');
            assert.equal(error.status, 503);
            return true;
        }
    );

    assert.equal(state.markedFailures.length, 1);
    assert.equal(state.markedFailures[0].failureCode, 'ranked_topic_version_mismatch');
});

test('rejects reuse of one request UUID for a different philosopher', async () => {
    const { repository } = createStatefulRepository({
        request: requestRow({ philosopher_id: 'plato', philosopher_name: 'Plato' }),
    });
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_start_request_reused');
            assert.equal(error.status, 409);
            return true;
        }
    );
});

test('requires a canonical philosopher ID', async () => {
    const { repository, state } = createStatefulRepository();
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput({ philosopherId: 'Marcus Aurelius' })),
        (error) => {
            assert.equal(error.code, 'invalid_ranked_philosopher');
            assert.equal(error.status, 400);
            return true;
        }
    );

    assert.equal(state.transactionCount, 0);
});

test('a fresh in-flight request returns a retryable conflict instead of generating twice', async () => {
    const { repository } = createStatefulRepository({
        request: requestRow({ updated_at: NOW }),
    });
    const deps = dependencies({ repository });

    await assert.rejects(
        deps.service.startPlacement(startInput()),
        (error) => {
            assert.equal(error.code, 'ranked_start_in_progress');
            assert.equal(error.status, 409);
            assert.equal(error.retryable, true);
            return true;
        }
    );

    assert.equal(deps.topicCalls, 0);
});

test('constructor rejects missing required services', () => {
    const { repository } = createStatefulRepository();

    assert.throws(
        () => createAccountRankedPlacementService({ repository }),
        (error) => {
            assert.ok(error instanceof AccountRankedPlacementError);
            assert.equal(error.code, 'invalid_ranked_placement_configuration');
            return true;
        }
    );
});
