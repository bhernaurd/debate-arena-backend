import express from 'express';

import { processAIJob } from './aiJobs.js';
import {
    ExpandedAgoraAccessError,
    authorizeAIJobCreate,
} from './expandedAgoraAccess.js';
import { AccountAuthError } from './lib/accountAuthService.js';
import { AccountProAccessError } from './lib/accountProAccessService.js';

const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const ALLOWED_JOB_TYPES = new Set([
    'debate_opening',
    'debate_reply',
    'daily_opening',
    'daily_reply',
    'debate_report',
    'debate_report_insight',
]);

class AccountAIJobRouteError extends Error {
    constructor(code, message, {
        status = 400,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AccountAIJobRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAIJobRouteError(code, message, options);
}

function cleanString(value, maximum = 20_000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maximum);
}

function requireInstallationId(req, bodyUserId = null) {
    const headerValue = cleanString(req.get('X-Installation-ID'), 128);
    const bodyValue = cleanString(bodyUserId, 128);

    if (!headerValue || !USER_ID_RE.test(headerValue)) {
        fail(
            'invalid_installation_id',
            'A valid X-Installation-ID header is required.',
            { status: 400 }
        );
    }
    if (bodyValue && bodyValue !== headerValue) {
        fail(
            'installation_id_mismatch',
            'The installation ID header does not match the request body.',
            { status: 403 }
        );
    }
    return headerValue;
}

function requireBearerToken(req) {
    const authorization = req.get('Authorization');
    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_access_token',
            'A signed-in Agora account is required.',
            { status: 401 }
        );
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
        authorization.trim()
    );
    if (!match) {
        fail(
            'invalid_access_token',
            'The account session is invalid or expired.',
            { status: 401 }
        );
    }
    return match[1];
}

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
        .map((message) => ({
            role: message?.role === 'assistant' ? 'assistant' : 'user',
            content: cleanString(message?.content, 50_000),
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

function publicError(error) {
    if (error instanceof ExpandedAgoraAccessError) {
        return {
            status: Number(error.statusCode) || 403,
            body: {
                success: false,
                error: error.message,
                code: error.code || 'expanded_agora_locked',
                details: error.details || null,
            },
        };
    }

    if (
        error instanceof AccountAIJobRouteError ||
        error instanceof AccountAuthError ||
        error instanceof AccountProAccessError
    ) {
        const rawStatus = Number(error.status ?? error.statusCode ?? 500);
        const status = Number.isInteger(rawStatus) ? rawStatus : 500;
        if (status >= 500) {
            return {
                status: 503,
                body: {
                    success: false,
                    error: 'Account AI generation is temporarily unavailable.',
                    code: 'account_ai_job_unavailable',
                    retryable: true,
                },
            };
        }
        return {
            status,
            body: {
                success: false,
                error: error.message || 'The account AI job could not be created.',
                code: error.code || 'account_ai_job_failed',
                retryable: Boolean(error.retryable),
            },
        };
    }

    return {
        status: 503,
        body: {
            success: false,
            error: 'Account AI generation is temporarily unavailable.',
            code: 'account_ai_job_unavailable',
            retryable: true,
        },
    };
}

function entitlementMetadata(access) {
    const entitlement = access?.entitlement ?? null;
    const isPro = access?.hasProAccess === true;
    const source = entitlement?.environment === 'GooglePlay'
        ? 'google_play'
        : entitlement
            ? 'app_store'
            : 'none';

    return {
        serverVerifiedPro: isPro,
        testProBypass: false,
        proVerificationReason: isPro
            ? 'authenticated_account_entitlement'
            : 'authenticated_account_free',
        proVerificationEnvironment: entitlement?.environment ?? null,
        proVerificationProductId: entitlement?.productId ?? null,
        proVerificationExpiresDate:
            entitlement?.accessExpiresAt?.getTime?.() ?? null,
        proVerificationIsTrial: entitlement?.isTrial === true,
        proVerificationOriginalTransactionId: null,
        proVerificationSource: source,
        analyticsAccessTier: isPro
            ? (entitlement?.isTrial === true ? 'trial' : 'paid_pro')
            : 'free',
        analyticsTierSource: 'authenticated_account_entitlement',
    };
}

/**
 * Creates persistent AI jobs for signed-in Android clients. Authentication and
 * Pro status are resolved entirely from the Agora account session; client Pro
 * metadata and StoreKit proof are ignored on this route.
 */
export function createAccountAIJobRouter({
    pool,
    accountAuthService,
    proAccessService,
    logger = console,
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error('Account AI jobs require a PostgreSQL pool.');
    }
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error('Account AI jobs require account authentication.');
    }
    if (
        !proAccessService ||
        typeof proAccessService.getCurrentAccess !== 'function'
    ) {
        throw new Error('Account AI jobs require the Pro access service.');
    }

    const router = express.Router();

    router.post('/', async (req, res) => {
        let client = null;
        try {
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                ? req.body
                : {};
            const installationId = requireInstallationId(req, body.userId);
            const accessToken = requireBearerToken(req);
            const authorization = await accountAuthService.authorizeAccessToken({
                installationId,
                accessToken,
            });
            const accountAccess = await proAccessService.getCurrentAccess({
                accountId: authorization.accountId,
            });

            const clientRequestId = cleanString(body.clientRequestId, 200);
            const jobType = cleanString(body.jobType, 80);
            const debateId = cleanString(body.debateId, 200);
            const messages = normalizeMessages(body.messages);
            const systemPrompt = cleanString(body.systemPrompt, 50_000);
            const clientMetadata =
                body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
                    ? body.metadata
                    : {};

            if (!clientRequestId) {
                fail('invalid_ai_job', 'clientRequestId is required.', { status: 400 });
            }
            if (!ALLOWED_JOB_TYPES.has(jobType)) {
                fail('invalid_ai_job', `Invalid jobType: ${jobType}`, { status: 400 });
            }
            if (messages.length === 0) {
                fail('invalid_ai_job', 'messages are required.', { status: 400 });
            }

            const verifiedMetadata = entitlementMetadata(accountAccess);
            const safeMetadata = {
                ...clientMetadata,
                ...verifiedMetadata,
                authenticatedAccountId: authorization.accountId,
            };

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
            const existingJob = existingResult.rows[0];
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

            const accessDecision = await authorizeAIJobCreate(client, {
                jobType,
                userId: installationId,
                debateId,
                clientRequestId,
                metadata: safeMetadata,
                iosVersion: null,
                iosBuild: null,
                isVerifiedPro: accountAccess.hasProAccess === true,
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
                    JSON.stringify({ messages, systemPrompt }),
                    JSON.stringify({
                        ...safeMetadata,
                        expandedAgoraAccessReason: accessDecision.reason,
                    }),
                ]
            );

            let job = result.rows[0];
            let responseStatus = 202;
            if (!job) {
                const conflictResult = await client.query(
                    `
                    SELECT *
                    FROM ai_generation_jobs
                    WHERE client_request_id = $1
                    LIMIT 1
                    `,
                    [clientRequestId]
                );
                job = conflictResult.rows[0];
                if (!job) {
                    throw new Error(
                        'AI job insert conflicted, but the existing job could not be loaded.'
                    );
                }
                if (job.user_id && job.user_id !== installationId) {
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

            if (job.status === 'pending' || job.status === 'failed') {
                const shouldProcessImmediately =
                    jobType !== 'debate_report_insight';
                if (shouldProcessImmediately) {
                    setImmediate(() => {
                        processAIJob(job.id).catch((error) => {
                            logger?.error?.(
                                '[AccountAIJobs] Immediate processing error.',
                                {
                                    jobId: job.id,
                                    error: error?.message || String(error),
                                }
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
                } catch {
                    // Preserve the original failure.
                }
                client.release();
            }

            const response = publicError(error);
            if (response.status >= 500) {
                logger?.error?.('[AccountAIJobs] Request failed.', {
                    errorCode: error?.code || 'unknown_error',
                });
            }
            return res.status(response.status).json(response.body);
        }
    });

    return router;
}
