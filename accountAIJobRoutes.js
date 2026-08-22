import express from 'express';

import {
    AccountAuthError,
} from './lib/accountAuthService.js';
import {
    AccountProAccessError,
} from './lib/accountProAccessService.js';
import {
    ExpandedAgoraAccessError,
    authorizeAIJobCreate,
} from './expandedAgoraAccess.js';
import {
    processAIJob,
} from './aiJobs.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const ALLOWED_JOB_TYPES = new Set([
    'debate_opening',
    'debate_reply',
    'daily_opening',
    'daily_reply',
    'debate_report',
    'debate_report_insight',
]);

class AccountAIJobRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'AccountAIJobRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAIJobRouteError(
        code,
        message,
        options
    );
}

function cleanString(value, maxLength = 20_000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function requireBody(req) {
    if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
    ) {
        fail(
            'invalid_ai_job_request',
            'A JSON object body is required.',
            { status: 400 }
        );
    }
    return req.body;
}

function requireInstallationId(req) {
    const value = cleanString(
        req.get('X-Installation-ID'),
        128
    );
    if (!USER_ID_RE.test(value)) {
        fail(
            'invalid_installation_id',
            'A valid X-Installation-ID header is required.',
            { status: 400 }
        );
    }
    return value;
}

function requireBearerToken(req) {
    const authorization = req.get('Authorization');
    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_access_token',
            'A Bearer access token is required.',
            { status: 401 }
        );
    }
    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(authorization.trim());
    if (!match) {
        fail(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }
    return match[1];
}

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .map((message) => ({
            role:
                message?.role === 'assistant'
                    ? 'assistant'
                    : 'user',
            content: cleanString(
                message?.content,
                50_000
            ),
        }))
        .filter((message) => message.content.length > 0);
}

function publicJob(row) {
    if (!row) return null;
    return {
        id: row.id,
        clientRequestId: row.client_request_id,
        jobType: row.job_type,
        debateId: row.debate_id,
        userId: row.user_id,
        status: row.status,
        resultText: row.result_text,
        errorMessage: row.error_message,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        processingStartedAt: row.processing_started_at,
        completedAt: row.completed_at,
        failedAt: row.failed_at,
    };
}

function verificationMetadata(access) {
    if (access?.hasProAccess !== true) {
        return {
            serverVerifiedPro: false,
            reason: 'no_verified_account_entitlement',
            environment: null,
            productId: null,
            expiresDate: null,
            isTrial: false,
            source: 'account_entitlement_lookup',
            analyticsAccessTier: 'free',
            analyticsTierSource:
                'server_verified_account_no_entitlement',
        };
    }

    const entitlement = access.entitlement || {};
    const expires =
        entitlement.accessExpiresAt ||
        entitlement.expiryTime ||
        entitlement.expiresAt ||
        null;
    const expiresDate = expires
        ? new Date(expires).getTime()
        : null;
    const isGooglePlay = access.source === 'google_play';
    const isTrial = entitlement.isTrial === true;

    return {
        serverVerifiedPro: true,
        reason: isGooglePlay
            ? 'verified_account_google_play'
            : 'verified_account_app_store',
        environment: isGooglePlay
            ? 'GooglePlay'
            : (entitlement.environment || null),
        productId:
            entitlement.productId || null,
        expiresDate:
            Number.isFinite(expiresDate)
                ? expiresDate
                : null,
        isTrial,
        source: isGooglePlay
            ? 'account_google_play'
            : 'account_app_store',
        analyticsAccessTier:
            isTrial ? 'trial' : 'paid_pro',
        analyticsTierSource: isGooglePlay
            ? 'server_verified_google_play_account'
            : 'server_verified_app_store_account',
    };
}

function unavailableVerificationMetadata(error) {
    return {
        serverVerifiedPro: false,
        reason: 'account_entitlement_verification_unavailable',
        environment: null,
        productId: null,
        expiresDate: null,
        isTrial: false,
        source: 'account_entitlement_lookup_unavailable',
        analyticsAccessTier: 'free',
        analyticsTierSource:
            'server_verification_temporarily_unavailable',
        verificationErrorCode:
            error?.code || 'pro_access_unavailable',
    };
}

function publicError(error) {
    if (error instanceof ExpandedAgoraAccessError) {
        return {
            status:
                Number(error.statusCode || 500),
            body: {
                success: false,
                error: error.message,
                code:
                    error.code ||
                    'expanded_agora_access_failed',
                details: error.details || null,
            },
        };
    }

    if (
        error instanceof AccountAuthError ||
        error instanceof AccountAIJobRouteError
    ) {
        const rawStatus = Number.isInteger(error.status)
            ? error.status
            : 500;
        const status = rawStatus >= 500 ? 503 : rawStatus;
        return {
            status,
            body: {
                success: false,
                error:
                    status >= 500
                        ? 'Account AI authorization is temporarily unavailable.'
                        : error.message,
                code:
                    status >= 500
                        ? 'account_ai_authorization_unavailable'
                        : (error.code || 'account_ai_authorization_failed'),
            },
        };
    }

    return {
        status: 503,
        body: {
            success: false,
            error:
                'Account AI authorization is temporarily unavailable.',
            code: 'account_ai_authorization_unavailable',
        },
    };
}

export function createAccountAIJobRouter({
    pool,
    accountAuthService,
    proAccessService,
    processJob = processAIJob,
    logger = console,
} = {}) {
    if (
        !pool ||
        typeof pool.connect !== 'function'
    ) {
        throw new Error(
            'A PostgreSQL pool is required for account AI jobs.'
        );
    }
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }
    if (
        !proAccessService ||
        typeof proAccessService.getCurrentAccess !== 'function'
    ) {
        throw new Error(
            'proAccessService.getCurrentAccess() is required.'
        );
    }
    if (typeof processJob !== 'function') {
        throw new Error('processJob must be a function.');
    }

    const router = express.Router();

    router.post('/ai-jobs', async (req, res) => {
        let client = null;
        try {
            const body = requireBody(req);
            const installationId =
                requireInstallationId(req);
            const accessToken =
                requireBearerToken(req);
            const authorization =
                await accountAuthService.authorizeAccessToken({
                    installationId,
                    accessToken,
                });

            const bodyUserId = cleanString(
                body.userId,
                128
            );
            if (
                bodyUserId &&
                bodyUserId !== installationId
            ) {
                fail(
                    'installation_id_mismatch',
                    'The installation ID header does not match the request body.',
                    { status: 403 }
                );
            }

            const clientRequestId = cleanString(
                body.clientRequestId,
                200
            );
            const jobType = cleanString(
                body.jobType,
                80
            );
            const debateId = cleanString(
                body.debateId,
                200
            );
            const messages = normalizeMessages(
                body.messages
            );
            const systemPrompt = cleanString(
                body.systemPrompt,
                50_000
            );
            const safeMetadata =
                body.metadata &&
                typeof body.metadata === 'object' &&
                !Array.isArray(body.metadata)
                    ? body.metadata
                    : {};

            if (!clientRequestId) {
                fail(
                    'invalid_ai_job_request',
                    'clientRequestId is required.',
                    { status: 400 }
                );
            }
            if (!ALLOWED_JOB_TYPES.has(jobType)) {
                fail(
                    'invalid_ai_job_request',
                    `Invalid jobType: ${jobType}`,
                    { status: 400 }
                );
            }
            if (messages.length === 0) {
                fail(
                    'invalid_ai_job_request',
                    'messages are required.',
                    { status: 400 }
                );
            }

            let verification;
            try {
                const access =
                    await proAccessService.getCurrentAccess({
                        accountId:
                            authorization.accountId,
                    });
                verification =
                    verificationMetadata(access);
            } catch (error) {
                if (
                    error instanceof AccountProAccessError &&
                    Number(error.status || 500) >= 500
                ) {
                    // Standard/free debates remain available during a store
                    // verification outage, but this request is never granted
                    // Pro model or Pro-only Expanded access.
                    verification =
                        unavailableVerificationMetadata(error);
                } else {
                    throw error;
                }
            }

            client = await pool.connect();
            await client.query('BEGIN');

            const existingResult = await client.query(
                `
                SELECT *
                FROM ai_generation_jobs
                WHERE client_request_id = $1
                LIMIT 1
                `,
                [clientRequestId]
            );
            const existingJob =
                existingResult.rows[0];
            if (existingJob) {
                if (
                    existingJob.user_id &&
                    existingJob.user_id !== installationId
                ) {
                    fail(
                        'client_request_owner_conflict',
                        'This client request belongs to another installation.',
                        { status: 409 }
                    );
                }
                await client.query('COMMIT');
                client.release();
                client = null;
                return res.status(200).json({
                    success: true,
                    job: publicJob(existingJob),
                });
            }

            const accessDecision =
                await authorizeAIJobCreate(client, {
                    jobType,
                    userId: installationId,
                    debateId,
                    clientRequestId,
                    metadata: safeMetadata,
                    iosVersion: null,
                    iosBuild: null,
                    isVerifiedPro:
                        verification.serverVerifiedPro === true,
                });

            const result = await client.query(
                `
                INSERT INTO ai_generation_jobs (
                    client_request_id,
                    job_type,
                    debate_id,
                    user_id,
                    status,
                    payload,
                    metadata
                )
                VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6::jsonb)
                ON CONFLICT (client_request_id) DO NOTHING
                RETURNING *
                `,
                [
                    clientRequestId,
                    jobType,
                    debateId || null,
                    installationId,
                    JSON.stringify({
                        messages,
                        systemPrompt,
                    }),
                    JSON.stringify({
                        ...safeMetadata,

                        // All security-sensitive values below are generated by
                        // the backend and overwrite same-named client metadata.
                        serverVerifiedPro:
                            verification.serverVerifiedPro,
                        authenticatedAccountId:
                            authorization.accountId,
                        proVerificationReason:
                            verification.reason,
                        proVerificationEnvironment:
                            verification.environment,
                        proVerificationProductId:
                            verification.productId,
                        proVerificationExpiresDate:
                            verification.expiresDate,
                        proVerificationIsTrial:
                            verification.isTrial,
                        proVerificationOriginalTransactionId:
                            null,
                        proVerificationSource:
                            verification.source,
                        proVerificationErrorCode:
                            verification.verificationErrorCode || null,
                        analyticsAccessTier:
                            verification.analyticsAccessTier,
                        analyticsTierSource:
                            verification.analyticsTierSource,
                        expandedAgoraAccessReason:
                            accessDecision.reason,
                    }),
                ]
            );

            let job = result.rows[0];
            let responseStatus = 202;
            if (!job) {
                const conflict = await client.query(
                    `
                    SELECT *
                    FROM ai_generation_jobs
                    WHERE client_request_id = $1
                    LIMIT 1
                    `,
                    [clientRequestId]
                );
                job = conflict.rows[0];
                if (!job) {
                    throw new Error(
                        'AI job insert conflicted, but the existing job could not be loaded.'
                    );
                }
                if (
                    job.user_id &&
                    job.user_id !== installationId
                ) {
                    fail(
                        'client_request_owner_conflict',
                        'This client request belongs to another installation.',
                        { status: 409 }
                    );
                }
                responseStatus = 200;
            }

            await client.query('COMMIT');
            client.release();
            client = null;

            if (
                job.status === 'pending' ||
                job.status === 'failed'
            ) {
                const shouldProcessImmediately =
                    jobType !== 'debate_report_insight';
                if (shouldProcessImmediately) {
                    setImmediate(() => {
                        Promise.resolve(processJob(job.id))
                            .catch((error) => {
                                logger?.error?.(
                                    '[AccountAIJobs] Immediate processing failed.',
                                    error?.message || error
                                );
                            });
                    });
                }
            }

            return res.status(responseStatus).json({
                success: true,
                job: publicJob(job),
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch (rollbackError) {
                    logger?.error?.(
                        '[AccountAIJobs] Rollback failed.',
                        rollbackError?.message || rollbackError
                    );
                }
                client.release();
            }

            const response = publicError(error);
            if (response.status >= 500) {
                logger?.error?.(
                    '[AccountAIJobs] Create failed.',
                    {
                        code: error?.code || null,
                        message:
                            error?.message || String(error),
                    }
                );
            }
            return res
                .status(response.status)
                .json(response.body);
        }
    });

    return router;
}
