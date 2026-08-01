import { randomUUID } from 'node:crypto';

import {
    requireRankedPhilosopher,
} from './rankedPhilosopherCatalog.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const TOPIC_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const RANKED_LADDER_SCHEMA_VERSION = 1;
const START_LEASE_MS = 10 * 60 * 1000;
const RECENT_TOPIC_LIMIT = 50;
const TOPIC_MODEL_PROVIDER = 'anthropic';

const SUPPORTED_MODES = new Set([
    'guided',
    'balanced',
    'relentless',
]);

const RANK_KEYS = new Set([
    'initiate',
    'student',
    'dialectician',
    'logician',
    'scholar',
    'sage',
    'philosopher',
    'alchemist',
]);

export class AccountRankedLadderError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            details = null,
            cause,
        } = {}
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AccountRankedLadderError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(code, message, options) {
    throw new AccountRankedLadderError(code, message, options);
}

function requireString(
    value,
    fieldName,
    {
        minimumLength = 1,
        maximumLength = 16_384,
        pattern = null,
        lowercase = false,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_ladder_request',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (
        cleaned.length < minimumLength ||
        cleaned.length > maximumLength ||
        (pattern && !pattern.test(cleaned))
    ) {
        fail(
            'invalid_ranked_ladder_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return lowercase ? cleaned.toLowerCase() : cleaned;
}

function requireInstallationId(value) {
    return requireString(value, 'installationId', {
        maximumLength: 128,
        pattern: INSTALLATION_ID_RE,
    });
}

function requireRequestId(value) {
    return requireString(value, 'requestId', {
        maximumLength: 64,
        pattern: UUID_RE,
        lowercase: true,
    });
}

function requireMode(value) {
    const mode = requireString(value, 'debateMode', {
        maximumLength: 20,
        lowercase: true,
    });

    if (!SUPPORTED_MODES.has(mode)) {
        fail(
            'invalid_ranked_debate_mode',
            'debateMode must be guided, balanced, or relentless.',
            { status: 400 }
        );
    }

    return mode;
}

function requireCanonicalPhilosopher(value) {
    const philosopherId = requireString(value, 'philosopherId', {
        maximumLength: 100,
        lowercase: true,
    });

    try {
        return requireRankedPhilosopher(philosopherId);
    } catch (error) {
        fail(
            error?.code ?? 'invalid_ranked_philosopher',
            error?.message ?? 'The selected philosopher is unavailable for Ranked.',
            {
                status: Number.isInteger(error?.status) ? error.status : 400,
                retryable: Boolean(error?.retryable),
                cause: error,
            }
        );
    }
}

function serviceDate(now) {
    const raw = now();
    const date = raw instanceof Date ? raw : new Date(raw);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_ranked_ladder_configuration',
            'now() returned an invalid date.'
        );
    }

    return date;
}

function rowValue(row, snakeCase, camelCase) {
    if (Object.prototype.hasOwnProperty.call(row, snakeCase)) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeDate(value, fieldName, { optional = false } = {}) {
    if (value == null && optional) return null;

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'ranked_ladder_state_unavailable',
            `Ranked ladder state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return date;
}

function normalizeInteger(
    value,
    fieldName,
    minimum,
    maximum,
    { optional = false } = {}
) {
    if (value == null && optional) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'ranked_ladder_state_unavailable',
            `Ranked ladder state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return parsed;
}

function normalizeNumber(
    value,
    fieldName,
    minimum,
    maximum,
    { optional = false } = {}
) {
    if (value == null && optional) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'ranked_ladder_state_unavailable',
            `Ranked ladder state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return parsed;
}

function normalizeText(
    value,
    fieldName,
    maximumLength,
    { optional = false } = {}
) {
    if (value == null && optional) return null;

    if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
        fail(
            'ranked_ladder_state_unavailable',
            `Ranked ladder state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return value.trim();
}

function normalizeConfiguration(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is unavailable.',
            { status: 503, retryable: true }
        );
    }

    if (rowValue(row, 'configuration_key', 'configurationKey') !== 'global') {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is invalid.',
            { status: 503, retryable: true }
        );
    }

    const booleanFields = [
        ['is_enabled', 'isEnabled'],
        ['allow_new_debates', 'allowNewDebates'],
        ['allow_resume_active_debates', 'allowResumeActiveDebates'],
        ['placements_enabled', 'placementsEnabled'],
        ['ladder_enabled', 'ladderEnabled'],
    ];

    for (const [snakeCase, camelCase] of booleanFields) {
        if (typeof rowValue(row, snakeCase, camelCase) !== 'boolean') {
            fail(
                'ranked_configuration_unavailable',
                `Ranked configuration contains an invalid ${camelCase}.`,
                { status: 503, retryable: true }
            );
        }
    }

    return Object.freeze({
        isEnabled: rowValue(row, 'is_enabled', 'isEnabled'),
        allowNewDebates: rowValue(row, 'allow_new_debates', 'allowNewDebates'),
        allowResumeActiveDebates: rowValue(
            row,
            'allow_resume_active_debates',
            'allowResumeActiveDebates'
        ),
        placementsEnabled: rowValue(row, 'placements_enabled', 'placementsEnabled'),
        ladderEnabled: rowValue(row, 'ladder_enabled', 'ladderEnabled'),
        rankedRulesVersion: normalizeText(
            rowValue(row, 'ranked_rules_version', 'rankedRulesVersion'),
            'configuration.rankedRulesVersion',
            100
        ),
        philosopherPromptVersion: normalizeText(
            rowValue(row, 'philosopher_prompt_version', 'philosopherPromptVersion'),
            'configuration.philosopherPromptVersion',
            100
        ),
        scoringPromptVersion: normalizeText(
            rowValue(row, 'scoring_prompt_version', 'scoringPromptVersion'),
            'configuration.scoringPromptVersion',
            100
        ),
        reportPromptVersion: normalizeText(
            rowValue(row, 'report_prompt_version', 'reportPromptVersion'),
            'configuration.reportPromptVersion',
            100
        ),
        topicGeneratorVersion: normalizeText(
            rowValue(row, 'topic_generator_version', 'topicGeneratorVersion'),
            'configuration.topicGeneratorVersion',
            100
        ),
        rpFormulaVersion: normalizeText(
            rowValue(row, 'rp_formula_version', 'rpFormulaVersion'),
            'configuration.rpFormulaVersion',
            100
        ),
        debateModelProvider: normalizeText(
            rowValue(row, 'debate_model_provider', 'debateModelProvider'),
            'configuration.debateModelProvider',
            100
        ),
        debateModelName: normalizeText(
            rowValue(row, 'debate_model_name', 'debateModelName'),
            'configuration.debateModelName',
            150
        ),
    });
}

function requireLadderEnabled(configuration) {
    if (!configuration.isEnabled) {
        fail(
            'ranked_disabled',
            'Ranked is not currently available.',
            { status: 503, retryable: false }
        );
    }

    if (!configuration.allowNewDebates) {
        fail(
            'ranked_new_debates_disabled',
            'New Ranked debates are temporarily unavailable.',
            { status: 503, retryable: true }
        );
    }

    if (!configuration.ladderEnabled) {
        fail(
            'ranked_ladder_disabled',
            'The Ranked ladder is not currently available.',
            { status: 503, retryable: false }
        );
    }
}

function normalizeProfile(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile is unavailable.',
            { status: 503, retryable: true }
        );
    }

    const accountId = String(rowValue(row, 'account_id', 'accountId') ?? '').toLowerCase();

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked profile belongs to a different account.',
            { status: 503 }
        );
    }

    const placementStatus = rowValue(row, 'placement_status', 'placementStatus');
    const currentRankKey = rowValue(row, 'current_rank_key', 'currentRankKey');
    const peakRankKey = rowValue(row, 'peak_rank_key', 'peakRankKey');

    if (placementStatus !== 'completed') {
        fail(
            'ranked_placement_required',
            'Complete all five placement trials before entering the Ranked ladder.',
            { status: 409, retryable: false }
        );
    }

    if (!RANK_KEYS.has(currentRankKey) || !RANK_KEYS.has(peakRankKey)) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile does not contain a valid rank.',
            { status: 503, retryable: true }
        );
    }

    const currentDivision = normalizeInteger(
        rowValue(row, 'current_division', 'currentDivision'),
        'profile.currentDivision',
        1,
        3,
        { optional: currentRankKey === 'alchemist' }
    );
    const peakDivision = normalizeInteger(
        rowValue(row, 'peak_division', 'peakDivision'),
        'profile.peakDivision',
        1,
        3,
        { optional: peakRankKey === 'alchemist' }
    );

    if (
        (currentRankKey === 'alchemist' && currentDivision != null) ||
        (currentRankKey !== 'alchemist' && currentDivision == null) ||
        (peakRankKey === 'alchemist' && peakDivision != null) ||
        (peakRankKey !== 'alchemist' && peakDivision == null)
    ) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile contains an invalid rank division.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        accountId,
        placementStatus,
        placementTrialsCompleted: normalizeInteger(
            rowValue(row, 'placement_trials_completed', 'placementTrialsCompleted'),
            'profile.placementTrialsCompleted',
            5,
            5
        ),
        placementWeightedScore: normalizeNumber(
            rowValue(row, 'placement_weighted_score', 'placementWeightedScore'),
            'profile.placementWeightedScore',
            0,
            10
        ),
        currentRankKey,
        currentDivision,
        currentRP: normalizeInteger(
            rowValue(row, 'current_rp', 'currentRP'),
            'profile.currentRP',
            0,
            99
        ),
        peakRankKey,
        peakDivision,
        peakReachedAt: normalizeDate(
            rowValue(row, 'peak_reached_at', 'peakReachedAt'),
            'profile.peakReachedAt'
        ),
        demotionProtectionDebatesRemaining: normalizeInteger(
            rowValue(
                row,
                'demotion_protection_debates_remaining',
                'demotionProtectionDebatesRemaining'
            ),
            'profile.demotionProtectionDebatesRemaining',
            0,
            1
        ),
        demotionProtectionReason: normalizeText(
            rowValue(row, 'demotion_protection_reason', 'demotionProtectionReason'),
            'profile.demotionProtectionReason',
            50,
            { optional: true }
        ),
        rankedDebatesCompleted: normalizeInteger(
            rowValue(row, 'ranked_debates_completed', 'rankedDebatesCompleted'),
            'profile.rankedDebatesCompleted',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedForfeits: normalizeInteger(
            rowValue(row, 'ranked_forfeits', 'rankedForfeits'),
            'profile.rankedForfeits',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedInvalidResults: normalizeInteger(
            rowValue(row, 'ranked_invalid_results', 'rankedInvalidResults'),
            'profile.rankedInvalidResults',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        stateVersion: normalizeInteger(
            rowValue(row, 'state_version', 'stateVersion'),
            'profile.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
        updatedAt: normalizeDate(
            rowValue(row, 'updated_at', 'updatedAt'),
            'profile.updatedAt'
        ),
    });
}

function normalizeDebate(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_ladder_state_unavailable',
            'The Ranked ladder debate is unavailable.',
            { status: 503, retryable: true }
        );
    }

    const id = normalizeText(rowValue(row, 'id', 'id'), 'debate.id', 64).toLowerCase();
    const accountId = normalizeText(
        rowValue(row, 'account_id', 'accountId'),
        'debate.accountId',
        64
    ).toLowerCase();
    const startRequestId = normalizeText(
        rowValue(row, 'start_request_id', 'startRequestId'),
        'debate.startRequestId',
        64
    ).toLowerCase();

    if (!UUID_RE.test(id) || !UUID_RE.test(accountId) || !UUID_RE.test(startRequestId)) {
        fail(
            'ranked_ladder_state_unavailable',
            'The Ranked ladder debate contains invalid identity data.',
            { status: 503, retryable: true }
        );
    }

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked ladder debate belongs to a different account.',
            { status: 503 }
        );
    }

    const rankKey = normalizeText(
        rowValue(row, 'starting_rank_key', 'startingRankKey'),
        'debate.startingRankKey',
        30
    );
    const division = normalizeInteger(
        rowValue(row, 'starting_division', 'startingDivision'),
        'debate.startingDivision',
        1,
        3,
        { optional: rankKey === 'alchemist' }
    );

    return Object.freeze({
        id,
        accountId,
        startRequestId,
        completionRequestId: null,
        forfeitRequestId: null,
        debateKind: 'ladder',
        placementTrialNumber: null,
        status: 'active',
        philosopherId: normalizeText(
            rowValue(row, 'philosopher_id', 'philosopherId'),
            'debate.philosopherId',
            100
        ),
        philosopherName: normalizeText(
            rowValue(row, 'philosopher_name', 'philosopherName'),
            'debate.philosopherName',
            100
        ),
        debateMode: requireMode(rowValue(row, 'debate_mode', 'debateMode')),
        topic: normalizeText(rowValue(row, 'topic', 'topic'), 'debate.topic', 4_000),
        topicFingerprint: requireString(
            rowValue(row, 'topic_fingerprint', 'topicFingerprint'),
            'debate.topicFingerprint',
            { maximumLength: 64, pattern: TOPIC_FINGERPRINT_RE }
        ),
        topicTheme: normalizeText(
            rowValue(row, 'topic_theme', 'topicTheme'),
            'debate.topicTheme',
            120
        ),
        topicModelProvider: normalizeText(
            rowValue(row, 'topic_model_provider', 'topicModelProvider'),
            'debate.topicModelProvider',
            100
        ),
        topicModelName: normalizeText(
            rowValue(row, 'topic_model_name', 'topicModelName'),
            'debate.topicModelName',
            200
        ),
        topicGeneratedAt: normalizeDate(
            rowValue(row, 'topic_generated_at', 'topicGeneratedAt'),
            'debate.topicGeneratedAt'
        ),
        messages: [],
        pendingGeneration: null,
        currentScoreText: null,
        currentScoreValue: null,
        finalScoreText: null,
        finalScoreValue: null,
        roundCount: 0,
        startingRankKey: rankKey,
        startingDivision: division,
        startingRP: normalizeInteger(
            rowValue(row, 'starting_rp', 'startingRP'),
            'debate.startingRP',
            0,
            99
        ),
        forfeitRPLossPreview: normalizeInteger(
            rowValue(row, 'forfeit_rp_loss_preview', 'forfeitRPLossPreview'),
            'debate.forfeitRPLossPreview',
            1,
            500
        ),
        rpDelta: null,
        endingRankKey: null,
        endingDivision: null,
        endingRP: null,
        promoted: false,
        demoted: false,
        protectionApplied: false,
        protectionConsumed: false,
        rankedRulesVersion: normalizeText(
            rowValue(row, 'ranked_rules_version', 'rankedRulesVersion'),
            'debate.rankedRulesVersion',
            100
        ),
        philosopherPromptVersion: normalizeText(
            rowValue(row, 'philosopher_prompt_version', 'philosopherPromptVersion'),
            'debate.philosopherPromptVersion',
            100
        ),
        scoringPromptVersion: normalizeText(
            rowValue(row, 'scoring_prompt_version', 'scoringPromptVersion'),
            'debate.scoringPromptVersion',
            100
        ),
        reportPromptVersion: normalizeText(
            rowValue(row, 'report_prompt_version', 'reportPromptVersion'),
            'debate.reportPromptVersion',
            100
        ),
        topicGeneratorVersion: normalizeText(
            rowValue(row, 'topic_generator_version', 'topicGeneratorVersion'),
            'debate.topicGeneratorVersion',
            100
        ),
        rpFormulaVersion: normalizeText(
            rowValue(row, 'rp_formula_version', 'rpFormulaVersion'),
            'debate.rpFormulaVersion',
            100
        ),
        modelProvider: normalizeText(
            rowValue(row, 'model_provider', 'modelProvider'),
            'debate.modelProvider',
            100
        ),
        modelName: normalizeText(
            rowValue(row, 'model_name', 'modelName'),
            'debate.modelName',
            150
        ),
        stateVersion: normalizeInteger(
            rowValue(row, 'state_version', 'stateVersion'),
            'debate.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
        startedAt: normalizeDate(rowValue(row, 'started_at', 'startedAt'), 'debate.startedAt'),
        lastActivityAt: normalizeDate(
            rowValue(row, 'last_activity_at', 'lastActivityAt'),
            'debate.lastActivityAt'
        ),
        completedAt: null,
        updatedAt: normalizeDate(rowValue(row, 'updated_at', 'updatedAt'), 'debate.updatedAt'),
    });
}

function requireGeneratedString(
    value,
    fieldName,
    {
        maximumLength,
        minimumLength = 1,
        pattern = null,
    }
) {
    if (typeof value !== 'string') {
        fail(
            'ranked_topic_generation_mismatch',
            `The generated Ranked topic contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    const cleaned = value.trim();

    if (
        cleaned.length < minimumLength ||
        cleaned.length > maximumLength ||
        (pattern && !pattern.test(cleaned))
    ) {
        fail(
            'ranked_topic_generation_mismatch',
            `The generated Ranked topic contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return cleaned;
}

function normalizeGeneratedTopic(result, expectedPhilosopher, expectedMode) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        fail(
            'ranked_topic_generation_failed',
            'A fresh Ranked topic could not be generated.',
            { status: 503, retryable: true }
        );
    }

    if (
        result.philosopherId !== expectedPhilosopher.id ||
        result.philosopherName !== expectedPhilosopher.name ||
        result.debateMode !== expectedMode
    ) {
        fail(
            'ranked_topic_generation_mismatch',
            'The generated Ranked topic did not match the reserved ladder debate.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        philosopherId: expectedPhilosopher.id,
        philosopherName: expectedPhilosopher.name,
        debateMode: expectedMode,
        topic: requireGeneratedString(result.topic, 'generatedTopic.topic', {
            minimumLength: 30,
            maximumLength: 220,
        }),
        openingQuestion: requireGeneratedString(
            result.openingQuestion,
            'generatedTopic.openingQuestion',
            {
                minimumLength: 20,
                maximumLength: 280,
            }
        ),
        topicNormalized: requireGeneratedString(
            result.topicNormalized,
            'generatedTopic.topicNormalized',
            { maximumLength: 220 }
        ),
        topicFingerprint: requireGeneratedString(
            result.topicFingerprint,
            'generatedTopic.topicFingerprint',
            { maximumLength: 64, pattern: TOPIC_FINGERPRINT_RE }
        ),
        theme: requireGeneratedString(result.theme, 'generatedTopic.theme', {
            minimumLength: 2,
            maximumLength: 120,
        }),
        model: requireGeneratedString(result.model, 'generatedTopic.model', {
            maximumLength: 200,
        }),
        generatorVersion: requireGeneratedString(
            result.generatorVersion,
            'generatedTopic.generatorVersion',
            { maximumLength: 100 }
        ),
    });
}


function createSeededOpeningMessage({
    requestId,
    openingQuestion,
    completedAt,
}) {
    const timestamp =
        completedAt instanceof Date
            ? completedAt
            : new Date(completedAt);

    if (
        Number.isNaN(
            timestamp.getTime()
        )
    ) {
        fail(
            'invalid_ranked_opening_configuration',
            'The seeded Ranked opening has an invalid timestamp.'
        );
    }

    const isoTimestamp =
        timestamp.toISOString();

    return Object.freeze({
        schemaVersion: 1,
        id: randomUUID(),
        requestId,
        generationId: randomUUID(),
        role: 'assistant',
        kind: 'opening',
        status: 'completed',
        visible: true,
        content: openingQuestion,
        roundNumber: 0,
        scoreText: null,
        scoreValue: null,
        failureCode: null,
        failureRetryable: null,
        createdAt: isoTimestamp,
        generationStartedAt: isoTimestamp,
        completedAt: isoTimestamp,
    });
}

function validateRequestIdentity(row, requestId, philosopher, debateMode) {
    const storedRequestId = String(rowValue(row, 'request_id', 'requestId') ?? '').toLowerCase();
    const storedKind = rowValue(row, 'debate_kind', 'debateKind');
    const storedPhilosopherId = rowValue(row, 'philosopher_id', 'philosopherId');
    const storedMode = rowValue(row, 'debate_mode', 'debateMode');

    if (
        storedRequestId !== requestId ||
        storedKind !== 'ladder' ||
        storedPhilosopherId !== philosopher.id ||
        storedMode !== debateMode
    ) {
        fail(
            'ranked_start_request_reused',
            'This Ranked start request ID was already used for different input.',
            { status: 409, retryable: false }
        );
    }
}

function isStale(row, staleBefore) {
    const updatedAt = normalizeDate(
        rowValue(row, 'updated_at', 'updatedAt'),
        'startRequest.updatedAt'
    );

    return updatedAt.getTime() <= staleBefore.getTime();
}

function mapDependencyError(error, fallback) {
    if (error instanceof AccountRankedLadderError) return error;

    return new AccountRankedLadderError(
        typeof error?.code === 'string' && error.code ? error.code : fallback.code,
        error?.message || fallback.message,
        {
            status: Number.isInteger(error?.status) ? error.status : fallback.status,
            retryable: Boolean(error?.retryable ?? fallback.retryable),
            cause: error,
        }
    );
}

function postgresConflict(error) {
    const constraint = String(error?.constraint ?? '');

    if (
        error?.code === '23505' &&
        constraint === 'account_ranked_debates_one_active_per_account_idx'
    ) {
        return new AccountRankedLadderError(
            'ranked_active_debate_exists',
            'This account already has an active Ranked debate.',
            { status: 409 }
        );
    }

    if (
        error?.code === '23505' &&
        constraint === 'account_ranked_start_requests_one_in_flight_idx'
    ) {
        return new AccountRankedLadderError(
            'ranked_start_in_progress',
            'A Ranked debate is already being prepared for this account.',
            { status: 409, retryable: true }
        );
    }

    return null;
}

export function createPostgresAccountRankedLadderRepository(pool) {
    if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
        fail(
            'invalid_ranked_ladder_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    const profileColumns = `
        account_id,
        placement_status,
        placement_trials_completed,
        placement_weighted_score,
        current_rank_key,
        current_division,
        current_rp,
        peak_rank_key,
        peak_division,
        peak_reached_at,
        demotion_protection_debates_remaining,
        demotion_protection_reason,
        ranked_debates_completed,
        ranked_forfeits,
        ranked_invalid_results,
        state_version,
        updated_at
    `;

    const ladderDebateColumns = `
        id,
        account_id,
        start_request_id,
        debate_kind,
        placement_trial_number,
        status,
        philosopher_id,
        philosopher_name,
        debate_mode,
        topic,
        topic_fingerprint,
        topic_theme,
        topic_model_provider,
        topic_model_name,
        topic_generated_at,
        starting_rank_key,
        starting_division,
        starting_rp,
        forfeit_rp_loss_preview,
        ranked_rules_version,
        philosopher_prompt_version,
        scoring_prompt_version,
        report_prompt_version,
        topic_generator_version,
        rp_formula_version,
        model_provider,
        model_name,
        state_version,
        started_at,
        last_activity_at,
        updated_at
    `;

    return Object.freeze({
        async withTransaction(work) {
            const client = await pool.connect();

            try {
                await client.query('BEGIN');
                const result = await work(client);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch {}
                throw error;
            } finally {
                client.release();
            }
        },

        async lockProfile(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:lock-profile */
                    SELECT ${profileColumns}
                    FROM account_ranked_profiles
                    WHERE account_id = $1::uuid
                    FOR UPDATE
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async loadConfiguration(client) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:load-configuration */
                    SELECT
                        configuration_key,
                        is_enabled,
                        allow_new_debates,
                        allow_resume_active_debates,
                        placements_enabled,
                        ladder_enabled,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        debate_model_provider,
                        debate_model_name
                    FROM ranked_system_configuration
                    WHERE configuration_key = 'global'
                `
            );

            return result.rows[0] ?? null;
        },

        async findStartRequestForUpdate(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:find-start-request */
                    SELECT *
                    FROM account_ranked_start_requests
                    WHERE account_id = $1::uuid
                      AND request_id = $2::uuid
                    FOR UPDATE
                `,
                [accountId, requestId]
            );

            return result.rows[0] ?? null;
        },

        async findOtherInFlightRequestForUpdate(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:find-other-in-flight-request */
                    SELECT *
                    FROM account_ranked_start_requests
                    WHERE account_id = $1::uuid
                      AND request_id <> $2::uuid
                      AND status IN ('reserved', 'topic_generated')
                    ORDER BY updated_at ASC
                    LIMIT 1
                    FOR UPDATE
                `,
                [accountId, requestId]
            );

            return result.rows[0] ?? null;
        },

        async findActiveDebate(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:find-active-debate */
                    SELECT ${ladderDebateColumns}
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND status = 'active'
                    LIMIT 1
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async findDebateByStartRequest(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:find-debate-by-request */
                    SELECT ${ladderDebateColumns}
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND start_request_id = $2::uuid
                    LIMIT 1
                `,
                [accountId, requestId]
            );

            return result.rows[0] ?? null;
        },

        async listRecentTopics(client, { accountId, limit }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:list-recent-topics */
                    SELECT topic
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND topic IS NOT NULL
                    ORDER BY started_at DESC, id DESC
                    LIMIT $2::integer
                `,
                [accountId, limit]
            );

            // rankedTopicGeneratorService expects recentTopics to be an
            // array of strings. PostgreSQL returns each selected row as an
            // object, so normalize the rows before calling the generator.
            return result.rows
                .map((row) => (
                    typeof row?.topic === 'string'
                        ? row.topic.trim()
                        : ''
                ))
                .filter((topic) => topic.length > 0);
        },

        async insertStartRequest(
            client,
            {
                accountId,
                requestId,
                philosopher,
                debateMode,
                createdAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:insert-start-request */
                    INSERT INTO account_ranked_start_requests (
                        account_id,
                        request_id,
                        debate_kind,
                        placement_trial_number,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        status,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1::uuid,
                        $2::uuid,
                        'ladder',
                        NULL,
                        $3::text,
                        $4::text,
                        $5::text,
                        'reserved',
                        $6::timestamptz,
                        $6::timestamptz
                    )
                    RETURNING *
                `,
                [
                    accountId,
                    requestId,
                    philosopher.id,
                    philosopher.name,
                    debateMode,
                    createdAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async reviveStartRequest(client, { accountId, requestId, revivedAt }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:revive-start-request */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'reserved',
                        topic = NULL,
                        topic_normalized = NULL,
                        topic_fingerprint = NULL,
                        topic_theme = NULL,
                        topic_model_provider = NULL,
                        topic_model_name = NULL,
                        topic_generator_version = NULL,
                        topic_generated_at = NULL,
                        failure_code = NULL,
                        failure_retryable = NULL,
                        completed_at = NULL,
                        attempt_count = attempt_count + 1,
                        updated_at = $3::timestamptz
                    WHERE account_id = $1::uuid
                      AND request_id = $2::uuid
                      AND status IN ('reserved', 'topic_generated', 'failed')
                    RETURNING *
                `,
                [accountId, requestId, revivedAt]
            );

            return result.rows[0] ?? null;
        },

        async markStartRequestFailed(
            client,
            {
                accountId,
                requestId,
                failureCode,
                failureRetryable,
                failedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:fail-start-request */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'failed',
                        failure_code = $3::text,
                        failure_retryable = $4::boolean,
                        updated_at = $5::timestamptz,
                        completed_at = $5::timestamptz
                    WHERE account_id = $1::uuid
                      AND request_id = $2::uuid
                      AND status IN ('reserved', 'topic_generated')
                    RETURNING request_id
                `,
                [
                    accountId,
                    requestId,
                    failureCode,
                    failureRetryable,
                    failedAt,
                ]
            );

            return result.rowCount === 1;
        },

        async storeGeneratedTopic(
            client,
            {
                accountId,
                requestId,
                generatedTopic,
                generatedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:store-topic */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'topic_generated',
                        topic = $3::text,
                        topic_normalized = $4::text,
                        topic_fingerprint = $5::text,
                        topic_theme = $6::text,
                        topic_model_provider = $7::text,
                        topic_model_name = $8::text,
                        topic_generator_version = $9::text,
                        opening_question = $10::text,
                        topic_generated_at = $11::timestamptz,
                        updated_at = $11::timestamptz
                    WHERE account_id = $1::uuid
                      AND request_id = $2::uuid
                      AND status = 'reserved'
                    RETURNING topic_generated_at
                `,
                [
                    accountId,
                    requestId,
                    generatedTopic.topic,
                    generatedTopic.topicNormalized,
                    generatedTopic.topicFingerprint,
                    generatedTopic.theme,
                    TOPIC_MODEL_PROVIDER,
                    generatedTopic.model,
                    generatedTopic.generatorVersion,
                    generatedTopic.openingQuestion,
                    generatedAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async insertLadderDebate(
            client,
            {
                accountId,
                installationId,
                requestId,
                philosopher,
                debateMode,
                profile,
                configuration,
                generatedTopic,
                topicGeneratedAt,
                forfeitRPLossPreview,
                startedAt,
            }
        ) {
            const openingMessage =
                createSeededOpeningMessage({
                    requestId,
                    openingQuestion:
                        generatedTopic.openingQuestion,
                    completedAt:
                        startedAt,
                });

            const result = await client.query(
                `
                    /* account-ranked-ladder:insert-debate */
                    INSERT INTO account_ranked_debates (
                        account_id,
                        start_request_id,
                        debate_kind,
                        placement_trial_number,
                        status,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        topic,
                        topic_source,
                        topic_fingerprint,
                        topic_theme,
                        topic_model_provider,
                        topic_model_name,
                        topic_generated_at,
                        starting_rank_key,
                        starting_division,
                        starting_rp,
                        forfeit_rp_loss_preview,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        model_provider,
                        model_name,
                        origin_installation_id,
                        last_synced_from_installation_id,
                        created_at,
                        started_at,
                        last_activity_at,
                        updated_at,
                        opening_question,
                        messages_json
                    )
                    VALUES (
                        $1::uuid,
                        $2::uuid,
                        'ladder',
                        NULL,
                        'active',
                        $3::text,
                        $4::text,
                        $5::text,
                        $6::text,
                        'system_generated',
                        $7::text,
                        $8::text,
                        $9::text,
                        $10::text,
                        $11::timestamptz,
                        $12::text,
                        $13::smallint,
                        $14::integer,
                        $15::integer,
                        $16::text,
                        $17::text,
                        $18::text,
                        $19::text,
                        $20::text,
                        $21::text,
                        $22::text,
                        $23::text,
                        $24::text,
                        $24::text,
                        $25::timestamptz,
                        $25::timestamptz,
                        $25::timestamptz,
                        $25::timestamptz,
                        $26::text,
                        $27::jsonb
                    )
                    RETURNING ${ladderDebateColumns}
                `,
                [
                    accountId,
                    requestId,
                    philosopher.id,
                    philosopher.name,
                    debateMode,
                    generatedTopic.topic,
                    generatedTopic.topicFingerprint,
                    generatedTopic.theme,
                    TOPIC_MODEL_PROVIDER,
                    generatedTopic.model,
                    topicGeneratedAt,
                    profile.currentRankKey,
                    profile.currentDivision,
                    profile.currentRP,
                    forfeitRPLossPreview,
                    configuration.rankedRulesVersion,
                    configuration.philosopherPromptVersion,
                    configuration.scoringPromptVersion,
                    configuration.reportPromptVersion,
                    configuration.topicGeneratorVersion,
                    configuration.rpFormulaVersion,
                    configuration.debateModelProvider,
                    configuration.debateModelName,
                    installationId,
                    startedAt,
                    generatedTopic.openingQuestion,
                    JSON.stringify([
                        openingMessage,
                    ]),
                ]
            );

            return result.rows[0] ?? null;
        },

        async completeStartRequest(client, { accountId, requestId, completedAt }) {
            const result = await client.query(
                `
                    /* account-ranked-ladder:complete-start-request */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'completed',
                        updated_at = $3::timestamptz,
                        completed_at = $3::timestamptz
                    WHERE account_id = $1::uuid
                      AND request_id = $2::uuid
                      AND status = 'topic_generated'
                    RETURNING request_id
                `,
                [accountId, requestId, completedAt]
            );

            return result.rowCount === 1;
        },
    });
}

export function createAccountRankedLadderService({
    pool = null,
    repository = null,
    accountAuthService,
    proAccessService,
    topicGeneratorService,
    ratingService,
    now = () => Date.now(),
    startLeaseMs = START_LEASE_MS,
} = {}) {
    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
        fail(
            'invalid_ranked_ladder_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (!proAccessService || typeof proAccessService.requireCurrentProAccess !== 'function') {
        fail(
            'invalid_ranked_ladder_configuration',
            'proAccessService.requireCurrentProAccess() is required.'
        );
    }

    if (!topicGeneratorService || typeof topicGeneratorService.generateTopic !== 'function') {
        fail(
            'invalid_ranked_ladder_configuration',
            'topicGeneratorService.generateTopic() is required.'
        );
    }

    if (!ratingService || typeof ratingService.previewForfeit !== 'function') {
        fail(
            'invalid_ranked_ladder_configuration',
            'ratingService.previewForfeit() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail('invalid_ranked_ladder_configuration', 'now must be a function.');
    }

    if (!Number.isSafeInteger(startLeaseMs) || startLeaseMs < 60_000) {
        fail(
            'invalid_ranked_ladder_configuration',
            'startLeaseMs must be at least 60000 milliseconds.'
        );
    }

    const repo = repository ?? createPostgresAccountRankedLadderRepository(pool);
    const requiredMethods = [
        'withTransaction',
        'lockProfile',
        'loadConfiguration',
        'findStartRequestForUpdate',
        'findOtherInFlightRequestForUpdate',
        'findActiveDebate',
        'findDebateByStartRequest',
        'listRecentTopics',
        'insertStartRequest',
        'reviveStartRequest',
        'markStartRequestFailed',
        'storeGeneratedTopic',
        'insertLadderDebate',
        'completeStartRequest',
    ];

    for (const method of requiredMethods) {
        if (typeof repo?.[method] !== 'function') {
            fail(
                'invalid_ranked_ladder_configuration',
                `Ranked ladder repository is missing ${method}().`
            );
        }
    }

    async function authorize({ installationId, accessToken }) {
        const cleanInstallationId = requireInstallationId(installationId);
        const cleanAccessToken = requireString(accessToken, 'accessToken', {
            maximumLength: 16_384,
        });

        try {
            const authorization = await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
            });

            const accountId = String(authorization?.accountId ?? '').toLowerCase();
            const authorizedInstallationId = requireInstallationId(
                authorization?.installationId ?? cleanInstallationId
            );

            if (!UUID_RE.test(accountId)) {
                fail(
                    'ranked_authentication_unavailable',
                    'Account authentication returned an invalid account ID.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                accountId,
                installationId: authorizedInstallationId,
            });
        } catch (error) {
            throw mapDependencyError(error, {
                code: 'invalid_access_token',
                message: 'The Agora account session is invalid or expired.',
                status: 401,
                retryable: false,
            });
        }
    }

    async function requirePro(accountId) {
        try {
            return await proAccessService.requireCurrentProAccess({ accountId });
        } catch (error) {
            throw mapDependencyError(error, {
                code: 'pro_access_unavailable',
                message: 'Agora Pro access could not be verified.',
                status: 503,
                retryable: true,
            });
        }
    }

    async function markReservedRequestFailed({ accountId, requestId, error }) {
        const failureCode = requireString(
            typeof error?.code === 'string' ? error.code : 'ranked_ladder_start_failed',
            'failureCode',
            { maximumLength: 100 }
        );
        const failedAt = serviceDate(now);

        try {
            await repo.withTransaction(async (client) => {
                await repo.markStartRequestFailed(client, {
                    accountId,
                    requestId,
                    failureCode,
                    failureRetryable: Boolean(error?.retryable),
                    failedAt,
                });
            });
        } catch {}
    }

    async function reserve({ accountId, requestId, philosopher, debateMode }) {
        const checkedAt = serviceDate(now);
        const staleBefore = new Date(checkedAt.getTime() - startLeaseMs);

        return repo.withTransaction(async (client) => {
            const profile = normalizeProfile(
                await repo.lockProfile(client, { accountId }),
                accountId
            );
            const configuration = normalizeConfiguration(
                await repo.loadConfiguration(client)
            );

            let request = await repo.findStartRequestForUpdate(client, {
                accountId,
                requestId,
            });

            if (request) {
                validateRequestIdentity(request, requestId, philosopher, debateMode);

                if (rowValue(request, 'status', 'status') === 'completed') {
                    const existingDebate = normalizeDebate(
                        await repo.findDebateByStartRequest(client, {
                            accountId,
                            requestId,
                        }),
                        accountId
                    );

                    return Object.freeze({
                        action: 'existing',
                        configuration,
                        profile,
                        debate: existingDebate,
                    });
                }
            }

            requireLadderEnabled(configuration);

            const activeDebateRow = await repo.findActiveDebate(client, { accountId });

            if (activeDebateRow) {
                const activeDebate = normalizeDebate(activeDebateRow, accountId);

                if (activeDebate.startRequestId === requestId) {
                    return Object.freeze({
                        action: 'existing',
                        configuration,
                        profile,
                        debate: activeDebate,
                    });
                }

                fail(
                    'ranked_active_debate_exists',
                    'This account already has an active Ranked debate.',
                    {
                        status: 409,
                        details: { activeDebateId: activeDebate.id },
                    }
                );
            }

            const otherInFlight = await repo.findOtherInFlightRequestForUpdate(client, {
                accountId,
                requestId,
            });

            if (otherInFlight) {
                if (!isStale(otherInFlight, staleBefore)) {
                    fail(
                        'ranked_start_in_progress',
                        'A Ranked debate is already being prepared for this account.',
                        { status: 409, retryable: true }
                    );
                }

                const otherRequestId = String(
                    rowValue(otherInFlight, 'request_id', 'requestId') ?? ''
                ).toLowerCase();

                if (UUID_RE.test(otherRequestId)) {
                    await repo.markStartRequestFailed(client, {
                        accountId,
                        requestId: otherRequestId,
                        failureCode: 'ranked_start_lease_expired',
                        failureRetryable: true,
                        failedAt: checkedAt,
                    });
                }
            }

            if (request) {
                const status = rowValue(request, 'status', 'status');
                const failureRetryable = Boolean(
                    rowValue(request, 'failure_retryable', 'failureRetryable')
                );

                if (status === 'failed' && !failureRetryable) {
                    fail(
                        rowValue(request, 'failure_code', 'failureCode') ||
                            'ranked_ladder_start_failed',
                        'This Ranked start request previously failed and cannot be retried.',
                        { status: 409, retryable: false }
                    );
                }

                if (
                    ['reserved', 'topic_generated'].includes(status) &&
                    !isStale(request, staleBefore)
                ) {
                    fail(
                        'ranked_start_in_progress',
                        'This Ranked debate is still being prepared.',
                        { status: 409, retryable: true }
                    );
                }

                request = await repo.reviveStartRequest(client, {
                    accountId,
                    requestId,
                    revivedAt: checkedAt,
                });

                if (!request) {
                    fail(
                        'ranked_start_request_state_changed',
                        'The Ranked start request changed before it could be retried.',
                        { status: 409, retryable: true }
                    );
                }
            } else {
                request = await repo.insertStartRequest(client, {
                    accountId,
                    requestId,
                    philosopher,
                    debateMode,
                    createdAt: checkedAt,
                });

                if (!request) {
                    fail(
                        'ranked_start_request_not_created',
                        'The Ranked start request could not be created.',
                        { status: 503, retryable: true }
                    );
                }
            }

            const recentTopics = await repo.listRecentTopics(client, {
                accountId,
                limit: RECENT_TOPIC_LIMIT,
            });

            return Object.freeze({
                action: 'generate',
                configuration,
                profile,
                recentTopics: Object.freeze(recentTopics),
            });
        });
    }

    async function finalize({
        accountId,
        installationId,
        requestId,
        philosopher,
        debateMode,
        reservation,
        generatedTopic,
    }) {
        return repo.withTransaction(async (client) => {
            const profile = normalizeProfile(
                await repo.lockProfile(client, { accountId }),
                accountId
            );
            const configuration = normalizeConfiguration(
                await repo.loadConfiguration(client)
            );
            requireLadderEnabled(configuration);

            const request = await repo.findStartRequestForUpdate(client, {
                accountId,
                requestId,
            });

            if (!request) {
                fail(
                    'ranked_start_request_missing',
                    'The Ranked start request no longer exists.',
                    { status: 409, retryable: true }
                );
            }

            validateRequestIdentity(request, requestId, philosopher, debateMode);

            if (rowValue(request, 'status', 'status') === 'completed') {
                return Object.freeze({
                    created: false,
                    configuration,
                    profile,
                    debate: normalizeDebate(
                        await repo.findDebateByStartRequest(client, {
                            accountId,
                            requestId,
                        }),
                        accountId
                    ),
                });
            }

            if (rowValue(request, 'status', 'status') !== 'reserved') {
                fail(
                    'ranked_start_request_not_reserved',
                    'The Ranked start request is no longer reserved.',
                    { status: 409, retryable: true }
                );
            }

            if (generatedTopic.generatorVersion !== configuration.topicGeneratorVersion) {
                fail(
                    'ranked_topic_version_mismatch',
                    'The Ranked topic generator version does not match the active Ranked configuration.',
                    { status: 503, retryable: false }
                );
            }

            if (
                profile.stateVersion !== reservation.profile.stateVersion ||
                profile.currentRankKey !== reservation.profile.currentRankKey ||
                profile.currentDivision !== reservation.profile.currentDivision ||
                profile.currentRP !== reservation.profile.currentRP
            ) {
                fail(
                    'ranked_profile_state_changed',
                    'The Ranked profile changed while the debate was being prepared.',
                    { status: 409, retryable: true }
                );
            }

            const activeDebateRow = await repo.findActiveDebate(client, { accountId });

            if (activeDebateRow) {
                const activeDebate = normalizeDebate(activeDebateRow, accountId);

                if (activeDebate.startRequestId === requestId) {
                    return Object.freeze({
                        created: false,
                        configuration,
                        profile,
                        debate: activeDebate,
                    });
                }

                fail(
                    'ranked_active_debate_exists',
                    'This account already has an active Ranked debate.',
                    {
                        status: 409,
                        details: { activeDebateId: activeDebate.id },
                    }
                );
            }

            const generatedAt = serviceDate(now);
            const storedTopic = await repo.storeGeneratedTopic(client, {
                accountId,
                requestId,
                generatedTopic,
                generatedAt,
            });

            if (!storedTopic) {
                fail(
                    'ranked_start_request_not_reserved',
                    'The Ranked start request could not store its generated topic.',
                    { status: 409, retryable: true }
                );
            }

            const topicGeneratedAt = normalizeDate(
                rowValue(storedTopic, 'topic_generated_at', 'topicGeneratedAt'),
                'startRequest.topicGeneratedAt'
            );
            const forfeitPreview = ratingService.previewForfeit({
                currentRankKey: profile.currentRankKey,
                currentDivision: profile.currentDivision,
                currentRP: profile.currentRP,
            });
            const startedAt = serviceDate(now);
            const debate = normalizeDebate(
                await repo.insertLadderDebate(client, {
                    accountId,
                    installationId,
                    requestId,
                    philosopher,
                    debateMode,
                    profile,
                    configuration,
                    generatedTopic,
                    topicGeneratedAt,
                    forfeitRPLossPreview: forfeitPreview.rpLoss,
                    startedAt,
                }),
                accountId
            );

            if (!(await repo.completeStartRequest(client, {
                accountId,
                requestId,
                completedAt: startedAt,
            }))) {
                fail(
                    'ranked_start_request_not_completed',
                    'The Ranked start request could not be completed.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                created: true,
                configuration,
                profile,
                debate,
            });
        });
    }

    async function startLadderDebate({
        installationId,
        accessToken,
        requestId,
        philosopherId,
        debateMode,
    }) {
        const cleanRequestId = requireRequestId(requestId);
        const philosopher = requireCanonicalPhilosopher(philosopherId);
        const cleanDebateMode = requireMode(debateMode);
        const authorization = await authorize({ installationId, accessToken });

        await requirePro(authorization.accountId);

        let reservation;

        try {
            reservation = await reserve({
                accountId: authorization.accountId,
                requestId: cleanRequestId,
                philosopher,
                debateMode: cleanDebateMode,
            });
        } catch (error) {
            const conflict = postgresConflict(error);
            if (conflict) throw conflict;
            if (error instanceof AccountRankedLadderError) throw error;

            fail(
                'ranked_ladder_unavailable',
                'The Ranked ladder is temporarily unavailable.',
                { status: 503, retryable: true, cause: error }
            );
        }

        if (reservation.action === 'existing') {
            return Object.freeze({
                schemaVersion: RANKED_LADDER_SCHEMA_VERSION,
                accountId: authorization.accountId,
                installationId: authorization.installationId,
                requestId: cleanRequestId,
                created: false,
                configuration: reservation.configuration,
                profile: reservation.profile,
                activeDebate: reservation.debate,
            });
        }

        let generatedTopic;

        try {
            const rawTopic = await topicGeneratorService.generateTopic({
                philosopherId: philosopher.id,
                debateMode: cleanDebateMode,
                recentTopics: reservation.recentTopics,
            });

            generatedTopic = normalizeGeneratedTopic(
                rawTopic,
                philosopher,
                cleanDebateMode
            );
        } catch (error) {
            const publicError = mapDependencyError(error, {
                code: 'ranked_topic_generation_failed',
                message: 'A fresh Ranked topic could not be generated.',
                status: 503,
                retryable: true,
            });

            await markReservedRequestFailed({
                accountId: authorization.accountId,
                requestId: cleanRequestId,
                error: publicError,
            });

            throw publicError;
        }

        let finalized;

        try {
            finalized = await finalize({
                accountId: authorization.accountId,
                installationId: authorization.installationId,
                requestId: cleanRequestId,
                philosopher,
                debateMode: cleanDebateMode,
                reservation,
                generatedTopic,
            });
        } catch (error) {
            const conflict = postgresConflict(error);
            const publicError = conflict ?? (
                error instanceof AccountRankedLadderError
                    ? error
                    : new AccountRankedLadderError(
                        'ranked_ladder_unavailable',
                        'The Ranked ladder is temporarily unavailable.',
                        { status: 503, retryable: true, cause: error }
                    )
            );

            await markReservedRequestFailed({
                accountId: authorization.accountId,
                requestId: cleanRequestId,
                error: publicError,
            });

            throw publicError;
        }

        return Object.freeze({
            schemaVersion: RANKED_LADDER_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            requestId: cleanRequestId,
            created: finalized.created,
            configuration: finalized.configuration,
            profile: finalized.profile,
            activeDebate: finalized.debate,
        });
    }

    return Object.freeze({
        startLadderDebate,
    });
}

export const accountRankedLadderConstants = Object.freeze({
    schemaVersion: RANKED_LADDER_SCHEMA_VERSION,
    startLeaseMs: START_LEASE_MS,
    recentTopicLimit: RECENT_TOPIC_LIMIT,
    topicModelProvider: TOPIC_MODEL_PROVIDER,
});
