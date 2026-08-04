import {
    AccountRankedDebateError,
} from './accountRankedDebateService.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const MIN_COMPLETION_USER_TURNS = 2;
const RANKED_DEBATE_SCHEMA_VERSION = 1;
const DEFAULT_RESOLVED_PAGE_LIMIT = 50;
const MAX_RESOLVED_PAGE_LIMIT = 100;
const MAX_RESOLVED_CURSOR_LENGTH = 512;

const RANK_ORDER = Object.freeze({
    initiate: 1,
    student: 2,
    dialectician: 3,
    logician: 4,
    scholar: 5,
    sage: 6,
    philosopher: 7,
    alchemist: 8,
});

function fail(code, message, options) {
    throw new AccountRankedDebateError(code, message, options);
}

function requireString(
    value,
    fieldName,
    {
        maximumLength = 16_384,
        pattern = null,
        lowercase = false,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_debate_request',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (!cleaned || cleaned.length > maximumLength || (pattern && !pattern.test(cleaned))) {
        fail(
            'invalid_ranked_debate_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return lowercase ? cleaned.toLowerCase() : cleaned;
}

function requireUuid(value, fieldName) {
    return requireString(value, fieldName, {
        maximumLength: 64,
        pattern: UUID_RE,
        lowercase: true,
    });
}

function requireInstallationId(value) {
    return requireString(value, 'installationId', {
        maximumLength: 128,
        pattern: INSTALLATION_ID_RE,
    });
}

function requireStateVersion(value) {
    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        fail(
            'invalid_ranked_state_version',
            'expectedStateVersion must be a positive integer.',
            { status: 400 }
        );
    }

    return parsed;
}

function requireResolvedPageLimit(value) {
    if (value == null || value === '') {
        return DEFAULT_RESOLVED_PAGE_LIMIT;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_RESOLVED_PAGE_LIMIT
    ) {
        fail(
            'invalid_ranked_history_page_limit',
            `limit must be an integer between 1 and ${MAX_RESOLVED_PAGE_LIMIT}.`,
            { status: 400, retryable: false }
        );
    }

    return parsed;
}

function encodeResolvedCursor({ completedAt, debateId }) {
    const payload = JSON.stringify({
        completedAt: dateValue(
            completedAt,
            'resolvedCursor.completedAt'
        ).toISOString(),
        debateId: requireUuid(
            debateId,
            'resolvedCursor.debateId'
        ),
    });

    return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeResolvedCursor(value) {
    if (value == null || value === '') {
        return null;
    }

    const cleanValue = requireString(
        value,
        'cursor',
        {
            maximumLength: MAX_RESOLVED_CURSOR_LENGTH,
            pattern: /^[A-Za-z0-9_-]+$/,
        }
    );

    try {
        const parsed = JSON.parse(
            Buffer.from(cleanValue, 'base64url').toString('utf8')
        );

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('invalid cursor payload');
        }

        return Object.freeze({
            completedAt: dateValue(
                parsed.completedAt,
                'resolvedCursor.completedAt'
            ),
            debateId: requireUuid(
                parsed.debateId,
                'resolvedCursor.debateId'
            ),
        });
    } catch (error) {
        if (error instanceof AccountRankedDebateError) {
            throw error;
        }

        fail(
            'invalid_ranked_history_cursor',
            'The Ranked history cursor is invalid.',
            { status: 400, retryable: false }
        );
    }
}

function serviceDate(now) {
    const raw = now();
    const date = raw instanceof Date ? raw : new Date(raw);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_ranked_debate_configuration',
            'now() returned an invalid date.'
        );
    }

    return date;
}

function numberValue(value, fieldName, minimum, maximum, { optional = false } = {}) {
    if (value == null && optional) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return parsed;
}

function integerValue(value, fieldName, minimum, maximum, { optional = false } = {}) {
    if (value == null && optional) return null;

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return parsed;
}

function dateValue(value, fieldName, { optional = false } = {}) {
    if (value == null && optional) return null;

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return date;
}

function textValue(value, fieldName, maximumLength, { optional = false } = {}) {
    if (value == null && optional) return null;

    if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
        fail(
            'ranked_debate_state_unavailable',
            `Ranked debate state contains an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }

    return value.trim();
}

function rowValue(row, snakeCase, camelCase) {
    if (Object.prototype.hasOwnProperty.call(row, snakeCase)) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeResolvedDebateIndexRow(
    row,
    expectedAccountId
) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_history_state_unavailable',
            'A resolved Ranked debate record is invalid.',
            { status: 503, retryable: true }
        );
    }

    const accountId = requireUuid(
        rowValue(row, 'account_id', 'accountId'),
        'resolvedDebate.accountId'
    );

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_history_account_mismatch',
            'A resolved Ranked debate belongs to a different account.',
            { status: 503, retryable: false }
        );
    }

    const debateKind = textValue(
        rowValue(row, 'debate_kind', 'debateKind'),
        'resolvedDebate.debateKind',
        20
    );

    const status = textValue(
        rowValue(row, 'status', 'status'),
        'resolvedDebate.status',
        20
    );

    if (!['placement', 'ladder'].includes(debateKind)) {
        fail(
            'ranked_history_state_unavailable',
            'A resolved Ranked debate has an invalid kind.',
            { status: 503, retryable: true }
        );
    }

    if (!['completed', 'forfeited'].includes(status)) {
        fail(
            'ranked_history_state_unavailable',
            'A resolved Ranked debate has an invalid status.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        id: requireUuid(
            rowValue(row, 'id', 'id'),
            'resolvedDebate.id'
        ),
        debateKind,
        status,
        completedAt: dateValue(
            rowValue(row, 'completed_at', 'completedAt'),
            'resolvedDebate.completedAt'
        ),
        updatedAt: dateValue(
            rowValue(row, 'updated_at', 'updatedAt'),
            'resolvedDebate.updatedAt'
        ),
    });
}

function normalizeMessages(value) {
    if (!Array.isArray(value)) {
        fail(
            'ranked_debate_state_unavailable',
            'Ranked debate messages are invalid.',
            { status: 503, retryable: true }
        );
    }

    return value.map((message, index) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            fail(
                'ranked_debate_state_unavailable',
                `Ranked debate message ${index} is invalid.`,
                { status: 503, retryable: true }
            );
        }

        return Object.freeze({
            schemaVersion: integerValue(
                message.schemaVersion,
                `messages[${index}].schemaVersion`,
                1,
                100
            ),
            id: requireUuid(message.id, `messages[${index}].id`),
            requestId: requireUuid(message.requestId, `messages[${index}].requestId`),
            generationId:
                message.generationId == null
                    ? null
                    : requireUuid(
                        message.generationId,
                        `messages[${index}].generationId`
                    ),
            role: textValue(message.role, `messages[${index}].role`, 20),
            kind: textValue(message.kind, `messages[${index}].kind`, 20),
            status: textValue(message.status, `messages[${index}].status`, 20),
            visible: Boolean(message.visible),
            content: typeof message.content === 'string' ? message.content : '',
            roundNumber: integerValue(
                message.roundNumber,
                `messages[${index}].roundNumber`,
                0,
                1_000
            ),
            scoreText:
                message.scoreText == null
                    ? null
                    : textValue(
                        message.scoreText,
                        `messages[${index}].scoreText`,
                        500
                    ),
            scoreValue: numberValue(
                message.scoreValue,
                `messages[${index}].scoreValue`,
                0,
                10,
                { optional: true }
            ),
            failureCode:
                message.failureCode == null
                    ? null
                    : textValue(
                        message.failureCode,
                        `messages[${index}].failureCode`,
                        100
                    ),
            failureRetryable:
                message.failureRetryable == null
                    ? null
                    : Boolean(message.failureRetryable),
            createdAt: dateValue(
                message.createdAt,
                `messages[${index}].createdAt`
            ),
            generationStartedAt: dateValue(
                message.generationStartedAt,
                `messages[${index}].generationStartedAt`,
                { optional: true }
            ),
            completedAt: dateValue(
                message.completedAt,
                `messages[${index}].completedAt`,
                { optional: true }
            ),
        });
    });
}

function publicMessages(messages) {
    return messages
        .filter((message) => message.visible && message.status === 'completed')
        .map((message) => Object.freeze({
            id: message.id,
            requestId: message.requestId,
            role: message.role,
            kind: message.kind,
            content: message.content,
            roundNumber: message.roundNumber,
            scoreText: message.scoreText,
            scoreValue: message.scoreValue,
            createdAt: message.createdAt,
            completedAt: message.completedAt,
        }));
}

function pendingGeneration(messages) {
    const pending = [...messages]
        .reverse()
        .find(
            (message) =>
                message.role === 'assistant' &&
                !message.visible &&
                ['pending', 'failed'].includes(message.status)
        );

    if (!pending) return null;

    return Object.freeze({
        requestId: pending.requestId,
        kind: pending.kind,
        roundNumber: pending.roundNumber,
        status: pending.status,
        retryable: Boolean(pending.failureRetryable),
        generationStartedAt: pending.generationStartedAt,
        failureCode: pending.failureCode,
    });
}

function normalizeLadderDebate(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_debate_not_found',
            'The Ranked debate could not be found.',
            { status: 404 }
        );
    }

    const accountId = textValue(
        rowValue(row, 'account_id', 'accountId'),
        'debate.accountId',
        64
    ).toLowerCase();

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_debate_not_found',
            'The Ranked debate could not be found.',
            { status: 404 }
        );
    }

    const debateKind = rowValue(row, 'debate_kind', 'debateKind');

    if (debateKind !== 'ladder') {
        fail(
            'ranked_debate_state_unavailable',
            'The Ranked debate is not a ladder debate.',
            { status: 503, retryable: false }
        );
    }

    const messages = normalizeMessages(rowValue(row, 'messages', 'messages'));
    const startingRankKey = textValue(
        rowValue(row, 'starting_rank_key', 'startingRankKey'),
        'debate.startingRankKey',
        30
    );
    const endingRankKey = textValue(
        rowValue(row, 'ending_rank_key', 'endingRankKey'),
        'debate.endingRankKey',
        30,
        { optional: true }
    );

    return Object.freeze({
        id: requireUuid(rowValue(row, 'id', 'id'), 'debate.id'),
        accountId,
        startRequestId: requireUuid(
            rowValue(row, 'start_request_id', 'startRequestId'),
            'debate.startRequestId'
        ),
        completionRequestId:
            rowValue(row, 'completion_request_id', 'completionRequestId') == null
                ? null
                : requireUuid(
                    rowValue(row, 'completion_request_id', 'completionRequestId'),
                    'debate.completionRequestId'
                ),
        forfeitRequestId:
            rowValue(row, 'forfeit_request_id', 'forfeitRequestId') == null
                ? null
                : requireUuid(
                    rowValue(row, 'forfeit_request_id', 'forfeitRequestId'),
                    'debate.forfeitRequestId'
                ),
        debateKind,
        placementTrialNumber: null,
        status: textValue(rowValue(row, 'status', 'status'), 'debate.status', 20),
        philosopherId: textValue(
            rowValue(row, 'philosopher_id', 'philosopherId'),
            'debate.philosopherId',
            100
        ),
        philosopherName: textValue(
            rowValue(row, 'philosopher_name', 'philosopherName'),
            'debate.philosopherName',
            100
        ),
        debateMode: textValue(
            rowValue(row, 'debate_mode', 'debateMode'),
            'debate.debateMode',
            20
        ),
        topic: textValue(rowValue(row, 'topic', 'topic'), 'debate.topic', 4_000),
        topicFingerprint: textValue(
            rowValue(row, 'topic_fingerprint', 'topicFingerprint'),
            'debate.topicFingerprint',
            64
        ),
        topicTheme: textValue(
            rowValue(row, 'topic_theme', 'topicTheme'),
            'debate.topicTheme',
            120
        ),
        topicModelProvider: textValue(
            rowValue(row, 'topic_model_provider', 'topicModelProvider'),
            'debate.topicModelProvider',
            100
        ),
        topicModelName: textValue(
            rowValue(row, 'topic_model_name', 'topicModelName'),
            'debate.topicModelName',
            200
        ),
        topicGeneratedAt: dateValue(
            rowValue(row, 'topic_generated_at', 'topicGeneratedAt'),
            'debate.topicGeneratedAt'
        ),
        messages,
        currentScoreText: textValue(
            rowValue(row, 'current_score_text', 'currentScoreText'),
            'debate.currentScoreText',
            500,
            { optional: true }
        ),
        currentScoreValue: numberValue(
            rowValue(row, 'current_score_value', 'currentScoreValue'),
            'debate.currentScoreValue',
            0,
            10,
            { optional: true }
        ),
        finalScoreText: textValue(
            rowValue(row, 'final_score_text', 'finalScoreText'),
            'debate.finalScoreText',
            500,
            { optional: true }
        ),
        finalScoreValue: numberValue(
            rowValue(row, 'final_score_value', 'finalScoreValue'),
            'debate.finalScoreValue',
            0,
            10,
            { optional: true }
        ),
        roundCount: integerValue(
            rowValue(row, 'round_count', 'roundCount'),
            'debate.roundCount',
            0,
            1_000
        ),
        startingRankKey,
        startingDivision: integerValue(
            rowValue(row, 'starting_division', 'startingDivision'),
            'debate.startingDivision',
            1,
            3,
            { optional: startingRankKey === 'alchemist' }
        ),
        startingRP: integerValue(
            rowValue(row, 'starting_rp', 'startingRP'),
            'debate.startingRP',
            0,
            99
        ),
        forfeitRPLossPreview: integerValue(
            rowValue(row, 'forfeit_rp_loss_preview', 'forfeitRPLossPreview'),
            'debate.forfeitRPLossPreview',
            1,
            500
        ),
        rpDelta: integerValue(
            rowValue(row, 'rp_delta', 'rpDelta'),
            'debate.rpDelta',
            -500,
            500,
            { optional: true }
        ),
        endingRankKey,
        endingDivision: integerValue(
            rowValue(row, 'ending_division', 'endingDivision'),
            'debate.endingDivision',
            1,
            3,
            { optional: endingRankKey == null || endingRankKey === 'alchemist' }
        ),
        endingRP: integerValue(
            rowValue(row, 'ending_rp', 'endingRP'),
            'debate.endingRP',
            0,
            99,
            { optional: true }
        ),
        promoted: Boolean(rowValue(row, 'promoted', 'promoted')),
        demoted: Boolean(rowValue(row, 'demoted', 'demoted')),
        protectionApplied: Boolean(
            rowValue(row, 'protection_applied', 'protectionApplied')
        ),
        protectionConsumed: Boolean(
            rowValue(row, 'protection_consumed', 'protectionConsumed')
        ),
        rankedRulesVersion: textValue(
            rowValue(row, 'ranked_rules_version', 'rankedRulesVersion'),
            'debate.rankedRulesVersion',
            100
        ),
        philosopherPromptVersion: textValue(
            rowValue(row, 'philosopher_prompt_version', 'philosopherPromptVersion'),
            'debate.philosopherPromptVersion',
            100
        ),
        scoringPromptVersion: textValue(
            rowValue(row, 'scoring_prompt_version', 'scoringPromptVersion'),
            'debate.scoringPromptVersion',
            100
        ),
        reportPromptVersion: textValue(
            rowValue(row, 'report_prompt_version', 'reportPromptVersion'),
            'debate.reportPromptVersion',
            100
        ),
        topicGeneratorVersion: textValue(
            rowValue(row, 'topic_generator_version', 'topicGeneratorVersion'),
            'debate.topicGeneratorVersion',
            100
        ),
        rpFormulaVersion: textValue(
            rowValue(row, 'rp_formula_version', 'rpFormulaVersion'),
            'debate.rpFormulaVersion',
            100
        ),
        modelProvider: textValue(
            rowValue(row, 'model_provider', 'modelProvider'),
            'debate.modelProvider',
            100
        ),
        modelName: textValue(
            rowValue(row, 'model_name', 'modelName'),
            'debate.modelName',
            150
        ),
        stateVersion: integerValue(
            rowValue(row, 'state_version', 'stateVersion'),
            'debate.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
        startedAt: dateValue(rowValue(row, 'started_at', 'startedAt'), 'debate.startedAt'),
        lastActivityAt: dateValue(
            rowValue(row, 'last_activity_at', 'lastActivityAt'),
            'debate.lastActivityAt'
        ),
        completedAt: dateValue(
            rowValue(row, 'completed_at', 'completedAt'),
            'debate.completedAt',
            { optional: true }
        ),
        updatedAt: dateValue(rowValue(row, 'updated_at', 'updatedAt'), 'debate.updatedAt'),
    });
}

function publicDebate(debate) {
    return Object.freeze({
        id: debate.id,
        accountId: debate.accountId,
        startRequestId: debate.startRequestId,
        completionRequestId: debate.completionRequestId,
        forfeitRequestId: debate.forfeitRequestId,
        debateKind: debate.debateKind,
        placementTrialNumber: debate.placementTrialNumber,
        status: debate.status,
        philosopherId: debate.philosopherId,
        philosopherName: debate.philosopherName,
        debateMode: debate.debateMode,
        topic: debate.topic,
        topicFingerprint: debate.topicFingerprint,
        topicTheme: debate.topicTheme,
        topicModelProvider: debate.topicModelProvider,
        topicModelName: debate.topicModelName,
        topicGeneratedAt: debate.topicGeneratedAt,
        messages: publicMessages(debate.messages),
        pendingGeneration: pendingGeneration(debate.messages),
        currentScoreText: debate.currentScoreText,
        currentScoreValue: debate.currentScoreValue,
        finalScoreText: debate.finalScoreText,
        finalScoreValue: debate.finalScoreValue,
        roundCount: debate.roundCount,
        startingRankKey: debate.startingRankKey,
        startingDivision: debate.startingDivision,
        startingRP: debate.startingRP,
        forfeitRPLossPreview: debate.forfeitRPLossPreview,
        rpDelta: debate.rpDelta,
        endingRankKey: debate.endingRankKey,
        endingDivision: debate.endingDivision,
        endingRP: debate.endingRP,
        promoted: debate.promoted,
        demoted: debate.demoted,
        protectionApplied: debate.protectionApplied,
        protectionConsumed: debate.protectionConsumed,
        rankedRulesVersion: debate.rankedRulesVersion,
        philosopherPromptVersion: debate.philosopherPromptVersion,
        scoringPromptVersion: debate.scoringPromptVersion,
        reportPromptVersion: debate.reportPromptVersion,
        topicGeneratorVersion: debate.topicGeneratorVersion,
        rpFormulaVersion: debate.rpFormulaVersion,
        modelProvider: debate.modelProvider,
        modelName: debate.modelName,
        stateVersion: debate.stateVersion,
        startedAt: debate.startedAt,
        lastActivityAt: debate.lastActivityAt,
        completedAt: debate.completedAt,
        updatedAt: debate.updatedAt,
    });
}

function normalizeProfile(row, expectedAccountId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile is unavailable.',
            { status: 503, retryable: true }
        );
    }

    const accountId = textValue(
        rowValue(row, 'account_id', 'accountId'),
        'profile.accountId',
        64
    ).toLowerCase();

    if (accountId !== expectedAccountId) {
        fail(
            'ranked_profile_account_mismatch',
            'The Ranked profile belongs to a different account.',
            { status: 503 }
        );
    }

    const currentRankKey = textValue(
        rowValue(row, 'current_rank_key', 'currentRankKey'),
        'profile.currentRankKey',
        30
    );
    const peakRankKey = textValue(
        rowValue(row, 'peak_rank_key', 'peakRankKey'),
        'profile.peakRankKey',
        30
    );

    if (!(currentRankKey in RANK_ORDER) || !(peakRankKey in RANK_ORDER)) {
        fail(
            'ranked_profile_unavailable',
            'The Ranked profile contains an invalid rank.',
            { status: 503, retryable: true }
        );
    }

    return Object.freeze({
        accountId,
        placementStatus: textValue(
            rowValue(row, 'placement_status', 'placementStatus'),
            'profile.placementStatus',
            30
        ),
        currentRankKey,
        currentDivision: integerValue(
            rowValue(row, 'current_division', 'currentDivision'),
            'profile.currentDivision',
            1,
            3,
            { optional: currentRankKey === 'alchemist' }
        ),
        currentRP: integerValue(
            rowValue(row, 'current_rp', 'currentRP'),
            'profile.currentRP',
            0,
            99
        ),
        peakRankKey,
        peakDivision: integerValue(
            rowValue(row, 'peak_division', 'peakDivision'),
            'profile.peakDivision',
            1,
            3,
            { optional: peakRankKey === 'alchemist' }
        ),
        peakReachedAt: dateValue(
            rowValue(row, 'peak_reached_at', 'peakReachedAt'),
            'profile.peakReachedAt'
        ),
        protectionRemaining: integerValue(
            rowValue(
                row,
                'demotion_protection_debates_remaining',
                'demotionProtectionDebatesRemaining'
            ),
            'profile.protectionRemaining',
            0,
            1
        ),
        protectionReason: textValue(
            rowValue(row, 'demotion_protection_reason', 'demotionProtectionReason'),
            'profile.protectionReason',
            50,
            { optional: true }
        ),
        protectionGrantedAt: dateValue(
            rowValue(
                row,
                'demotion_protection_granted_at',
                'demotionProtectionGrantedAt'
            ),
            'profile.protectionGrantedAt',
            { optional: true }
        ),
        rankedDebatesCompleted: integerValue(
            rowValue(row, 'ranked_debates_completed', 'rankedDebatesCompleted'),
            'profile.rankedDebatesCompleted',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedForfeits: integerValue(
            rowValue(row, 'ranked_forfeits', 'rankedForfeits'),
            'profile.rankedForfeits',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        rankedInvalidResults: integerValue(
            rowValue(row, 'ranked_invalid_results', 'rankedInvalidResults'),
            'profile.rankedInvalidResults',
            0,
            Number.MAX_SAFE_INTEGER
        ),
        stateVersion: integerValue(
            rowValue(row, 'state_version', 'stateVersion'),
            'profile.stateVersion',
            1,
            Number.MAX_SAFE_INTEGER
        ),
    });
}

function scoreSummary(messages) {
    const opening = messages.find(
        (message) =>
            message.role === 'assistant' &&
            message.kind === 'opening' &&
            message.status === 'completed' &&
            message.visible
    );

    if (!opening) {
        fail(
            'ranked_completion_not_ready',
            'The Ranked opening must finish before the debate can be completed.',
            { status: 409, retryable: false }
        );
    }

    const unresolved = messages.find(
        (message) =>
            message.role === 'assistant' &&
            ['pending', 'failed'].includes(message.status)
    );

    if (unresolved) {
        fail(
            unresolved.status === 'pending'
                ? 'ranked_generation_in_progress'
                : 'ranked_generation_failed',
            unresolved.status === 'pending'
                ? 'The current Ranked response is still being generated.'
                : 'The failed Ranked response must be retried before completion.',
            {
                status: 409,
                retryable:
                    unresolved.status === 'pending' ||
                    Boolean(unresolved.failureRetryable),
                details: { requestId: unresolved.requestId },
            }
        );
    }

    const userTurns = messages.filter(
        (message) =>
            message.role === 'user' &&
            message.kind === 'turn' &&
            message.status === 'completed'
    ).length;

    if (userTurns < MIN_COMPLETION_USER_TURNS) {
        fail(
            'ranked_completion_not_ready',
            `At least ${MIN_COMPLETION_USER_TURNS} completed user responses are required.`,
            {
                status: 409,
                retryable: false,
                details: {
                    minimumUserTurns: MIN_COMPLETION_USER_TURNS,
                    currentUserTurns: userTurns,
                },
            }
        );
    }

    const scoredReplies = messages.filter(
        (message) =>
            message.role === 'assistant' &&
            message.kind === 'turn' &&
            message.status === 'completed' &&
            message.scoreValue != null
    );

    if (scoredReplies.length === 0) {
        fail(
            'ranked_completion_score_unavailable',
            'The Ranked debate does not contain a completed scored response.',
            {
                status: 409,
                retryable: false,
                details: { scoredRoundCount: 0 },
            }
        );
    }

    const average = scoredReplies.reduce(
        (sum, message) => sum + message.scoreValue,
        0
    ) / scoredReplies.length;
    const finalScoreValue = Math.round((average + Number.EPSILON) * 10) / 10;

    return Object.freeze({
        finalScoreValue,
        finalScoreText: `${finalScoreValue.toFixed(1)}/10`,
        scoredRoundCount: scoredReplies.length,
    });
}

function requestIdAlreadyUsed(debate, requestId) {
    return (
        debate.startRequestId === requestId ||
        debate.messages.some((message) => message.requestId === requestId)
    );
}

function compareRankDivision(leftRank, leftDivision, rightRank, rightDivision) {
    const rankDifference = RANK_ORDER[leftRank] - RANK_ORDER[rightRank];
    if (rankDifference !== 0) return rankDifference;

    if (leftRank === 'alchemist') return 0;

    // Division I is above II, and II is above III.
    return rightDivision - leftDivision;
}

function ladderCompletionPayload({ debate, profile, event }) {
    const scoredRoundCount = debate.messages.filter(
        (message) =>
            message.role === 'assistant' &&
            message.kind === 'turn' &&
            message.status === 'completed' &&
            message.scoreValue != null
    ).length;

    return Object.freeze({
        outcome:
            debate.status === 'forfeited'
                ? 'forfeited'
                : debate.status === 'invalid'
                    ? 'invalid'
                    : 'completed',
        completedAt: debate.completedAt,
        finalScoreText: debate.finalScoreText,
        finalScoreValue: debate.finalScoreValue,
        scoredRoundCount,
        placement: null,
        ladder: Object.freeze({
            rpDelta: debate.rpDelta,
            beforeRankKey: debate.startingRankKey,
            beforeDivision: debate.startingDivision,
            beforeRP: debate.startingRP,
            afterRankKey: debate.endingRankKey,
            afterDivision: debate.endingDivision,
            afterRP: debate.endingRP,
            promoted: debate.promoted,
            demoted: debate.demoted,
            protectionBefore: integerValue(
                rowValue(event, 'protection_before', 'protectionBefore'),
                'event.protectionBefore',
                0,
                1
            ),
            protectionAfter: integerValue(
                rowValue(event, 'protection_after', 'protectionAfter'),
                'event.protectionAfter',
                0,
                1
            ),
            protectionApplied: debate.protectionApplied,
            protectionConsumed: debate.protectionConsumed,
            peakRankKey: profile.peakRankKey,
            peakDivision: profile.peakDivision,
            peakReachedAt: profile.peakReachedAt,
            forfeitRPLossPreview: debate.forfeitRPLossPreview,
            formulaComponents:
                rowValue(event, 'formula_components', 'formulaComponents') ?? {},
        }),
    });
}

export function createPostgresAccountRankedUnifiedRepository(pool) {
    if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') {
        fail(
            'invalid_ranked_debate_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    const debateColumns = `
        id,
        account_id,
        start_request_id,
        completion_request_id,
        forfeit_request_id,
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
        messages,
        current_score_text,
        current_score_value,
        final_score_text,
        final_score_value,
        round_count,
        starting_rank_key,
        starting_division,
        starting_rp,
        forfeit_rp_loss_preview,
        rp_delta,
        ending_rank_key,
        ending_division,
        ending_rp,
        promoted,
        demoted,
        protection_applied,
        protection_consumed,
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
        completed_at,
        updated_at
    `;

    const profileColumns = `
        account_id,
        placement_status,
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
        state_version
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

        async loadConfiguration(client) {
            const result = await client.query(
                `
                    /* account-ranked-unified:load-configuration */
                    SELECT
                        configuration_key,
                        is_enabled,
                        allow_resume_active_debates
                    FROM ranked_system_configuration
                    WHERE configuration_key = 'global'
                `
            );

            return result.rows[0] ?? null;
        },

        async findDebateKind({ accountId, debateId }) {
            const result = await pool.query(
                `
                    /* account-ranked-unified:find-kind */
                    SELECT debate_kind
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                    LIMIT 1
                `,
                [accountId, debateId]
            );

            return result.rows[0]?.debate_kind ?? null;
        },

        async findLadderMetadata({ accountId, debateId }) {
            const result = await pool.query(
                `
                    /* account-ranked-unified:find-ladder-metadata */
                    SELECT
                        starting_rank_key,
                        starting_division,
                        starting_rp,
                        forfeit_rp_loss_preview,
                        rp_delta,
                        ending_rank_key,
                        ending_division,
                        ending_rp,
                        promoted,
                        demoted,
                        protection_applied,
                        protection_consumed
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                      AND debate_kind = 'ladder'
                    LIMIT 1
                `,
                [accountId, debateId]
            );

            return result.rows[0] ?? null;
        },

        async listResolvedDebates({
            accountId,
            limit,
            cursorCompletedAt = null,
            cursorDebateId = null,
        }) {
            const result = await pool.query(
                `
                    /* account-ranked-unified:list-resolved-debates */
                    SELECT
                        account_id,
                        id,
                        debate_kind,
                        status,
                        completed_at,
                        updated_at
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND status IN ('completed', 'forfeited')
                      AND completed_at IS NOT NULL
                      AND (
                            $2::timestamptz IS NULL
                            OR (completed_at, id) <
                               ($2::timestamptz, $3::uuid)
                      )
                    ORDER BY completed_at DESC, id DESC
                    LIMIT $4::integer
                `,
                [
                    accountId,
                    cursorCompletedAt,
                    cursorDebateId,
                    limit,
                ]
            );

            return result.rows;
        },

        async lockDebate(client, { accountId, debateId }) {
            const result = await client.query(
                `
                    /* account-ranked-unified:lock-debate */
                    SELECT ${debateColumns}
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                    LIMIT 1
                    FOR UPDATE
                `,
                [accountId, debateId]
            );

            return result.rows[0] ?? null;
        },

        async loadDebate(client, { accountId, debateId }) {
            const result = await client.query(
                `
                    /* account-ranked-unified:load-debate */
                    SELECT ${debateColumns}
                    FROM account_ranked_debates
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                    LIMIT 1
                `,
                [accountId, debateId]
            );

            return result.rows[0] ?? null;
        },

        async lockProfile(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-unified:lock-profile */
                    SELECT ${profileColumns}
                    FROM account_ranked_profiles
                    WHERE account_id = $1::uuid
                    FOR UPDATE
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async loadProfile(client, { accountId }) {
            const result = await client.query(
                `
                    /* account-ranked-unified:load-profile */
                    SELECT ${profileColumns}
                    FROM account_ranked_profiles
                    WHERE account_id = $1::uuid
                    LIMIT 1
                `,
                [accountId]
            );

            return result.rows[0] ?? null;
        },

        async completeLadderDebate(
            client,
            {
                accountId,
                debateId,
                requestId,
                expectedStateVersion,
                score,
                rating,
                installationId,
                completedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-unified:complete-ladder-debate */
                    UPDATE account_ranked_debates
                    SET
                        status = 'completed',
                        completion_request_id = $4::uuid,
                        final_score_text = $5::text,
                        final_score_value = $6::numeric,
                        rp_delta = $7::integer,
                        ending_rank_key = $8::text,
                        ending_division = $9::smallint,
                        ending_rp = $10::integer,
                        promoted = $11::boolean,
                        demoted = $12::boolean,
                        protection_applied = $13::boolean,
                        protection_consumed = $14::boolean,
                        last_synced_from_installation_id = $15::text,
                        completed_at = $16::timestamptz,
                        last_activity_at = GREATEST(last_activity_at, $16::timestamptz),
                        updated_at = GREATEST(updated_at, $16::timestamptz),
                        state_version = state_version + 1
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                      AND status = 'active'
                      AND state_version = $3::integer
                    RETURNING ${debateColumns}
                `,
                [
                    accountId,
                    debateId,
                    expectedStateVersion,
                    requestId,
                    score.finalScoreText,
                    score.finalScoreValue,
                    rating.rpDelta,
                    rating.after.rankKey,
                    rating.after.division,
                    rating.after.rp,
                    rating.promoted,
                    rating.demoted,
                    rating.protectionApplied,
                    rating.protectionConsumed,
                    installationId,
                    completedAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async forfeitLadderDebate(
            client,
            {
                accountId,
                debateId,
                requestId,
                expectedStateVersion,
                rating,
                installationId,
                forfeitedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-unified:forfeit-ladder-debate */
                    UPDATE account_ranked_debates
                    SET
                        status = 'forfeited',
                        forfeit_request_id = $4::uuid,
                        final_score_text = '0.00/10',
                        final_score_value = 0,
                        rp_delta = $5::integer,
                        ending_rank_key = $6::text,
                        ending_division = $7::smallint,
                        ending_rp = $8::integer,
                        promoted = FALSE,
                        demoted = $9::boolean,
                        protection_applied = FALSE,
                        protection_consumed = FALSE,
                        last_synced_from_installation_id = $10::text,
                        completed_at = $11::timestamptz,
                        last_activity_at = GREATEST(last_activity_at, $11::timestamptz),
                        updated_at = GREATEST(updated_at, $11::timestamptz),
                        state_version = state_version + 1
                    WHERE account_id = $1::uuid
                      AND id = $2::uuid
                      AND status = 'active'
                      AND state_version = $3::integer
                    RETURNING ${debateColumns}
                `,
                [
                    accountId,
                    debateId,
                    expectedStateVersion,
                    requestId,
                    rating.rpDelta,
                    rating.after.rankKey,
                    rating.after.division,
                    rating.after.rp,
                    rating.demoted,
                    installationId,
                    forfeitedAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async updateProfileForLadderResult(
            client,
            {
                accountId,
                expectedStateVersion,
                rating,
                peakReachedAt,
                protectionReason,
                protectionGrantedAt,
                completedAt,
                outcome,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-unified:update-profile */
                    UPDATE account_ranked_profiles
                    SET
                        current_rank_key = $3::text,
                        current_division = $4::smallint,
                        current_rp = $5::integer,
                        peak_rank_key = $6::text,
                        peak_division = $7::smallint,
                        peak_reached_at = $8::timestamptz,
                        demotion_protection_debates_remaining = $9::smallint,
                        demotion_protection_reason = $10::text,
                        demotion_protection_granted_at = $11::timestamptz,
                        ranked_debates_completed =
                            ranked_debates_completed +
                            CASE WHEN $12::text = 'completed' THEN 1 ELSE 0 END,
                        ranked_forfeits =
                            ranked_forfeits +
                            CASE WHEN $12::text = 'forfeited' THEN 1 ELSE 0 END,
                        ranked_invalid_results =
                            ranked_invalid_results +
                            CASE WHEN $12::text = 'invalid' THEN 1 ELSE 0 END,
                        last_ranked_debate_completed_at =
                            CASE
                                WHEN $12::text = 'completed'
                                    THEN $13::timestamptz
                                ELSE last_ranked_debate_completed_at
                            END,
                        state_version = state_version + 1,
                        updated_at = GREATEST(updated_at, $13::timestamptz)
                    WHERE account_id = $1::uuid
                      AND state_version = $2::integer
                      AND placement_status = 'completed'
                    RETURNING ${profileColumns}
                `,
                [
                    accountId,
                    expectedStateVersion,
                    rating.after.rankKey,
                    rating.after.division,
                    rating.after.rp,
                    rating.peakAfter.rankKey,
                    rating.peakAfter.division,
                    peakReachedAt,
                    rating.protectionAfter,
                    protectionReason,
                    protectionGrantedAt,
                    outcome,
                    completedAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async insertRatingEvent(
            client,
            {
                accountId,
                debate,
                rating,
                eventType,
                finalScoreValue,
                occurredAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-ranked-unified:insert-rating-event */
                    INSERT INTO account_ranked_rating_events (
                        account_id,
                        ranked_debate_id,
                        event_type,
                        philosopher_id,
                        philosopher_name,
                        debate_mode,
                        topic_fingerprint,
                        final_score_value,
                        rp_delta,
                        before_rank_key,
                        before_division,
                        before_rp,
                        after_rank_key,
                        after_division,
                        after_rp,
                        promoted,
                        demoted,
                        protection_before,
                        protection_after,
                        protection_applied,
                        protection_consumed,
                        ranked_rules_version,
                        philosopher_prompt_version,
                        scoring_prompt_version,
                        report_prompt_version,
                        topic_generator_version,
                        rp_formula_version,
                        model_provider,
                        model_name,
                        formula_components,
                        occurred_at,
                        created_at
                    )
                    VALUES (
                        $1::uuid,
                        $2::uuid,
                        $3::text,
                        $4::text,
                        $5::text,
                        $6::text,
                        $7::text,
                        $8::numeric,
                        $9::integer,
                        $10::text,
                        $11::smallint,
                        $12::integer,
                        $13::text,
                        $14::smallint,
                        $15::integer,
                        $16::boolean,
                        $17::boolean,
                        $18::smallint,
                        $19::smallint,
                        $20::boolean,
                        $21::boolean,
                        $22::text,
                        $23::text,
                        $24::text,
                        $25::text,
                        $26::text,
                        $27::text,
                        $28::text,
                        $29::text,
                        $30::jsonb,
                        $31::timestamptz,
                        $31::timestamptz
                    )
                    RETURNING *
                `,
                [
                    accountId,
                    debate.id,
                    eventType,
                    debate.philosopherId,
                    debate.philosopherName,
                    debate.debateMode,
                    debate.topicFingerprint,
                    finalScoreValue,
                    rating.rpDelta,
                    rating.before.rankKey,
                    rating.before.division,
                    rating.before.rp,
                    rating.after.rankKey,
                    rating.after.division,
                    rating.after.rp,
                    rating.promoted,
                    rating.demoted,
                    rating.protectionBefore,
                    rating.protectionAfter,
                    rating.protectionApplied,
                    rating.protectionConsumed,
                    debate.rankedRulesVersion,
                    debate.philosopherPromptVersion,
                    debate.scoringPromptVersion,
                    debate.reportPromptVersion,
                    debate.topicGeneratorVersion,
                    debate.rpFormulaVersion,
                    debate.modelProvider,
                    debate.modelName,
                    JSON.stringify(rating.formulaComponents),
                    occurredAt,
                ]
            );

            return result.rows[0] ?? null;
        },

        async findRatingEvent(client, { accountId, debateId }) {
            const result = await client.query(
                `
                    /* account-ranked-unified:find-rating-event */
                    SELECT *
                    FROM account_ranked_rating_events
                    WHERE account_id = $1::uuid
                      AND ranked_debate_id = $2::uuid
                      AND event_type IN ('ladder_result', 'forfeit', 'invalid_response')
                    ORDER BY occurred_at DESC
                    LIMIT 1
                `,
                [accountId, debateId]
            );

            return result.rows[0] ?? null;
        },
    });
}

export function createAccountRankedUnifiedDebateService({
    pool = null,
    repository = null,
    baseService,
    accountAuthService,
    proAccessService,
    ratingService,
    now = () => Date.now(),
} = {}) {
    if (
        !baseService ||
        typeof baseService.resumeActiveDebate !== 'function' ||
        typeof baseService.getResolvedDebateResult !== 'function' ||
        typeof baseService.generateOpening !== 'function' ||
        typeof baseService.submitTurn !== 'function' ||
        typeof baseService.completeDebate !== 'function' ||
        typeof baseService.forfeitDebate !== 'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'A complete base Ranked debate service is required.'
        );
    }

    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
        fail(
            'invalid_ranked_debate_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (!proAccessService || typeof proAccessService.requireCurrentProAccess !== 'function') {
        fail(
            'invalid_ranked_debate_configuration',
            'proAccessService.requireCurrentProAccess() is required.'
        );
    }

    if (
        !ratingService ||
        typeof ratingService.calculateCompletedDebate !== 'function' ||
        typeof ratingService.calculateForfeit !== 'function'
    ) {
        fail(
            'invalid_ranked_debate_configuration',
            'A complete Ranked rating service is required.'
        );
    }

    const repo = repository ?? createPostgresAccountRankedUnifiedRepository(pool);

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
            if (error instanceof AccountRankedDebateError) throw error;

            fail(
                typeof error?.code === 'string' ? error.code : 'invalid_access_token',
                error?.message || 'The Agora account session is invalid or expired.',
                {
                    status: Number.isInteger(error?.status) ? error.status : 401,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function requirePro(accountId) {
        try {
            await proAccessService.requireCurrentProAccess({ accountId });
        } catch (error) {
            fail(
                typeof error?.code === 'string' ? error.code : 'pro_access_unavailable',
                error?.message || 'Agora Pro access could not be verified.',
                {
                    status: Number.isInteger(error?.status) ? error.status : 503,
                    retryable: Boolean(error?.retryable ?? true),
                    cause: error,
                }
            );
        }
    }

    async function authorizeForDebate(input, debateId) {
        const authorization = await authorize(input);
        await requirePro(authorization.accountId);

        const cleanDebateId = requireUuid(debateId, 'debateId');
        const debateKind = await repo.findDebateKind({
            accountId: authorization.accountId,
            debateId: cleanDebateId,
        });

        if (!debateKind) {
            fail(
                'ranked_debate_not_found',
                'The Ranked debate could not be found.',
                { status: 404 }
            );
        }

        return Object.freeze({
            ...authorization,
            debateId: cleanDebateId,
            debateKind,
        });
    }

    async function authorizeForResolvedDebate(input, debateId) {
        const authorization = await authorize(input);
        const cleanDebateId = requireUuid(debateId, 'debateId');
        const debateKind = await repo.findDebateKind({
            accountId: authorization.accountId,
            debateId: cleanDebateId,
        });

        if (!debateKind) {
            fail(
                'ranked_debate_not_found',
                'The Ranked debate could not be found.',
                { status: 404, retryable: false }
            );
        }

        return Object.freeze({
            ...authorization,
            debateId: cleanDebateId,
            debateKind,
        });
    }

    function enrichDebate(debate, metadata) {
        if (!debate || debate.debateKind !== 'ladder' || !metadata) return debate;

        return Object.freeze({
            ...debate,
            startingRankKey: metadata.starting_rank_key,
            startingDivision:
                metadata.starting_division == null
                    ? null
                    : Number(metadata.starting_division),
            startingRP: Number(metadata.starting_rp),
            forfeitRPLossPreview: Number(metadata.forfeit_rp_loss_preview),
            rpDelta: metadata.rp_delta == null ? null : Number(metadata.rp_delta),
            endingRankKey: metadata.ending_rank_key ?? null,
            endingDivision:
                metadata.ending_division == null
                    ? null
                    : Number(metadata.ending_division),
            endingRP: metadata.ending_rp == null ? null : Number(metadata.ending_rp),
            promoted: Boolean(metadata.promoted),
            demoted: Boolean(metadata.demoted),
            protectionApplied: Boolean(metadata.protection_applied),
            protectionConsumed: Boolean(metadata.protection_consumed),
        });
    }

    async function enrichResult(result) {
        if (!result?.debate || result.debate.debateKind !== 'ladder') return result;

        const metadata = await repo.findLadderMetadata({
            accountId: result.accountId,
            debateId: result.debate.id,
        });

        return Object.freeze({
            ...result,
            debate: enrichDebate(result.debate, metadata),
        });
    }

    async function resumeActiveDebate(input) {
        return enrichResult(await baseService.resumeActiveDebate(input));
    }

    async function generateOpening(input) {
        return enrichResult(await baseService.generateOpening(input));
    }

    async function submitTurn(input) {
        return enrichResult(await baseService.submitTurn(input));
    }

    async function completeLadderDebate({
        authorization,
        requestId,
        expectedStateVersion,
    }) {
        const cleanRequestId = requireUuid(requestId, 'requestId');
        const cleanExpectedVersion = requireStateVersion(expectedStateVersion);
        const completedAt = serviceDate(now);

        return repo.withTransaction(async (client) => {
            const configuration = await repo.loadConfiguration(client);

            if (
                !configuration ||
                configuration.configuration_key !== 'global' ||
                configuration.is_enabled !== true
            ) {
                fail(
                    'ranked_disabled',
                    'Ranked is not currently available.',
                    { status: 503, retryable: false }
                );
            }

            if (configuration.allow_resume_active_debates !== true) {
                fail(
                    'ranked_resume_disabled',
                    'Active Ranked debates are temporarily unavailable.',
                    { status: 503, retryable: true }
                );
            }

            const debate = normalizeLadderDebate(
                await repo.lockDebate(client, {
                    accountId: authorization.accountId,
                    debateId: authorization.debateId,
                }),
                authorization.accountId
            );

            if (debate.status === 'completed') {
                if (debate.completionRequestId !== cleanRequestId) {
                    fail(
                        'ranked_completion_request_conflict',
                        'This Ranked debate was already completed by a different request.',
                        {
                            status: 409,
                            retryable: false,
                            details: { requestId: debate.completionRequestId },
                        }
                    );
                }

                const profile = normalizeProfile(
                    await repo.loadProfile(client, {
                        accountId: authorization.accountId,
                    }),
                    authorization.accountId
                );
                const event = await repo.findRatingEvent(client, {
                    accountId: authorization.accountId,
                    debateId: debate.id,
                });

                if (!event) {
                    fail(
                        'ranked_ladder_result_unavailable',
                        'The completed Ranked ladder result could not be reconstructed.',
                        { status: 503, retryable: true }
                    );
                }

                return Object.freeze({
                    created: false,
                    debate,
                    profile,
                    event,
                });
            }

            if (debate.status === 'forfeited') {
                fail(
                    'ranked_debate_already_forfeited',
                    'This Ranked debate has already been forfeited and cannot be completed.',
                    { status: 409, retryable: false }
                );
            }

            if (debate.status !== 'active') {
                fail(
                    'ranked_debate_not_active',
                    'This Ranked debate is no longer active.',
                    { status: 409, retryable: false }
                );
            }

            if (debate.stateVersion !== cleanExpectedVersion) {
                fail(
                    'ranked_state_version_conflict',
                    'The Ranked debate changed before this request was applied.',
                    {
                        status: 409,
                        retryable: true,
                        details: {
                            expectedStateVersion: cleanExpectedVersion,
                            currentStateVersion: debate.stateVersion,
                        },
                    }
                );
            }

            if (requestIdAlreadyUsed(debate, cleanRequestId)) {
                fail(
                    'ranked_request_id_conflict',
                    'requestId was already used for another action in this Ranked debate.',
                    {
                        status: 409,
                        retryable: false,
                        details: { requestId: cleanRequestId },
                    }
                );
            }

            const score = scoreSummary(debate.messages);
            const profileBefore = normalizeProfile(
                await repo.lockProfile(client, {
                    accountId: authorization.accountId,
                }),
                authorization.accountId
            );

            if (profileBefore.placementStatus !== 'completed') {
                fail(
                    'ranked_profile_unavailable',
                    'The Ranked profile is not eligible for ladder results.',
                    { status: 503, retryable: true }
                );
            }

            if (
                profileBefore.currentRankKey !== debate.startingRankKey ||
                profileBefore.currentDivision !== debate.startingDivision ||
                profileBefore.currentRP !== debate.startingRP
            ) {
                fail(
                    'ranked_profile_state_conflict',
                    'The Ranked profile changed while this debate was active.',
                    { status: 409, retryable: true }
                );
            }

            const rating = ratingService.calculateCompletedDebate({
                finalScoreValue: score.finalScoreValue,
                debateMode: debate.debateMode,
                currentRankKey: profileBefore.currentRankKey,
                currentDivision: profileBefore.currentDivision,
                currentRP: profileBefore.currentRP,
                peakRankKey: profileBefore.peakRankKey,
                peakDivision: profileBefore.peakDivision,
                protectionDebatesRemaining: profileBefore.protectionRemaining,
            });

            const peakAdvanced = compareRankDivision(
                rating.peakAfter.rankKey,
                rating.peakAfter.division,
                profileBefore.peakRankKey,
                profileBefore.peakDivision
            ) > 0;
            const peakReachedAt = peakAdvanced
                ? completedAt
                : profileBefore.peakReachedAt;

            let protectionReason = null;
            let protectionGrantedAt = null;

            if (rating.protectionAfter === 1) {
                if (rating.majorPromotion) {
                    protectionReason = 'major_promotion';
                    protectionGrantedAt = completedAt;
                } else {
                    protectionReason = profileBefore.protectionReason;
                    protectionGrantedAt = profileBefore.protectionGrantedAt;
                }
            }

            const updatedDebate = normalizeLadderDebate(
                await repo.completeLadderDebate(client, {
                    accountId: authorization.accountId,
                    debateId: debate.id,
                    requestId: cleanRequestId,
                    expectedStateVersion: cleanExpectedVersion,
                    score,
                    rating,
                    installationId: authorization.installationId,
                    completedAt,
                }),
                authorization.accountId
            );

            const updatedProfile = normalizeProfile(
                await repo.updateProfileForLadderResult(client, {
                    accountId: authorization.accountId,
                    expectedStateVersion: profileBefore.stateVersion,
                    rating,
                    peakReachedAt,
                    protectionReason,
                    protectionGrantedAt,
                    completedAt,
                    outcome: 'completed',
                }),
                authorization.accountId
            );

            const event = await repo.insertRatingEvent(client, {
                accountId: authorization.accountId,
                debate: updatedDebate,
                rating,
                eventType: 'ladder_result',
                finalScoreValue: score.finalScoreValue,
                occurredAt: completedAt,
            });

            if (!event) {
                fail(
                    'ranked_rating_event_not_created',
                    'The Ranked rating event could not be saved.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                created: true,
                debate: updatedDebate,
                profile: updatedProfile,
                event,
            });
        });
    }

    async function forfeitLadderDebate({
        authorization,
        requestId,
        expectedStateVersion,
    }) {
        const cleanRequestId = requireUuid(requestId, 'requestId');
        const cleanExpectedVersion = requireStateVersion(expectedStateVersion);
        const forfeitedAt = serviceDate(now);

        return repo.withTransaction(async (client) => {
            const configuration = await repo.loadConfiguration(client);

            if (
                !configuration ||
                configuration.configuration_key !== 'global' ||
                configuration.is_enabled !== true
            ) {
                fail(
                    'ranked_disabled',
                    'Ranked is not currently available.',
                    { status: 503, retryable: false }
                );
            }

            if (configuration.allow_resume_active_debates !== true) {
                fail(
                    'ranked_resume_disabled',
                    'Active Ranked debates are temporarily unavailable.',
                    { status: 503, retryable: true }
                );
            }

            const debate = normalizeLadderDebate(
                await repo.lockDebate(client, {
                    accountId: authorization.accountId,
                    debateId: authorization.debateId,
                }),
                authorization.accountId
            );

            if (debate.status === 'forfeited') {
                if (debate.forfeitRequestId !== cleanRequestId) {
                    fail(
                        'ranked_forfeit_request_conflict',
                        'This Ranked debate was already forfeited by a different request.',
                        {
                            status: 409,
                            retryable: false,
                            details: { requestId: debate.forfeitRequestId },
                        }
                    );
                }

                const profile = normalizeProfile(
                    await repo.loadProfile(client, {
                        accountId: authorization.accountId,
                    }),
                    authorization.accountId
                );
                const event = await repo.findRatingEvent(client, {
                    accountId: authorization.accountId,
                    debateId: debate.id,
                });

                if (!event) {
                    fail(
                        'ranked_ladder_result_unavailable',
                        'The forfeited Ranked ladder result could not be reconstructed.',
                        { status: 503, retryable: true }
                    );
                }

                return Object.freeze({
                    created: false,
                    debate,
                    profile,
                    event,
                });
            }

            if (debate.status === 'completed') {
                fail(
                    'ranked_debate_already_completed',
                    'This Ranked debate has already been completed and cannot be forfeited.',
                    { status: 409, retryable: false }
                );
            }

            if (debate.status !== 'active') {
                fail(
                    'ranked_debate_not_active',
                    'This Ranked debate is no longer active.',
                    { status: 409, retryable: false }
                );
            }

            if (debate.stateVersion !== cleanExpectedVersion) {
                fail(
                    'ranked_state_version_conflict',
                    'The Ranked debate changed before this request was applied.',
                    {
                        status: 409,
                        retryable: true,
                        details: {
                            expectedStateVersion: cleanExpectedVersion,
                            currentStateVersion: debate.stateVersion,
                        },
                    }
                );
            }

            if (requestIdAlreadyUsed(debate, cleanRequestId)) {
                fail(
                    'ranked_request_id_conflict',
                    'requestId was already used for another action in this Ranked debate.',
                    {
                        status: 409,
                        retryable: false,
                        details: { requestId: cleanRequestId },
                    }
                );
            }

            const profileBefore = normalizeProfile(
                await repo.lockProfile(client, {
                    accountId: authorization.accountId,
                }),
                authorization.accountId
            );

            if (
                profileBefore.currentRankKey !== debate.startingRankKey ||
                profileBefore.currentDivision !== debate.startingDivision ||
                profileBefore.currentRP !== debate.startingRP
            ) {
                fail(
                    'ranked_profile_state_conflict',
                    'The Ranked profile changed while this debate was active.',
                    { status: 409, retryable: true }
                );
            }

            const rating = ratingService.calculateForfeit({
                currentRankKey: profileBefore.currentRankKey,
                currentDivision: profileBefore.currentDivision,
                currentRP: profileBefore.currentRP,
                peakRankKey: profileBefore.peakRankKey,
                peakDivision: profileBefore.peakDivision,
                protectionDebatesRemaining: profileBefore.protectionRemaining,
            });

            if (Math.abs(rating.rpDelta) !== debate.forfeitRPLossPreview) {
                fail(
                    'ranked_forfeit_preview_changed',
                    'The Ranked forfeit loss no longer matches the loss shown when this debate began.',
                    {
                        status: 409,
                        retryable: true,
                        details: { rpLoss: Math.abs(rating.rpDelta) },
                    }
                );
            }

            const updatedDebate = normalizeLadderDebate(
                await repo.forfeitLadderDebate(client, {
                    accountId: authorization.accountId,
                    debateId: debate.id,
                    requestId: cleanRequestId,
                    expectedStateVersion: cleanExpectedVersion,
                    rating,
                    installationId: authorization.installationId,
                    forfeitedAt,
                }),
                authorization.accountId
            );

            const updatedProfile = normalizeProfile(
                await repo.updateProfileForLadderResult(client, {
                    accountId: authorization.accountId,
                    expectedStateVersion: profileBefore.stateVersion,
                    rating,
                    peakReachedAt: profileBefore.peakReachedAt,
                    protectionReason: profileBefore.protectionReason,
                    protectionGrantedAt: profileBefore.protectionGrantedAt,
                    completedAt: forfeitedAt,
                    outcome: 'forfeited',
                }),
                authorization.accountId
            );

            const event = await repo.insertRatingEvent(client, {
                accountId: authorization.accountId,
                debate: updatedDebate,
                rating,
                eventType: 'forfeit',
                finalScoreValue: 0,
                occurredAt: forfeitedAt,
            });

            if (!event) {
                fail(
                    'ranked_rating_event_not_created',
                    'The Ranked forfeit event could not be saved.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                created: true,
                debate: updatedDebate,
                profile: updatedProfile,
                event,
            });
        });
    }

    async function listResolvedDebates(input = {}) {
        const authorization = await authorize(input);

        if (typeof repo.listResolvedDebates !== 'function') {
            fail(
                'invalid_ranked_debate_configuration',
                'Ranked history listing is not configured.'
            );
        }

        const limit = requireResolvedPageLimit(input.limit);
        const cursor = decodeResolvedCursor(input.cursor);
        const rows = await repo.listResolvedDebates({
            accountId: authorization.accountId,
            limit: limit + 1,
            cursorCompletedAt: cursor?.completedAt ?? null,
            cursorDebateId: cursor?.debateId ?? null,
        });

        if (!Array.isArray(rows)) {
            fail(
                'ranked_history_state_unavailable',
                'Resolved Ranked history is unavailable.',
                { status: 503, retryable: true }
            );
        }

        const normalized = rows.map((row) =>
            normalizeResolvedDebateIndexRow(
                row,
                authorization.accountId
            )
        );

        const hasMore = normalized.length > limit;
        const debates = normalized.slice(0, limit);
        const lastDebate = debates.at(-1) ?? null;
        const nextCursor =
            hasMore && lastDebate
                ? encodeResolvedCursor({
                    completedAt: lastDebate.completedAt,
                    debateId: lastDebate.id,
                })
                : null;

        return Object.freeze({
            schemaVersion: RANKED_DEBATE_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            retrievedAt: serviceDate(now),
            debates: Object.freeze(debates),
            nextCursor,
            hasMore,
        });
    }

    async function completeDebate(input) {
        const authorization = await authorizeForDebate(input, input.debateId);

        if (authorization.debateKind !== 'ladder') {
            return baseService.completeDebate(input);
        }

        const result = await completeLadderDebate({
            authorization,
            requestId: input.requestId,
            expectedStateVersion: input.expectedStateVersion,
        });

        return Object.freeze({
            schemaVersion: RANKED_DEBATE_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            requestId: requireUuid(input.requestId, 'requestId'),
            created: result.created,
            debate: publicDebate(result.debate),
            completion: ladderCompletionPayload(result),
        });
    }

    async function forfeitDebate(input) {
        const authorization = await authorizeForDebate(input, input.debateId);

        if (authorization.debateKind !== 'ladder') {
            return baseService.forfeitDebate(input);
        }

        const result = await forfeitLadderDebate({
            authorization,
            requestId: input.requestId,
            expectedStateVersion: input.expectedStateVersion,
        });

        return Object.freeze({
            schemaVersion: RANKED_DEBATE_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            requestId: requireUuid(input.requestId, 'requestId'),
            created: result.created,
            debate: publicDebate(result.debate),
            completion: ladderCompletionPayload(result),
        });
    }

    async function getResolvedDebateResult(input) {
        const authorization = await authorizeForResolvedDebate(
            input,
            input.debateId
        );

        if (authorization.debateKind !== 'ladder') {
            return baseService.getResolvedDebateResult(input);
        }

        const result = await repo.withTransaction(async (client) => {
            const debate = normalizeLadderDebate(
                await repo.loadDebate(client, {
                    accountId: authorization.accountId,
                    debateId: authorization.debateId,
                }),
                authorization.accountId
            );

            if (!['completed', 'forfeited', 'invalid'].includes(debate.status)) {
                fail(
                    'ranked_debate_result_not_available',
                    'This Ranked debate does not have a completed result yet.',
                    { status: 409, retryable: false }
                );
            }

            const requestId =
                debate.status === 'forfeited'
                    ? debate.forfeitRequestId
                    : debate.completionRequestId;

            if (!requestId) {
                fail(
                    'ranked_result_state_unavailable',
                    'The resolved Ranked debate is missing its request identity.',
                    { status: 503, retryable: true }
                );
            }

            const profile = normalizeProfile(
                await repo.loadProfile(client, {
                    accountId: authorization.accountId,
                }),
                authorization.accountId
            );
            const event = await repo.findRatingEvent(client, {
                accountId: authorization.accountId,
                debateId: debate.id,
            });

            if (!event) {
                fail(
                    'ranked_ladder_result_unavailable',
                    'The Ranked ladder result could not be reconstructed.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                requestId,
                debate,
                profile,
                event,
            });
        });

        return Object.freeze({
            schemaVersion: RANKED_DEBATE_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            requestId: result.requestId,
            created: false,
            retrievedAt: serviceDate(now),
            debate: publicDebate(result.debate),
            completion: ladderCompletionPayload(result),
        });
    }

    return Object.freeze({
        resumeActiveDebate,
        listResolvedDebates,
        getResolvedDebateResult,
        generateOpening,
        submitTurn,
        completeDebate,
        forfeitDebate,
    });
}
