import crypto from 'node:crypto';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const ISO_DATE_TIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const HISTORY_SCHEMA_VERSION = 1;
const MAX_BATCH_SIZE = 25;
const MAX_MESSAGES_PER_DEBATE = 200;
const MAX_ROUND_SCORES = 100;
const MAX_DEBATE_JSON_BYTES = 250_000;
const MAX_BATCH_JSON_BYTES = 1_750_000;

const DOWNLOAD_CURSOR_VERSION = 1;
const DEFAULT_DOWNLOAD_PAGE_SIZE = 25;
const MAX_DOWNLOAD_PAGE_SIZE = 50;
const MAX_DOWNLOAD_CURSOR_LENGTH = 512;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export class AccountDebateHistoryError extends Error {
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
        this.name = 'AccountDebateHistoryError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountDebateHistoryError(
        code,
        message,
        options
    );
}

function requireObject(value, fieldName) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} must be an object.`,
            { status: 400 }
        );
    }

    return value;
}

function requireArray(value, fieldName, maximum) {
    if (!Array.isArray(value)) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} must be an array.`,
            { status: 400 }
        );
    }

    if (value.length > maximum) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} contains too many items.`,
            { status: 400 }
        );
    }

    return value;
}

function requireString(
    value,
    fieldName,
    {
        maxLength = 16_384,
        pattern = null,
        preserveWhitespace = false,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();
    const returnedValue = preserveWhitespace
        ? value
        : cleaned;

    if (!cleaned || value.length > maxLength) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    if (pattern && !pattern.test(cleaned)) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} has an invalid format.`,
            { status: 400 }
        );
    }

    return returnedValue;
}

function optionalString(value, fieldName, maximum) {
    if (value == null) return null;
    return requireString(value, fieldName, {
        maxLength: maximum,
    });
}

function requireText(value, fieldName, maximum) {
    return requireString(value, fieldName, {
        maxLength: maximum,
        preserveWhitespace: true,
    });
}

function optionalText(value, fieldName, maximum) {
    if (value == null) return null;
    return requireText(value, fieldName, maximum);
}

function requireUuid(value, fieldName) {
    return requireString(value, fieldName, {
        maxLength: 64,
        pattern: UUID_RE,
    }).toLowerCase();
}

function optionalUuid(value, fieldName) {
    if (value == null) return null;
    return requireUuid(value, fieldName);
}

function optionalEnumString(
    value,
    fieldName,
    allowedValues
) {
    if (value == null) return null;

    const cleaned = requireString(
        value,
        fieldName,
        { maxLength: 50 }
    ).toLowerCase();

    if (!allowedValues.has(cleaned)) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is not supported.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function requireFiniteNumberInRange(
    value,
    fieldName,
    minimum,
    maximum
) {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum
    ) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return value;
}

function optionalFiniteNumberInRange(
    value,
    fieldName,
    minimum,
    maximum
) {
    if (value == null) return null;

    return requireFiniteNumberInRange(
        value,
        fieldName,
        minimum,
        maximum
    );
}

function optionalIntegerInRange(
    value,
    fieldName,
    minimum,
    maximum
) {
    if (value == null) return null;

    return requireIntegerInRange(
        value,
        fieldName,
        minimum,
        maximum
    );
}

function requireInstallationId(value) {
    return requireString(value, 'installationId', {
        maxLength: 128,
        pattern: INSTALLATION_ID_RE,
    });
}

function requireBoolean(value, fieldName) {
    if (typeof value !== 'boolean') {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} must be a boolean.`,
            { status: 400 }
        );
    }

    return value;
}

function requirePositiveInteger(value, fieldName, maximum) {
    if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > maximum
    ) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return value;
}

function requireIntegerInRange(
    value,
    fieldName,
    minimum,
    maximum
) {
    if (
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
    ) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return value;
}

function optionalScoreValue(value, fieldName) {
    if (value == null) return null;

    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 10
    ) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} must be between 0 and 10.`,
            { status: 400 }
        );
    }

    return value;
}

function normalizeIsoDate(value, fieldName) {
    const cleaned = requireString(value, fieldName, {
        maxLength: 64,
        pattern: ISO_DATE_TIME_RE,
    });
    const date = new Date(cleaned);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is not a valid date.`,
            { status: 400 }
        );
    }

    return date.toISOString();
}

function optionalCalendarDate(value, fieldName) {
    if (value == null) return null;

    const cleaned = requireString(value, fieldName, {
        maxLength: 10,
        pattern: CALENDAR_DATE_RE,
    });
    const parsed = new Date(`${cleaned}T00:00:00.000Z`);

    if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== cleaned
    ) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName} is not a valid calendar date.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function normalizeStringArray(
    value,
    fieldName,
    {
        maximumItems = 50,
        maximumLength = 5_000,
    } = {}
) {
    return requireArray(
        value,
        fieldName,
        maximumItems
    ).map((item, index) =>
        requireText(
            item,
            `${fieldName}[${index}]`,
            maximumLength
        )
    );
}

function normalizeScoreUpdate(value, fieldName) {
    if (value == null) return null;

    const scoreUpdate = requireObject(value, fieldName);

    return Object.freeze({
        score: requireString(
            scoreUpdate.score,
            `${fieldName}.score`,
            { maxLength: 50 }
        ),
        note: requireText(
            scoreUpdate.note,
            `${fieldName}.note`,
            2_000
        ),
    });
}

function normalizeMessage(value, debateIndex, messageIndex) {
    const prefix =
        `debates[${debateIndex}].messages[${messageIndex}]`;
    const message = requireObject(value, prefix);
    const role = requireString(
        message.role,
        `${prefix}.role`,
        { maxLength: 20 }
    );

    if (role !== 'user' && role !== 'assistant') {
        fail(
            'invalid_debate_history_payload',
            `${prefix}.role is not supported.`,
            { status: 400 }
        );
    }

    return Object.freeze({
        id: requireUuid(message.id, `${prefix}.id`),
        role,
        content: requireText(
            message.content,
            `${prefix}.content`,
            20_000
        ),
        timestamp: normalizeIsoDate(
            message.timestamp,
            `${prefix}.timestamp`
        ),
        scoreUpdate: normalizeScoreUpdate(
            message.scoreUpdate,
            `${prefix}.scoreUpdate`
        ),
    });
}

function normalizeRoundScore(value, debateIndex, roundIndex) {
    const prefix =
        `debates[${debateIndex}].report.roundScores[${roundIndex}]`;
    const roundScore = requireObject(value, prefix);

    return Object.freeze({
        id: requireUuid(roundScore.id, `${prefix}.id`),
        round: requirePositiveInteger(
            roundScore.round,
            `${prefix}.round`,
            1_000
        ),
        score: requireIntegerInRange(
            roundScore.score,
            `${prefix}.score`,
            0,
            10
        ),
        justification: requireText(
            roundScore.justification,
            `${prefix}.justification`,
            10_000
        ),
    });
}

function normalizeReport(value, debateIndex) {
    if (value == null) return null;

    const prefix = `debates[${debateIndex}].report`;
    const report = requireObject(value, prefix);
    const roundScores = requireArray(
        report.roundScores,
        `${prefix}.roundScores`,
        MAX_ROUND_SCORES
    ).map((item, index) =>
        normalizeRoundScore(item, debateIndex, index)
    );

    const roundIds = new Set();

    for (const roundScore of roundScores) {
        if (roundIds.has(roundScore.id)) {
            fail(
                'duplicate_round_score_id',
                `${prefix}.roundScores contains a duplicate id.`,
                { status: 400 }
            );
        }

        roundIds.add(roundScore.id);
    }

    return Object.freeze({
        overallScore: requireString(
            report.overallScore,
            `${prefix}.overallScore`,
            { maxLength: 50 }
        ),
        verdict: optionalText(
            report.verdict,
            `${prefix}.verdict`,
            5_000
        ),
        arc: optionalText(
            report.arc,
            `${prefix}.arc`,
            20_000
        ),
        roundScores,
        strengths: normalizeStringArray(
            report.strengths,
            `${prefix}.strengths`
        ),
        weaknesses: normalizeStringArray(
            report.weaknesses,
            `${prefix}.weaknesses`
        ),
        improvements: normalizeStringArray(
            report.improvements,
            `${prefix}.improvements`
        ),
        perfectArgument: requireText(
            report.perfectArgument,
            `${prefix}.perfectArgument`,
            30_000
        ),
        rematchFocus: optionalText(
            report.rematchFocus,
            `${prefix}.rematchFocus`,
            10_000
        ),
        philosopherName: requireString(
            report.philosopherName,
            `${prefix}.philosopherName`,
            { maxLength: 100 }
        ),
        generatedAt: normalizeIsoDate(
            report.generatedAt,
            `${prefix}.generatedAt`
        ),
        shareCardQuote: optionalText(
            report.shareCardQuote,
            `${prefix}.shareCardQuote`,
            500
        ),
        shareCardQuoteSpeaker: optionalString(
            report.shareCardQuoteSpeaker,
            `${prefix}.shareCardQuoteSpeaker`,
            100
        ),
        shareCardQuoteLabel: optionalString(
            report.shareCardQuoteLabel,
            `${prefix}.shareCardQuoteLabel`,
            100
        ),
    });
}

const RANKED_DEBATE_KINDS = new Set([
    'placement',
    'ladder',
]);

const RANKED_DEBATE_OUTCOMES = new Set([
    'completed',
    'forfeited',
]);

function normalizeRankedPlacementContext(
    value,
    fieldName
) {
    const placement = requireObject(
        value,
        fieldName
    );

    return Object.freeze({
        trialNumber: requireIntegerInRange(
            placement.trialNumber,
            `${fieldName}.trialNumber`,
            1,
            5
        ),
        trialsCompleted: requireIntegerInRange(
            placement.trialsCompleted,
            `${fieldName}.trialsCompleted`,
            0,
            5
        ),
        trialsRequired: requireIntegerInRange(
            placement.trialsRequired,
            `${fieldName}.trialsRequired`,
            1,
            5
        ),
        placementWeightPercent:
            requireFiniteNumberInRange(
                placement.placementWeightPercent,
                `${fieldName}.placementWeightPercent`,
                0,
                100
            ),
        weightedScoreContribution:
            requireFiniteNumberInRange(
                placement.weightedScoreContribution,
                `${fieldName}.weightedScoreContribution`,
                0,
                10
            ),
        placementCompleted: requireBoolean(
            placement.placementCompleted,
            `${fieldName}.placementCompleted`
        ),
        placementWeightedScore:
            optionalFiniteNumberInRange(
                placement.placementWeightedScore,
                `${fieldName}.placementWeightedScore`,
                0,
                10
            ),
        startingRankText: optionalString(
            placement.startingRankText,
            `${fieldName}.startingRankText`,
            100
        ),
        nextTrialNumber: optionalIntegerInRange(
            placement.nextTrialNumber,
            `${fieldName}.nextTrialNumber`,
            1,
            5
        ),
        nextModeName: optionalString(
            placement.nextModeName,
            `${fieldName}.nextModeName`,
            50
        ),
    });
}

function normalizeRankedLadderContext(
    value,
    fieldName
) {
    const ladder = requireObject(
        value,
        fieldName
    );

    return Object.freeze({
        rpDelta: requireIntegerInRange(
            ladder.rpDelta,
            `${fieldName}.rpDelta`,
            -10_000,
            10_000
        ),
        beforeRankText: requireString(
            ladder.beforeRankText,
            `${fieldName}.beforeRankText`,
            { maxLength: 100 }
        ),
        beforeRP: requireIntegerInRange(
            ladder.beforeRP,
            `${fieldName}.beforeRP`,
            0,
            100_000
        ),
        afterRankText: requireString(
            ladder.afterRankText,
            `${fieldName}.afterRankText`,
            { maxLength: 100 }
        ),
        afterRP: requireIntegerInRange(
            ladder.afterRP,
            `${fieldName}.afterRP`,
            0,
            100_000
        ),
        promoted: requireBoolean(
            ladder.promoted,
            `${fieldName}.promoted`
        ),
        demoted: requireBoolean(
            ladder.demoted,
            `${fieldName}.demoted`
        ),
        protectionApplied: requireBoolean(
            ladder.protectionApplied,
            `${fieldName}.protectionApplied`
        ),
        protectionConsumed: requireBoolean(
            ladder.protectionConsumed,
            `${fieldName}.protectionConsumed`
        ),
    });
}

function normalizeRankedReportContext(
    value,
    fieldName
) {
    if (value == null) return null;

    const context = requireObject(
        value,
        fieldName
    );
    const kind = optionalEnumString(
        context.kind,
        `${fieldName}.kind`,
        RANKED_DEBATE_KINDS
    );

    if (kind == null) {
        fail(
            'invalid_debate_history_payload',
            `${fieldName}.kind is required.`,
            { status: 400 }
        );
    }

    const normalized = {
        kind,
        modeName: requireString(
            context.modeName,
            `${fieldName}.modeName`,
            { maxLength: 50 }
        ),
        finalScoreText: requireString(
            context.finalScoreText,
            `${fieldName}.finalScoreText`,
            { maxLength: 50 }
        ),
        scoredRoundCount: requireIntegerInRange(
            context.scoredRoundCount,
            `${fieldName}.scoredRoundCount`,
            0,
            1_000
        ),
        placement: null,
        ladder: null,
    };

    if (kind === 'placement') {
        normalized.placement =
            normalizeRankedPlacementContext(
                context.placement,
                `${fieldName}.placement`
            );

        if (context.ladder != null) {
            fail(
                'invalid_debate_history_payload',
                `${fieldName}.ladder must be absent for a placement result.`,
                { status: 400 }
            );
        }
    } else {
        normalized.ladder =
            normalizeRankedLadderContext(
                context.ladder,
                `${fieldName}.ladder`
            );

        if (context.placement != null) {
            fail(
                'invalid_debate_history_payload',
                `${fieldName}.placement must be absent for a ladder result.`,
                { status: 400 }
            );
        }
    }

    if (
        Buffer.byteLength(
            canonicalJson(normalized),
            'utf8'
        ) > 20_000
    ) {
        fail(
            'debate_history_record_too_large',
            `${fieldName} exceeds the maximum supported size.`,
            { status: 413 }
        );
    }

    return Object.freeze(normalized);
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }

    if (value && typeof value === 'object') {
        const entries = Object.keys(value)
            .sort()
            .map((key) =>
                `${JSON.stringify(key)}:${canonicalJson(value[key])}`
            );

        return `{${entries.join(',')}}`;
    }

    return JSON.stringify(value);
}


function normalizeDebate(value, debateIndex) {
    const prefix = `debates[${debateIndex}]`;
    const debate = requireObject(value, prefix);
    const messages = requireArray(
        debate.messages,
        `${prefix}.messages`,
        MAX_MESSAGES_PER_DEBATE
    ).map((item, index) =>
        normalizeMessage(item, debateIndex, index)
    );

    const messageIds = new Set();

    for (const message of messages) {
        if (messageIds.has(message.id)) {
            fail(
                'duplicate_message_id',
                `${prefix}.messages contains a duplicate id.`,
                { status: 400 }
            );
        }

        messageIds.add(message.id);
    }

    const normalized = {
        savedDebateId: requireUuid(
            debate.id,
            `${prefix}.id`
        ),
        analyticsDebateId: optionalString(
            debate.analyticsDebateId,
            `${prefix}.analyticsDebateId`,
            128
        ),
        philosopherName: requireString(
            debate.philosopherName,
            `${prefix}.philosopherName`,
            { maxLength: 100 }
        ),
        philosopherInitials: requireString(
            debate.philosopherInitials,
            `${prefix}.philosopherInitials`,
            { maxLength: 20 }
        ),
        philosopherColorHex: requireString(
            debate.philosopherColorHex,
            `${prefix}.philosopherColorHex`,
            { maxLength: 32 }
        ),
        topic: requireText(
            debate.topic,
            `${prefix}.topic`,
            2_000
        ),
        date: normalizeIsoDate(
            debate.date,
            `${prefix}.date`
        ),
        messages,
        finalScore: optionalString(
            debate.finalScore,
            `${prefix}.finalScore`,
            50
        ),
        finalScoreValue: optionalScoreValue(
            debate.finalScoreValue,
            `${prefix}.finalScoreValue`
        ),
        hasBeenAnalyzed: requireBoolean(
            debate.hasBeenAnalyzed,
            `${prefix}.hasBeenAnalyzed`
        ),
        report: normalizeReport(
            debate.report,
            debateIndex
        ),
        isDailyChallenge: requireBoolean(
            debate.isDailyChallenge,
            `${prefix}.isDailyChallenge`
        ),
        dailyChallengeId: optionalString(
            debate.dailyChallengeId,
            `${prefix}.dailyChallengeId`,
            128
        ),
        dailyChallengeDate: optionalCalendarDate(
            debate.dailyChallengeDate,
            `${prefix}.dailyChallengeDate`
        ),
        debateModeRawValue: optionalString(
            debate.debateModeRawValue,
            `${prefix}.debateModeRawValue`,
            50
        ),
        rankedDebateId: optionalUuid(
            debate.rankedDebateId,
            `${prefix}.rankedDebateId`
        ),
        rankedDebateKindRawValue:
            optionalEnumString(
                debate.rankedDebateKindRawValue,
                `${prefix}.rankedDebateKindRawValue`,
                RANKED_DEBATE_KINDS
            ),
        rankedOutcomeRawValue:
            optionalEnumString(
                debate.rankedOutcomeRawValue,
                `${prefix}.rankedOutcomeRawValue`,
                RANKED_DEBATE_OUTCOMES
            ),
        rankedReportContext:
            normalizeRankedReportContext(
                debate.rankedReportContext,
                `${prefix}.rankedReportContext`
            ),
        contentUpdatedAt: normalizeIsoDate(
            debate.contentUpdatedAt,
            `${prefix}.contentUpdatedAt`
        ),
    };

    const hasAnyRankedMetadata =
        normalized.rankedDebateId != null ||
        normalized.rankedDebateKindRawValue != null ||
        normalized.rankedOutcomeRawValue != null ||
        normalized.rankedReportContext != null;

    if (hasAnyRankedMetadata) {
        if (
            normalized.rankedDebateId == null ||
            normalized.rankedDebateKindRawValue == null ||
            normalized.rankedOutcomeRawValue == null ||
            normalized.rankedReportContext == null
        ) {
            fail(
                'invalid_debate_history_payload',
                `${prefix} contains incomplete Ranked metadata.`,
                { status: 400 }
            );
        }

        if (
            normalized.rankedDebateId !==
            normalized.savedDebateId
        ) {
            fail(
                'invalid_debate_history_payload',
                `${prefix}.rankedDebateId must match the SavedDebate id.`,
                { status: 400 }
            );
        }

        if (
            normalized.rankedReportContext.kind !==
            normalized.rankedDebateKindRawValue
        ) {
            fail(
                'invalid_debate_history_payload',
                `${prefix} contains inconsistent Ranked result types.`,
                { status: 400 }
            );
        }

        if (normalized.isDailyChallenge) {
            fail(
                'invalid_debate_history_payload',
                `${prefix} cannot be both Ranked and a Daily Challenge.`,
                { status: 400 }
            );
        }
    }

    const encoded = canonicalJson(normalized);
    const byteLength = Buffer.byteLength(encoded, 'utf8');

    if (byteLength > MAX_DEBATE_JSON_BYTES) {
        fail(
            'debate_history_record_too_large',
            `${prefix} exceeds the maximum supported size.`,
            { status: 413 }
        );
    }

    return Object.freeze({
        ...normalized,
        contentSha256: crypto
            .createHash('sha256')
            .update(encoded, 'utf8')
            .digest('hex'),
    });
}

function normalizeBatch({ schemaVersion, debates }) {
    if (schemaVersion !== HISTORY_SCHEMA_VERSION) {
        fail(
            'unsupported_debate_history_schema',
            'The debate-history schema version is not supported.',
            { status: 400 }
        );
    }

    const items = requireArray(
        debates,
        'debates',
        MAX_BATCH_SIZE
    );

    if (items.length === 0) {
        fail(
            'invalid_debate_history_payload',
            'debates must contain at least one record.',
            { status: 400 }
        );
    }

    const normalized = items.map(normalizeDebate);
    const debateIds = new Set();

    for (const debate of normalized) {
        if (debateIds.has(debate.savedDebateId)) {
            fail(
                'duplicate_saved_debate_id',
                'The batch contains a duplicate SavedDebate id.',
                { status: 400 }
            );
        }

        debateIds.add(debate.savedDebateId);
    }

    const batchBytes = Buffer.byteLength(
        canonicalJson(normalized),
        'utf8'
    );

    if (batchBytes > MAX_BATCH_JSON_BYTES) {
        fail(
            'debate_history_batch_too_large',
            'The debate-history batch exceeds the maximum supported size.',
            { status: 413 }
        );
    }

    return normalized;
}


function normalizeDownloadPageLimit(value) {
    if (value == null || value === '') {
        return DEFAULT_DOWNLOAD_PAGE_SIZE;
    }

    const parsed =
        typeof value === 'number'
            ? value
            : (
                typeof value === 'string' &&
                /^\d+$/.test(value.trim())
                    ? Number(value.trim())
                    : Number.NaN
            );

    if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_DOWNLOAD_PAGE_SIZE
    ) {
        fail(
            'invalid_debate_history_page_limit',
            `limit must be between 1 and ${MAX_DOWNLOAD_PAGE_SIZE}.`,
            { status: 400 }
        );
    }

    return parsed;
}

function decodeDownloadCursor(value) {
    if (value == null || value === '') {
        return null;
    }

    if (
        typeof value !== 'string' ||
        value.length > MAX_DOWNLOAD_CURSOR_LENGTH ||
        !BASE64URL_RE.test(value)
    ) {
        fail(
            'invalid_debate_history_cursor',
            'The debate-history cursor is invalid.',
            { status: 400 }
        );
    }

    let decodedText;

    try {
        const decodedBuffer = Buffer.from(value, 'base64url');

        if (
            decodedBuffer.length === 0 ||
            decodedBuffer.toString('base64url') !== value
        ) {
            throw new Error('Invalid base64url cursor.');
        }

        decodedText = decodedBuffer.toString('utf8');
    } catch {
        fail(
            'invalid_debate_history_cursor',
            'The debate-history cursor is invalid.',
            { status: 400 }
        );
    }

    let payload;

    try {
        payload = JSON.parse(decodedText);
    } catch {
        fail(
            'invalid_debate_history_cursor',
            'The debate-history cursor is invalid.',
            { status: 400 }
        );
    }

    if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        payload.v !== DOWNLOAD_CURSOR_VERSION
    ) {
        fail(
            'invalid_debate_history_cursor',
            'The debate-history cursor is invalid.',
            { status: 400 }
        );
    }

    const keys = Object.keys(payload).sort();

    if (
        keys.length !== 3 ||
        keys[0] !== 'd' ||
        keys[1] !== 'i' ||
        keys[2] !== 'v'
    ) {
        fail(
            'invalid_debate_history_cursor',
            'The debate-history cursor is invalid.',
            { status: 400 }
        );
    }

    try {
        return Object.freeze({
            debateDate: normalizeIsoDate(
                payload.d,
                'cursor.debateDate'
            ),
            savedDebateId: requireUuid(
                payload.i,
                'cursor.savedDebateId'
            ),
        });
    } catch (error) {
        if (error instanceof AccountDebateHistoryError) {
            fail(
                'invalid_debate_history_cursor',
                'The debate-history cursor is invalid.',
                {
                    status: 400,
                    cause: error,
                }
            );
        }

        throw error;
    }
}

function encodeDownloadCursor({
    debateDate,
    savedDebateId,
}) {
    const payload = JSON.stringify({
        v: DOWNLOAD_CURSOR_VERSION,
        d: normalizeIsoDate(
            debateDate,
            'cursor.debateDate'
        ),
        i: requireUuid(
            savedDebateId,
            'cursor.savedDebateId'
        ),
    });

    return Buffer.from(payload, 'utf8').toString('base64url');
}

function normalizeDatabaseDate(value, fieldName) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            fail(
                'debate_history_download_unavailable',
                'Debate history contains an invalid date.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        return value.toISOString();
    }

    if (typeof value === 'string') {
        try {
            return normalizeIsoDate(value, fieldName);
        } catch (error) {
            if (error instanceof AccountDebateHistoryError) {
                fail(
                    'debate_history_download_unavailable',
                    'Debate history contains an invalid date.',
                    {
                        status: 503,
                        retryable: true,
                        cause: error,
                    }
                );
            }

            throw error;
        }
    }

    fail(
        'debate_history_download_unavailable',
        'Debate history contains an invalid date.',
        {
            status: 503,
            retryable: true,
        }
    );
}

function normalizeDatabaseCalendarDate(value, fieldName) {
    if (value == null) return null;

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            fail(
                'debate_history_download_unavailable',
                'Debate history contains an invalid calendar date.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        return value.toISOString().slice(0, 10);
    }

    if (typeof value === 'string') {
        try {
            return optionalCalendarDate(value, fieldName);
        } catch (error) {
            if (error instanceof AccountDebateHistoryError) {
                fail(
                    'debate_history_download_unavailable',
                    'Debate history contains an invalid calendar date.',
                    {
                        status: 503,
                        retryable: true,
                        cause: error,
                    }
                );
            }

            throw error;
        }
    }

    fail(
        'debate_history_download_unavailable',
        'Debate history contains an invalid calendar date.',
        {
            status: 503,
            retryable: true,
        }
    );
}

function normalizeDatabaseJson(value, fieldName) {
    if (typeof value !== 'string') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        fail(
            'debate_history_download_unavailable',
            `Debate history contains invalid ${fieldName} JSON.`,
            {
                status: 503,
                retryable: true,
                cause: error,
            }
        );
    }
}

function rowValue(row, snakeCase, camelCase) {
    if (
        Object.prototype.hasOwnProperty.call(row, snakeCase)
    ) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeDownloadedDebate(
    row,
    rowIndex,
    expectedAccountId
) {
    if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'debate_history_download_unavailable',
            'Debate history returned an invalid database row.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const rowAccountId = requireUuid(
        rowValue(row, 'account_id', 'accountId'),
        `rows[${rowIndex}].accountId`
    );

    if (rowAccountId !== expectedAccountId) {
        fail(
            'debate_history_account_mismatch',
            'Debate history returned data for a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const sourceSchemaVersion = rowValue(
        row,
        'source_schema_version',
        'sourceSchemaVersion'
    );

    if (sourceSchemaVersion !== HISTORY_SCHEMA_VERSION) {
        fail(
            'unsupported_stored_debate_history_schema',
            'Stored debate history uses an unsupported schema version.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const normalized = normalizeDebate(
        {
            id: rowValue(
                row,
                'saved_debate_id',
                'savedDebateId'
            ),
            analyticsDebateId: rowValue(
                row,
                'analytics_debate_id',
                'analyticsDebateId'
            ),
            philosopherName: rowValue(
                row,
                'philosopher_name',
                'philosopherName'
            ),
            philosopherInitials: rowValue(
                row,
                'philosopher_initials',
                'philosopherInitials'
            ),
            philosopherColorHex: rowValue(
                row,
                'philosopher_color_hex',
                'philosopherColorHex'
            ),
            topic: rowValue(row, 'topic', 'topic'),
            date: normalizeDatabaseDate(
                rowValue(
                    row,
                    'debate_date',
                    'debateDate'
                ),
                `rows[${rowIndex}].debateDate`
            ),
            messages: normalizeDatabaseJson(
                rowValue(row, 'messages', 'messages'),
                'messages'
            ),
            finalScore: rowValue(
                row,
                'final_score_text',
                'finalScore'
            ),
            finalScoreValue: rowValue(
                row,
                'final_score_value',
                'finalScoreValue'
            ),
            hasBeenAnalyzed: rowValue(
                row,
                'has_been_analyzed',
                'hasBeenAnalyzed'
            ),
            report: normalizeDatabaseJson(
                rowValue(row, 'report', 'report'),
                'report'
            ),
            isDailyChallenge: rowValue(
                row,
                'is_daily_challenge',
                'isDailyChallenge'
            ),
            dailyChallengeId: rowValue(
                row,
                'daily_challenge_id',
                'dailyChallengeId'
            ),
            dailyChallengeDate:
                normalizeDatabaseCalendarDate(
                    rowValue(
                        row,
                        'daily_challenge_date',
                        'dailyChallengeDate'
                    ),
                    `rows[${rowIndex}].dailyChallengeDate`
                ),
            debateModeRawValue: rowValue(
                row,
                'debate_mode_raw_value',
                'debateModeRawValue'
            ),
            rankedDebateId: rowValue(
                row,
                'ranked_debate_id',
                'rankedDebateId'
            ),
            rankedDebateKindRawValue: rowValue(
                row,
                'ranked_debate_kind',
                'rankedDebateKindRawValue'
            ),
            rankedOutcomeRawValue: rowValue(
                row,
                'ranked_outcome',
                'rankedOutcomeRawValue'
            ),
            rankedReportContext: normalizeDatabaseJson(
                rowValue(
                    row,
                    'ranked_report_context',
                    'rankedReportContext'
                ),
                'ranked report context'
            ),
            contentUpdatedAt: normalizeDatabaseDate(
                rowValue(
                    row,
                    'content_updated_at',
                    'contentUpdatedAt'
                ),
                `rows[${rowIndex}].contentUpdatedAt`
            ),
        },
        rowIndex
    );

    return Object.freeze({
        id: normalized.savedDebateId,
        analyticsDebateId: normalized.analyticsDebateId,
        philosopherName: normalized.philosopherName,
        philosopherInitials: normalized.philosopherInitials,
        philosopherColorHex: normalized.philosopherColorHex,
        topic: normalized.topic,
        date: normalized.date,
        messages: normalized.messages,
        finalScore: normalized.finalScore,
        finalScoreValue: normalized.finalScoreValue,
        hasBeenAnalyzed: normalized.hasBeenAnalyzed,
        report: normalized.report,
        isDailyChallenge: normalized.isDailyChallenge,
        dailyChallengeId: normalized.dailyChallengeId,
        dailyChallengeDate: normalized.dailyChallengeDate,
        debateModeRawValue: normalized.debateModeRawValue,
        rankedDebateId: normalized.rankedDebateId,
        rankedDebateKindRawValue:
            normalized.rankedDebateKindRawValue,
        rankedOutcomeRawValue:
            normalized.rankedOutcomeRawValue,
        rankedReportContext:
            normalized.rankedReportContext,
        contentUpdatedAt: normalized.contentUpdatedAt,
    });
}

function validateStableDownloadOrder(debates) {
    const seenIds = new Set();

    for (let index = 0; index < debates.length; index += 1) {
        const debate = debates[index];

        if (seenIds.has(debate.id)) {
            fail(
                'debate_history_download_unavailable',
                'Debate history returned a duplicate debate.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        seenIds.add(debate.id);

        if (index === 0) continue;

        const previous = debates[index - 1];
        const previousTime = Date.parse(previous.date);
        const currentTime = Date.parse(debate.date);

        const correctlyOrdered =
            previousTime > currentTime ||
            (
                previousTime === currentTime &&
                previous.id < debate.id
            );

        if (!correctlyOrdered) {
            fail(
                'debate_history_download_unavailable',
                'Debate history was returned in an unstable order.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }
    }
}

function currentServiceDate(now) {
    const milliseconds = now();

    if (
        !Number.isFinite(milliseconds) ||
        milliseconds < 0
    ) {
        fail(
            'invalid_debate_history_configuration',
            'now() returned an invalid value.'
        );
    }

    return new Date(milliseconds);
}

function normalizeRepositoryResult(row) {
    return Object.freeze({
        savedDebateId:
            row.saved_debate_id ?? row.savedDebateId,
        status: row.status,
        contentUpdatedAt:
            row.content_updated_at ?? row.contentUpdatedAt,
        lastSyncedAt:
            row.last_synced_at ?? row.lastSyncedAt,
    });
}

export function createPostgresAccountDebateHistoryRepository(pool) {
    if (
        !pool ||
        typeof pool.connect !== 'function' ||
        typeof pool.query !== 'function'
    ) {
        fail(
            'invalid_debate_history_configuration',
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

        async upsertDebate(
            client,
            {
                accountId,
                installationId,
                schemaVersion,
                debate,
                syncedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-history:upsert-saved-debate */
                    INSERT INTO account_debate_history (
                        account_id,
                        saved_debate_id,
                        origin_installation_id,
                        last_synced_from_installation_id,
                        analytics_debate_id,
                        philosopher_name,
                        philosopher_initials,
                        philosopher_color_hex,
                        topic,
                        debate_date,
                        debate_mode_raw_value,
                        ranked_debate_id,
                        ranked_debate_kind,
                        ranked_outcome,
                        ranked_report_context,
                        is_daily_challenge,
                        daily_challenge_id,
                        daily_challenge_date,
                        final_score_text,
                        final_score_value,
                        has_been_analyzed,
                        messages,
                        report,
                        message_count,
                        source_schema_version,
                        content_updated_at,
                        content_sha256,
                        first_synced_at,
                        last_synced_at,
                        sync_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3, $3, $4, $5, $6, $7, $8,
                        $9, $10, $11, $12, $13, $14::jsonb, $15,
                        $16, $17::date, $18, $19, $20, $21::jsonb,
                        $22::jsonb, $23, $24, $25, $26, $27, $27,
                        1, $27, $27
                    )
                    ON CONFLICT (account_id, saved_debate_id)
                    DO UPDATE SET
                        last_synced_from_installation_id = EXCLUDED.last_synced_from_installation_id,
                        analytics_debate_id = EXCLUDED.analytics_debate_id,
                        philosopher_name = EXCLUDED.philosopher_name,
                        philosopher_initials = EXCLUDED.philosopher_initials,
                        philosopher_color_hex = EXCLUDED.philosopher_color_hex,
                        topic = EXCLUDED.topic,
                        debate_date = EXCLUDED.debate_date,
                        debate_mode_raw_value = EXCLUDED.debate_mode_raw_value,
                        ranked_debate_id = COALESCE(
                            EXCLUDED.ranked_debate_id,
                            account_debate_history.ranked_debate_id
                        ),
                        ranked_debate_kind = COALESCE(
                            EXCLUDED.ranked_debate_kind,
                            account_debate_history.ranked_debate_kind
                        ),
                        ranked_outcome = COALESCE(
                            EXCLUDED.ranked_outcome,
                            account_debate_history.ranked_outcome
                        ),
                        ranked_report_context = COALESCE(
                            EXCLUDED.ranked_report_context,
                            account_debate_history.ranked_report_context
                        ),
                        is_daily_challenge = EXCLUDED.is_daily_challenge,
                        daily_challenge_id = EXCLUDED.daily_challenge_id,
                        daily_challenge_date = EXCLUDED.daily_challenge_date,
                        final_score_text = EXCLUDED.final_score_text,
                        final_score_value = EXCLUDED.final_score_value,
                        has_been_analyzed = EXCLUDED.has_been_analyzed,
                        messages = EXCLUDED.messages,
                        report = EXCLUDED.report,
                        message_count = EXCLUDED.message_count,
                        source_schema_version = EXCLUDED.source_schema_version,
                        content_updated_at = EXCLUDED.content_updated_at,
                        content_sha256 = EXCLUDED.content_sha256,
                        last_synced_at = EXCLUDED.last_synced_at,
                        sync_count = account_debate_history.sync_count + 1,
                        updated_at = EXCLUDED.updated_at
                    WHERE
                        EXCLUDED.content_updated_at >=
                            account_debate_history.content_updated_at
                    RETURNING
                        saved_debate_id,
                        'synced'::text AS status,
                        content_updated_at,
                        last_synced_at
                `,
                [
                    accountId,
                    debate.savedDebateId,
                    installationId,
                    debate.analyticsDebateId,
                    debate.philosopherName,
                    debate.philosopherInitials,
                    debate.philosopherColorHex,
                    debate.topic,
                    debate.date,
                    debate.debateModeRawValue,
                    debate.rankedDebateId,
                    debate.rankedDebateKindRawValue,
                    debate.rankedOutcomeRawValue,
                    debate.rankedReportContext == null
                        ? null
                        : JSON.stringify(
                            debate.rankedReportContext
                        ),
                    debate.isDailyChallenge,
                    debate.dailyChallengeId,
                    debate.dailyChallengeDate,
                    debate.finalScore,
                    debate.finalScoreValue,
                    debate.hasBeenAnalyzed,
                    JSON.stringify(debate.messages),
                    debate.report == null
                        ? null
                        : JSON.stringify(debate.report),
                    debate.messages.length,
                    schemaVersion,
                    debate.contentUpdatedAt,
                    debate.contentSha256,
                    syncedAt,
                ]
            );

            if (result.rows[0]) {
                return normalizeRepositoryResult(result.rows[0]);
            }

            const canonical = await client.query(
                `
                    /* account-history:load-stale-canonical */
                    SELECT
                        saved_debate_id,
                        'stale_ignored'::text AS status,
                        content_updated_at,
                        last_synced_at
                    FROM account_debate_history
                    WHERE account_id = $1
                      AND saved_debate_id = $2
                `,
                [accountId, debate.savedDebateId]
            );

            if (!canonical.rows[0]) {
                fail(
                    'debate_history_persistence_failed',
                    'The debate-history record could not be persisted.',
                    {
                        status: 503,
                        retryable: true,
                    }
                );
            }

            return normalizeRepositoryResult(
                canonical.rows[0]
            );
        },

        async listDebates({
            accountId,
            limit,
            cursor,
        }) {
            const fetchLimit = limit + 1;

            const result = await pool.query(
                `
                    /* account-history:list-saved-debates */
                    SELECT
                        account_id,
                        saved_debate_id,
                        analytics_debate_id,
                        philosopher_name,
                        philosopher_initials,
                        philosopher_color_hex,
                        topic,
                        debate_date,
                        debate_mode_raw_value,
                        ranked_debate_id,
                        ranked_debate_kind,
                        ranked_outcome,
                        ranked_report_context,
                        is_daily_challenge,
                        daily_challenge_id,
                        daily_challenge_date,
                        final_score_text,
                        final_score_value,
                        has_been_analyzed,
                        messages,
                        report,
                        source_schema_version,
                        content_updated_at
                    FROM account_debate_history
                    WHERE account_id = $1
                      AND (
                            $3::timestamptz IS NULL
                            OR debate_date < $3::timestamptz
                            OR (
                                debate_date = $3::timestamptz
                                AND saved_debate_id > $4::uuid
                            )
                      )
                    ORDER BY
                        debate_date DESC,
                        saved_debate_id ASC
                    LIMIT $2
                `,
                [
                    accountId,
                    fetchLimit,
                    cursor?.debateDate ?? null,
                    cursor?.savedDebateId ?? null,
                ]
            );

            const hasMore = result.rows.length > limit;

            return Object.freeze({
                rows: Object.freeze(
                    result.rows.slice(0, limit)
                ),
                hasMore,
            });
        },
    });
}

export function createAccountDebateHistoryService({
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
            'invalid_debate_history_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_debate_history_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountDebateHistoryRepository(pool);

    if (
        !repo ||
        typeof repo.withTransaction !== 'function' ||
        typeof repo.upsertDebate !== 'function' ||
        typeof repo.listDebates !== 'function'
    ) {
        fail(
            'invalid_debate_history_configuration',
            'A valid debate-history repository is required.'
        );
    }

    async function authorize({ installationId, accessToken }) {
        const cleanInstallationId =
            requireInstallationId(installationId);
        const cleanAccessToken = requireString(
            accessToken,
            'accessToken',
            { maxLength: 16_384 }
        );

        try {
            return await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
            });
        } catch (error) {
            fail(
                error?.code || 'invalid_access_token',
                error?.message ||
                    'The Agora account session is invalid or expired.',
                {
                    status:
                        Number.isInteger(error?.status)
                            ? error.status
                            : 401,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function syncDebates({
        installationId,
        accessToken,
        schemaVersion,
        debates,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });
        const normalizedDebates = normalizeBatch({
            schemaVersion,
            debates,
        });
        const syncedAt = currentServiceDate(now);

        try {
            const results = await repo.withTransaction(
                async (client) => {
                    const rows = [];

                    for (const debate of normalizedDebates) {
                        rows.push(
                            await repo.upsertDebate(client, {
                                accountId:
                                    authorization.accountId,
                                installationId:
                                    authorization.installationId,
                                schemaVersion,
                                debate,
                                syncedAt,
                            })
                        );
                    }

                    return rows;
                }
            );

            return Object.freeze({
                accountId: authorization.accountId,
                installationId:
                    authorization.installationId,
                syncedAt,
                results: Object.freeze(results),
            });
        } catch (error) {
            if (error instanceof AccountDebateHistoryError) {
                throw error;
            }

            fail(
                'debate_history_sync_unavailable',
                'Debate history could not be synchronized.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }
    }


    async function listDebates({
        installationId,
        accessToken,
        limit = null,
        cursor = null,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const normalizedLimit =
            normalizeDownloadPageLimit(limit);
        const normalizedCursor =
            decodeDownloadCursor(cursor);
        const downloadedAt = currentServiceDate(now);

        let page;

        try {
            page = await repo.listDebates({
                accountId: authorization.accountId,
                limit: normalizedLimit,
                cursor: normalizedCursor,
            });
        } catch (error) {
            if (error instanceof AccountDebateHistoryError) {
                throw error;
            }

            fail(
                'debate_history_download_unavailable',
                'Debate history could not be downloaded.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        if (
            !page ||
            typeof page !== 'object' ||
            !Array.isArray(page.rows) ||
            typeof page.hasMore !== 'boolean' ||
            page.rows.length > normalizedLimit
        ) {
            fail(
                'debate_history_download_unavailable',
                'Debate history returned an invalid page.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        const debates = page.rows.map(
            (row, index) => {
                try {
                    return normalizeDownloadedDebate(
                        row,
                        index,
                        authorization.accountId
                    );
                } catch (error) {
                    if (
                        error instanceof
                            AccountDebateHistoryError &&
                        (
                            error.code ===
                                'debate_history_account_mismatch' ||
                            error.code ===
                                'unsupported_stored_debate_history_schema' ||
                            error.code ===
                                'debate_history_download_unavailable'
                        )
                    ) {
                        throw error;
                    }

                    if (
                        error instanceof
                            AccountDebateHistoryError
                    ) {
                        fail(
                            'debate_history_download_unavailable',
                            'Stored debate history is invalid.',
                            {
                                status: 503,
                                retryable: true,
                                cause: error,
                            }
                        );
                    }

                    throw error;
                }
            }
        );

        validateStableDownloadOrder(debates);

        if (page.hasMore && debates.length === 0) {
            fail(
                'debate_history_download_unavailable',
                'Debate history returned an invalid continuation page.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        const lastDebate =
            debates.length > 0
                ? debates[debates.length - 1]
                : null;

        const nextCursor =
            page.hasMore && lastDebate
                ? encodeDownloadCursor({
                    debateDate: lastDebate.date,
                    savedDebateId: lastDebate.id,
                })
                : null;

        return Object.freeze({
            schemaVersion: HISTORY_SCHEMA_VERSION,
            accountId: authorization.accountId,
            installationId:
                authorization.installationId,
            downloadedAt,
            debates: Object.freeze(debates),
            nextCursor,
            hasMore: page.hasMore,
        });
    }

    return Object.freeze({
        syncDebates,
        listDebates,
    });
}

export const accountDebateHistoryConstants = Object.freeze({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    maxBatchSize: MAX_BATCH_SIZE,
    maxMessagesPerDebate: MAX_MESSAGES_PER_DEBATE,
    maxDebateJsonBytes: MAX_DEBATE_JSON_BYTES,
    maxBatchJsonBytes: MAX_BATCH_JSON_BYTES,
    defaultDownloadPageSize:
        DEFAULT_DOWNLOAD_PAGE_SIZE,
    maxDownloadPageSize:
        MAX_DOWNLOAD_PAGE_SIZE,
    downloadCursorVersion:
        DOWNLOAD_CURSOR_VERSION,
});
