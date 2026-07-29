const ACHIEVEMENT_ID_RE =
    /^[a-z0-9][a-z0-9_]{0,99}$/;
const INSTALLATION_ID_RE =
    /^[A-Za-z0-9-]{8,128}$/;
const ISO_DATE_TIME_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ACHIEVEMENT_SCHEMA_VERSION = 1;
const MAX_ACHIEVEMENT_RECORDS = 100;

export class AccountAchievementError extends Error {
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
        this.name = 'AccountAchievementError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAchievementError(
        code,
        message,
        options
    );
}

function requireString(
    value,
    fieldName,
    {
        maxLength = 16_384,
        pattern = null,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_achievement_payload',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (
        !cleaned ||
        value.length > maxLength ||
        (pattern && !pattern.test(cleaned))
    ) {
        fail(
            'invalid_achievement_payload',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function requireInstallationId(value) {
    return requireString(
        value,
        'installationId',
        {
            maxLength: 128,
            pattern: INSTALLATION_ID_RE,
        }
    );
}

function normalizeIsoDate(value, fieldName) {
    const cleaned = requireString(
        value,
        fieldName,
        {
            maxLength: 64,
            pattern: ISO_DATE_TIME_RE,
        }
    );

    const date = new Date(cleaned);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_achievement_payload',
            `${fieldName} is not a valid date.`,
            { status: 400 }
        );
    }

    return date.toISOString();
}

function normalizeRecord(value, index) {
    const prefix = `records[${index}]`;

    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
    ) {
        fail(
            'invalid_achievement_payload',
            `${prefix} must be an object.`,
            { status: 400 }
        );
    }

    return Object.freeze({
        achievementId: requireString(
            value.achievementId,
            `${prefix}.achievementId`,
            {
                maxLength: 100,
                pattern: ACHIEVEMENT_ID_RE,
            }
        ),
        unlockedAt: normalizeIsoDate(
            value.unlockedAt,
            `${prefix}.unlockedAt`
        ),
    });
}

function normalizeBatch({
    schemaVersion,
    records,
}) {
    if (schemaVersion !== ACHIEVEMENT_SCHEMA_VERSION) {
        fail(
            'unsupported_achievement_schema',
            'The achievement schema version is not supported.',
            { status: 400 }
        );
    }

    if (!Array.isArray(records)) {
        fail(
            'invalid_achievement_payload',
            'records must be an array.',
            { status: 400 }
        );
    }

    if (records.length > MAX_ACHIEVEMENT_RECORDS) {
        fail(
            'achievement_batch_too_large',
            'The achievement batch contains too many records.',
            { status: 413 }
        );
    }

    const normalized = records.map(normalizeRecord);
    const ids = new Set();

    for (const record of normalized) {
        if (ids.has(record.achievementId)) {
            fail(
                'duplicate_achievement_id',
                'The batch contains a duplicate achievement id.',
                { status: 400 }
            );
        }

        ids.add(record.achievementId);
    }

    return normalized;
}

function normalizeStoredRecord(row) {
    const achievementId =
        row?.achievement_id ?? row?.achievementId;
    const unlockedAt =
        row?.unlocked_at ?? row?.unlockedAt;
    const lastSyncedAt =
        row?.last_synced_at ?? row?.lastSyncedAt;

    if (
        typeof achievementId !== 'string' ||
        !ACHIEVEMENT_ID_RE.test(achievementId)
    ) {
        fail(
            'achievement_storage_invalid',
            'Stored achievement data is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const unlockedDate = new Date(unlockedAt);
    const lastSyncedDate = new Date(lastSyncedAt);

    if (
        Number.isNaN(unlockedDate.getTime()) ||
        Number.isNaN(lastSyncedDate.getTime())
    ) {
        fail(
            'achievement_storage_invalid',
            'Stored achievement data is invalid.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        achievementId,
        unlockedAt: unlockedDate,
        lastSyncedAt: lastSyncedDate,
    });
}

export function createPostgresAccountAchievementRepository(
    pool
) {
    if (!pool || typeof pool.connect !== 'function') {
        fail(
            'invalid_achievement_configuration',
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

        async upsertUnlock(
            client,
            {
                accountId,
                installationId,
                schemaVersion,
                record,
                syncedAt,
            }
        ) {
            const result = await client.query(
                `
                    /* account-achievements:upsert-unlock */
                    INSERT INTO account_achievement_unlocks (
                        account_id,
                        achievement_id,
                        unlocked_at,
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
                        $1, $2, $3, $4, $4, $5,
                        $6, $6, 1, $6, $6
                    )
                    ON CONFLICT (
                        account_id,
                        achievement_id
                    )
                    DO UPDATE SET
                        unlocked_at = LEAST(
                            account_achievement_unlocks.unlocked_at,
                            EXCLUDED.unlocked_at
                        ),
                        last_synced_from_installation_id =
                            EXCLUDED.last_synced_from_installation_id,
                        source_schema_version =
                            EXCLUDED.source_schema_version,
                        last_synced_at =
                            EXCLUDED.last_synced_at,
                        sync_count =
                            account_achievement_unlocks.sync_count + 1,
                        updated_at =
                            EXCLUDED.updated_at
                    RETURNING
                        achievement_id,
                        unlocked_at,
                        last_synced_at
                `,
                [
                    accountId,
                    record.achievementId,
                    record.unlockedAt,
                    installationId,
                    schemaVersion,
                    syncedAt,
                ]
            );

            if (!result.rows[0]) {
                fail(
                    'achievement_persistence_failed',
                    'The achievement unlock could not be persisted.',
                    {
                        status: 503,
                        retryable: true,
                    }
                );
            }

            return normalizeStoredRecord(
                result.rows[0]
            );
        },

        async listUnlocks(
            client,
            {
                accountId,
            }
        ) {
            const result = await client.query(
                `
                    /* account-achievements:list-unlocks */
                    SELECT
                        achievement_id,
                        unlocked_at,
                        last_synced_at
                    FROM account_achievement_unlocks
                    WHERE account_id = $1
                    ORDER BY
                        unlocked_at ASC,
                        achievement_id ASC
                `,
                [accountId]
            );

            return result.rows.map(
                normalizeStoredRecord
            );
        },
    });
}

export function createAccountAchievementService({
    pool = null,
    repository = null,
    accountAuthService,
    now = () => Date.now(),
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService
            .authorizeAccessToken !== 'function'
    ) {
        fail(
            'invalid_achievement_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_achievement_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountAchievementRepository(
            pool
        );

    if (
        !repo ||
        typeof repo.withTransaction !== 'function' ||
        typeof repo.upsertUnlock !== 'function' ||
        typeof repo.listUnlocks !== 'function'
    ) {
        fail(
            'invalid_achievement_configuration',
            'A valid achievement repository is required.'
        );
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
            {
                maxLength: 16_384,
            }
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

    async function syncUnlocks({
        installationId,
        accessToken,
        schemaVersion,
        records,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const normalizedRecords =
            normalizeBatch({
                schemaVersion,
                records,
            });

        const syncedAtMilliseconds = now();

        if (
            !Number.isFinite(
                syncedAtMilliseconds
            ) ||
            syncedAtMilliseconds < 0
        ) {
            fail(
                'invalid_achievement_configuration',
                'now() returned an invalid value.'
            );
        }

        const syncedAt = new Date(
            syncedAtMilliseconds
        );

        try {
            const canonicalRecords =
                await repo.withTransaction(
                    async (client) => {
                        for (
                            const record
                            of normalizedRecords
                        ) {
                            await repo.upsertUnlock(
                                client,
                                {
                                    accountId:
                                        authorization
                                            .accountId,
                                    installationId:
                                        authorization
                                            .installationId,
                                    schemaVersion,
                                    record,
                                    syncedAt,
                                }
                            );
                        }

                        return repo.listUnlocks(
                            client,
                            {
                                accountId:
                                    authorization
                                        .accountId,
                            }
                        );
                    }
                );

            const ids = new Set();

            for (
                const record
                of canonicalRecords
            ) {
                if (
                    ids.has(
                        record.achievementId
                    )
                ) {
                    fail(
                        'achievement_storage_invalid',
                        'Stored achievement data contains duplicate records.',
                        {
                            status: 503,
                            retryable: true,
                        }
                    );
                }

                ids.add(
                    record.achievementId
                );
            }

            return Object.freeze({
                accountId:
                    authorization.accountId,
                installationId:
                    authorization.installationId,
                syncedAt,
                submittedCount:
                    normalizedRecords.length,
                records: Object.freeze(
                    canonicalRecords
                ),
            });
        } catch (error) {
            if (
                error instanceof
                AccountAchievementError
            ) {
                throw error;
            }

            fail(
                'achievement_sync_unavailable',
                'Achievement unlocks could not be synchronized.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }
    }

    return Object.freeze({
        syncUnlocks,
    });
}

export const accountAchievementConstants =
    Object.freeze({
        schemaVersion:
            ACHIEVEMENT_SCHEMA_VERSION,
        maxRecords:
            MAX_ACHIEVEMENT_RECORDS,
    });
