import { randomUUID } from 'node:crypto';

import {
    isRankedPhilosopherID,
    requireRankedPhilosopher,
} from './rankedPhilosopherCatalog.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const TOPIC_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const RANKED_PLACEMENT_SCHEMA_VERSION = 1;
const START_LEASE_MS = 10 * 60 * 1000;
const RECENT_TOPIC_LIMIT = 50;
const TOPIC_MODEL_PROVIDER = 'anthropic';

const PLACEMENT_SEQUENCE = Object.freeze([
    Object.freeze({ trialNumber: 1, requiredMode: 'guided', weightBasisPoints: 1500 }),
    Object.freeze({ trialNumber: 2, requiredMode: 'balanced', weightBasisPoints: 2000 }),
    Object.freeze({ trialNumber: 3, requiredMode: 'balanced', weightBasisPoints: 2000 }),
    Object.freeze({ trialNumber: 4, requiredMode: 'relentless', weightBasisPoints: 2000 }),
    Object.freeze({ trialNumber: 5, requiredMode: 'relentless', weightBasisPoints: 2500 }),
]);

export class AccountRankedPlacementError extends Error {
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
        this.name = 'AccountRankedPlacementError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(code, message, options) {
    throw new AccountRankedPlacementError(code, message, options);
}

function requireString(
    value,
    fieldName,
    {
        maximumLength = 16_384,
        minimumLength = 1,
        pattern = null,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_placement_request',
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
            'invalid_ranked_placement_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return cleaned;
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
    }).toLowerCase();
}

function requireCanonicalPhilosopher(value) {
    const philosopherId = requireString(value, 'philosopherId', {
        maximumLength: 100,
    }).toLowerCase();

    if (!isRankedPhilosopherID(philosopherId)) {
        fail(
            'invalid_ranked_philosopher',
            'A canonical Ranked philosopher ID is required.',
            { status: 400 }
        );
    }

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
    const value = now();
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_ranked_placement_configuration',
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
            'ranked_placement_state_unavailable',
            `Ranked state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return date;
}

function normalizeInteger(value, fieldName, minimum, maximum) {
    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'ranked_placement_state_unavailable',
            `Ranked state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return parsed;
}

function normalizeText(value, fieldName, maximumLength) {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximumLength
    ) {
        fail(
            'ranked_placement_state_unavailable',
            `Ranked state contains an invalid ${fieldName}.`,
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

    const configurationKey = rowValue(row, 'configuration_key', 'configurationKey');

    if (configurationKey !== 'global') {
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

function requirePlacementEnabled(configuration) {
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

    if (!configuration.placementsEnabled) {
        fail(
            'ranked_placements_disabled',
            'Ranked placements are not currently available.',
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

    const accountId = rowValue(row, 'account_id', 'accountId');

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked profile belongs to a different account.',
            { status: 503 }
        );
    }

    const placementStatus = rowValue(row, 'placement_status', 'placementStatus');

    if (!['not_started', 'in_progress', 'completed'].includes(placementStatus)) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile contains an invalid placement status.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        accountId,
        placementStatus,
        placementTrialsCompleted: normalizeInteger(
            rowValue(row, 'placement_trials_completed', 'placementTrialsCompleted'),
            'profile.placementTrialsCompleted',
            0,
            5
        ),
        stateVersion: normalizeInteger(
            rowValue(row, 'state_version', 'stateVersion'),
            'profile.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
        updatedAt: normalizeDate(rowValue(row, 'updated_at', 'updatedAt'), 'profile.updatedAt'),
    });
}

function normalizeTrial(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_placement_state_unavailable',
            'The next Ranked placement trial is unavailable.',
            { status: 503, retryable: true }
        );
    }

    const accountId = rowValue(row, 'account_id', 'accountId');

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked placement trial belongs to a different account.',
            { status: 503 }
        );
    }

    const trialNumber = normalizeInteger(
        rowValue(row, 'trial_number', 'trialNumber'),
        'placementTrial.trialNumber',
        1,
        5
    );
    const expected = PLACEMENT_SEQUENCE[trialNumber - 1];
    const requiredMode = rowValue(row, 'required_mode', 'requiredMode');
    const weightBasisPoints = normalizeInteger(
        rowValue(row, 'weight_basis_points', 'weightBasisPoints'),
        'placementTrial.weightBasisPoints',
        1,
        10_000
    );

    if (
        requiredMode !== expected.requiredMode ||
        weightBasisPoints !== expected.weightBasisPoints
    ) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement sequence is invalid.',
            { status: 503 }
        );
    }

    const status = rowValue(row, 'status', 'status');

    if (!['pending', 'active', 'completed', 'forfeited', 'invalid'].includes(status)) {
        fail(
            'ranked_placement_state_unavailable',
            'The Ranked placement trial contains an invalid status.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        trialNumber,
        requiredMode,
        weightBasisPoints,
        status,
        rankedDebateId: rowValue(row, 'ranked_debate_id', 'rankedDebateId') ?? null,
        philosopherId: rowValue(row, 'philosopher_id', 'philosopherId') ?? null,
        philosopherName: rowValue(row, 'philosopher_name', 'philosopherName') ?? null,
        topicFingerprint: rowValue(row, 'topic_fingerprint', 'topicFingerprint') ?? null,
        startedAt: normalizeDate(
            rowValue(row, 'started_at', 'startedAt'),
            'placementTrial.startedAt',
            { optional: true }
        ),
        updatedAt: normalizeDate(rowValue(row, 'updated_at', 'updatedAt'), 'placementTrial.updatedAt'),
    });
}

function normalizeDebate(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_debate_unavailable',
            'The Ranked debate is unavailable.',
            { status: 503, retryable: true }
        );
    }

    const accountId = rowValue(row, 'account_id', 'accountId');

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked debate belongs to a different account.',
            { status: 503 }
        );
    }

    const id = String(rowValue(row, 'id', 'id') ?? '').trim().toLowerCase();
    const startRequestId = String(
        rowValue(row, 'start_request_id', 'startRequestId') ?? ''
    ).trim().toLowerCase();
    const debateKind = rowValue(row, 'debate_kind', 'debateKind');
    const status = rowValue(row, 'status', 'status');
    const debateMode = rowValue(row, 'debate_mode', 'debateMode');

    if (!UUID_RE.test(id) || !UUID_RE.test(startRequestId)) {
        fail(
            'ranked_debate_unavailable',
            'The Ranked debate contains an invalid identifier.',
            { status: 503, retryable: true }
        );
    }

    if (
        debateKind !== 'placement' ||
        !['active', 'completed', 'forfeited', 'invalid', 'voided'].includes(status) ||
        !['guided', 'balanced', 'relentless'].includes(debateMode)
    ) {
        fail(
            'ranked_debate_unavailable',
            'The Ranked debate contains invalid placement state.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        id,
        accountId,
        startRequestId,
        debateKind,
        placementTrialNumber: normalizeInteger(
            rowValue(row, 'placement_trial_number', 'placementTrialNumber'),
            'debate.placementTrialNumber',
            1,
            5
        ),
        status,
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
        debateMode,
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
            'The generated Ranked topic did not match the reserved placement.',
            { status: 503, retryable: true }
        );
    }

    const topic = requireGeneratedString(result.topic, 'generatedTopic.topic', {
        minimumLength: 30,
        maximumLength: 220,
    });
    const openingQuestion = requireGeneratedString(
        result.openingQuestion,
        'generatedTopic.openingQuestion',
        {
            minimumLength: 20,
            maximumLength: 280,
        }
    );
    const topicNormalized = requireGeneratedString(
        result.topicNormalized,
        'generatedTopic.topicNormalized',
        { maximumLength: 220 }
    );
    const topicFingerprint = requireGeneratedString(
        result.topicFingerprint,
        'generatedTopic.topicFingerprint',
        { maximumLength: 64, pattern: TOPIC_FINGERPRINT_RE }
    );
    const theme = requireGeneratedString(result.theme, 'generatedTopic.theme', {
        minimumLength: 2,
        maximumLength: 120,
    });
    const model = requireGeneratedString(result.model, 'generatedTopic.model', {
        maximumLength: 200,
    });
    const generatorVersion = requireGeneratedString(
        result.generatorVersion,
        'generatedTopic.generatorVersion',
        { maximumLength: 100 }
    );

    return Object.freeze({
        philosopherId: expectedPhilosopher.id,
        philosopherName: expectedPhilosopher.name,
        debateMode: expectedMode,
        topic,
        openingQuestion,
        topicNormalized,
        topicFingerprint,
        theme,
        model,
        generatorVersion,
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

function validateRequestIdentity(row, requestId, philosopher) {
    const storedRequestId = String(rowValue(row, 'request_id', 'requestId') ?? '').toLowerCase();
    const storedKind = rowValue(row, 'debate_kind', 'debateKind');
    const storedPhilosopherId = rowValue(row, 'philosopher_id', 'philosopherId');

    if (
        storedRequestId !== requestId ||
        storedKind !== 'placement' ||
        storedPhilosopherId !== philosopher.id
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
    if (error instanceof AccountRankedPlacementError) return error;

    const code = typeof error?.code === 'string' && error.code
        ? error.code
        : fallback.code;
    const status = Number.isInteger(error?.status)
        ? error.status
        : fallback.status;

    return new AccountRankedPlacementError(
        code,
        error?.message || fallback.message,
        {
            status,
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
        return new AccountRankedPlacementError(
            'ranked_active_debate_exists',
            'This account already has an active Ranked debate.',
            { status: 409 }
        );
    }

    if (
        error?.code === '23505' &&
        constraint === 'account_ranked_start_requests_one_in_flight_idx'
    ) {
        return new AccountRankedPlacementError(
            'ranked_start_in_progress',
            'A Ranked debate is already being prepared for this account.',
            { status: 409, retryable: true }
        );
    }

    if (
        error?.code === '23505' &&
        (
            constraint === 'account_ranked_debates_one_placement_trial_idx' ||
            constraint === 'account_ranked_placement_trials_no_repeat_philosopher_idx'
        )
    ) {
        return new AccountRankedPlacementError(
            'ranked_placement_conflict',
            'The Ranked placement state changed before this debate could begin.',
            { status: 409, retryable: true }
        );
    }

    return null;
}

export function createPostgresAccountRankedPlacementRepository(pool) {
    if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
        fail(
            'invalid_ranked_placement_configuration',
            'A PostgreSQL pool is required.'
        );
    }

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

        async ensureFoundation(client, { accountId }) {
            await client.query(
                `
                    /* account-ranked-placement:ensure-profile */
                    INSERT INTO account_ranked_profiles (
                        account_id
                    )
                    VALUES ($1)
                    ON CONFLICT (account_id)
                    DO NOTHING
                `,
                [accountId]
            );

            await client.query(
                `
                    /* account-ranked-placement:ensure-trials */
                    INSERT INTO account_ranked_placement_trials (
                        account_id,
                        trial_number,
                        required_mode,
                        weight_basis_points
                    )
                    VALUES
                        ($1, 1, 'guided', 1500),
                        ($1, 2, 'balanced', 2000),
                        ($1, 3, 'balanced', 2000),
                        ($1, 4, 'relentless', 2000),
                        ($1, 5, 'relentless', 2500)
                    ON CONFLICT (account_id, trial_number)
                    DO NOTHING
                `,
                [accountId]
            );
        },

        async lockProfile(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:lock-profile */
                    SELECT
                        account_id,
                        placement_status,
                        placement_trials_completed,
                        state_version,
                        updated_at
                    FROM account_ranked_profiles
                    WHERE account_id = $1
                    FOR UPDATE
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async loadConfiguration(client) {
            const result = await client.query(
                `
                    /* account-ranked-placement:load-configuration */
                    SELECT
                        configuration_key,
                        is_enabled,
                        allow_new_debates,
                        allow_resume_active_debates,
                        placements_enabled,
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
                    /* account-ranked-placement:find-request */
                    SELECT *
                    FROM account_ranked_start_requests
                    WHERE account_id = $1
                      AND request_id = $2
                    FOR UPDATE
                `,
                [accountId, requestId]
            );

            return result.rows[0] ?? null;
        },

        async findOtherInFlightRequestForUpdate(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:find-other-in-flight */
                    SELECT *
                    FROM account_ranked_start_requests
                    WHERE account_id = $1
                      AND request_id <> $2
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
                    /* account-ranked-placement:find-active-debate */
                    SELECT
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
                        model_provider,
                        model_name,
                        state_version,
                        started_at,
                        last_activity_at
                    FROM account_ranked_debates
                    WHERE account_id = $1
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
                    /* account-ranked-placement:find-debate-by-request */
                    SELECT
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
                        model_provider,
                        model_name,
                        state_version,
                        started_at,
                        last_activity_at
                    FROM account_ranked_debates
                    WHERE account_id = $1
                      AND start_request_id = $2
                    LIMIT 1
                `,
                [accountId, requestId]
            );

            return result.rows[0] ?? null;
        },

        async findNextPendingTrialForUpdate(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:find-next-trial */
                    SELECT
                        account_id,
                        trial_number,
                        required_mode,
                        weight_basis_points,
                        status,
                        ranked_debate_id,
                        philosopher_id,
                        philosopher_name,
                        topic_fingerprint,
                        started_at,
                        updated_at
                    FROM account_ranked_placement_trials
                    WHERE account_id = $1
                      AND status = 'pending'
                    ORDER BY trial_number ASC
                    LIMIT 1
                    FOR UPDATE
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async findTrialByNumber(client, { accountId, trialNumber }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:find-trial-by-number */
                    SELECT
                        account_id,
                        trial_number,
                        required_mode,
                        weight_basis_points,
                        status,
                        ranked_debate_id,
                        philosopher_id,
                        philosopher_name,
                        topic_fingerprint,
                        started_at,
                        updated_at
                    FROM account_ranked_placement_trials
                    WHERE account_id = $1
                      AND trial_number = $2
                    LIMIT 1
                `,
                [accountId, trialNumber]
            );

            return result.rows[0] ?? null;
        },

        async findActiveTrial(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:find-active-trial */
                    SELECT trial_number
                    FROM account_ranked_placement_trials
                    WHERE account_id = $1
                      AND status = 'active'
                    LIMIT 1
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async listUsedPhilosopherIds(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:list-used-philosophers */
                    SELECT philosopher_id
                    FROM account_ranked_placement_trials
                    WHERE account_id = $1
                      AND philosopher_id IS NOT NULL
                    ORDER BY trial_number ASC
                `,
                [accountId]
            );

            return result.rows.map((row) => row.philosopher_id);
        },

        async listRecentTopics(client, { accountId, limit }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:list-recent-topics */
                    SELECT topic
                    FROM account_ranked_debates
                    WHERE account_id = $1
                    ORDER BY created_at DESC, id DESC
                    LIMIT $2
                `,
                [accountId, limit]
            );

            return result.rows.map((row) => row.topic);
        },

        async insertStartRequest(
            client,
            {
                accountId,
                requestId,
                trial,
                philosopher,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-placement:insert-request */
                    INSERT INTO account_ranked_start_requests (
                        account_id,
                        request_id,
                        debate_kind,
                        placement_trial_number,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        status,
                        attempt_count
                    )
                    VALUES (
                        $1,
                        $2,
                        'placement',
                        $3,
                        $4,
                        $5,
                        $6,
                        'reserved',
                        1
                    )
                    RETURNING *
                `,
                [
                    accountId,
                    requestId,
                    trial.trialNumber,
                    philosopher.id,
                    philosopher.name,
                    trial.requiredMode,
                ]
            );

            return result.rows[0];
        },

        async reviveStartRequest(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:revive-request */
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
                        attempt_count = attempt_count + 1,
                        updated_at = CURRENT_TIMESTAMP,
                        completed_at = NULL
                    WHERE account_id = $1
                      AND request_id = $2
                      AND attempt_count < 100
                    RETURNING *
                `,
                [accountId, requestId]
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
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-placement:fail-request */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'failed',
                        failure_code = $3,
                        failure_retryable = $4,
                        updated_at = CURRENT_TIMESTAMP,
                        completed_at = CURRENT_TIMESTAMP
                    WHERE account_id = $1
                      AND request_id = $2
                      AND status IN ('reserved', 'topic_generated')
                    RETURNING request_id
                `,
                [accountId, requestId, failureCode, failureRetryable]
            );

            return result.rowCount === 1;
        },

        async storeGeneratedTopic(
            client,
            {
                accountId,
                requestId,
                generatedTopic,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-placement:store-topic */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'topic_generated',
                        topic = $3,
                        topic_normalized = $4,
                        topic_fingerprint = $5,
                        topic_theme = $6,
                        topic_model_provider = $7,
                        topic_model_name = $8,
                        topic_generator_version = $9,
                        opening_question = $10,
                        topic_generated_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE account_id = $1
                      AND request_id = $2
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
                ]
            );

            return result.rows[0] ?? null;
        },

        async insertPlacementDebate(
            client,
            {
                accountId,
                installationId,
                requestId,
                trial,
                philosopher,
                configuration,
                generatedTopic,
                topicGeneratedAt,
            }
        ) {
            const openingMessage =
                createSeededOpeningMessage({
                    requestId,
                    openingQuestion:
                        generatedTopic.openingQuestion,
                    completedAt:
                        topicGeneratedAt,
                });

            const result = await client.query(
                `
                    /* account-ranked-placement:insert-debate */
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
                        opening_question,
                        messages
                    )
                    VALUES (
                        $1,
                        $2,
                        'placement',
                        $3,
                        'active',
                        $4,
                        $5,
                        $6,
                        $7,
                        'system_generated',
                        $8,
                        $9,
                        $10,
                        $11,
                        $12,
                        $13,
                        $14,
                        $15,
                        $16,
                        $17,
                        $18,
                        $19,
                        $20,
                        $21,
                        $21,
                        $22,
                        $23::jsonb
                    )
                    RETURNING
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
                        model_provider,
                        model_name,
                        state_version,
                        started_at,
                        last_activity_at
                `,
                [
                    accountId,
                    requestId,
                    trial.trialNumber,
                    philosopher.id,
                    philosopher.name,
                    trial.requiredMode,
                    generatedTopic.topic,
                    generatedTopic.topicFingerprint,
                    generatedTopic.theme,
                    TOPIC_MODEL_PROVIDER,
                    generatedTopic.model,
                    topicGeneratedAt,
                    configuration.rankedRulesVersion,
                    configuration.philosopherPromptVersion,
                    configuration.scoringPromptVersion,
                    configuration.reportPromptVersion,
                    configuration.topicGeneratorVersion,
                    configuration.rpFormulaVersion,
                    configuration.debateModelProvider,
                    configuration.debateModelName,
                    installationId,
                    generatedTopic.openingQuestion,
                    JSON.stringify([
                        openingMessage,
                    ]),
                ]
            );

            return result.rows[0] ?? null;
        },

        async activatePlacementTrial(
            client,
            {
                accountId,
                trialNumber,
                debateId,
                philosopher,
                topicFingerprint,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-placement:activate-trial */
                    UPDATE account_ranked_placement_trials
                    SET
                        status = 'active',
                        ranked_debate_id = $3,
                        philosopher_id = $4,
                        philosopher_name = $5,
                        topic_fingerprint = $6,
                        started_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE account_id = $1
                      AND trial_number = $2
                      AND status = 'pending'
                    RETURNING
                        account_id,
                        trial_number,
                        required_mode,
                        weight_basis_points,
                        status,
                        ranked_debate_id,
                        philosopher_id,
                        philosopher_name,
                        topic_fingerprint,
                        started_at,
                        updated_at
                `,
                [
                    accountId,
                    trialNumber,
                    debateId,
                    philosopher.id,
                    philosopher.name,
                    topicFingerprint,
                ]
            );

            return result.rows[0] ?? null;
        },

        async markProfilePlacementStarted(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:mark-profile-started */
                    UPDATE account_ranked_profiles
                    SET
                        placement_status = 'in_progress',
                        state_version = state_version + 1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE account_id = $1
                      AND placement_status IN ('not_started', 'in_progress')
                    RETURNING
                        account_id,
                        placement_status,
                        placement_trials_completed,
                        state_version,
                        updated_at
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async completeStartRequest(client, { accountId, requestId }) {
            const result = await client.query(
                `
                    /* account-ranked-placement:complete-request */
                    UPDATE account_ranked_start_requests
                    SET
                        status = 'completed',
                        updated_at = CURRENT_TIMESTAMP,
                        completed_at = CURRENT_TIMESTAMP
                    WHERE account_id = $1
                      AND request_id = $2
                      AND status = 'topic_generated'
                    RETURNING request_id
                `,
                [accountId, requestId]
            );

            return result.rowCount === 1;
        },
    });
}

export function createAccountRankedPlacementService({
    pool = null,
    repository = null,
    accountAuthService,
    proAccessService,
    topicGeneratorService,
    now = () => Date.now(),
    startLeaseMs = START_LEASE_MS,
} = {}) {
    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
        fail(
            'invalid_ranked_placement_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (!proAccessService || typeof proAccessService.requireCurrentProAccess !== 'function') {
        fail(
            'invalid_ranked_placement_configuration',
            'proAccessService.requireCurrentProAccess() is required.'
        );
    }

    if (!topicGeneratorService || typeof topicGeneratorService.generateTopic !== 'function') {
        fail(
            'invalid_ranked_placement_configuration',
            'topicGeneratorService.generateTopic() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail('invalid_ranked_placement_configuration', 'now must be a function.');
    }

    if (!Number.isSafeInteger(startLeaseMs) || startLeaseMs < 60_000) {
        fail(
            'invalid_ranked_placement_configuration',
            'startLeaseMs must be at least 60000 milliseconds.'
        );
    }

    const repo = repository ?? createPostgresAccountRankedPlacementRepository(pool);
    const requiredRepositoryMethods = [
        'withTransaction',
        'ensureFoundation',
        'lockProfile',
        'loadConfiguration',
        'findStartRequestForUpdate',
        'findOtherInFlightRequestForUpdate',
        'findActiveDebate',
        'findDebateByStartRequest',
        'findNextPendingTrialForUpdate',
        'findTrialByNumber',
        'findActiveTrial',
        'listUsedPhilosopherIds',
        'listRecentTopics',
        'insertStartRequest',
        'reviveStartRequest',
        'markStartRequestFailed',
        'storeGeneratedTopic',
        'insertPlacementDebate',
        'activatePlacementTrial',
        'markProfilePlacementStarted',
        'completeStartRequest',
    ];

    for (const method of requiredRepositoryMethods) {
        if (typeof repo?.[method] !== 'function') {
            fail(
                'invalid_ranked_placement_configuration',
                `Ranked placement repository is missing ${method}().`
            );
        }
    }

    async function authorize({ installationId, accessToken }) {
        const cleanInstallationId = requireInstallationId(installationId);
        const cleanAccessToken = requireString(accessToken, 'accessToken', {
            maximumLength: 16_384,
        });

        try {
            return await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
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

    async function failReservedRequest({ accountId, requestId, error }) {
        const failureCode = requireString(
            typeof error?.code === 'string' ? error.code : 'ranked_start_failed',
            'failureCode',
            { maximumLength: 100 }
        );
        const failureRetryable = Boolean(error?.retryable);

        try {
            await repo.withTransaction(async (client) => {
                await repo.markStartRequestFailed(client, {
                    accountId,
                    requestId,
                    failureCode,
                    failureRetryable,
                });
            });
        } catch {
            // Preserve the original public error. A later stale-request takeover
            // can recover an unmarked reservation if this cleanup also fails.
        }
    }

    async function reserve({ accountId, installationId, requestId, philosopher }) {
        const checkedAt = serviceDate(now);
        const staleBefore = new Date(checkedAt.getTime() - startLeaseMs);

        return repo.withTransaction(async (client) => {
            await repo.ensureFoundation(client, { accountId });
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
                validateRequestIdentity(request, requestId, philosopher);

                if (rowValue(request, 'status', 'status') === 'completed') {
                    const existingDebate = await repo.findDebateByStartRequest(client, {
                        accountId,
                        requestId,
                    });

                    if (!existingDebate) {
                        fail(
                            'ranked_placement_state_unavailable',
                            'The completed Ranked start request has no debate.',
                            { status: 503, retryable: true }
                        );
                    }

                    const normalizedDebate = normalizeDebate(existingDebate, accountId);
                    const existingTrial = normalizeTrial(
                        await repo.findTrialByNumber(client, {
                            accountId,
                            trialNumber: normalizedDebate.placementTrialNumber,
                        }),
                        accountId
                    );

                    return Object.freeze({
                        action: 'existing',
                        configuration,
                        profile,
                        trial: existingTrial,
                        debate: normalizedDebate,
                    });
                }
            }

            requirePlacementEnabled(configuration);

            const activeDebateRow = await repo.findActiveDebate(client, { accountId });

            if (activeDebateRow) {
                const activeDebate = normalizeDebate(activeDebateRow, accountId);

                if (activeDebate.startRequestId === requestId) {
                    const existingTrial = normalizeTrial(
                        await repo.findTrialByNumber(client, {
                            accountId,
                            trialNumber: activeDebate.placementTrialNumber,
                        }),
                        accountId
                    );

                    return Object.freeze({
                        action: 'existing',
                        configuration,
                        profile,
                        trial: existingTrial,
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

                await repo.markStartRequestFailed(client, {
                    accountId,
                    requestId: String(rowValue(otherInFlight, 'request_id', 'requestId')).toLowerCase(),
                    failureCode: 'ranked_start_abandoned',
                    failureRetryable: true,
                });
            }

            if (request) {
                const status = rowValue(request, 'status', 'status');

                if (status === 'failed') {
                    if (rowValue(request, 'failure_retryable', 'failureRetryable') !== true) {
                        fail(
                            'ranked_start_request_failed',
                            'This Ranked start request cannot be retried.',
                            { status: 409, retryable: false }
                        );
                    }

                    request = await repo.reviveStartRequest(client, { accountId, requestId });
                } else if (status === 'reserved' || status === 'topic_generated') {
                    if (!isStale(request, staleBefore)) {
                        fail(
                            'ranked_start_in_progress',
                            'This Ranked debate is still being prepared.',
                            { status: 409, retryable: true }
                        );
                    }

                    request = await repo.reviveStartRequest(client, { accountId, requestId });
                } else {
                    fail(
                        'ranked_placement_state_unavailable',
                        'The Ranked start request has an invalid status.',
                        { status: 503, retryable: true }
                    );
                }

                if (!request) {
                    fail(
                        'ranked_start_retry_exhausted',
                        'This Ranked start request has exceeded its retry limit.',
                        { status: 409, retryable: false }
                    );
                }
            }

            if (profile.placementStatus === 'completed') {
                fail(
                    'ranked_placements_completed',
                    'This account has already completed Ranked placements.',
                    { status: 409 }
                );
            }

            const activeTrial = await repo.findActiveTrial(client, { accountId });

            if (activeTrial) {
                fail(
                    'ranked_placement_state_unavailable',
                    'A placement trial is active without an active Ranked debate.',
                    { status: 503, retryable: true }
                );
            }

            const trial = normalizeTrial(
                await repo.findNextPendingTrialForUpdate(client, { accountId }),
                accountId
            );

            if (trial.status !== 'pending') {
                fail(
                    'ranked_placement_state_unavailable',
                    'The next Ranked placement trial is not pending.',
                    { status: 503, retryable: true }
                );
            }

            const usedPhilosophers = await repo.listUsedPhilosopherIds(client, { accountId });

            if (usedPhilosophers.includes(philosopher.id)) {
                fail(
                    'ranked_placement_philosopher_already_used',
                    'Each Ranked placement trial must use a different philosopher.',
                    { status: 409 }
                );
            }

            if (!request) {
                request = await repo.insertStartRequest(client, {
                    accountId,
                    requestId,
                    trial,
                    philosopher,
                });
            } else {
                const storedTrialNumber = normalizeInteger(
                    rowValue(request, 'placement_trial_number', 'placementTrialNumber'),
                    'startRequest.placementTrialNumber',
                    1,
                    5
                );
                const storedMode = rowValue(request, 'debate_mode', 'debateMode');

                if (
                    storedTrialNumber !== trial.trialNumber ||
                    storedMode !== trial.requiredMode
                ) {
                    fail(
                        'ranked_start_request_stale',
                        'This Ranked start request no longer matches the next placement trial.',
                        { status: 409, retryable: false }
                    );
                }
            }

            const recentTopics = await repo.listRecentTopics(client, {
                accountId,
                limit: RECENT_TOPIC_LIMIT,
            });

            return Object.freeze({
                action: 'generate',
                profile,
                configuration,
                trial,
                philosopher,
                recentTopics: Object.freeze(recentTopics),
                installationId,
            });
        });
    }

    async function finalize({
        accountId,
        installationId,
        requestId,
        philosopher,
        reservation,
        generatedTopic,
    }) {
        return repo.withTransaction(async (client) => {
            const profile = normalizeProfile(
                await repo.lockProfile(client, { accountId }),
                accountId
            );
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

            validateRequestIdentity(request, requestId, philosopher);

            if (rowValue(request, 'status', 'status') === 'completed') {
                const existingDebate = await repo.findDebateByStartRequest(client, {
                    accountId,
                    requestId,
                });

                if (!existingDebate) {
                    fail(
                        'ranked_placement_state_unavailable',
                        'The completed Ranked start request has no debate.',
                        { status: 503, retryable: true }
                    );
                }

                const normalizedDebate = normalizeDebate(existingDebate, accountId);
                const existingTrial = normalizeTrial(
                    await repo.findTrialByNumber(client, {
                        accountId,
                        trialNumber: normalizedDebate.placementTrialNumber,
                    }),
                    accountId
                );

                return Object.freeze({
                    created: false,
                    configuration: reservation.configuration,
                    profile,
                    trial: existingTrial,
                    debate: normalizedDebate,
                });
            }

            if (rowValue(request, 'status', 'status') !== 'reserved') {
                fail(
                    'ranked_start_request_not_reserved',
                    'The Ranked start request is no longer reserved.',
                    { status: 409, retryable: true }
                );
            }

            const configuration = normalizeConfiguration(
                await repo.loadConfiguration(client)
            );
            requirePlacementEnabled(configuration);

            if (generatedTopic.generatorVersion !== configuration.topicGeneratorVersion) {
                fail(
                    'ranked_topic_version_mismatch',
                    'The Ranked topic generator version does not match the active Ranked configuration.',
                    { status: 503, retryable: false }
                );
            }

            const activeDebateRow = await repo.findActiveDebate(client, { accountId });

            if (activeDebateRow) {
                const activeDebate = normalizeDebate(activeDebateRow, accountId);

                if (activeDebate.startRequestId === requestId) {
                    const existingTrial = normalizeTrial(
                        await repo.findTrialByNumber(client, {
                            accountId,
                            trialNumber: activeDebate.placementTrialNumber,
                        }),
                        accountId
                    );

                    return Object.freeze({
                        created: false,
                        configuration,
                        profile,
                        trial: existingTrial,
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

            const trial = normalizeTrial(
                await repo.findNextPendingTrialForUpdate(client, { accountId }),
                accountId
            );

            if (
                trial.trialNumber !== reservation.trial.trialNumber ||
                trial.requiredMode !== reservation.trial.requiredMode
            ) {
                fail(
                    'ranked_placement_state_changed',
                    'The Ranked placement state changed while the topic was being generated.',
                    { status: 409, retryable: true }
                );
            }

            const usedPhilosophers = await repo.listUsedPhilosopherIds(client, { accountId });

            if (usedPhilosophers.includes(philosopher.id)) {
                fail(
                    'ranked_placement_philosopher_already_used',
                    'Each Ranked placement trial must use a different philosopher.',
                    { status: 409 }
                );
            }

            const storedTopic = await repo.storeGeneratedTopic(client, {
                accountId,
                requestId,
                generatedTopic,
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

            const debateRow = await repo.insertPlacementDebate(client, {
                accountId,
                installationId,
                requestId,
                trial,
                philosopher,
                configuration,
                generatedTopic,
                topicGeneratedAt,
            });
            const debate = normalizeDebate(debateRow, accountId);

            const trialRow = await repo.activatePlacementTrial(client, {
                accountId,
                trialNumber: trial.trialNumber,
                debateId: debate.id,
                philosopher,
                topicFingerprint: generatedTopic.topicFingerprint,
            });

            if (!trialRow) {
                fail(
                    'ranked_placement_state_changed',
                    'The placement trial could not be activated.',
                    { status: 409, retryable: true }
                );
            }

            const updatedProfileRow = await repo.markProfilePlacementStarted(client, {
                accountId,
            });

            if (!updatedProfileRow) {
                fail(
                    'ranked_placement_state_changed',
                    'The Ranked profile could not begin placements.',
                    { status: 409, retryable: true }
                );
            }

            if (!(await repo.completeStartRequest(client, { accountId, requestId }))) {
                fail(
                    'ranked_start_request_not_completed',
                    'The Ranked start request could not be completed.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                created: true,
                configuration,
                profile: normalizeProfile(updatedProfileRow, accountId),
                trial: normalizeTrial(trialRow, accountId),
                debate,
            });
        });
    }

    async function startPlacement({
        installationId,
        accessToken,
        requestId,
        philosopherId,
    }) {
        const cleanRequestId = requireRequestId(requestId);
        const philosopher = requireCanonicalPhilosopher(philosopherId);
        const authorization = await authorize({ installationId, accessToken });
        const accountId = String(authorization.accountId ?? '').toLowerCase();
        const authorizedInstallationId = requireInstallationId(
            authorization.installationId ?? installationId
        );

        if (!UUID_RE.test(accountId)) {
            fail(
                'ranked_authentication_unavailable',
                'Account authentication returned an invalid account ID.',
                { status: 503, retryable: true }
            );
        }

        await requirePro(accountId);

        let reservation;

        try {
            reservation = await reserve({
                accountId,
                installationId: authorizedInstallationId,
                requestId: cleanRequestId,
                philosopher,
            });
        } catch (error) {
            const conflict = postgresConflict(error);
            if (conflict) throw conflict;
            if (error instanceof AccountRankedPlacementError) throw error;

            fail(
                'ranked_placement_unavailable',
                'Ranked placement is temporarily unavailable.',
                { status: 503, retryable: true, cause: error }
            );
        }

        if (reservation.action === 'existing') {
            return Object.freeze({
                schemaVersion: RANKED_PLACEMENT_SCHEMA_VERSION,
                accountId,
                installationId: authorizedInstallationId,
                requestId: cleanRequestId,
                created: false,
                configuration: reservation.configuration,
                profile: reservation.profile,
                placementTrial: reservation.trial,
                activeDebate: reservation.debate,
            });
        }

        let generatedTopic;

        try {
            const rawGeneratedTopic = await topicGeneratorService.generateTopic({
                philosopherId: philosopher.id,
                debateMode: reservation.trial.requiredMode,
                recentTopics: reservation.recentTopics,
            });

            generatedTopic = normalizeGeneratedTopic(
                rawGeneratedTopic,
                philosopher,
                reservation.trial.requiredMode
            );
        } catch (error) {
            const publicError = mapDependencyError(error, {
                code: 'ranked_topic_generation_failed',
                message: 'A fresh Ranked topic could not be generated.',
                status: 503,
                retryable: true,
            });

            await failReservedRequest({
                accountId,
                requestId: cleanRequestId,
                error: publicError,
            });

            throw publicError;
        }

        let finalized;

        try {
            finalized = await finalize({
                accountId,
                installationId: authorizedInstallationId,
                requestId: cleanRequestId,
                philosopher,
                reservation,
                generatedTopic,
            });
        } catch (error) {
            const conflict = postgresConflict(error);
            const publicError = conflict ?? (
                error instanceof AccountRankedPlacementError
                    ? error
                    : new AccountRankedPlacementError(
                        'ranked_placement_unavailable',
                        'Ranked placement is temporarily unavailable.',
                        { status: 503, retryable: true, cause: error }
                    )
            );

            await failReservedRequest({
                accountId,
                requestId: cleanRequestId,
                error: publicError,
            });

            throw publicError;
        }

        return Object.freeze({
            schemaVersion: RANKED_PLACEMENT_SCHEMA_VERSION,
            accountId,
            installationId: authorizedInstallationId,
            requestId: cleanRequestId,
            created: finalized.created,
            configuration: finalized.configuration,
            profile: finalized.profile,
            placementTrial: finalized.trial,
            activeDebate: finalized.debate,
        });
    }

    return Object.freeze({
        startPlacement,
    });
}

export const accountRankedPlacementConstants = Object.freeze({
    schemaVersion: RANKED_PLACEMENT_SCHEMA_VERSION,
    startLeaseMs: START_LEASE_MS,
    recentTopicLimit: RECENT_TOPIC_LIMIT,
    topicModelProvider: TOPIC_MODEL_PROVIDER,
    placementSequence: PLACEMENT_SEQUENCE,
});
