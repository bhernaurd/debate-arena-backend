const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const ISO_DATE_TIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MESSAGE_ROLE_VALUES = new Set(['user', 'assistant']);

const PROGRESS_SCHEMA_VERSION = 1;
const MAX_MESSAGES = 200;
const MAX_RECORD_JSON_BYTES = 300_000;

export class AccountDailyChallengeProgressError extends Error {
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
        this.name = 'AccountDailyChallengeProgressError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountDailyChallengeProgressError(
        code,
        message,
        options
    );
}

function requireObject(value, fieldName) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} must be an object.`,
            { status: 400 }
        );
    }

    return value;
}

function requireString(
    value,
    fieldName,
    {
        maximum = 16_384,
        pattern = null,
        preserveWhitespace = false,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const trimmed = value.trim();

    if (
        !trimmed ||
        value.length > maximum ||
        (pattern && !pattern.test(trimmed))
    ) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return preserveWhitespace ? value : trimmed;
}

function optionalString(value, fieldName, maximum) {
    if (value == null) return null;

    return requireString(value, fieldName, {
        maximum,
    });
}

function requireText(value, fieldName, maximum) {
    return requireString(value, fieldName, {
        maximum,
        preserveWhitespace: true,
    });
}

function requireInstallationId(value) {
    return requireString(value, 'installationId', {
        maximum: 128,
        pattern: INSTALLATION_ID_RE,
    });
}

function normalizeCalendarDate(value, fieldName) {
    const cleaned = requireString(value, fieldName, {
        maximum: 10,
        pattern: CALENDAR_DATE_RE,
    });

    const parsed = new Date(`${cleaned}T00:00:00.000Z`);

    if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== cleaned
    ) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} is not a valid calendar date.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function normalizeIsoDate(value, fieldName) {
    const cleaned = requireString(value, fieldName, {
        maximum: 64,
        pattern: ISO_DATE_TIME_RE,
    });

    const date = new Date(cleaned);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} is not a valid date.`,
            { status: 400 }
        );
    }

    return date.toISOString();
}

function optionalScore(value, fieldName) {
    if (value == null) return null;

    return requireString(value, fieldName, {
        maximum: 50,
    });
}

function requireNonnegativeInteger(value, fieldName, maximum) {
    if (
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > maximum
    ) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return value;
}

function normalizeScoreUpdate(value, fieldName) {
    if (value == null) return null;

    const scoreUpdate = requireObject(value, fieldName);

    return Object.freeze({
        score: requireString(
            scoreUpdate.score,
            `${fieldName}.score`,
            { maximum: 50 }
        ),
        note: requireText(
            scoreUpdate.note,
            `${fieldName}.note`,
            2_000
        ),
    });
}

function normalizeMessage(value, index) {
    const prefix = `mutation.record.messages[${index}]`;
    const message = requireObject(value, prefix);

    const id = requireString(
        message.id,
        `${prefix}.id`,
        { maximum: 64 }
    ).toLowerCase();

    const role = requireString(
        message.role,
        `${prefix}.role`,
        { maximum: 20 }
    );

    if (!MESSAGE_ROLE_VALUES.has(role)) {
        fail(
            'invalid_daily_challenge_progress_payload',
            `${prefix}.role is not supported.`,
            { status: 400 }
        );
    }

    return Object.freeze({
        id,
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

function normalizeActiveRecord(value) {
    const record = requireObject(
        value,
        'mutation.record'
    );

    if (!Array.isArray(record.messages)) {
        fail(
            'invalid_daily_challenge_progress_payload',
            'mutation.record.messages must be an array.',
            { status: 400 }
        );
    }

    if (record.messages.length > MAX_MESSAGES) {
        fail(
            'invalid_daily_challenge_progress_payload',
            'mutation.record.messages contains too many items.',
            { status: 400 }
        );
    }

    const messages = record.messages.map(normalizeMessage);
    const messageIds = new Set();

    for (const message of messages) {
        if (messageIds.has(message.id)) {
            fail(
                'duplicate_daily_challenge_message_id',
                'mutation.record.messages contains a duplicate id.',
                { status: 400 }
            );
        }

        messageIds.add(message.id);
    }

    const createdAt = normalizeIsoDate(
        record.createdAt,
        'mutation.record.createdAt'
    );
    const updatedAt = normalizeIsoDate(
        record.updatedAt,
        'mutation.record.updatedAt'
    );

    if (new Date(updatedAt) < new Date(createdAt)) {
        fail(
            'invalid_daily_challenge_progress_payload',
            'mutation.record.updatedAt cannot be earlier than createdAt.',
            { status: 400 }
        );
    }

    const normalized = Object.freeze({
        challengeId: requireString(
            record.challengeId,
            'mutation.record.challengeId',
            { maximum: 128 }
        ),
        challengeDate: normalizeCalendarDate(
            record.challengeDate,
            'mutation.record.challengeDate'
        ),
        challengeTitle: requireText(
            record.challengeTitle,
            'mutation.record.challengeTitle',
            500
        ),
        challengeQuestion: requireText(
            record.challengeQuestion,
            'mutation.record.challengeQuestion',
            5_000
        ),
        philosopherId: requireString(
            record.philosopherId,
            'mutation.record.philosopherId',
            { maximum: 128 }
        ),
        philosopherName: requireString(
            record.philosopherName,
            'mutation.record.philosopherName',
            { maximum: 100 }
        ),
        analyticsDebateId: optionalString(
            record.analyticsDebateId,
            'mutation.record.analyticsDebateId',
            128
        ),
        userOpeningAnswer: requireText(
            record.userOpeningAnswer,
            'mutation.record.userOpeningAnswer',
            20_000
        ),
        messages,
        currentScore: optionalScore(
            record.currentScore,
            'mutation.record.currentScore'
        ),
        roundCount: requireNonnegativeInteger(
            record.roundCount,
            'mutation.record.roundCount',
            1_000
        ),
        createdAt,
        updatedAt,
    });

    const byteLength = Buffer.byteLength(
        JSON.stringify(normalized),
        'utf8'
    );

    if (byteLength > MAX_RECORD_JSON_BYTES) {
        fail(
            'daily_challenge_progress_record_too_large',
            'The Daily Challenge progress record is too large.',
            { status: 413 }
        );
    }

    return normalized;
}

function normalizeMutation(value) {
    if (value == null) return null;

    const mutation = requireObject(value, 'mutation');
    const kind = requireString(
        mutation.kind,
        'mutation.kind',
        { maximum: 20 }
    );

    if (kind === 'upsert') {
        return Object.freeze({
            kind,
            record: normalizeActiveRecord(
                mutation.record
            ),
        });
    }

    if (kind === 'clear') {
        return Object.freeze({
            kind,
            challengeId: requireString(
                mutation.challengeId,
                'mutation.challengeId',
                { maximum: 128 }
            ),
            challengeDate: normalizeCalendarDate(
                mutation.challengeDate,
                'mutation.challengeDate'
            ),
            updatedAt: normalizeIsoDate(
                mutation.updatedAt,
                'mutation.updatedAt'
            ),
        });
    }

    fail(
        'invalid_daily_challenge_progress_payload',
        'mutation.kind is not supported.',
        { status: 400 }
    );
}

function normalizeStoredRecord(row) {
    if (!row) return null;

    const messages =
        typeof row.messages === 'string'
            ? JSON.parse(row.messages)
            : row.messages;

    const record = {
        challengeId:
            row.challenge_id ?? row.challengeId,
        challengeDate:
            String(
                row.challenge_date ?? row.challengeDate
            ).slice(0, 10),
        challengeTitle:
            row.challenge_title ?? row.challengeTitle,
        challengeQuestion:
            row.challenge_question ?? row.challengeQuestion,
        philosopherId:
            row.philosopher_id ?? row.philosopherId,
        philosopherName:
            row.philosopher_name ?? row.philosopherName,
        analyticsDebateId:
            row.analytics_debate_id ?? row.analyticsDebateId ?? null,
        userOpeningAnswer:
            row.user_opening_answer ?? row.userOpeningAnswer,
        messages,
        currentScore:
            row.current_score ?? row.currentScore ?? null,
        roundCount:
            row.round_count ?? row.roundCount,
        createdAt:
            row.session_created_at ?? row.createdAt,
        updatedAt:
            row.mutation_updated_at ?? row.updatedAt,
    };

    return normalizeActiveRecord(record);
}

export function createPostgresAccountDailyChallengeProgressRepository(
    pool
) {
    if (!pool || typeof pool.connect !== 'function') {
        fail(
            'invalid_daily_challenge_progress_configuration',
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

        async hasCompletedChallenge(
            client,
            {
                accountId,
                challengeId,
                challengeDate,
            }
        ) {
            const result = await client.query(
                `
                    /* account-daily-progress:completed-history-check */
                    SELECT 1
                    FROM account_debate_history
                    WHERE account_id = $1
                      AND is_daily_challenge = TRUE
                      AND (
                            daily_challenge_id = $2
                            OR daily_challenge_date = $3::date
                      )
                    LIMIT 1
                `,
                [
                    accountId,
                    challengeId,
                    challengeDate,
                ]
            );

            return Boolean(result.rows[0]);
        },

        async upsertActive(
            client,
            {
                accountId,
                installationId,
                schemaVersion,
                record,
                syncedAt,
            }
        ) {
            const existing = await client.query(
                `
                    /* account-daily-progress:load-existing */
                    SELECT
                        status,
                        mutation_updated_at
                    FROM account_daily_challenge_progress
                    WHERE account_id = $1
                      AND challenge_id = $2
                    FOR UPDATE
                `,
                [
                    accountId,
                    record.challengeId,
                ]
            );

            if (existing.rows[0]?.status === 'cleared') {
                return Object.freeze({
                    status: 'cleared_ignored',
                });
            }

            if (
                existing.rows[0] &&
                new Date(existing.rows[0].mutation_updated_at) >
                    new Date(record.updatedAt)
            ) {
                return Object.freeze({
                    status: 'stale_ignored',
                });
            }

            await client.query(
                `
                    /* account-daily-progress:clear-older-active */
                    UPDATE account_daily_challenge_progress
                    SET
                        status = 'cleared',
                        challenge_title = NULL,
                        challenge_question = NULL,
                        philosopher_id = NULL,
                        philosopher_name = NULL,
                        analytics_debate_id = NULL,
                        user_opening_answer = NULL,
                        messages = NULL,
                        current_score = NULL,
                        round_count = NULL,
                        session_created_at = NULL,
                        last_synced_from_installation_id = $2,
                        last_synced_at = $3,
                        sync_count = sync_count + 1,
                        updated_at = $3
                    WHERE account_id = $1
                      AND status = 'active'
                      AND challenge_id <> $4
                      AND challenge_date <= $5::date
                `,
                [
                    accountId,
                    installationId,
                    syncedAt,
                    record.challengeId,
                    record.challengeDate,
                ]
            );

            await client.query(
                `
                    /* account-daily-progress:upsert-active */
                    INSERT INTO account_daily_challenge_progress (
                        account_id,
                        challenge_id,
                        challenge_date,
                        status,
                        challenge_title,
                        challenge_question,
                        philosopher_id,
                        philosopher_name,
                        analytics_debate_id,
                        user_opening_answer,
                        messages,
                        current_score,
                        round_count,
                        session_created_at,
                        mutation_updated_at,
                        origin_installation_id,
                        last_synced_from_installation_id,
                        source_schema_version,
                        first_synced_at,
                        last_synced_at,
                        sync_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3::date, 'active',
                        $4, $5, $6, $7, $8, $9,
                        $10::jsonb, $11, $12, $13, $14,
                        $15, $15, $16, $17, $17, 1, $17, $17
                    )
                    ON CONFLICT (account_id, challenge_id)
                    DO UPDATE SET
                        challenge_date = EXCLUDED.challenge_date,
                        status = 'active',
                        challenge_title = EXCLUDED.challenge_title,
                        challenge_question = EXCLUDED.challenge_question,
                        philosopher_id = EXCLUDED.philosopher_id,
                        philosopher_name = EXCLUDED.philosopher_name,
                        analytics_debate_id = EXCLUDED.analytics_debate_id,
                        user_opening_answer = EXCLUDED.user_opening_answer,
                        messages = EXCLUDED.messages,
                        current_score = EXCLUDED.current_score,
                        round_count = EXCLUDED.round_count,
                        session_created_at = EXCLUDED.session_created_at,
                        mutation_updated_at = EXCLUDED.mutation_updated_at,
                        last_synced_from_installation_id =
                            EXCLUDED.last_synced_from_installation_id,
                        source_schema_version =
                            EXCLUDED.source_schema_version,
                        last_synced_at = EXCLUDED.last_synced_at,
                        sync_count =
                            account_daily_challenge_progress.sync_count + 1,
                        updated_at = EXCLUDED.updated_at
                    WHERE account_daily_challenge_progress.status <> 'cleared'
                      AND EXCLUDED.mutation_updated_at >=
                          account_daily_challenge_progress.mutation_updated_at
                `,
                [
                    accountId,
                    record.challengeId,
                    record.challengeDate,
                    record.challengeTitle,
                    record.challengeQuestion,
                    record.philosopherId,
                    record.philosopherName,
                    record.analyticsDebateId,
                    record.userOpeningAnswer,
                    JSON.stringify(record.messages),
                    record.currentScore,
                    record.roundCount,
                    record.createdAt,
                    record.updatedAt,
                    installationId,
                    schemaVersion,
                    syncedAt,
                ]
            );

            return Object.freeze({
                status: 'synced',
            });
        },

        async clearChallenge(
            client,
            {
                accountId,
                installationId,
                schemaVersion,
                challengeId,
                challengeDate,
                updatedAt,
                syncedAt,
            }
        ) {
            await client.query(
                `
                    /* account-daily-progress:clear-challenge */
                    INSERT INTO account_daily_challenge_progress (
                        account_id,
                        challenge_id,
                        challenge_date,
                        status,
                        mutation_updated_at,
                        origin_installation_id,
                        last_synced_from_installation_id,
                        source_schema_version,
                        first_synced_at,
                        last_synced_at,
                        sync_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3::date, 'cleared', $4,
                        $5, $5, $6, $7, $7, 1, $7, $7
                    )
                    ON CONFLICT (account_id, challenge_id)
                    DO UPDATE SET
                        challenge_date = EXCLUDED.challenge_date,
                        status = 'cleared',
                        challenge_title = NULL,
                        challenge_question = NULL,
                        philosopher_id = NULL,
                        philosopher_name = NULL,
                        analytics_debate_id = NULL,
                        user_opening_answer = NULL,
                        messages = NULL,
                        current_score = NULL,
                        round_count = NULL,
                        session_created_at = NULL,
                        mutation_updated_at = GREATEST(
                            account_daily_challenge_progress.mutation_updated_at,
                            EXCLUDED.mutation_updated_at
                        ),
                        last_synced_from_installation_id =
                            EXCLUDED.last_synced_from_installation_id,
                        source_schema_version =
                            EXCLUDED.source_schema_version,
                        last_synced_at = EXCLUDED.last_synced_at,
                        sync_count =
                            account_daily_challenge_progress.sync_count + 1,
                        updated_at = EXCLUDED.updated_at
                `,
                [
                    accountId,
                    challengeId,
                    challengeDate,
                    updatedAt,
                    installationId,
                    schemaVersion,
                    syncedAt,
                ]
            );

            return Object.freeze({
                status: 'cleared',
            });
        },

        async loadCurrentActive(
            client,
            {
                accountId,
            }
        ) {
            const result = await client.query(
                `
                    /* account-daily-progress:load-current-active */
                    SELECT
                        challenge_id,
                        challenge_date,
                        challenge_title,
                        challenge_question,
                        philosopher_id,
                        philosopher_name,
                        analytics_debate_id,
                        user_opening_answer,
                        messages,
                        current_score,
                        round_count,
                        session_created_at,
                        mutation_updated_at
                    FROM account_daily_challenge_progress
                    WHERE account_id = $1
                      AND status = 'active'
                    ORDER BY
                        challenge_date DESC,
                        mutation_updated_at DESC,
                        challenge_id ASC
                    LIMIT 1
                `,
                [accountId]
            );

            return normalizeStoredRecord(
                result.rows[0] ?? null
            );
        },
    });
}

export function createAccountDailyChallengeProgressService({
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
            'invalid_daily_challenge_progress_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_daily_challenge_progress_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountDailyChallengeProgressRepository(
            pool
        );

    const requiredRepositoryMethods = [
        'withTransaction',
        'hasCompletedChallenge',
        'upsertActive',
        'clearChallenge',
        'loadCurrentActive',
    ];

    for (const method of requiredRepositoryMethods) {
        if (typeof repo?.[method] !== 'function') {
            fail(
                'invalid_daily_challenge_progress_configuration',
                'A valid Daily Challenge progress repository is required.'
            );
        }
    }

    async function authorize({
        installationId,
        accessToken,
    }) {
        const cleanInstallationId =
            requireInstallationId(
                installationId
            );
        const cleanAccessToken = requireString(
            accessToken,
            'accessToken',
            { maximum: 16_384 }
        );

        try {
            return await accountAuthService
                .authorizeAccessToken({
                    installationId:
                        cleanInstallationId,
                    accessToken:
                        cleanAccessToken,
                });
        } catch (error) {
            fail(
                error?.code ||
                    'invalid_access_token',
                error?.message ||
                    'The Agora account session is invalid or expired.',
                {
                    status:
                        Number.isInteger(error?.status)
                            ? error.status
                            : 401,
                    retryable:
                        Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function syncProgress({
        installationId,
        accessToken,
        schemaVersion,
        mutation,
    }) {
        if (schemaVersion !== PROGRESS_SCHEMA_VERSION) {
            fail(
                'unsupported_daily_challenge_progress_schema',
                'The Daily Challenge progress schema version is not supported.',
                { status: 400 }
            );
        }

        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const normalizedMutation =
            normalizeMutation(mutation);

        const syncedAtMilliseconds = now();

        if (
            !Number.isFinite(syncedAtMilliseconds) ||
            syncedAtMilliseconds < 0
        ) {
            fail(
                'invalid_daily_challenge_progress_configuration',
                'now() returned an invalid value.'
            );
        }

        const syncedAt = new Date(
            syncedAtMilliseconds
        );

        try {
            const transactionResult =
                await repo.withTransaction(
                    async (client) => {
                        let mutationStatus =
                            'download_only';

                        if (
                            normalizedMutation?.kind ===
                            'upsert'
                        ) {
                            const record =
                                normalizedMutation.record;

                            const completed =
                                await repo.hasCompletedChallenge(
                                    client,
                                    {
                                        accountId:
                                            authorization.accountId,
                                        challengeId:
                                            record.challengeId,
                                        challengeDate:
                                            record.challengeDate,
                                    }
                                );

                            if (completed) {
                                await repo.clearChallenge(
                                    client,
                                    {
                                        accountId:
                                            authorization.accountId,
                                        installationId:
                                            authorization.installationId,
                                        schemaVersion,
                                        challengeId:
                                            record.challengeId,
                                        challengeDate:
                                            record.challengeDate,
                                        updatedAt:
                                            record.updatedAt,
                                        syncedAt,
                                    }
                                );

                                mutationStatus =
                                    'completed_ignored';
                            } else {
                                const result =
                                    await repo.upsertActive(
                                        client,
                                        {
                                            accountId:
                                                authorization.accountId,
                                            installationId:
                                                authorization.installationId,
                                            schemaVersion,
                                            record,
                                            syncedAt,
                                        }
                                    );

                                mutationStatus =
                                    result.status;
                            }
                        } else if (
                            normalizedMutation?.kind ===
                            'clear'
                        ) {
                            const result =
                                await repo.clearChallenge(
                                    client,
                                    {
                                        accountId:
                                            authorization.accountId,
                                        installationId:
                                            authorization.installationId,
                                        schemaVersion,
                                        challengeId:
                                            normalizedMutation.challengeId,
                                        challengeDate:
                                            normalizedMutation.challengeDate,
                                        updatedAt:
                                            normalizedMutation.updatedAt,
                                        syncedAt,
                                    }
                                );

                            mutationStatus =
                                result.status;
                        }

                        const current =
                            await repo.loadCurrentActive(
                                client,
                                {
                                    accountId:
                                        authorization.accountId,
                                }
                            );

                        return {
                            mutationStatus,
                            current,
                        };
                    }
                );

            return Object.freeze({
                accountId:
                    authorization.accountId,
                installationId:
                    authorization.installationId,
                syncedAt,
                mutationStatus:
                    transactionResult.mutationStatus,
                current:
                    transactionResult.current,
            });
        } catch (error) {
            if (
                error instanceof
                AccountDailyChallengeProgressError
            ) {
                throw error;
            }

            fail(
                'daily_challenge_progress_sync_unavailable',
                'Daily Challenge progress could not be synchronized.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }
    }

    return Object.freeze({
        syncProgress,
    });
}

export const accountDailyChallengeProgressConstants =
    Object.freeze({
        schemaVersion:
            PROGRESS_SCHEMA_VERSION,
        maxMessages:
            MAX_MESSAGES,
        maxRecordJsonBytes:
            MAX_RECORD_JSON_BYTES,
    });
