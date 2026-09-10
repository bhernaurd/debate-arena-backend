import pg from 'pg';

const { Pool } = pg;
const MESSAGE_ID_MAX_LENGTH = 255;
const ERROR_CODE_MAX_LENGTH = 128;
const DEFAULT_STALE_CLAIM_SECONDS = 300;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export class GooglePlayRtdnMessageStoreError extends Error {
    constructor(code, message, { status = 503, retryable = true, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlayRtdnMessageStoreError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlayRtdnMessageStoreError(code, message, options);
}

function safeString(value, maximum) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function safeOptionalString(value, maximum) {
    if (value == null) return null;
    return safeString(value, maximum);
}

function defaultPool() {
    return new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 2,
        idleTimeoutMillis: 30_000,
    });
}

function normalizeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeTokenHash(value) {
    const cleaned = safeOptionalString(value, 64)?.toLowerCase();
    return cleaned && SHA256_HEX_RE.test(cleaned) ? cleaned : null;
}

export function createGooglePlayRtdnMessageStore({
    pool = defaultPool(),
    staleClaimSeconds = DEFAULT_STALE_CLAIM_SECONDS,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error('Google Play RTDN message store requires a PostgreSQL pool.');
    }

    const staleSeconds = Number(staleClaimSeconds);
    if (!Number.isSafeInteger(staleSeconds) || staleSeconds < 30 || staleSeconds > 3600) {
        throw new Error('Google Play RTDN stale claim duration is invalid.');
    }

    function mapDatabaseError(cause) {
        if (cause?.code === '42P01') {
            fail(
                'google_play_rtdn_schema_unavailable',
                'Google Play notification deduplication is not ready on this server.',
                { cause }
            );
        }
        fail(
            'google_play_rtdn_dedupe_unavailable',
            'Google Play notification deduplication is temporarily unavailable.',
            { cause }
        );
    }

    async function claim({
        messageId,
        packageName = null,
        notificationType = null,
        eventTimeMillis = null,
        purchaseTokenSha256 = null,
    } = {}) {
        const cleanMessageId = safeString(messageId, MESSAGE_ID_MAX_LENGTH);
        if (!cleanMessageId) {
            fail(
                'invalid_google_play_rtdn_message_id',
                'Google Play Pub/Sub message ID is invalid.',
                { status: 400, retryable: false }
            );
        }

        const cleanPackageName = safeOptionalString(packageName, 255);
        const cleanNotificationType = normalizeInteger(notificationType);
        const cleanEventTimeMillis = normalizeInteger(eventTimeMillis);
        const cleanTokenHash = normalizeTokenHash(purchaseTokenSha256);

        try {
            const inserted = await pool.query(
                `
                INSERT INTO google_play_rtdn_messages (
                    message_id,
                    package_name,
                    notification_type,
                    event_time_millis,
                    purchase_token_sha256,
                    status,
                    claimed_at,
                    updated_at
                )
                VALUES ($1, $2, $3, $4, $5, 'processing', NOW(), NOW())
                ON CONFLICT (message_id) DO NOTHING
                RETURNING message_id
                `,
                [
                    cleanMessageId,
                    cleanPackageName,
                    cleanNotificationType,
                    cleanEventTimeMillis,
                    cleanTokenHash,
                ]
            );

            if (inserted.rowCount === 1) {
                return Object.freeze({ claimed: true, duplicate: false, inProgress: false });
            }

            const existing = await pool.query(
                `
                SELECT status, updated_at
                FROM google_play_rtdn_messages
                WHERE message_id = $1
                LIMIT 1
                `,
                [cleanMessageId]
            );
            const row = existing.rows?.[0];

            if (row?.status === 'processed' || row?.status === 'ignored') {
                return Object.freeze({ claimed: false, duplicate: true, inProgress: false });
            }

            const reclaimed = await pool.query(
                `
                UPDATE google_play_rtdn_messages
                SET
                    package_name = COALESCE($2, package_name),
                    notification_type = COALESCE($3, notification_type),
                    event_time_millis = COALESCE($4, event_time_millis),
                    purchase_token_sha256 = COALESCE($5, purchase_token_sha256),
                    status = 'processing',
                    claimed_at = NOW(),
                    processed_at = NULL,
                    updated_at = NOW(),
                    error_code = NULL
                WHERE message_id = $1
                  AND (
                        status = 'failed'
                        OR (
                            status = 'processing'
                            AND updated_at <= NOW() - ($6::integer * INTERVAL '1 second')
                        )
                  )
                RETURNING message_id
                `,
                [
                    cleanMessageId,
                    cleanPackageName,
                    cleanNotificationType,
                    cleanEventTimeMillis,
                    cleanTokenHash,
                    staleSeconds,
                ]
            );

            if (reclaimed.rowCount === 1) {
                return Object.freeze({ claimed: true, duplicate: true, inProgress: false });
            }

            return Object.freeze({ claimed: false, duplicate: true, inProgress: true });
        } catch (cause) {
            if (cause instanceof GooglePlayRtdnMessageStoreError) throw cause;
            mapDatabaseError(cause);
        }
    }

    async function complete(messageId, { processed = true } = {}) {
        const cleanMessageId = safeString(messageId, MESSAGE_ID_MAX_LENGTH);
        if (!cleanMessageId) return;
        try {
            await pool.query(
                `
                UPDATE google_play_rtdn_messages
                SET
                    status = $2,
                    processed_at = NOW(),
                    updated_at = NOW(),
                    error_code = NULL
                WHERE message_id = $1
                `,
                [cleanMessageId, processed ? 'processed' : 'ignored']
            );
        } catch (cause) {
            mapDatabaseError(cause);
        }
    }

    async function markFailed(messageId, errorCode) {
        const cleanMessageId = safeString(messageId, MESSAGE_ID_MAX_LENGTH);
        if (!cleanMessageId) return;
        const cleanErrorCode =
            safeOptionalString(errorCode, ERROR_CODE_MAX_LENGTH) ||
            'google_play_rtdn_processing_failed';
        try {
            await pool.query(
                `
                UPDATE google_play_rtdn_messages
                SET
                    status = 'failed',
                    processed_at = NULL,
                    updated_at = NOW(),
                    error_code = $2
                WHERE message_id = $1
                `,
                [cleanMessageId, cleanErrorCode]
            );
        } catch (cause) {
            mapDatabaseError(cause);
        }
    }

    return Object.freeze({ claim, complete, markFailed });
}
