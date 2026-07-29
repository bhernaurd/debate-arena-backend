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
        contentUpdatedAt: normalizeIsoDate(
            debate.contentUpdatedAt,
            `${prefix}.contentUpdatedAt`
        ),
    };

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
    if (!pool || typeof pool.connect !== 'function') {
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
                        $9, $10, $11, $12, $13::date, $14, $15,
                        $16, $17::jsonb, $18::jsonb, $19, $20, $21,
                        $22, $23, $23, 1, $23, $23
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
        typeof repo.upsertDebate !== 'function'
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
        const syncedAtMilliseconds = now();

        if (
            !Number.isFinite(syncedAtMilliseconds) ||
            syncedAtMilliseconds < 0
        ) {
            fail(
                'invalid_debate_history_configuration',
                'now() returned an invalid value.'
            );
        }

        const syncedAt = new Date(syncedAtMilliseconds);

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

    return Object.freeze({
        syncDebates,
    });
}

export const accountDebateHistoryConstants = Object.freeze({
    schemaVersion: HISTORY_SCHEMA_VERSION,
    maxBatchSize: MAX_BATCH_SIZE,
    maxMessagesPerDebate: MAX_MESSAGES_PER_DEBATE,
    maxDebateJsonBytes: MAX_DEBATE_JSON_BYTES,
    maxBatchJsonBytes: MAX_BATCH_JSON_BYTES,
});
