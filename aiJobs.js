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

import express from 'express';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const router = express.Router();
const { Pool } = pg;

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

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
// If your current backend uses a different Claude model, change it here.
const DEFAULT_CLAUDE_MODEL =
    process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

const MODEL_BY_JOB_TYPE = {
    debate_opening: DEFAULT_CLAUDE_MODEL,
    debate_reply: DEFAULT_CLAUDE_MODEL,
    daily_opening: DEFAULT_CLAUDE_MODEL,
    daily_reply: DEFAULT_CLAUDE_MODEL,
    debate_report: DEFAULT_CLAUDE_MODEL,
};

const MAX_TOKENS_BY_JOB_TYPE = {
    debate_opening: 900,
    debate_reply: 900,
    daily_opening: 900,
    daily_reply: 900,
    debate_report: 2200,
};

const TEMPERATURE_BY_JOB_TYPE = {
    debate_opening: 0.7,
    debate_reply: 0.7,
    daily_opening: 0.7,
    daily_reply: 0.7,
    debate_report: 0.25,
};

const ALLOWED_JOB_TYPES = new Set(Object.keys(MODEL_BY_JOB_TYPE));

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

    const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages,
    });

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
            // claimedJob.attempts is already incremented by the UPDATE ... RETURNING above.
            const currentAttempts = Number(claimedJob.attempts || 0);
            const maxAttempts = Number(claimedJob.max_attempts || 3);
            const shouldFinalFail = currentAttempts >= maxAttempts;

            await pool.query(
                `
                UPDATE ai_generation_jobs
                SET
                    status = $2,
                    error_message = $3,
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
        // Recover jobs that got stuck as processing because the server restarted.
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
            ORDER BY created_at ASC
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
            setImmediate(() => {
                processAIJob(job.id).catch((err) => {
                    console.error(
                        '[AIJobs] Immediate processing error:',
                        err.message
                    );
                });
            });
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
