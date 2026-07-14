// expandedAgoraAccess.js
// Reusable release/access engine for The Agora's Expanded Agora philosophers.
//
// The release record stores only the dates/settings you normally choose:
//   - pro_launch_at
//   - free_event_starts_at
//   - event duration (default 72 hours)
//   - grace duration (default 7 days)
//   - preview debate limit (default 3)
//
// The database view derives the event end, grace start, grace end, and
// eligibility cutoff automatically.

import express from 'express';

const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const PHILOSOPHER_ID_RE = /^[a-z0-9][a-z0-9_-]{1,79}$/;

const STANDARD_PHILOSOPHER_IDS = new Set([
    'socrates',
    'plato',
    'aristotle',
    'nietzsche',
    'aurelius',
    'marcus-aurelius',
    'marcus_aurelius',
    'jung',
    'carl-jung',
    'carl_jung',
]);

// Camus predates the scheduled-release engine. Keep his existing access
// behavior untouched when global enforcement is enabled.
const LEGACY_EXPANDED_PHILOSOPHER_IDS = new Set([
    'camus',
    'albert-camus',
    'albert_camus',
]);

const ACCESS_RELEVANT_JOB_TYPES = new Set([
    'debate_opening',
    'debate_reply',
]);

export const EXPANDED_AGORA_ENFORCEMENT_ENABLED =
    String(process.env.EXPANDED_AGORA_ENFORCEMENT || 'false')
        .trim()
        .toLowerCase() === 'true';

// Safe production testing:
// Keep global enforcement disabled while the live Pro-verification path is
// unfinished, but enforce access for specific installation IDs listed in:
// EXPANDED_AGORA_ENFORCEMENT_TEST_USER_IDS=id1,id2
const EXPANDED_AGORA_ENFORCEMENT_TEST_USER_IDS = new Set(
    String(process.env.EXPANDED_AGORA_ENFORCEMENT_TEST_USER_IDS || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
);

function expandedAgoraEnforcementEnabledForUser(userId) {
    const normalizedUserId = cleanString(userId, 128).toLowerCase();

    return (
        EXPANDED_AGORA_ENFORCEMENT_ENABLED ||
        EXPANDED_AGORA_ENFORCEMENT_TEST_USER_IDS.has(normalizedUserId)
    );
}

export class ExpandedAgoraAccessError extends Error {
    constructor(
        message,
        statusCode = 403,
        code = 'expanded_agora_locked',
        details = null
    ) {
        super(message);
        this.name = 'ExpandedAgoraAccessError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}

function cleanString(value, maxLength = 200) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function parseOptionalPositiveInteger(value) {
    if (value === undefined || value === null || value === '') return null;

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}

function isValidUserId(value) {
    return typeof value === 'string' && USER_ID_RE.test(value);
}

function isValidPhilosopherId(value) {
    return typeof value === 'string' && PHILOSOPHER_ID_RE.test(value);
}

function normalizeMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return {};
    }

    return metadata;
}

function philosopherIdFromMetadata(metadata) {
    const normalized = normalizeMetadata(metadata);
    return cleanString(normalized.philosopherId, 80).toLowerCase();
}

function iosBuildFromRequest(req) {
    return parseOptionalPositiveInteger(
        req.get('x-ios-build') || req.query?.iosBuild
    );
}

function isoOrNull(value) {
    if (!value) return null;
    return new Date(value).toISOString();
}

function phaseForRelease(release, now) {
    const currentMs = now.getTime();
    const launchMs = new Date(release.pro_launch_at).getTime();
    const eventStartMs = new Date(release.free_event_starts_at).getTime();
    const eventEndMs = new Date(release.free_event_ends_at).getTime();
    const graceEndMs = new Date(release.grace_ends_at).getTime();

    if (currentMs < launchMs) return 'coming_soon';
    if (currentMs < eventStartMs) return 'pro_early_access';
    if (currentMs < eventEndMs) return 'free_event';
    if (currentMs < graceEndMs) return 'grace_period';
    return 'pro_only';
}

function minimumBuildSatisfied(release, iosBuild) {
    const minimumBuild = Number(release.minimum_ios_build || 0);

    if (!minimumBuild) return true;
    if (!iosBuild) return false;

    return iosBuild >= minimumBuild;
}

async function getFirstSeenAt(db, userId) {
    const result = await db.query(
        `
        SELECT MIN(first_seen_at) AS first_seen_at
        FROM user_activity_days
        WHERE user_id = $1
        `,
        [userId]
    );

    return result.rows[0]?.first_seen_at || null;
}

async function getEnabledReleaseRows(db, philosopherId = null) {
    const values = [];
    let philosopherFilter = '';

    if (philosopherId) {
        values.push(philosopherId);
        philosopherFilter = `AND philosopher_id = $${values.length}`;
    }

    const result = await db.query(
        `
        SELECT *
        FROM expanded_philosopher_release_schedule
        WHERE is_enabled = TRUE
        ${philosopherFilter}
        ORDER BY pro_launch_at ASC, philosopher_id ASC
        `,
        values
    );

    return result.rows;
}

async function getAnyReleaseRow(db, philosopherId) {
    const result = await db.query(
        `
        SELECT *
        FROM expanded_philosopher_release_schedule
        WHERE philosopher_id = $1
        LIMIT 1
        `,
        [philosopherId]
    );

    return result.rows[0] || null;
}

// Older App Store builds may not send philosopherId on every debate job.
// Once an enabled scheduled release has minimum_ios_build set, builds at or
// above that threshold must send philosopherId; older or unknown builds remain
// compatible.
async function philosopherIdRequiredForBuild(db, iosBuild) {
    if (!iosBuild) return false;

    const result = await db.query(
        `
        SELECT MIN(minimum_ios_build)::int AS minimum_strict_build
        FROM expanded_philosopher_release_schedule
        WHERE is_enabled = TRUE
          AND minimum_ios_build IS NOT NULL
        `
    );

    const minimumStrictBuild = Number(
        result.rows[0]?.minimum_strict_build || 0
    );

    return (
        minimumStrictBuild > 0 &&
        iosBuild >= minimumStrictBuild
    );
}

async function getUsageByPhilosopher(db, userId) {
    const result = await db.query(
        `
        SELECT
            philosopher_id,
            COUNT(*) FILTER (
                WHERE authorization_source = 'free_event'
                  AND status = 'authorized'
            )::int AS event_debates,
            COUNT(*) FILTER (
                WHERE authorization_source = 'grace_preview'
                  AND status = 'authorized'
            )::int AS grace_debates
        FROM expanded_debate_authorizations
        WHERE user_id = $1
        GROUP BY philosopher_id
        `,
        [userId]
    );

    return new Map(
        result.rows.map((row) => [
            row.philosopher_id,
            {
                eventDebates: Number(row.event_debates || 0),
                graceDebates: Number(row.grace_debates || 0),
            },
        ])
    );
}

function buildReleaseStatus({
    release,
    firstSeenAt,
    usage,
    iosBuild,
    now,
}) {
    const phase = phaseForRelease(release, now);
    const buildSatisfied = minimumBuildSatisfied(release, iosBuild);
    const eligibilityCutoff = new Date(release.grace_eligibility_cutoff_at);
    const firstSeenDate = firstSeenAt ? new Date(firstSeenAt) : null;

    const eligibleForGrace = Boolean(
        firstSeenDate &&
        firstSeenDate.getTime() < eligibilityCutoff.getTime()
    );

    const eventDebates = usage?.eventDebates || 0;
    const graceDebates = usage?.graceDebates || 0;
    const previewLimit = Number(release.preview_debate_limit || 0);

    // Open Access Event debates are unlimited and never reduce the later
    // three-debate preview. Only successfully authorized grace previews count.
    const previewDebatesRemaining = Math.max(
        0,
        previewLimit - graceDebates
    );

    let freeAccess = 'none';
    let accessReason = 'pro_required';

    if (!buildSatisfied) {
        accessReason = 'update_required';
    } else if (phase === 'free_event') {
        freeAccess = 'event';
        accessReason = 'free_event';
    } else if (
        phase === 'grace_period' &&
        eligibleForGrace &&
        previewDebatesRemaining > 0
    ) {
        freeAccess = 'grace_preview';
        accessReason = 'grace_preview';
    } else if (phase === 'coming_soon') {
        accessReason = 'coming_soon';
    } else if (phase === 'pro_early_access') {
        accessReason = 'pro_early_access';
    } else if (phase === 'grace_period' && !eligibleForGrace) {
        accessReason = 'not_grace_eligible';
    } else if (
        phase === 'grace_period' &&
        previewDebatesRemaining === 0
    ) {
        accessReason = 'preview_exhausted';
    }

    return {
        philosopherId: release.philosopher_id,
        displayName: release.display_name,
        phase,
        freeAccess,
        accessReason,
        eligibleForGrace,
        previewDebateLimit: previewLimit,
        previewDebatesRemaining,
        eventDebatesCounted: eventDebates,
        graceDebatesCounted: graceDebates,
        officialTimeZone: release.official_time_zone,
        proLaunchAt: isoOrNull(release.pro_launch_at),
        freeEventStartsAt: isoOrNull(release.free_event_starts_at),
        freeEventEndsAt: isoOrNull(release.free_event_ends_at),
        graceStartsAt: isoOrNull(release.grace_starts_at),
        graceEndsAt: isoOrNull(release.grace_ends_at),
        graceEligibilityCutoffAt: isoOrNull(
            release.grace_eligibility_cutoff_at
        ),
        minimumIosBuild: release.minimum_ios_build
            ? Number(release.minimum_ios_build)
            : null,
        minimumBuildSatisfied: buildSatisfied,
    };
}

export async function getExpandedAgoraAccessSnapshot(
    db,
    { userId, iosBuild = null }
) {
    if (!isValidUserId(userId)) {
        throw new ExpandedAgoraAccessError(
            'A valid installation ID is required.',
            400,
            'invalid_installation_id'
        );
    }

    const now = new Date();

    const [
        releases,
        firstSeenAt,
        usageByPhilosopher,
    ] = await Promise.all([
        getEnabledReleaseRows(db),
        getFirstSeenAt(db, userId),
        getUsageByPhilosopher(db, userId),
    ]);

    const philosophers = releases.map((release) =>
        buildReleaseStatus({
            release,
            firstSeenAt,
            usage: usageByPhilosopher.get(release.philosopher_id),
            iosBuild,
            now,
        })
    );

    const eventPhilosopher = philosophers.find(
        (item) => item.freeAccess === 'event'
    );

    const previewPhilosopherIds = philosophers
        .filter((item) => item.freeAccess === 'grace_preview')
        .map((item) => item.philosopherId);

    return {
        serverTime: now.toISOString(),
        installationFirstSeenAt: isoOrNull(firstSeenAt),
        enforcementEnabled:
            expandedAgoraEnforcementEnabledForUser(userId),
        specialEventPhilosopherId:
            eventPhilosopher?.philosopherId || null,
        previewPhilosopherIds,
        philosophers,
    };
}

async function existingAuthorizationForDebate(
    db,
    { userId, philosopherId, debateId }
) {
    const result = await db.query(
        `
        SELECT *
        FROM expanded_debate_authorizations
        WHERE user_id = $1
          AND philosopher_id = $2
          AND debate_id = $3
        LIMIT 1
        `,
        [userId, philosopherId, debateId]
    );

    return result.rows[0] || null;
}

async function insertOpeningReservation(
    db,
    {
        userId,
        philosopherId,
        debateId,
        clientRequestId,
        source,
    }
) {
    const existing = await existingAuthorizationForDebate(db, {
        userId,
        philosopherId,
        debateId,
    });

    if (existing) {
        if (existing.opening_client_request_id !== clientRequestId) {
            throw new ExpandedAgoraAccessError(
                'This debate already has a different opening request.',
                409,
                'debate_opening_conflict'
            );
        }

        if (existing.status === 'failed') {
            const reactivated = await db.query(
                `
                UPDATE expanded_debate_authorizations
                SET
                    status = 'reserved',
                    failed_at = NULL,
                    failure_reason = NULL,
                    reserved_at = NOW()
                WHERE id = $1
                RETURNING *
                `,
                [existing.id]
            );

            return reactivated.rows[0];
        }

        return existing;
    }

    const result = await db.query(
        `
        INSERT INTO expanded_debate_authorizations (
            user_id,
            philosopher_id,
            debate_id,
            opening_client_request_id,
            authorization_source,
            status
        )
        VALUES ($1, $2, $3, $4, $5, 'reserved')
        RETURNING *
        `,
        [
            userId,
            philosopherId,
            debateId,
            clientRequestId,
            source,
        ]
    );

    return result.rows[0];
}

async function authorizeExpandedOpening(
    db,
    {
        userId,
        philosopherId,
        debateId,
        clientRequestId,
        iosBuild,
        isVerifiedPro,
        release: suppliedRelease = null,
    }
) {
    const release =
        suppliedRelease ||
        await getAnyReleaseRow(db, philosopherId);

    if (!release) {
        throw new ExpandedAgoraAccessError(
            'Unknown philosopher ID.',
            400,
            'unknown_philosopher'
        );
    }

    if (!release.is_enabled) {
        throw new ExpandedAgoraAccessError(
            'This philosopher release is not enabled.',
            403,
            'release_disabled'
        );
    }

    if (!minimumBuildSatisfied(release, iosBuild)) {
        throw new ExpandedAgoraAccessError(
            'Update The Agora to access this philosopher.',
            426,
            'update_required',
            {
                minimumIosBuild: release.minimum_ios_build
                    ? Number(release.minimum_ios_build)
                    : null,
            }
        );
    }

    const now = new Date();
    const phase = phaseForRelease(release, now);

    if (phase === 'coming_soon') {
        throw new ExpandedAgoraAccessError(
            'This philosopher has not launched yet.',
            403,
            'coming_soon'
        );
    }

    if (isVerifiedPro) {
        const reservation = await insertOpeningReservation(db, {
            userId,
            philosopherId,
            debateId,
            clientRequestId,
            source: 'pro',
        });

        return {
            allowed: true,
            reason: 'pro',
            authorization: reservation,
        };
    }

    if (phase === 'free_event') {
        const reservation = await insertOpeningReservation(db, {
            userId,
            philosopherId,
            debateId,
            clientRequestId,
            source: 'free_event',
        });

        return {
            allowed: true,
            reason: 'free_event',
            authorization: reservation,
        };
    }

    if (phase === 'grace_period') {
        // Serialize preview checks for this installation/philosopher pair so
        // simultaneous opening requests cannot exceed the allowance.
        await db.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [userId, philosopherId]
        );

        const firstSeenAt = await getFirstSeenAt(db, userId);
        const cutoff = new Date(release.grace_eligibility_cutoff_at);
        const firstSeenDate = firstSeenAt
            ? new Date(firstSeenAt)
            : null;

        if (
            !firstSeenDate ||
            firstSeenDate.getTime() >= cutoff.getTime()
        ) {
            throw new ExpandedAgoraAccessError(
                'This installation is not eligible for the grace preview.',
                403,
                'not_grace_eligible'
            );
        }

        const existing = await existingAuthorizationForDebate(db, {
            userId,
            philosopherId,
            debateId,
        });

        if (existing) {
            const reservation = await insertOpeningReservation(db, {
                userId,
                philosopherId,
                debateId,
                clientRequestId,
                source: existing.authorization_source,
            });

            return {
                allowed: true,
                reason: existing.authorization_source,
                authorization: reservation,
            };
        }

        const countResult = await db.query(
            `
            SELECT COUNT(*)::int AS used
            FROM expanded_debate_authorizations
            WHERE user_id = $1
              AND philosopher_id = $2
              AND authorization_source = 'grace_preview'
              AND status IN ('reserved', 'authorized')
            `,
            [userId, philosopherId]
        );

        const used = Number(countResult.rows[0]?.used || 0);
        const limit = Number(release.preview_debate_limit || 0);

        if (used >= limit) {
            throw new ExpandedAgoraAccessError(
                'No free preview debates remain.',
                403,
                'preview_exhausted',
                {
                    previewDebateLimit: limit,
                    previewDebatesRemaining: 0,
                }
            );
        }

        const reservation = await insertOpeningReservation(db, {
            userId,
            philosopherId,
            debateId,
            clientRequestId,
            source: 'grace_preview',
        });

        return {
            allowed: true,
            reason: 'grace_preview',
            previewDebatesRemaining: Math.max(
                0,
                limit - used - 1
            ),
            authorization: reservation,
        };
    }

    throw new ExpandedAgoraAccessError(
        'Agora Pro is required to start a new debate with this philosopher.',
        403,
        phase === 'pro_early_access'
            ? 'pro_early_access'
            : 'pro_required'
    );
}

async function authorizeExpandedReply(
    db,
    { userId, philosopherId, debateId }
) {
    const authorization = await existingAuthorizationForDebate(db, {
        userId,
        philosopherId,
        debateId,
    });

    if (
        !authorization ||
        authorization.status !== 'authorized'
    ) {
        throw new ExpandedAgoraAccessError(
            'This Expanded Agora debate was not previously authorized.',
            403,
            'debate_not_authorized'
        );
    }

    return {
        allowed: true,
        reason: 'existing_debate',
        authorization,
    };
}

export async function authorizeAIJobCreate(
    db,
    {
        jobType,
        userId,
        debateId,
        clientRequestId,
        metadata,
        iosBuild = null,
        isVerifiedPro = false,
    }
) {
    if (!ACCESS_RELEVANT_JOB_TYPES.has(jobType)) {
        return {
            allowed: true,
            reason: 'not_access_relevant',
        };
    }

    const philosopherId = philosopherIdFromMetadata(metadata);
    const enforcementEnabled =
        expandedAgoraEnforcementEnabledForUser(userId);

    if (!philosopherId) {
        const mustSendPhilosopherId =
            enforcementEnabled &&
            await philosopherIdRequiredForBuild(db, iosBuild);

        if (mustSendPhilosopherId) {
            throw new ExpandedAgoraAccessError(
                'philosopherId is required for debate AI jobs.',
                400,
                'missing_philosopher_id'
            );
        }

        return {
            allowed: true,
            reason: 'legacy_missing_philosopher_id',
        };
    }

    if (!isValidPhilosopherId(philosopherId)) {
        throw new ExpandedAgoraAccessError(
            'Invalid philosopherId.',
            400,
            'invalid_philosopher_id'
        );
    }

    if (STANDARD_PHILOSOPHER_IDS.has(philosopherId)) {
        return {
            allowed: true,
            reason: 'standard_philosopher',
        };
    }

    if (LEGACY_EXPANDED_PHILOSOPHER_IDS.has(philosopherId)) {
        return {
            allowed: true,
            reason: 'legacy_expanded_philosopher',
            philosopherId,
        };
    }

    // Only philosophers represented in the scheduled-release table are
    // governed by this engine. This keeps existing or experimental Expanded
    // Agora philosophers from being blocked accidentally.
    const release = await getAnyReleaseRow(db, philosopherId);

    if (!release) {
        return {
            allowed: true,
            reason: 'unscheduled_expanded_philosopher',
            philosopherId,
        };
    }

    if (!enforcementEnabled) {
        return {
            allowed: true,
            reason: 'expanded_enforcement_disabled',
            philosopherId,
        };
    }

    if (!isValidUserId(userId)) {
        throw new ExpandedAgoraAccessError(
            'A valid installation ID is required.',
            400,
            'invalid_installation_id'
        );
    }

    if (!debateId) {
        throw new ExpandedAgoraAccessError(
            'debateId is required for Expanded Agora debates.',
            400,
            'missing_debate_id'
        );
    }

    if (jobType === 'debate_opening') {
        return authorizeExpandedOpening(db, {
            userId,
            philosopherId,
            debateId,
            clientRequestId,
            iosBuild,
            isVerifiedPro,
            release,
        });
    }

    return authorizeExpandedReply(db, {
        userId,
        philosopherId,
        debateId,
    });
}

export async function markExpandedOpeningAuthorized(db, job) {
    if (job?.job_type !== 'debate_opening') return;

    const philosopherId = philosopherIdFromMetadata(job.metadata);

    if (
        !philosopherId ||
        STANDARD_PHILOSOPHER_IDS.has(philosopherId) ||
        LEGACY_EXPANDED_PHILOSOPHER_IDS.has(philosopherId)
    ) {
        return;
    }

    await db.query(
        `
        UPDATE expanded_debate_authorizations
        SET
            status = 'authorized',
            authorized_at = COALESCE(authorized_at, NOW()),
            failed_at = NULL,
            failure_reason = NULL
        WHERE opening_client_request_id = $1
          AND user_id = $2
          AND philosopher_id = $3
        `,
        [
            job.client_request_id,
            job.user_id,
            philosopherId,
        ]
    );
}

export async function markExpandedOpeningFailed(
    db,
    job,
    failureReason
) {
    if (job?.job_type !== 'debate_opening') return;

    const philosopherId = philosopherIdFromMetadata(job.metadata);

    if (
        !philosopherId ||
        STANDARD_PHILOSOPHER_IDS.has(philosopherId) ||
        LEGACY_EXPANDED_PHILOSOPHER_IDS.has(philosopherId)
    ) {
        return;
    }

    await db.query(
        `
        UPDATE expanded_debate_authorizations
        SET
            status = 'failed',
            failed_at = NOW(),
            failure_reason = $4
        WHERE opening_client_request_id = $1
          AND user_id = $2
          AND philosopher_id = $3
          AND status <> 'authorized'
        `,
        [
            job.client_request_id,
            job.user_id,
            philosopherId,
            cleanString(failureReason, 1000) ||
                'Opening generation failed.',
        ]
    );
}

export async function reactivateExpandedOpeningForRetry(
    db,
    job
) {
    if (job?.job_type !== 'debate_opening') return;

    const philosopherId = philosopherIdFromMetadata(job.metadata);

    if (
        !philosopherId ||
        STANDARD_PHILOSOPHER_IDS.has(philosopherId) ||
        LEGACY_EXPANDED_PHILOSOPHER_IDS.has(philosopherId)
    ) {
        return;
    }

    await db.query(
        `
        UPDATE expanded_debate_authorizations
        SET
            status = 'reserved',
            reserved_at = NOW(),
            failed_at = NULL,
            failure_reason = NULL
        WHERE opening_client_request_id = $1
          AND user_id = $2
          AND philosopher_id = $3
          AND status = 'failed'
        `,
        [
            job.client_request_id,
            job.user_id,
            philosopherId,
        ]
    );
}

export function createExpandedAgoraAccessRouter(pool) {
    const router = express.Router();

    router.get('/access', async (req, res) => {
        try {
            const userId = cleanString(
                req.get('x-installation-id') ||
                    req.query?.userId,
                128
            );

            if (!isValidUserId(userId)) {
                return res.status(400).json({
                    success: false,
                    error:
                        'A valid X-Installation-ID header is required.',
                    code: 'invalid_installation_id',
                });
            }

            const snapshot =
                await getExpandedAgoraAccessSnapshot(pool, {
                    userId,
                    iosBuild: iosBuildFromRequest(req),
                });

            return res.json({
                success: true,
                ...snapshot,
            });
        } catch (err) {
            const statusCode = Number(
                err?.statusCode || 500
            );

            console.error(
                '[ExpandedAgora] Access snapshot error:',
                err?.message || err
            );

            return res.status(statusCode).json({
                success: false,
                error:
                    err?.message ||
                    'Failed to load Expanded Agora access.',
                code:
                    err?.code ||
                    'expanded_agora_access_failed',
                details: err?.details || null,
            });
        }
    });

    return router;
}
