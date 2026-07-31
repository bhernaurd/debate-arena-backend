const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;

const RANKED_PROFILE_SCHEMA_VERSION = 1;
const MAX_ACTIVE_DEBATE_SCORE_TEXT_LENGTH = 500;

const PLACEMENT_SEQUENCE = Object.freeze([
    Object.freeze({
        trialNumber: 1,
        requiredMode: 'guided',
        weightBasisPoints: 1500,
    }),
    Object.freeze({
        trialNumber: 2,
        requiredMode: 'balanced',
        weightBasisPoints: 2000,
    }),
    Object.freeze({
        trialNumber: 3,
        requiredMode: 'balanced',
        weightBasisPoints: 2000,
    }),
    Object.freeze({
        trialNumber: 4,
        requiredMode: 'relentless',
        weightBasisPoints: 2000,
    }),
    Object.freeze({
        trialNumber: 5,
        requiredMode: 'relentless',
        weightBasisPoints: 2500,
    }),
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

const PLACEMENT_STATUSES = new Set([
    'not_started',
    'in_progress',
    'completed',
]);

const TRIAL_STATUSES = new Set([
    'pending',
    'active',
    'completed',
    'forfeited',
    'invalid',
]);

export class AccountRankedProfileError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            cause,
        } = {}
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AccountRankedProfileError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountRankedProfileError(
        code,
        message,
        options
    );
}

function requireString(
    value,
    fieldName,
    {
        maximumLength = 16_384,
        pattern = null,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_profile_request',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (!cleaned || value.length > maximumLength) {
        fail(
            'invalid_ranked_profile_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    if (pattern && !pattern.test(cleaned)) {
        fail(
            'invalid_ranked_profile_request',
            `${fieldName} has an invalid format.`,
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

function currentServiceDate(now) {
    const milliseconds = now();

    if (
        !Number.isFinite(milliseconds) ||
        milliseconds < 0
    ) {
        fail(
            'invalid_ranked_profile_configuration',
            'now() returned an invalid value.'
        );
    }

    return new Date(milliseconds);
}

function rowValue(row, snakeCase, camelCase) {
    if (
        Object.prototype.hasOwnProperty.call(
            row,
            snakeCase
        )
    ) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeDate(
    value,
    fieldName,
    {
        optional = false,
    } = {}
) {
    if (value == null && optional) {
        return null;
    }

    const date = value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return date;
}

function normalizeInteger(
    value,
    fieldName,
    minimum,
    maximum,
    {
        optional = false,
    } = {}
) {
    if (value == null && optional) {
        return null;
    }

    const parsed = typeof value === 'number'
        ? value
        : Number(value);

    if (
        !Number.isSafeInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum
    ) {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return parsed;
}

function normalizeNumber(
    value,
    fieldName,
    minimum,
    maximum,
    {
        optional = false,
    } = {}
) {
    if (value == null && optional) {
        return null;
    }

    const parsed = typeof value === 'number'
        ? value
        : Number(value);

    if (
        !Number.isFinite(parsed) ||
        parsed < minimum ||
        parsed > maximum
    ) {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return parsed;
}

function normalizeBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return value;
}

function normalizeOptionalText(
    value,
    fieldName,
    maximumLength
) {
    if (value == null) return null;

    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximumLength
    ) {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return value.trim();
}

function normalizeRankKey(
    value,
    fieldName,
    {
        optional = false,
    } = {}
) {
    if (value == null && optional) {
        return null;
    }

    if (
        typeof value !== 'string' ||
        !RANK_KEYS.has(value)
    ) {
        fail(
            'ranked_profile_unavailable',
            `Ranked profile contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return value;
}

function normalizeConfiguration(row) {
    if (!row || typeof row !== 'object') {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        rowValue(
            row,
            'configuration_key',
            'configurationKey'
        ) !== 'global'
    ) {
        fail(
            'ranked_configuration_unavailable',
            'Ranked configuration is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        isEnabled: normalizeBoolean(
            rowValue(row, 'is_enabled', 'isEnabled'),
            'configuration.isEnabled'
        ),
        allowNewDebates: normalizeBoolean(
            rowValue(
                row,
                'allow_new_debates',
                'allowNewDebates'
            ),
            'configuration.allowNewDebates'
        ),
        allowResumeActiveDebates: normalizeBoolean(
            rowValue(
                row,
                'allow_resume_active_debates',
                'allowResumeActiveDebates'
            ),
            'configuration.allowResumeActiveDebates'
        ),
        placementsEnabled: normalizeBoolean(
            rowValue(
                row,
                'placements_enabled',
                'placementsEnabled'
            ),
            'configuration.placementsEnabled'
        ),
        ladderEnabled: normalizeBoolean(
            rowValue(
                row,
                'ladder_enabled',
                'ladderEnabled'
            ),
            'configuration.ladderEnabled'
        ),
        leaderboardEnabled: normalizeBoolean(
            rowValue(
                row,
                'leaderboard_enabled',
                'leaderboardEnabled'
            ),
            'configuration.leaderboardEnabled'
        ),
        populationLimitsEnabled: normalizeBoolean(
            rowValue(
                row,
                'population_limits_enabled',
                'populationLimitsEnabled'
            ),
            'configuration.populationLimitsEnabled'
        ),
        rankedRulesVersion: normalizeOptionalText(
            rowValue(
                row,
                'ranked_rules_version',
                'rankedRulesVersion'
            ),
            'configuration.rankedRulesVersion',
            100
        ),
        philosopherPromptVersion: normalizeOptionalText(
            rowValue(
                row,
                'philosopher_prompt_version',
                'philosopherPromptVersion'
            ),
            'configuration.philosopherPromptVersion',
            100
        ),
        scoringPromptVersion: normalizeOptionalText(
            rowValue(
                row,
                'scoring_prompt_version',
                'scoringPromptVersion'
            ),
            'configuration.scoringPromptVersion',
            100
        ),
        reportPromptVersion: normalizeOptionalText(
            rowValue(
                row,
                'report_prompt_version',
                'reportPromptVersion'
            ),
            'configuration.reportPromptVersion',
            100
        ),
        topicGeneratorVersion: normalizeOptionalText(
            rowValue(
                row,
                'topic_generator_version',
                'topicGeneratorVersion'
            ),
            'configuration.topicGeneratorVersion',
            100
        ),
        rpFormulaVersion: normalizeOptionalText(
            rowValue(
                row,
                'rp_formula_version',
                'rpFormulaVersion'
            ),
            'configuration.rpFormulaVersion',
            100
        ),
        updatedAt: normalizeDate(
            rowValue(row, 'updated_at', 'updatedAt'),
            'configuration.updatedAt'
        ),
    });
}

function normalizeProfile(row, expectedAccountId) {
    if (!row || typeof row !== 'object') {
        fail(
            'ranked_profile_unavailable',
            'Ranked profile is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId = rowValue(
        row,
        'account_id',
        'accountId'
    );

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'Ranked profile belongs to a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const placementStatus = rowValue(
        row,
        'placement_status',
        'placementStatus'
    );

    if (!PLACEMENT_STATUSES.has(placementStatus)) {
        fail(
            'ranked_profile_unavailable',
            'Ranked profile contains an invalid placement status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        accountId,
        placementStatus,
        placementTrialsCompleted: normalizeInteger(
            rowValue(
                row,
                'placement_trials_completed',
                'placementTrialsCompleted'
            ),
            'profile.placementTrialsCompleted',
            0,
            5
        ),
        placementWeightedScore: normalizeNumber(
            rowValue(
                row,
                'placement_weighted_score',
                'placementWeightedScore'
            ),
            'profile.placementWeightedScore',
            0,
            10,
            { optional: true }
        ),
        currentRankKey: normalizeRankKey(
            rowValue(
                row,
                'current_rank_key',
                'currentRankKey'
            ),
            'profile.currentRankKey',
            { optional: true }
        ),
        currentDivision: normalizeInteger(
            rowValue(
                row,
                'current_division',
                'currentDivision'
            ),
            'profile.currentDivision',
            1,
            3,
            { optional: true }
        ),
        currentRP: normalizeInteger(
            rowValue(row, 'current_rp', 'currentRP'),
            'profile.currentRP',
            0,
            99,
            { optional: true }
        ),
        peakRankKey: normalizeRankKey(
            rowValue(
                row,
                'peak_rank_key',
                'peakRankKey'
            ),
            'profile.peakRankKey',
            { optional: true }
        ),
        peakDivision: normalizeInteger(
            rowValue(
                row,
                'peak_division',
                'peakDivision'
            ),
            'profile.peakDivision',
            1,
            3,
            { optional: true }
        ),
        peakReachedAt: normalizeDate(
            rowValue(
                row,
                'peak_reached_at',
                'peakReachedAt'
            ),
            'profile.peakReachedAt',
            { optional: true }
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
        demotionProtectionReason: normalizeOptionalText(
            rowValue(
                row,
                'demotion_protection_reason',
                'demotionProtectionReason'
            ),
            'profile.demotionProtectionReason',
            50
        ),
        demotionProtectionGrantedAt: normalizeDate(
            rowValue(
                row,
                'demotion_protection_granted_at',
                'demotionProtectionGrantedAt'
            ),
            'profile.demotionProtectionGrantedAt',
            { optional: true }
        ),
        rankedDebatesCompleted: normalizeInteger(
            rowValue(
                row,
                'ranked_debates_completed',
                'rankedDebatesCompleted'
            ),
            'profile.rankedDebatesCompleted',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedForfeits: normalizeInteger(
            rowValue(
                row,
                'ranked_forfeits',
                'rankedForfeits'
            ),
            'profile.rankedForfeits',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedInvalidResults: normalizeInteger(
            rowValue(
                row,
                'ranked_invalid_results',
                'rankedInvalidResults'
            ),
            'profile.rankedInvalidResults',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        lastRankedDebateCompletedAt: normalizeDate(
            rowValue(
                row,
                'last_ranked_debate_completed_at',
                'lastRankedDebateCompletedAt'
            ),
            'profile.lastRankedDebateCompletedAt',
            { optional: true }
        ),
        stateVersion: normalizeInteger(
            rowValue(
                row,
                'state_version',
                'stateVersion'
            ),
            'profile.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
        createdAt: normalizeDate(
            rowValue(row, 'created_at', 'createdAt'),
            'profile.createdAt'
        ),
        updatedAt: normalizeDate(
            rowValue(row, 'updated_at', 'updatedAt'),
            'profile.updatedAt'
        ),
    });
}

function normalizePlacementTrial(
    row,
    expectedAccountId,
    rowIndex
) {
    if (!row || typeof row !== 'object') {
        fail(
            'ranked_profile_unavailable',
            'Ranked placement trials are unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId = rowValue(
        row,
        'account_id',
        'accountId'
    );

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'Ranked placement trial belongs to a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const trialNumber = normalizeInteger(
        rowValue(row, 'trial_number', 'trialNumber'),
        `placementTrials[${rowIndex}].trialNumber`,
        1,
        5
    );
    const expected = PLACEMENT_SEQUENCE[trialNumber - 1];
    const requiredMode = rowValue(
        row,
        'required_mode',
        'requiredMode'
    );
    const weightBasisPoints = normalizeInteger(
        rowValue(
            row,
            'weight_basis_points',
            'weightBasisPoints'
        ),
        `placementTrials[${rowIndex}].weightBasisPoints`,
        1,
        10_000
    );

    if (
        requiredMode !== expected.requiredMode ||
        weightBasisPoints !== expected.weightBasisPoints
    ) {
        fail(
            'ranked_profile_unavailable',
            'Ranked placement sequence is invalid.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const status = rowValue(row, 'status', 'status');

    if (!TRIAL_STATUSES.has(status)) {
        fail(
            'ranked_profile_unavailable',
            'Ranked placement trial has an invalid status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        trialNumber,
        requiredMode,
        weightBasisPoints,
        status,
        rankedDebateId: rowValue(
            row,
            'ranked_debate_id',
            'rankedDebateId'
        ) ?? null,
        philosopherId: normalizeOptionalText(
            rowValue(
                row,
                'philosopher_id',
                'philosopherId'
            ),
            `placementTrials[${rowIndex}].philosopherId`,
            100
        ),
        philosopherName: normalizeOptionalText(
            rowValue(
                row,
                'philosopher_name',
                'philosopherName'
            ),
            `placementTrials[${rowIndex}].philosopherName`,
            100
        ),
        topicFingerprint: normalizeOptionalText(
            rowValue(
                row,
                'topic_fingerprint',
                'topicFingerprint'
            ),
            `placementTrials[${rowIndex}].topicFingerprint`,
            64
        ),
        finalScoreValue: normalizeNumber(
            rowValue(
                row,
                'final_score_value',
                'finalScoreValue'
            ),
            `placementTrials[${rowIndex}].finalScoreValue`,
            0,
            10,
            { optional: true }
        ),
        weightedScoreContribution: normalizeNumber(
            rowValue(
                row,
                'weighted_score_contribution',
                'weightedScoreContribution'
            ),
            `placementTrials[${rowIndex}].weightedScoreContribution`,
            0,
            2.5,
            { optional: true }
        ),
        startedAt: normalizeDate(
            rowValue(row, 'started_at', 'startedAt'),
            `placementTrials[${rowIndex}].startedAt`,
            { optional: true }
        ),
        completedAt: normalizeDate(
            rowValue(row, 'completed_at', 'completedAt'),
            `placementTrials[${rowIndex}].completedAt`,
            { optional: true }
        ),
        createdAt: normalizeDate(
            rowValue(row, 'created_at', 'createdAt'),
            `placementTrials[${rowIndex}].createdAt`
        ),
        updatedAt: normalizeDate(
            rowValue(row, 'updated_at', 'updatedAt'),
            `placementTrials[${rowIndex}].updatedAt`
        ),
    });
}

function normalizeRankTier(row, rowIndex) {
    if (!row || typeof row !== 'object') {
        fail(
            'ranked_profile_unavailable',
            'Ranked tiers are unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        key: normalizeRankKey(
            rowValue(row, 'rank_key', 'rankKey'),
            `rankTiers[${rowIndex}].key`
        ),
        order: normalizeInteger(
            rowValue(row, 'rank_order', 'rankOrder'),
            `rankTiers[${rowIndex}].order`,
            1,
            8
        ),
        displayName: normalizeOptionalText(
            rowValue(
                row,
                'display_name',
                'displayName'
            ),
            `rankTiers[${rowIndex}].displayName`,
            50
        ),
        supportsDivisions: normalizeBoolean(
            rowValue(
                row,
                'supports_divisions',
                'supportsDivisions'
            ),
            `rankTiers[${rowIndex}].supportsDivisions`
        ),
        populationLimitedCapable: normalizeBoolean(
            rowValue(
                row,
                'population_limited_capable',
                'populationLimitedCapable'
            ),
            `rankTiers[${rowIndex}].populationLimitedCapable`
        ),
    });
}

function normalizeActiveDebate(row, expectedAccountId) {
    if (row == null) return null;

    if (!row || typeof row !== 'object') {
        fail(
            'ranked_profile_unavailable',
            'Active Ranked debate is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId = rowValue(
        row,
        'account_id',
        'accountId'
    );

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'Active Ranked debate belongs to a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    if (rowValue(row, 'status', 'status') !== 'active') {
        fail(
            'ranked_profile_unavailable',
            'Ranked profile returned a non-active debate as active.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        id: rowValue(row, 'id', 'id'),
        debateKind: rowValue(
            row,
            'debate_kind',
            'debateKind'
        ),
        placementTrialNumber: normalizeInteger(
            rowValue(
                row,
                'placement_trial_number',
                'placementTrialNumber'
            ),
            'activeDebate.placementTrialNumber',
            1,
            5,
            { optional: true }
        ),
        philosopherId: normalizeOptionalText(
            rowValue(
                row,
                'philosopher_id',
                'philosopherId'
            ),
            'activeDebate.philosopherId',
            100
        ),
        philosopherName: normalizeOptionalText(
            rowValue(
                row,
                'philosopher_name',
                'philosopherName'
            ),
            'activeDebate.philosopherName',
            100
        ),
        debateMode: rowValue(
            row,
            'debate_mode',
            'debateMode'
        ),
        topic: normalizeOptionalText(
            rowValue(row, 'topic', 'topic'),
            'activeDebate.topic',
            4_000
        ),
        currentScoreText: normalizeOptionalText(
            rowValue(
                row,
                'current_score_text',
                'currentScoreText'
            ),
            'activeDebate.currentScoreText',
            MAX_ACTIVE_DEBATE_SCORE_TEXT_LENGTH
        ),
        currentScoreValue: normalizeNumber(
            rowValue(
                row,
                'current_score_value',
                'currentScoreValue'
            ),
            'activeDebate.currentScoreValue',
            0,
            10,
            { optional: true }
        ),
        roundCount: normalizeInteger(
            rowValue(row, 'round_count', 'roundCount'),
            'activeDebate.roundCount',
            0,
            1_000
        ),
        lastActivityAt: normalizeDate(
            rowValue(
                row,
                'last_activity_at',
                'lastActivityAt'
            ),
            'activeDebate.lastActivityAt'
        ),
        stateVersion: normalizeInteger(
            rowValue(
                row,
                'state_version',
                'stateVersion'
            ),
            'activeDebate.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
    });
}

function normalizeSnapshot(snapshot, expectedAccountId) {
    if (
        !snapshot ||
        typeof snapshot !== 'object' ||
        Array.isArray(snapshot)
    ) {
        fail(
            'ranked_profile_unavailable',
            'Ranked profile snapshot is unavailable.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        !Array.isArray(snapshot.placementTrials) ||
        snapshot.placementTrials.length !== 5
    ) {
        fail(
            'ranked_profile_unavailable',
            'Ranked placement sequence is incomplete.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    if (
        !Array.isArray(snapshot.rankTiers) ||
        snapshot.rankTiers.length !== 8
    ) {
        fail(
            'ranked_profile_unavailable',
            'Ranked tier configuration is incomplete.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const placementTrials = snapshot.placementTrials
        .map((row, index) =>
            normalizePlacementTrial(
                row,
                expectedAccountId,
                index
            )
        )
        .sort(
            (left, right) =>
                left.trialNumber - right.trialNumber
        );

    for (let index = 0; index < 5; index += 1) {
        if (placementTrials[index].trialNumber !== index + 1) {
            fail(
                'ranked_profile_unavailable',
                'Ranked placement sequence contains duplicate or missing trials.',
                {
                    status: 503,
                    retryable: false,
                }
            );
        }
    }

    const rankTiers = snapshot.rankTiers
        .map(normalizeRankTier)
        .sort((left, right) => left.order - right.order);

    for (let index = 0; index < 8; index += 1) {
        if (rankTiers[index].order !== index + 1) {
            fail(
                'ranked_profile_unavailable',
                'Ranked tier ordering is invalid.',
                {
                    status: 503,
                    retryable: false,
                }
            );
        }
    }

    return Object.freeze({
        configuration: normalizeConfiguration(
            snapshot.configuration
        ),
        profile: normalizeProfile(
            snapshot.profile,
            expectedAccountId
        ),
        placementTrials: Object.freeze(placementTrials),
        rankTiers: Object.freeze(rankTiers),
        activeDebate: normalizeActiveDebate(
            snapshot.activeDebate,
            expectedAccountId
        ),
    });
}

export function createPostgresAccountRankedProfileRepository(pool) {
    if (
        !pool ||
        typeof pool.connect !== 'function' ||
        typeof pool.query !== 'function'
    ) {
        fail(
            'invalid_ranked_profile_configuration',
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

        async ensureProfile(
            client,
            {
                accountId,
                bootstrappedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked:ensure-profile */
                    INSERT INTO account_ranked_profiles (
                        account_id,
                        created_at,
                        updated_at
                    )
                    VALUES ($1, $2, $2)
                    ON CONFLICT (account_id)
                    DO NOTHING
                    RETURNING account_id
                `,
                [accountId, bootstrappedAt]
            );

            return result.rowCount === 1;
        },

        async ensurePlacementTrials(
            client,
            {
                accountId,
                bootstrappedAt,
            }
        ) {
            await client.query(
                `
                    /* account-ranked:ensure-placement-trials */
                    INSERT INTO account_ranked_placement_trials (
                        account_id,
                        trial_number,
                        required_mode,
                        weight_basis_points,
                        created_at,
                        updated_at
                    )
                    VALUES
                        ($1, 1, 'guided', 1500, $2, $2),
                        ($1, 2, 'balanced', 2000, $2, $2),
                        ($1, 3, 'balanced', 2000, $2, $2),
                        ($1, 4, 'relentless', 2000, $2, $2),
                        ($1, 5, 'relentless', 2500, $2, $2)
                    ON CONFLICT (account_id, trial_number)
                    DO NOTHING
                `,
                [accountId, bootstrappedAt]
            );
        },

        async loadSnapshot(client, { accountId }) {
            // A single pg Client may execute only one query at a time.
            // Keep these reads sequential inside the surrounding transaction.
            const configurationResult = await client.query(
                `
                    /* account-ranked:load-configuration */
                    SELECT
                        configuration_key,
                        is_enabled,
                        allow_new_debates,
                        allow_resume_active_debates,
                        placements_enabled,
                        ladder_enabled,
                        leaderboard_enabled,
                        population_limits_enabled,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        updated_at
                    FROM ranked_system_configuration
                    WHERE configuration_key = 'global'
                `
            );

            const profileResult = await client.query(
                `
                    /* account-ranked:load-profile */
                    SELECT
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
                        demotion_protection_granted_at,
                        ranked_debates_completed,
                        ranked_forfeits,
                        ranked_invalid_results,
                        last_ranked_debate_completed_at,
                        state_version,
                        created_at,
                        updated_at
                    FROM account_ranked_profiles
                    WHERE account_id = $1
                `,
                [accountId]
            );

            const placementTrialsResult = await client.query(
                `
                    /* account-ranked:load-placement-trials */
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
                        final_score_value,
                        weighted_score_contribution,
                        started_at,
                        completed_at,
                        created_at,
                        updated_at
                    FROM account_ranked_placement_trials
                    WHERE account_id = $1
                    ORDER BY trial_number ASC
                `,
                [accountId]
            );

            const rankTiersResult = await client.query(
                `
                    /* account-ranked:load-rank-tiers */
                    SELECT
                        rank_key,
                        rank_order,
                        display_name,
                        supports_divisions,
                        population_limited_capable
                    FROM ranked_rank_tiers
                    ORDER BY rank_order ASC
                `
            );

            const activeDebateResult = await client.query(
                `
                    /* account-ranked:load-active-debate */
                    SELECT
                        id,
                        account_id,
                        debate_kind,
                        placement_trial_number,
                        status,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        topic,
                        current_score_text,
                        current_score_value,
                        round_count,
                        last_activity_at,
                        state_version
                    FROM account_ranked_debates
                    WHERE account_id = $1
                      AND status = 'active'
                    LIMIT 1
                `,
                [accountId]
            );

            return Object.freeze({
                configuration:
                    configurationResult.rows[0] ?? null,
                profile:
                    profileResult.rows[0] ?? null,
                placementTrials:
                    placementTrialsResult.rows,
                rankTiers:
                    rankTiersResult.rows,
                activeDebate:
                    activeDebateResult.rows[0] ?? null,
            });
        },
    });
}

export function createAccountRankedProfileService({
    pool = null,
    repository = null,
    accountAuthService,
    now = () => Date.now(),
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        fail(
            'invalid_ranked_profile_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_ranked_profile_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountRankedProfileRepository(pool);

    if (
        !repo ||
        typeof repo.withTransaction !== 'function' ||
        typeof repo.ensureProfile !== 'function' ||
        typeof repo.ensurePlacementTrials !== 'function' ||
        typeof repo.loadSnapshot !== 'function'
    ) {
        fail(
            'invalid_ranked_profile_configuration',
            'A valid Ranked profile repository is required.'
        );
    }

    async function authorize({
        installationId,
        accessToken,
    }) {
        const cleanInstallationId =
            requireInstallationId(installationId);
        const cleanAccessToken = requireString(
            accessToken,
            'accessToken',
            { maximumLength: 16_384 }
        );

        try {
            return await accountAuthService
                .authorizeAccessToken({
                    installationId:
                        cleanInstallationId,
                    accessToken: cleanAccessToken,
                });
        } catch (error) {
            const status = Number.isInteger(error?.status)
                ? error.status
                : 401;
            const code =
                typeof error?.code === 'string' &&
                error.code
                    ? error.code
                    : 'invalid_access_token';

            const message = status === 403
                ? 'This Agora account is unavailable.'
                : 'The Agora account session is invalid or expired.';

            fail(
                code,
                message,
                {
                    status,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function bootstrapProfile({
        installationId,
        accessToken,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });
        const bootstrappedAt = currentServiceDate(now);

        try {
            const result = await repo.withTransaction(
                async (client) => {
                    const profileCreated =
                        await repo.ensureProfile(
                            client,
                            {
                                accountId:
                                    authorization.accountId,
                                bootstrappedAt,
                            }
                        );

                    await repo.ensurePlacementTrials(
                        client,
                        {
                            accountId:
                                authorization.accountId,
                            bootstrappedAt,
                        }
                    );

                    const rawSnapshot =
                        await repo.loadSnapshot(
                            client,
                            {
                                accountId:
                                    authorization.accountId,
                            }
                        );

                    return Object.freeze({
                        profileCreated,
                        snapshot: normalizeSnapshot(
                            rawSnapshot,
                            authorization.accountId
                        ),
                    });
                }
            );

            return Object.freeze({
                schemaVersion:
                    RANKED_PROFILE_SCHEMA_VERSION,
                accountId: authorization.accountId,
                installationId:
                    authorization.installationId,
                bootstrappedAt,
                profileCreated: result.profileCreated,
                configuration:
                    result.snapshot.configuration,
                profile: result.snapshot.profile,
                placementTrials:
                    result.snapshot.placementTrials,
                rankTiers:
                    result.snapshot.rankTiers,
                activeDebate:
                    result.snapshot.activeDebate,
            });
        } catch (error) {
            if (error instanceof AccountRankedProfileError) {
                throw error;
            }

            fail(
                'ranked_profile_unavailable',
                'Ranked profile is temporarily unavailable.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }
    }

    return Object.freeze({
        bootstrapProfile,
    });
}

export const accountRankedProfileConstants = Object.freeze({
    schemaVersion: RANKED_PROFILE_SCHEMA_VERSION,
    placementSequence: PLACEMENT_SEQUENCE,
});
