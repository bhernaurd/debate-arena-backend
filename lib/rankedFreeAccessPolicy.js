import pg from 'pg';
import { DateTime } from 'luxon';

import { createAccountAuthService } from './accountAuthService.js';
import { createAccountProAccessService } from './accountProAccessService.js';
import {
    findRankedPhilosopher,
    isRankedPhilosopherID,
} from './rankedPhilosopherCatalog.js';

const { Pool } = pg;

const DEFAULT_TIME_ZONE = 'America/Chicago';
const FREE_START_LEASE_MS = 10 * 60 * 1000;
const MAX_TIME_ZONE_LENGTH = 100;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const PHILOSOPHER_ID_RE = /^[a-z0-9-]{1,100}$/;

export class RankedFreeAccessPolicyError extends Error {
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
        this.name = 'RankedFreeAccessPolicyError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new RankedFreeAccessPolicyError(
        code,
        message,
        options
    );
}

function cleanText(value, fieldName, maximumLength) {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximumLength
    ) {
        fail(
            'invalid_ranked_free_access_request',
            `${fieldName} is invalid.`,
            { status: 400, retryable: false }
        );
    }

    return value.trim();
}

function cleanUUID(value, fieldName) {
    const cleaned = cleanText(value, fieldName, 64).toLowerCase();

    if (!UUID_RE.test(cleaned)) {
        fail(
            'invalid_ranked_free_access_request',
            `${fieldName} must be a valid UUID.`,
            { status: 400, retryable: false }
        );
    }

    return cleaned;
}

function cleanInstallationId(value) {
    const cleaned = cleanText(value, 'installationId', 128);

    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail(
            'invalid_ranked_free_access_request',
            'installationId is invalid.',
            { status: 400, retryable: false }
        );
    }

    return cleaned;
}

function cleanPhilosopherId(value) {
    const cleaned = cleanText(value, 'philosopherId', 100).toLowerCase();

    if (!PHILOSOPHER_ID_RE.test(cleaned)) {
        fail(
            'invalid_ranked_philosopher',
            'The selected philosopher is unavailable for Ranked.',
            { status: 400, retryable: false }
        );
    }

    return cleaned;
}

function normalizeTimeZone(value) {
    if (value == null || String(value).trim() === '') {
        return DEFAULT_TIME_ZONE;
    }

    const cleaned = String(value).trim();

    if (cleaned.length > MAX_TIME_ZONE_LENGTH) {
        fail(
            'invalid_ranked_timezone',
            'The device time zone is invalid.',
            { status: 400, retryable: false }
        );
    }

    const probe = DateTime.now().setZone(cleaned);

    if (!probe.isValid) {
        fail(
            'invalid_ranked_timezone',
            'The device time zone is invalid.',
            { status: 400, retryable: false }
        );
    }

    return cleaned;
}

function normalizeNow(now) {
    const raw = now();
    const date = raw instanceof Date ? raw : new Date(raw);

    if (Number.isNaN(date.getTime())) {
        fail(
            'ranked_free_access_unavailable',
            'Ranked access time could not be resolved.',
            { status: 503, retryable: true }
        );
    }

    return date;
}

export function rankedDailyWindow({
    timezone,
    now = new Date(),
} = {}) {
    const cleanTimeZone = normalizeTimeZone(timezone);
    const instant = now instanceof Date ? now : new Date(now);

    if (Number.isNaN(instant.getTime())) {
        fail(
            'ranked_free_access_unavailable',
            'Ranked access time could not be resolved.',
            { status: 503, retryable: true }
        );
    }

    const localNow = DateTime
        .fromJSDate(instant, { zone: 'utc' })
        .setZone(cleanTimeZone);

    const todayStart = localNow
        .startOf('day')
        .set({ hour: 5 });

    const startsAt = localNow < todayStart
        ? todayStart.minus({ days: 1 })
        : todayStart;

    const endsAt = startsAt.plus({ days: 1 });

    return Object.freeze({
        timezone: cleanTimeZone,
        challengeDate: startsAt.toISODate(),
        startsAt: startsAt.toUTC().toJSDate(),
        expiresAt: endsAt
            .minus({ seconds: 1 })
            .toUTC()
            .toJSDate(),
    });
}

function serializeDate(value) {
    return value instanceof Date
        ? value.toISOString()
        : new Date(value).toISOString();
}

function createDefaultDependencies() {
    const connectionString = process.env.DATABASE_URL?.trim();

    if (!connectionString) {
        fail(
            'ranked_free_access_unavailable',
            'DATABASE_URL is required for Ranked access policy.',
            { status: 503, retryable: true }
        );
    }

    const pool = new Pool({
        connectionString,
        ssl: connectionString.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 4,
    });

    pool.on('error', (error) => {
        console.error(
            '[RankedFreeAccess] PostgreSQL pool error:',
            error?.message || error
        );
    });

    return Object.freeze({
        pool,
        accountAuthService: createAccountAuthService({ pool }),
        proAccessService: createAccountProAccessService({ pool }),
    });
}

export function createRankedFreeAccessPolicy({
    pool,
    accountAuthService,
    proAccessService,
    now = () => Date.now(),
    leaseMs = FREE_START_LEASE_MS,
    logger = console,
} = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        fail(
            'invalid_ranked_free_access_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        fail(
            'invalid_ranked_free_access_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (
        !proAccessService ||
        typeof proAccessService.getCurrentAccess !== 'function'
    ) {
        fail(
            'invalid_ranked_free_access_configuration',
            'proAccessService.getCurrentAccess() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_ranked_free_access_configuration',
            'now must be a function.'
        );
    }

    if (!Number.isSafeInteger(leaseMs) || leaseMs < 60_000) {
        fail(
            'invalid_ranked_free_access_configuration',
            'leaseMs must be at least 60000 milliseconds.'
        );
    }

    async function authorize({ installationId, accessToken }) {
        const cleanInstallationID = cleanInstallationId(installationId);
        const cleanAccessToken = cleanText(accessToken, 'accessToken', 16_384);

        try {
            const result = await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationID,
                accessToken: cleanAccessToken,
            });

            const accountId = String(result?.accountId ?? '').trim().toLowerCase();

            if (!UUID_RE.test(accountId)) {
                fail(
                    'ranked_authentication_unavailable',
                    'Account authentication returned an invalid account ID.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                accountId,
                installationId: cleanInstallationID,
            });
        } catch (error) {
            if (error instanceof RankedFreeAccessPolicyError) {
                throw error;
            }

            throw new RankedFreeAccessPolicyError(
                error?.code || 'invalid_access_token',
                error?.message || 'The Agora account session is invalid or expired.',
                {
                    status: Number.isInteger(error?.status) ? error.status : 401,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function hasProAccess(accountId) {
        try {
            const access = await proAccessService.getCurrentAccess({ accountId });
            return access?.hasProAccess === true;
        } catch (error) {
            // Ranked must remain usable at the free tier even if subscription
            // metadata is temporarily unavailable. This is a conservative
            // fallback: it can temporarily restrict a Pro user, but it never
            // grants unlimited Ranked access to an unverified account.
            logger?.warn?.(
                '[RankedFreeAccess] Pro lookup unavailable; using free tier.',
                {
                    accountId,
                    code: error?.code ?? 'unknown_error',
                    message: error?.message ?? 'Unknown error',
                }
            );
            return false;
        }
    }

    async function loadDailyPhilosopher(client, challengeDate) {
        const result = await client.query(
            `
                /* ranked-free-access:daily-philosopher */
                SELECT
                    philosopher_id,
                    philosopher_name
                FROM daily_challenges
                WHERE challenge_date = $1::date
                LIMIT 1
            `,
            [challengeDate]
        );

        const row = result.rows[0];

        if (!row) {
            return null;
        }

        const philosopherId =
            typeof row.philosopher_id === 'string'
                ? row.philosopher_id.trim().toLowerCase()
                : '';

        if (!PHILOSOPHER_ID_RE.test(philosopherId)) {
            return null;
        }

        const canonical = findRankedPhilosopher(philosopherId);
        const philosopherName =
            typeof row.philosopher_name === 'string' && row.philosopher_name.trim()
                ? row.philosopher_name.trim()
                : canonical?.name ?? philosopherId;

        return Object.freeze({
            id: philosopherId,
            name: philosopherName,
            rankedEligible: isRankedPhilosopherID(philosopherId),
        });
    }

    async function findUsage(client, { accountId, challengeDate, forUpdate = false }) {
        const result = await client.query(
            `
                /* ranked-free-access:find-usage */
                SELECT
                    account_id,
                    challenge_date,
                    request_id,
                    philosopher_id,
                    timezone,
                    status,
                    reserved_at,
                    updated_at,
                    completed_at
                FROM account_ranked_free_daily_starts
                WHERE account_id = $1::uuid
                  AND challenge_date = $2::date
                ${forUpdate ? 'FOR UPDATE' : ''}
            `,
            [accountId, challengeDate]
        );

        return result.rows[0] ?? null;
    }

    async function debateExistsForRequest(client, { accountId, requestId }) {
        const result = await client.query(
            `
                /* ranked-free-access:debate-exists */
                SELECT id
                FROM account_ranked_debates
                WHERE account_id = $1::uuid
                  AND start_request_id = $2::uuid
                  AND debate_kind = 'ladder'
                LIMIT 1
            `,
            [accountId, requestId]
        );

        return result.rowCount > 0;
    }

    async function markCompleted(client, { accountId, challengeDate, completedAt }) {
        await client.query(
            `
                /* ranked-free-access:mark-completed */
                UPDATE account_ranked_free_daily_starts
                SET
                    status = 'completed',
                    completed_at = COALESCE(completed_at, $3::timestamptz),
                    updated_at = $3::timestamptz
                WHERE account_id = $1::uuid
                  AND challenge_date = $2::date
            `,
            [accountId, challengeDate, completedAt]
        );
    }

    async function usageAvailability(client, {
        accountId,
        challengeDate,
        checkedAt,
    }) {
        const usage = await findUsage(client, {
            accountId,
            challengeDate,
        });

        if (!usage) {
            return Object.freeze({ available: true, usage: null });
        }

        if (usage.status === 'completed') {
            return Object.freeze({ available: false, usage });
        }

        const requestId = String(usage.request_id ?? '').toLowerCase();

        if (
            UUID_RE.test(requestId) &&
            await debateExistsForRequest(client, { accountId, requestId })
        ) {
            try {
                await markCompleted(client, {
                    accountId,
                    challengeDate,
                    completedAt: checkedAt,
                });
            } catch {}

            return Object.freeze({ available: false, usage });
        }

        const reservedAt = new Date(usage.reserved_at);
        const isFresh =
            !Number.isNaN(reservedAt.getTime()) &&
            reservedAt.getTime() > checkedAt.getTime() - leaseMs;

        return Object.freeze({
            available: !isFresh,
            usage,
        });
    }

    async function getAccessSummary({ accountId, timezone }) {
        const cleanAccountId = cleanUUID(accountId, 'accountId');
        const checkedAt = normalizeNow(now);
        const window = rankedDailyWindow({
            timezone,
            now: checkedAt,
        });
        const isPro = await hasProAccess(cleanAccountId);

        const dailyPhilosopher = await loadDailyPhilosopher(
            pool,
            window.challengeDate
        );

        let freeLadderStartAvailable = isPro;

        if (!isPro && dailyPhilosopher?.rankedEligible === true) {
            try {
                const availability = await usageAvailability(pool, {
                    accountId: cleanAccountId,
                    challengeDate: window.challengeDate,
                    checkedAt,
                });
                freeLadderStartAvailable = availability.available;
            } catch (error) {
                // Migration 039 is additive. During a rolling deployment, an
                // older database should fail closed for free ladder starts but
                // should not make the entire Ranked profile unavailable.
                if (error?.code !== '42P01') {
                    throw error;
                }
                freeLadderStartAvailable = false;
            }
        }

        return Object.freeze({
            tier: isPro ? 'pro' : 'free',
            isPro,
            timezone: window.timezone,
            challengeDate: window.challengeDate,
            dailyPhilosopherId: dailyPhilosopher?.id ?? null,
            dailyPhilosopherName: dailyPhilosopher?.name ?? null,
            freeLadderStartAvailable,
            windowStartsAt: serializeDate(window.startsAt),
            windowExpiresAt: serializeDate(window.expiresAt),
        });
    }

    async function reserveLadderStart({
        accountId,
        requestId,
        philosopherId,
        timezone,
    }) {
        const cleanAccountId = cleanUUID(accountId, 'accountId');
        const cleanRequestId = cleanUUID(requestId, 'requestId');
        const cleanPhilosopherID = cleanPhilosopherId(philosopherId);
        const checkedAt = normalizeNow(now);
        const window = rankedDailyWindow({ timezone, now: checkedAt });

        if (await hasProAccess(cleanAccountId)) {
            return Object.freeze({
                tier: 'pro',
                isPro: true,
                reserved: false,
                challengeDate: window.challengeDate,
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Serialize one account/day before checking or writing the usage
            // row. This prevents two devices from reserving the same free day
            // at the same time.
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
                [cleanAccountId, window.challengeDate]
            );

            const dailyPhilosopher = await loadDailyPhilosopher(
                client,
                window.challengeDate
            );

            if (!dailyPhilosopher || !dailyPhilosopher.rankedEligible) {
                fail(
                    'ranked_daily_philosopher_unavailable',
                    "Today's free Ranked philosopher is temporarily unavailable.",
                    { status: 503, retryable: true }
                );
            }

            if (cleanPhilosopherID !== dailyPhilosopher.id) {
                fail(
                    'ranked_free_daily_philosopher_required',
                    `Free Ranked is available with today's philosopher, ${dailyPhilosopher.name}. Agora Pro unlocks every Ranked philosopher.`,
                    { status: 403, retryable: false }
                );
            }

            let usage = await findUsage(client, {
                accountId: cleanAccountId,
                challengeDate: window.challengeDate,
                forUpdate: true,
            });

            if (usage) {
                const storedRequestId = String(usage.request_id ?? '').toLowerCase();
                const storedPhilosopherId = String(usage.philosopher_id ?? '').toLowerCase();

                if (storedRequestId === cleanRequestId) {
                    if (storedPhilosopherId !== cleanPhilosopherID) {
                        fail(
                            'ranked_start_request_reused',
                            'This Ranked start request ID was already used for different input.',
                            { status: 409, retryable: false }
                        );
                    }

                    await client.query('COMMIT');
                    return Object.freeze({
                        tier: 'free',
                        isPro: false,
                        reserved: true,
                        challengeDate: window.challengeDate,
                        dailyPhilosopherId: dailyPhilosopher.id,
                    });
                }

                if (
                    UUID_RE.test(storedRequestId) &&
                    await debateExistsForRequest(client, {
                        accountId: cleanAccountId,
                        requestId: storedRequestId,
                    })
                ) {
                    await markCompleted(client, {
                        accountId: cleanAccountId,
                        challengeDate: window.challengeDate,
                        completedAt: checkedAt,
                    });
                    usage = { ...usage, status: 'completed' };
                }

                if (usage.status === 'completed') {
                    fail(
                        'ranked_free_daily_limit_reached',
                        "Today's free Ranked debate has already been used. Agora Pro unlocks unlimited Ranked debates.",
                        { status: 403, retryable: false }
                    );
                }

                const reservedAt = new Date(usage.reserved_at);
                const isFresh =
                    !Number.isNaN(reservedAt.getTime()) &&
                    reservedAt.getTime() > checkedAt.getTime() - leaseMs;

                if (isFresh) {
                    fail(
                        'ranked_free_daily_start_in_progress',
                        'Your free Ranked debate is already being prepared.',
                        { status: 409, retryable: true }
                    );
                }

                await client.query(
                    `
                        /* ranked-free-access:reuse-expired-reservation */
                        UPDATE account_ranked_free_daily_starts
                        SET
                            request_id = $3::uuid,
                            philosopher_id = $4::text,
                            timezone = $5::text,
                            status = 'reserved',
                            reserved_at = $6::timestamptz,
                            updated_at = $6::timestamptz,
                            completed_at = NULL
                        WHERE account_id = $1::uuid
                          AND challenge_date = $2::date
                    `,
                    [
                        cleanAccountId,
                        window.challengeDate,
                        cleanRequestId,
                        cleanPhilosopherID,
                        window.timezone,
                        checkedAt,
                    ]
                );
            } else {
                await client.query(
                    `
                        /* ranked-free-access:reserve */
                        INSERT INTO account_ranked_free_daily_starts (
                            account_id,
                            challenge_date,
                            request_id,
                            philosopher_id,
                            timezone,
                            status,
                            reserved_at,
                            updated_at
                        )
                        VALUES (
                            $1::uuid,
                            $2::date,
                            $3::uuid,
                            $4::text,
                            $5::text,
                            'reserved',
                            $6::timestamptz,
                            $6::timestamptz
                        )
                    `,
                    [
                        cleanAccountId,
                        window.challengeDate,
                        cleanRequestId,
                        cleanPhilosopherID,
                        window.timezone,
                        checkedAt,
                    ]
                );
            }

            await client.query('COMMIT');

            return Object.freeze({
                tier: 'free',
                isPro: false,
                reserved: true,
                challengeDate: window.challengeDate,
                dailyPhilosopherId: dailyPhilosopher.id,
            });
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {}

            if (error instanceof RankedFreeAccessPolicyError) {
                throw error;
            }

            if (error?.code === '42P01') {
                fail(
                    'ranked_free_access_unavailable',
                    'Free Ranked access is temporarily unavailable.',
                    { status: 503, retryable: true, cause: error }
                );
            }

            throw new RankedFreeAccessPolicyError(
                'ranked_free_access_unavailable',
                'Free Ranked access is temporarily unavailable.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        } finally {
            client.release();
        }
    }

    async function authorizeAndGetAccess({
        installationId,
        accessToken,
        timezone,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const access = await getAccessSummary({
            accountId: authorization.accountId,
            timezone,
        });

        return Object.freeze({
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            access,
        });
    }

    async function authorizeAndReserveLadderStart({
        installationId,
        accessToken,
        requestId,
        philosopherId,
        timezone,
    }) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const reservation = await reserveLadderStart({
            accountId: authorization.accountId,
            requestId,
            philosopherId,
            timezone,
        });

        return Object.freeze({
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            reservation,
        });
    }

    return Object.freeze({
        getAccessSummary,
        reserveLadderStart,
        authorizeAndGetAccess,
        authorizeAndReserveLadderStart,
    });
}

const defaultDependencies = createDefaultDependencies();

export const rankedFreeAccessPolicy = createRankedFreeAccessPolicy({
    pool: defaultDependencies.pool,
    accountAuthService: defaultDependencies.accountAuthService,
    proAccessService: defaultDependencies.proAccessService,
});

export const rankedFreeAccessConstants = Object.freeze({
    defaultTimeZone: DEFAULT_TIME_ZONE,
    freeStartLeaseMs: FREE_START_LEASE_MS,
});
