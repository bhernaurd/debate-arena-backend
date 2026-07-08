// aiJobs.js
// Persistent AI generation jobs for The Agora.
//
// This lets philosopher replies, opening messages, Daily Challenge replies,
// and Debate Reports keep generating on the backend even if the iOS app
// switches tabs, backgrounds, locks, or gets suspended.
//
// Endpoints:
// POST /api/ai-jobs
// GET  /api/ai-jobs/:jobId
// GET  /api/ai-jobs/client/:clientRequestId
// POST /api/ai-jobs/:jobId/retry
//
// This version keeps the existing persistent job system, but bypasses the
// Anthropic SDK/fetch layer for Claude calls because Railway is currently
// failing with:
// "Invalid response body while trying to fetch ... Premature close"

import express from 'express';
import pg from 'pg';
import https from 'https';

const router = express.Router();
const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

pool.on('error', (err) => {
    console.error('[AIJobs] Postgres pool error:', err.message);
});

// Keep this model consistent with the rest of your backend.
const DEFAULT_CLAUDE_MODEL =
    process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

const ANTHROPIC_VERSION =
    process.env.ANTHROPIC_VERSION || '2023-06-01';

const MODEL_BY_JOB_TYPE = {
    debate_opening: DEFAULT_CLAUDE_MODEL,
    debate_reply: DEFAULT_CLAUDE_MODEL,
    daily_opening: DEFAULT_CLAUDE_MODEL,
    daily_reply: DEFAULT_CLAUDE_MODEL,
    debate_report: DEFAULT_CLAUDE_MODEL,
    debate_report_insight: DEFAULT_CLAUDE_MODEL,
};

const MAX_TOKENS_BY_JOB_TYPE = {
    debate_opening: 900,
    debate_reply: 900,
    daily_opening: 900,
    daily_reply: 900,
    debate_report: 2200,
    debate_report_insight: 850,
};

const TEMPERATURE_BY_JOB_TYPE = {
    debate_opening: 0.7,
    debate_reply: 0.7,
    daily_opening: 0.7,
    daily_reply: 0.7,
    debate_report: 0.25,
    debate_report_insight: 0.25,
};

const ALLOWED_JOB_TYPES = new Set(Object.keys(MODEL_BY_JOB_TYPE));

// MARK: - Helpers

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanString(value, maxLength = 20000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];

    return messages
        .map((message) => {
            const role = message?.role === 'assistant' ? 'assistant' : 'user';
            const content = cleanString(message?.content, 50000);

            return {
                role,
                content,
            };
        })
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

function isRateLimitAnthropicError(err) {
    const statusCode = Number(err?.statusCode || err?.status || 0);
    const type = String(err?.type || '').toLowerCase();
    const message = String(err?.message || err || '').toLowerCase();

    return (
        statusCode === 429 ||
        type.includes('rate_limit') ||
        message.includes('rate limited') ||
        message.includes('rate limit') ||
        message.includes('rate_limit') ||
        message.includes('too many requests') ||
        message.includes('type 2a')
    );
}

function isRetryableAnthropicError(err) {
    const statusCode = Number(err?.statusCode || err?.status || 0);
    const message = String(err?.message || err || '').toLowerCase();

    return (
        isRateLimitAnthropicError(err) ||
        statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 500 ||
        statusCode === 502 ||
        statusCode === 503 ||
        statusCode === 504 ||
        statusCode === 529 ||
        message.includes('premature close') ||
        message.includes('socket hang up') ||
        message.includes('network') ||
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('fetch failed') ||
        message.includes('econnreset') ||
        message.includes('etimedout') ||
        message.includes('empty response') ||
        message.includes('503') ||
        message.includes('529') ||
        message.includes('overloaded')
    );
}

function retryAfterMsFromResponse(res) {
    const rawRetryAfter = res?.headers?.['retry-after'];

    if (!rawRetryAfter) {
        return null;
    }

    const seconds = Number(rawRetryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 45_000);
    }

    const dateMs = Date.parse(rawRetryAfter);

    if (Number.isFinite(dateMs)) {
        return Math.min(Math.max(dateMs - Date.now(), 0), 45_000);
    }

    return null;
}

function retryDelayMs(err, attempt) {
    const retryAfterMs = Number(err?.retryAfterMs);

    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(retryAfterMs, 45_000);
    }

    const jitterMs = Math.floor(Math.random() * 350);

    if (isRateLimitAnthropicError(err)) {
        const rateLimitBackoffMs = [2_500, 5_000, 10_000, 20_000, 35_000];
        return rateLimitBackoffMs[Math.min(attempt - 1, rateLimitBackoffMs.length - 1)] + jitterMs;
    }

    return Math.min(1_000 * attempt, 5_000) + jitterMs;
}

function anthropicErrorFromResponse(parsed, statusCode, retryAfterMs) {
    const message =
        parsed?.error?.message ||
        parsed?.message ||
        `Anthropic request failed with status ${statusCode}`;

    const err = new Error(message);

    err.statusCode = statusCode;
    err.type = parsed?.error?.type || parsed?.type || null;
    err.retryAfterMs = retryAfterMs;

    return err;
}

// MARK: - Raw Anthropic HTTPS client

function callAnthropicMessagesRaw(payload, label = 'ai job') {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;

        if (!apiKey) {
            reject(new Error('Missing ANTHROPIC_API_KEY'));
            return;
        }

        const body = JSON.stringify(payload);

        const options = {
            hostname: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
                'Content-Length': Buffer.byteLength(body),
                'Connection': 'close',
            },
            timeout: 90_000,
            agent: new https.Agent({
                keepAlive: false,
                maxSockets: 1,
            }),
        };

        const req = https.request(options, (res) => {
            let raw = '';

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                raw += chunk;
            });

            res.on('end', () => {
                const statusCode = res.statusCode || 0;

                if (!raw || raw.trim().length === 0) {
                    reject(new Error(`Anthropic empty response body. Status ${statusCode}`));
                    return;
                }

                let parsed;

                try {
                    parsed = JSON.parse(raw);
                } catch {
                    reject(
                        new Error(
                            `Anthropic returned non-JSON response. Status ${statusCode}. Body: ${raw.slice(0, 300)}`
                        )
                    );
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    reject(
                        anthropicErrorFromResponse(
                            parsed,
                            statusCode,
                            retryAfterMsFromResponse(res)
                        )
                    );
                    return;
                }

                resolve(parsed);
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`Anthropic request timed out for ${label}`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        req.write(body);
        req.end();
    });
}

async function createClaudeMessageWithRetry(args, label = 'ai job') {
    let lastError;
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await callAnthropicMessagesRaw(args, label);
        } catch (err) {
            lastError = err;

            const retryable = isRetryableAnthropicError(err);
            const delayMs = retryDelayMs(err, attempt);

            console.error(
                `[AIJobs] Claude ${label} attempt ${attempt}/${maxAttempts} failed:`,
                err?.message || err
            );

            if (!retryable || attempt === maxAttempts) {
                throw err;
            }

            console.warn(
                `[AIJobs] Retrying ${label} in ${Math.round(delayMs / 1000)}s...`
            );

            await sleep(delayMs);
        }
    }

    throw lastError;
}

// MARK: - Claude job call

async function callClaudeForJob(job) {
    const payload = job.payload || {};

    const messages = normalizeMessages(payload.messages);
    const systemPrompt = cleanString(payload.systemPrompt, 50000);

    if (messages.length === 0) {
        throw new Error('No messages supplied for AI job.');
    }

    const model = MODEL_BY_JOB_TYPE[job.job_type] || DEFAULT_CLAUDE_MODEL;
    const maxTokens = MAX_TOKENS_BY_JOB_TYPE[job.job_type] || 900;
    const temperature = TEMPERATURE_BY_JOB_TYPE[job.job_type] ?? 0.7;

    const response = await createClaudeMessageWithRetry(
        {
            model,
            max_tokens: maxTokens,
            temperature,
            system: systemPrompt,
            messages,
        },
        `${job.job_type} ${job.id} using ${model}`
    );

    const text = (response.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();

    if (!text) {
        throw new Error('Claude returned an empty response.');
    }

    return text;
}

export async function processAIJob(jobId) {
    let claimedJob = null;

    try {
        const claimResult = await pool.query(
            `
            UPDATE ai_generation_jobs
            SET
                status = 'processing',
                attempts = attempts + 1,
                processing_started_at = NOW(),
                error_message = NULL,
                failed_at = NULL
            WHERE id = $1
              AND status IN ('pending', 'failed')
              AND attempts < max_attempts
            RETURNING *
            `,
            [jobId]
        );

        claimedJob = claimResult.rows[0];

        if (!claimedJob) {
            return null;
        }

        console.log(
            `[AIJobs] Processing ${claimedJob.job_type}: ${claimedJob.id}`
        );

        const resultText = await callClaudeForJob(claimedJob);

        const completeResult = await pool.query(
            `
            UPDATE ai_generation_jobs
            SET
                status = 'completed',
                result_text = $2,
                error_message = NULL,
                completed_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [claimedJob.id, resultText]
        );

        console.log(
            `[AIJobs] Completed ${claimedJob.job_type}: ${claimedJob.id}`
        );

        return publicJob(completeResult.rows[0]);
    } catch (err) {
        const message = err?.message || 'Unknown AI job error';

        console.error(`[AIJobs] Job failed ${jobId}:`, message);

        if (claimedJob?.id) {
            const currentAttempts = Number(claimedJob.attempts || 0);
            const maxAttempts = Number(claimedJob.max_attempts || 3);
            const shouldFinalFail = currentAttempts >= maxAttempts;

            await pool.query(
                `
                UPDATE ai_generation_jobs
                SET
                    status = $2,
                    error_message = $3,
                    processing_started_at = NULL,
                    failed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE failed_at END
                WHERE id = $1
                `,
                [
                    claimedJob.id,
                    shouldFinalFail ? 'failed' : 'pending',
                    message,
                ]
            );
        }

        return null;
    }
}

export async function processQueuedAIJobs(limit = 3) {
    try {
        await pool.query(
            `
            UPDATE ai_generation_jobs
            SET
                status = 'pending',
                processing_started_at = NULL,
                error_message = 'Recovered stale processing job.'
            WHERE status = 'processing'
              AND processing_started_at < NOW() - INTERVAL '3 minutes'
              AND attempts < max_attempts
            `
        );

        const result = await pool.query(
            `
            SELECT id
            FROM ai_generation_jobs
            WHERE status = 'pending'
              AND attempts < max_attempts
            ORDER BY
                CASE
                    WHEN job_type IN ('debate_opening', 'debate_reply', 'daily_opening', 'daily_reply') THEN 0
                    WHEN job_type = 'debate_report' THEN 1
                    WHEN job_type = 'debate_report_insight' THEN 2
                    ELSE 3
                END ASC,
                created_at ASC
            LIMIT $1
            `,
            [limit]
        );

        for (const row of result.rows) {
            processAIJob(row.id).catch((err) => {
                console.error(
                    '[AIJobs] Background processor error:',
                    err.message
                );
            });
        }

        return result.rows.length;
    } catch (err) {
        console.error('[AIJobs] Queue processor error:', err.message);
        return 0;
    }
}

// MARK: - Create or resume AI job

router.post('/api/ai-jobs', async (req, res) => {
    try {
        const {
            clientRequestId,
            jobType,
            debateId,
            userId,
            messages,
            systemPrompt,
            metadata,
        } = req.body || {};

        const cleanClientRequestId = cleanString(clientRequestId, 200);
        const cleanJobType = cleanString(jobType, 80);
        const cleanDebateId = cleanString(debateId, 200);
        const cleanUserId = cleanString(userId, 200);
        const normalizedMessages = normalizeMessages(messages);
        const cleanSystemPrompt = cleanString(systemPrompt, 50000);

        if (!cleanClientRequestId) {
            return res.status(400).json({
                success: false,
                error: 'clientRequestId is required.',
            });
        }

        if (!ALLOWED_JOB_TYPES.has(cleanJobType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid jobType: ${cleanJobType}`,
            });
        }

        if (normalizedMessages.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'messages are required.',
            });
        }

        const payload = {
            messages: normalizedMessages,
            systemPrompt: cleanSystemPrompt,
        };

        const safeMetadata =
            metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                ? metadata
                : {};

        const result = await pool.query(
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
            ON CONFLICT (client_request_id)
            DO UPDATE SET
                metadata = ai_generation_jobs.metadata || EXCLUDED.metadata
            RETURNING *
            `,
            [
                cleanClientRequestId,
                cleanJobType,
                cleanDebateId || null,
                cleanUserId || null,
                JSON.stringify(payload),
                JSON.stringify(safeMetadata),
            ]
        );

        const job = result.rows[0];

        if (job.status === 'pending' || job.status === 'failed') {
            const shouldProcessImmediately = cleanJobType !== 'debate_report_insight';

            if (shouldProcessImmediately) {
                setImmediate(() => {
                    processAIJob(job.id).catch((err) => {
                        console.error(
                            '[AIJobs] Immediate processing error:',
                            err.message
                        );
                    });
                });
            } else {
                console.log(
                    `[AIJobs] Queued low-priority insight job: ${job.id}`
                );
            }
        }

        return res.status(202).json({
            success: true,
            job: publicJob(job),
        });
    } catch (err) {
        console.error('[AIJobs] Create job error:', err.message);

        return res.status(500).json({
            success: false,
            error: 'Failed to create AI job.',
        });
    }
});

// MARK: - Fetch AI job by backend job id

router.get('/api/ai-jobs/:jobId', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM ai_generation_jobs
            WHERE id = $1
            LIMIT 1
            `,
            [req.params.jobId]
        );

        const job = result.rows[0];

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'AI job not found.',
            });
        }

        return res.json({
            success: true,
            job: publicJob(job),
        });
    } catch (err) {
        console.error('[AIJobs] Get job error:', err.message);

        return res.status(500).json({
            success: false,
            error: 'Failed to fetch AI job.',
        });
    }
});

// MARK: - Fetch AI job by iOS client request id

router.get('/api/ai-jobs/client/:clientRequestId', async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT *
            FROM ai_generation_jobs
            WHERE client_request_id = $1
            LIMIT 1
            `,
            [req.params.clientRequestId]
        );

        const job = result.rows[0];

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'AI job not found.',
            });
        }

        return res.json({
            success: true,
            job: publicJob(job),
        });
    } catch (err) {
        console.error('[AIJobs] Get job by client id error:', err.message);

        return res.status(500).json({
            success: false,
            error: 'Failed to fetch AI job.',
        });
    }
});

// MARK: - Retry failed AI job

router.post('/api/ai-jobs/:jobId/retry', async (req, res) => {
    try {
        const result = await pool.query(
            `
            UPDATE ai_generation_jobs
            SET
                status = 'pending',
                attempts = 0,
                error_message = NULL,
                failed_at = NULL,
                processing_started_at = NULL
            WHERE id = $1
              AND status = 'failed'
            RETURNING *
            `,
            [req.params.jobId]
        );

        const job = result.rows[0];

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'Failed job not found.',
            });
        }

        setImmediate(() => {
            processAIJob(job.id).catch((err) => {
                console.error('[AIJobs] Retry processing error:', err.message);
            });
        });

        return res.json({
            success: true,
            job: publicJob(job),
        });
    } catch (err) {
        console.error('[AIJobs] Retry job error:', err.message);

        return res.status(500).json({
            success: false,
            error: 'Failed to retry AI job.',
        });
    }
});

export default router;
