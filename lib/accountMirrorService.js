import crypto from 'node:crypto';

import {
    MIRROR_ANALYSIS_PROMPT_VERSION,
    MIRROR_ARCHETYPE_VERSION,
    MIRROR_CONTEXT_BUCKETS,
    MIRROR_DIMENSIONS,
    MIRROR_EVIDENCE_ENGINE_VERSION,
    MIRROR_EXTRACTOR_VERSION,
    MIRROR_POLES,
    MIRROR_QUESTIONS,
    MIRROR_QUESTIONNAIRE_VERSION,
    MIRROR_QUESTION_IDS,
    calculateDebateAdjustments,
    evidenceBreadthSummary,
    finalMirrorScores,
    matchMirrorArchetypes,
    meaningfulChangeBand,
    questionnaireScores,
} from './mirrorScoring.js';
import { createMirrorAnthropicService } from './mirrorAnthropicService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const EVIDENCE_CONFIDENCE_THRESHOLD = 0.80;
const EVIDENCE_MAX_ATTEMPTS = 3;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
const RESPONSE_LABELS = Object.freeze({
    1: 'Strongly disagree',
    2: 'Disagree',
    3: 'Neutral',
    4: 'Agree',
    5: 'Strongly agree',
});

export class AccountMirrorError extends Error {
    constructor(code, message, { status = 500, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AccountMirrorError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountMirrorError(code, message, options);
}

function cleanString(value, maximum = 10_000) {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function requireUuid(value, fieldName) {
    const clean = cleanString(value, 64).toLowerCase();
    if (!UUID_RE.test(clean)) {
        fail('invalid_mirror_input', `${fieldName} must be a UUID.`, { status: 400 });
    }
    return clean;
}

function asDate(value) {
    if (value instanceof Date) return value;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid Mirror date.');
    return date;
}

function toIso(value) {
    return value == null ? null : asDate(value).toISOString();
}

function shuffleQuestionIds() {
    const items = [...MIRROR_QUESTION_IDS];
    for (let index = items.length - 1; index > 0; index -= 1) {
        const swap = crypto.randomInt(0, index + 1);
        [items[index], items[swap]] = [items[swap], items[index]];
    }
    return items;
}

function rowValue(row, snake, camel) {
    if (!row) return undefined;
    return Object.prototype.hasOwnProperty.call(row, snake) ? row[snake] : row[camel];
}

function parseJson(value, fallback) {
    if (value == null) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function cycleFromRow(row) {
    if (!row) return null;
    return {
        id: String(row.id),
        accountId: String(row.account_id),
        cycleNumber: Number(row.cycle_number),
        status: row.status,
        previousCycleId: row.previous_cycle_id ? String(row.previous_cycle_id) : null,
        windowStartedAt: row.window_started_at ? asDate(row.window_started_at) : null,
        questionnaireEligibleAt: asDate(row.questionnaire_eligible_at),
        questionnaireStartedAt: row.questionnaire_started_at ? asDate(row.questionnaire_started_at) : null,
        questionnaireCompletedAt: row.questionnaire_completed_at ? asDate(row.questionnaire_completed_at) : null,
        questionOrder: parseJson(row.question_order, []),
        testEligibleOverride: row.test_eligible_override === true,
        failureCode: row.failure_code || null,
        failureMessage: row.failure_message || null,
        createdAt: asDate(row.created_at),
        updatedAt: asDate(row.updated_at),
    };
}

function cycleEligibleNow(cycle, now = new Date()) {
    if (!cycle) return false;
    if (cycle.cycleNumber === 1) return true;
    return cycle.testEligibleOverride || now.getTime() >= cycle.questionnaireEligibleAt.getTime();
}

function testAllowlist() {
    const accounts = new Set(
        cleanString(process.env.MIRROR_TEST_ACCOUNT_IDS || '', 100_000)
            .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
    );
    const installations = new Set(
        cleanString(process.env.MIRROR_TEST_INSTALLATION_IDS || '', 100_000)
            .split(',').map((value) => value.trim()).filter(Boolean)
    );
    const enabled = ['true', '1', 'yes', 'on'].includes(
        cleanString(process.env.MIRROR_TEST_MODE_ENABLED || 'false', 20).toLowerCase()
    );
    return { enabled, accounts, installations };
}

function isTestAllowed(accountId, installationId) {
    const config = testAllowlist();
    if (!config.enabled) return false;
    return config.accounts.has(String(accountId).toLowerCase()) ||
        config.installations.has(String(installationId));
}

function validPole(dimension, pole) {
    const poles = MIRROR_POLES[dimension];
    return Boolean(poles && (pole === poles.left || pole === poles.right));
}

function exactExcerptInMessage(message, excerpt) {
    const text = typeof message?.content === 'string' ? message.content : '';
    return Boolean(excerpt && text.includes(excerpt));
}

function sanitizeError(error) {
    return cleanString(error?.message || 'Unknown Mirror error.', 800);
}

function sourceTypeForRow(row) {
    if (row.ranked_debate_id) return 'ranked';
    if (row.is_daily_challenge === true) return 'daily_challenge';
    return 'normal';
}

function snapshotSummaryFromRow(row) {
    if (!row) return null;
    return {
        id: String(row.id),
        cycleId: String(row.cycle_id),
        cycleNumber: Number(row.cycle_number),
        primaryArchetypeId: row.primary_archetype_id,
        primaryArchetypeName: row.primary_archetype_name,
        primaryFit: Number(row.primary_fit),
        secondaryArchetypeId: row.secondary_archetype_id,
        secondaryArchetypeName: row.secondary_archetype_name,
        secondaryFit: Number(row.secondary_fit),
        blendStatus: row.blend_status,
        generatedAt: asDate(row.generated_at),
    };
}

export function createAccountMirrorService({
    pool,
    accountAuthService,
    proAccessService,
    anthropicService = null,
    now = () => Date.now(),
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error('A PostgreSQL pool is required for The Mirror.');
    }
    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
        throw new Error('A valid account auth service is required for The Mirror.');
    }
    if (!proAccessService || typeof proAccessService.getCurrentAccess !== 'function') {
        throw new Error('A valid Pro-access service is required for The Mirror.');
    }

    const mirrorAI = anthropicService ?? createMirrorAnthropicService({ pool });
    const generationLocks = new Map();
    const evidenceLocks = new Map();

    async function authorize({ installationId, accessToken }) {
        try {
            return await accountAuthService.authorizeAccessToken({ installationId, accessToken });
        } catch (error) {
            fail(error?.code || 'mirror_authentication_failed', error?.message || 'Authentication failed.', {
                status: Number.isInteger(error?.status) ? error.status : 401,
                retryable: Boolean(error?.retryable),
                cause: error,
            });
        }
    }

    async function currentPro(accountId) {
        try {
            return await proAccessService.getCurrentAccess({ accountId });
        } catch (error) {
            fail('mirror_pro_access_unavailable', 'Pro access could not be verified.', {
                status: 503, retryable: true, cause: error,
            });
        }
    }

    async function requirePro(accountId) {
        const access = await currentPro(accountId);
        if (!access.hasProAccess) {
            fail('mirror_pro_required', 'Agora Pro is required to use The Mirror.', {
                status: 403, retryable: false,
            });
        }
        return access;
    }

    async function withTransaction(work) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await work(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            try { await client.query('ROLLBACK'); } catch {}
            throw error;
        } finally {
            client.release();
        }
    }

    async function findCurrentCycle(accountId, target = pool) {
        const result = await target.query(
            `SELECT * FROM account_mirror_cycles
             WHERE account_id = $1 AND status <> 'completed'
             ORDER BY cycle_number DESC LIMIT 1`,
            [accountId]
        );
        return cycleFromRow(result.rows[0]);
    }

    async function latestCompletedCycle(accountId, target = pool) {
        const result = await target.query(
            `SELECT * FROM account_mirror_cycles
             WHERE account_id = $1 AND status = 'completed'
             ORDER BY cycle_number DESC LIMIT 1`,
            [accountId]
        );
        return cycleFromRow(result.rows[0]);
    }

    async function createCycle(target, {
        accountId,
        cycleNumber,
        previousCycleId = null,
        windowStartedAt = null,
        eligibleAt,
    }) {
        const result = await target.query(
            `
            INSERT INTO account_mirror_cycles (
                account_id, cycle_number, previous_cycle_id,
                window_started_at, questionnaire_eligible_at,
                questionnaire_version, archetype_model_version,
                evidence_engine_version, extractor_version,
                analysis_prompt_version, question_order
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
            ON CONFLICT (account_id, cycle_number) DO NOTHING
            RETURNING *
            `,
            [
                accountId, cycleNumber, previousCycleId, windowStartedAt, eligibleAt,
                MIRROR_QUESTIONNAIRE_VERSION, MIRROR_ARCHETYPE_VERSION,
                MIRROR_EVIDENCE_ENGINE_VERSION, MIRROR_EXTRACTOR_VERSION,
                MIRROR_ANALYSIS_PROMPT_VERSION, JSON.stringify(shuffleQuestionIds()),
            ]
        );
        if (result.rows[0]) return cycleFromRow(result.rows[0]);
        const existing = await target.query(
            `SELECT * FROM account_mirror_cycles WHERE account_id=$1 AND cycle_number=$2`,
            [accountId, cycleNumber]
        );
        return cycleFromRow(existing.rows[0]);
    }

    async function bootstrapStartingCycle(accountId) {
        const current = await findCurrentCycle(accountId);
        if (current) return current;
        const completed = await latestCompletedCycle(accountId);
        if (completed) {
            // Defensive recovery if a prior snapshot completed but next cycle was not created.
            const start = completed.questionnaireCompletedAt || completed.updatedAt;
            return withTransaction((tx) => createCycle(tx, {
                accountId,
                cycleNumber: completed.cycleNumber + 1,
                previousCycleId: completed.id,
                windowStartedAt: start,
                eligibleAt: new Date(start.getTime() + THIRTY_DAYS_MS),
            }));
        }
        const nowDate = new Date(now());
        return withTransaction((tx) => createCycle(tx, {
            accountId,
            cycleNumber: 1,
            windowStartedAt: null,
            eligibleAt: nowDate,
        }));
    }

    async function answerRows(cycleId) {
        const result = await pool.query(
            `SELECT question_id, answer_value, answered_at, updated_at
             FROM account_mirror_questionnaire_answers
             WHERE cycle_id=$1 ORDER BY question_id`,
            [cycleId]
        );
        return result.rows.map((row) => ({
            questionId: row.question_id,
            answerValue: Number(row.answer_value),
            answeredAt: asDate(row.answered_at),
            updatedAt: asDate(row.updated_at),
        }));
    }

    async function evidenceSummary(cycleId) {
        const result = await pool.query(
            `
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status='accepted')::int AS accepted,
                COUNT(*) FILTER (WHERE status='no_evidence')::int AS no_evidence,
                COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                COUNT(*) FILTER (WHERE status='processing')::int AS processing,
                COUNT(*) FILTER (WHERE status='failed')::int AS failed,
                COUNT(*) FILTER (WHERE source_type='normal')::int AS normal_count,
                COUNT(*) FILTER (WHERE source_type='ranked')::int AS ranked_count,
                COUNT(*) FILTER (WHERE source_type='daily_challenge')::int AS daily_count
            FROM account_mirror_debate_evidence
            WHERE cycle_id=$1
            `,
            [cycleId]
        );
        const row = result.rows[0] || {};
        const breadthResult = await pool.query(
            `SELECT COUNT(DISTINCT dimension)::int AS dimensions
             FROM account_mirror_evidence_signals s
             JOIN account_mirror_debate_evidence e ON e.id=s.evidence_id
             WHERE e.cycle_id=$1 AND s.validated=TRUE AND s.excluded_by_user=FALSE`,
            [cycleId]
        );
        return {
            total: Number(row.total || 0),
            accepted: Number(row.accepted || 0),
            noEvidence: Number(row.no_evidence || 0),
            pending: Number(row.pending || 0),
            processing: Number(row.processing || 0),
            failed: Number(row.failed || 0),
            normalCount: Number(row.normal_count || 0),
            rankedCount: Number(row.ranked_count || 0),
            dailyChallengeCount: Number(row.daily_count || 0),
            exploredDimensionCount: Number(breadthResult.rows[0]?.dimensions || 0),
        };
    }

    async function latestSnapshot(accountId) {
        const result = await pool.query(
            `SELECT * FROM account_mirror_snapshots WHERE account_id=$1 ORDER BY cycle_number DESC LIMIT 1`,
            [accountId]
        );
        return result.rows[0] || null;
    }

    async function dimensionResults(cycleId) {
        const result = await pool.query(
            `SELECT * FROM account_mirror_dimension_results WHERE cycle_id=$1`,
            [cycleId]
        );
        return result.rows.map((row) => ({
            dimension: row.dimension,
            questionnaireScore: Number(row.questionnaire_score),
            debateAdjustment: Number(row.debate_adjustment),
            finalScore: Number(row.final_score),
            evidenceStrength: Number(row.evidence_strength),
            evidenceConsistency: Number(row.evidence_consistency),
            evidenceBreadth: Number(row.evidence_breadth),
            previousFinalScore: row.previous_final_score == null ? null : Number(row.previous_final_score),
            changeFromPrevious: row.change_from_previous == null ? null : Number(row.change_from_previous),
        }));
    }

    async function serializeSnapshot(row, { includeAnalysis = true } = {}) {
        if (!row) return null;
        const dimensions = await dimensionResults(row.cycle_id);
        return {
            ...snapshotSummaryFromRow(row),
            dimensions,
            analysis: includeAnalysis ? parseJson(row.analysis_json, {}) : undefined,
            sonnetModel: includeAnalysis ? row.sonnet_model : undefined,
        };
    }

    async function listHistoryRows(accountId, limit = 50) {
        const result = await pool.query(
            `SELECT * FROM account_mirror_snapshots WHERE account_id=$1 ORDER BY cycle_number DESC LIMIT $2`,
            [accountId, Math.max(1, Math.min(100, Number(limit) || 50))]
        );
        return result.rows;
    }

    async function getState({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        const accountId = auth.accountId;
        const access = await currentPro(accountId);

        let current = await findCurrentCycle(accountId);
        if (!current && access.hasProAccess) {
            current = await bootstrapStartingCycle(accountId);
        }

        if (current && current.cycleNumber > 1 && access.hasProAccess) {
            void handleDebateHistorySync({ accountId }).catch((error) => {
                console.error('[Mirror] Background evidence sync failed:', sanitizeError(error));
            });
        }

        if (current && ['evidence_finalizing', 'analysis_generating'].includes(current.status) && access.hasProAccess) {
            void kickGeneration({ accountId, cycleId: current.id, installationId }).catch((error) => {
                console.error('[Mirror] Background generation resume failed:', sanitizeError(error));
            });
        }

        const answers = current ? await answerRows(current.id) : [];
        const evidence = current ? await evidenceSummary(current.id) : null;
        const latest = await latestSnapshot(accountId);
        const history = await listHistoryRows(accountId, 24);

        return {
            schemaVersion: 1,
            accountId,
            installationId,
            hasProAccess: access.hasProAccess === true,
            testModeAvailable: isTestAllowed(accountId, installationId),
            currentCycle: current ? {
                ...current,
                eligibleNow: cycleEligibleNow(current, new Date(now())),
                answeredCount: answers.length,
                totalQuestions: MIRROR_QUESTION_IDS.length,
                answers,
                evidence,
            } : null,
            currentSnapshot: latest ? await serializeSnapshot(latest) : null,
            history: history.map(snapshotSummaryFromRow),
        };
    }

    async function saveAnswer({ installationId, accessToken, questionId, answerValue }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        const id = cleanString(questionId, 80);
        const value = Number(answerValue);
        if (!MIRROR_QUESTION_IDS.includes(id) || !Number.isInteger(value) || value < 1 || value > 5) {
            fail('invalid_mirror_answer', 'The Mirror answer is invalid.', { status: 400 });
        }

        const cycle = await bootstrapStartingCycle(auth.accountId);
        if (!cycleEligibleNow(cycle, new Date(now()))) {
            fail('mirror_questionnaire_not_ready', 'Your next Mirror is not available yet.', { status: 409 });
        }
        if (cycle.questionnaireCompletedAt) {
            fail('mirror_questionnaire_sealed', 'This Mirror questionnaire has already been completed.', { status: 409 });
        }

        const timestamp = new Date(now());
        await withTransaction(async (tx) => {
            await tx.query(
                `UPDATE account_mirror_cycles
                 SET questionnaire_started_at=COALESCE(questionnaire_started_at,$2),
                     status='questionnaire_in_progress', updated_at=$2
                 WHERE id=$1 AND questionnaire_completed_at IS NULL`,
                [cycle.id, timestamp]
            );
            await tx.query(
                `INSERT INTO account_mirror_questionnaire_answers (
                    cycle_id, question_id, answer_value, answered_at, updated_at
                 ) VALUES ($1,$2,$3,$4,$4)
                 ON CONFLICT (cycle_id, question_id) DO UPDATE SET
                    answer_value=EXCLUDED.answer_value,
                    updated_at=EXCLUDED.updated_at`,
                [cycle.id, id, value, timestamp]
            );
        });

        return { cycleId: cycle.id, questionId: id, answerValue: value, savedAt: timestamp };
    }

    async function submitQuestionnaire({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        const cycle = await bootstrapStartingCycle(auth.accountId);
        if (!cycleEligibleNow(cycle, new Date(now()))) {
            fail('mirror_questionnaire_not_ready', 'Your next Mirror is not available yet.', { status: 409 });
        }

        const answers = await answerRows(cycle.id);
        if (answers.length !== MIRROR_QUESTION_IDS.length) {
            fail('mirror_questionnaire_incomplete', `Answer all ${MIRROR_QUESTION_IDS.length} questions before completing your Mirror.`, { status: 409 });
        }

        if (!cycle.questionnaireCompletedAt) {
            const completedAt = new Date(now());
            await pool.query(
                `UPDATE account_mirror_cycles
                 SET questionnaire_completed_at=$2,
                     status='evidence_finalizing',
                     test_eligible_override=FALSE,
                     updated_at=$2,
                     failure_code=NULL,
                     failure_message=NULL,
                     failed_at=NULL
                 WHERE id=$1 AND questionnaire_completed_at IS NULL`,
                [cycle.id, completedAt]
            );
        }

        void kickGeneration({ accountId: auth.accountId, cycleId: cycle.id, installationId }).catch((error) => {
            console.error('[Mirror] Questionnaire generation failed:', sanitizeError(error));
        });

        const refreshed = await pool.query(`SELECT * FROM account_mirror_cycles WHERE id=$1`, [cycle.id]);
        return cycleFromRow(refreshed.rows[0]);
    }

    async function enqueueEligibleDebatesForAccount({ accountId, cycleId = null }) {
        const cycle = cycleId
            ? cycleFromRow((await pool.query(`SELECT * FROM account_mirror_cycles WHERE id=$1 AND account_id=$2`, [cycleId, accountId])).rows[0])
            : await findCurrentCycle(accountId);
        if (!cycle || cycle.cycleNumber <= 1 || !cycle.windowStartedAt) return 0;

        const result = await pool.query(
            `
            INSERT INTO account_mirror_debate_evidence (
                cycle_id, account_id, debate_history_id, saved_debate_id,
                source_type, debate_completed_at, extractor_version
            )
            SELECT
                $2::uuid,
                h.account_id,
                h.id,
                h.saved_debate_id,
                CASE
                    WHEN h.ranked_debate_id IS NOT NULL THEN 'ranked'
                    WHEN h.is_daily_challenge = TRUE THEN 'daily_challenge'
                    ELSE 'normal'
                END,
                CASE
                    WHEN h.ranked_debate_id IS NOT NULL THEN rd.completed_at
                    ELSE h.debate_date
                END,
                $5
            FROM account_debate_history h
            LEFT JOIN account_ranked_debates rd
              ON rd.id = h.ranked_debate_id
             AND rd.account_id = h.account_id
            WHERE h.account_id = $1
              AND h.final_score_value IS NOT NULL
              AND (
                    h.ranked_debate_id IS NULL
                    OR (
                        rd.status = 'completed'
                        AND rd.final_score_value IS NOT NULL
                        AND rd.completed_at IS NOT NULL
                    )
                  )
              AND (CASE WHEN h.ranked_debate_id IS NOT NULL THEN rd.completed_at ELSE h.debate_date END) > $3
              AND (
                    $4::timestamptz IS NULL
                    OR (CASE WHEN h.ranked_debate_id IS NOT NULL THEN rd.completed_at ELSE h.debate_date END) <= $4
                  )
            ON CONFLICT (cycle_id, saved_debate_id) DO NOTHING
            RETURNING id
            `,
            [accountId, cycle.id, cycle.windowStartedAt, cycle.questionnaireCompletedAt, MIRROR_EXTRACTOR_VERSION]
        );
        return result.rowCount;
    }

  