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
    buildMirrorExplorationTargets,
    calculateDebateAdjustments,
    evidenceBreadthSummary,
    finalMirrorScores,
    matchMirrorArchetypes,
    meaningfulChangeBand,
    questionnaireScores,
} from './mirrorScoring.js';
import {
    MIRROR_ANALYSIS_TRANSLATION_VERSION,
    createMirrorAnthropicService,
    normalizeMirrorLanguageCode,
} from './mirrorAnthropicService.js';

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
    const translationLocks = new Map();

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

    async function snapshotEvidence(cycleId) {
        const signalsResult = await pool.query(
            `SELECT s.id, s.dimension, s.pole, s.confidence, s.stance_strength,
                    s.context_bucket, s.evidence_excerpt, s.position_summary,
                    s.excluded_by_user, s.excluded_at,
                    e.source_type, e.saved_debate_id, e.debate_completed_at,
                    h.philosopher_name, h.topic
             FROM account_mirror_evidence_signals s
             JOIN account_mirror_debate_evidence e ON e.id=s.evidence_id
             JOIN account_debate_history h ON h.id=e.debate_history_id
             WHERE e.cycle_id=$1 AND e.status='accepted'
               AND s.validated=TRUE
             ORDER BY e.debate_completed_at ASC, s.ordinal ASC`,
            [cycleId]
        );
        const revisionsResult = await pool.query(
            `SELECT r.id, r.dimension, r.before_pole, r.after_pole, r.confidence,
                    r.revision_strength, r.before_excerpt, r.after_excerpt,
                    r.revision_summary, r.excluded_by_user, r.excluded_at,
                    e.source_type, e.saved_debate_id, e.debate_completed_at,
                    h.philosopher_name, h.topic
             FROM account_mirror_revision_events r
             JOIN account_mirror_debate_evidence e ON e.id=r.evidence_id
             JOIN account_debate_history h ON h.id=e.debate_history_id
             WHERE e.cycle_id=$1 AND e.status='accepted'
               AND r.validated=TRUE
             ORDER BY e.debate_completed_at ASC`,
            [cycleId]
        );
        return {
            signals: signalsResult.rows.map((item) => ({
                id: String(item.id),
                dimension: item.dimension,
                pole: item.pole,
                confidence: Number(item.confidence),
                stanceStrength: Number(item.stance_strength),
                contextBucket: item.context_bucket,
                excerpt: item.evidence_excerpt,
                positionSummary: item.position_summary,
                sourceType: item.source_type,
                savedDebateId: String(item.saved_debate_id),
                philosopherName: item.philosopher_name,
                topic: item.topic,
                debateCompletedAt: toIso(item.debate_completed_at),
                excludedFromFuture: item.excluded_by_user === true,
                excludedAt: item.excluded_at ? toIso(item.excluded_at) : null,
            })),
            revisions: revisionsResult.rows.map((item) => ({
                id: String(item.id),
                dimension: item.dimension,
                beforePole: item.before_pole,
                afterPole: item.after_pole,
                confidence: Number(item.confidence),
                revisionStrength: Number(item.revision_strength),
                beforeExcerpt: item.before_excerpt,
                afterExcerpt: item.after_excerpt,
                revisionSummary: item.revision_summary,
                sourceType: item.source_type,
                savedDebateId: String(item.saved_debate_id),
                philosopherName: item.philosopher_name,
                topic: item.topic,
                debateCompletedAt: toIso(item.debate_completed_at),
                excludedFromFuture: item.excluded_by_user === true,
                excludedAt: item.excluded_at ? toIso(item.excluded_at) : null,
            })),
        };
    }

    async function priorEvidenceCorrections(accountId, beforeCycleNumber) {
        if (!Number.isInteger(beforeCycleNumber) || beforeCycleNumber <= 1) {
            return [];
        }

        const result = await pool.query(
            `
            SELECT
                'signal'::text AS kind,
                s.id,
                c.cycle_number,
                s.dimension,
                s.position_summary AS summary,
                s.evidence_excerpt AS excerpt,
                s.excluded_at
            FROM account_mirror_evidence_signals s
            JOIN account_mirror_debate_evidence e ON e.id=s.evidence_id
            JOIN account_mirror_cycles c ON c.id=e.cycle_id
            WHERE e.account_id=$1
              AND c.cycle_number < $2
              AND s.validated=TRUE
              AND s.excluded_by_user=TRUE

            UNION ALL

            SELECT
                'revision'::text AS kind,
                r.id,
                c.cycle_number,
                r.dimension,
                r.revision_summary AS summary,
                r.after_excerpt AS excerpt,
                r.excluded_at
            FROM account_mirror_revision_events r
            JOIN account_mirror_debate_evidence e ON e.id=r.evidence_id
            JOIN account_mirror_cycles c ON c.id=e.cycle_id
            WHERE e.account_id=$1
              AND c.cycle_number < $2
              AND r.validated=TRUE
              AND r.excluded_by_user=TRUE

            ORDER BY excluded_at DESC NULLS LAST, cycle_number DESC
            LIMIT 50
            `,
            [accountId, beforeCycleNumber]
        );

        return result.rows.map((item) => ({
            kind: item.kind,
            id: String(item.id),
            cycleNumber: Number(item.cycle_number),
            dimension: item.dimension,
            summary: item.summary,
            excerpt: item.excerpt,
            excludedAt: item.excluded_at ? toIso(item.excluded_at) : null,
        }));
    }

    async function localizedSnapshotAnalysis(row, {
        languageCode = 'en',
        installationId = null,
    } = {}) {
        const canonicalAnalysis = parseJson(row.analysis_json, {});
        const sourceLanguageCode = normalizeMirrorLanguageCode(
            row.analysis_language_code || 'en'
        );
        const targetLanguageCode = normalizeMirrorLanguageCode(languageCode);

        if (targetLanguageCode === sourceLanguageCode) {
            return canonicalAnalysis;
        }

        const cached = await pool.query(
            `SELECT analysis_json
             FROM account_mirror_analysis_translations
             WHERE snapshot_id=$1 AND language_code=$2 AND translation_version=$3
             LIMIT 1`,
            [row.id, targetLanguageCode, MIRROR_ANALYSIS_TRANSLATION_VERSION]
        );
        if (cached.rows[0]) {
            return parseJson(cached.rows[0].analysis_json, canonicalAnalysis);
        }

        const lockKey = `${row.id}:${targetLanguageCode}:${MIRROR_ANALYSIS_TRANSLATION_VERSION}`;
        if (translationLocks.has(lockKey)) {
            return translationLocks.get(lockKey);
        }

        const task = (async () => {
            const recheck = await pool.query(
                `SELECT analysis_json
                 FROM account_mirror_analysis_translations
                 WHERE snapshot_id=$1 AND language_code=$2 AND translation_version=$3
                 LIMIT 1`,
                [row.id, targetLanguageCode, MIRROR_ANALYSIS_TRANSLATION_VERSION]
            );
            if (recheck.rows[0]) {
                return parseJson(recheck.rows[0].analysis_json, canonicalAnalysis);
            }

            const translation = await mirrorAI.translateMirrorAnalysis({
                accountId: row.account_id,
                installationId,
                snapshotId: row.id,
                sourceAnalysis: canonicalAnalysis,
                sourceLanguageCode,
                targetLanguageCode,
            });

            await pool.query(
                `INSERT INTO account_mirror_analysis_translations (
                    snapshot_id, account_id, source_language_code, language_code,
                    translation_version, analysis_json, model_name,
                    input_tokens, output_tokens, estimated_cost_usd, latency_ms
                 ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
                 ON CONFLICT (snapshot_id, language_code, translation_version)
                 DO NOTHING`,
                [
                    row.id,
                    row.account_id,
                    sourceLanguageCode,
                    targetLanguageCode,
                    MIRROR_ANALYSIS_TRANSLATION_VERSION,
                    JSON.stringify(translation.value),
                    translation.model || 'cache',
                    translation.usage?.inputTokens || 0,
                    translation.usage?.outputTokens || 0,
                    translation.estimatedCostUsd ?? null,
                    translation.latencyMs ?? null,
                ]
            );

            const persisted = await pool.query(
                `SELECT analysis_json
                 FROM account_mirror_analysis_translations
                 WHERE snapshot_id=$1 AND language_code=$2 AND translation_version=$3
                 LIMIT 1`,
                [row.id, targetLanguageCode, MIRROR_ANALYSIS_TRANSLATION_VERSION]
            );

            return persisted.rows[0]
                ? parseJson(persisted.rows[0].analysis_json, translation.value)
                : translation.value;
        })().finally(() => translationLocks.delete(lockKey));

        translationLocks.set(lockKey, task);
        return task;
    }

    async function serializeSnapshot(
        row,
        {
            includeAnalysis = true,
            languageCode = 'en',
            installationId = null,
        } = {}
    ) {
        if (!row) return null;
        const dimensions = await dimensionResults(row.cycle_id);
        const evidence = await snapshotEvidence(row.cycle_id);
        const displayLanguageCode = normalizeMirrorLanguageCode(languageCode);
        return {
            ...snapshotSummaryFromRow(row),
            dimensions,
            evidence,
            analysis: includeAnalysis
                ? await localizedSnapshotAnalysis(row, { languageCode, installationId })
                : undefined,
            analysisLanguageCode: includeAnalysis
                ? normalizeMirrorLanguageCode(row.analysis_language_code || 'en')
                : undefined,
            displayLanguageCode: includeAnalysis ? displayLanguageCode : undefined,
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

    async function getState({ installationId, accessToken, languageCode = 'en' }) {
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
            void kickGeneration({ accountId, cycleId: current.id, installationId, languageCode }).catch((error) => {
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
            currentSnapshot: latest ? await serializeSnapshot(latest, { languageCode, installationId }) : null,
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

    async function submitQuestionnaire({ installationId, accessToken, languageCode = 'en' }) {
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

        void kickGeneration({ accountId: auth.accountId, cycleId: cycle.id, installationId, languageCode }).catch((error) => {
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

    function validateEvidenceExtraction(raw, messages) {
        const userMessages = new Map(
            (messages || [])
                .filter((message) => message?.role === 'user' && UUID_RE.test(String(message?.id || '')))
                .map((message) => [String(message.id).toLowerCase(), message])
        );
        const signals = [];

        for (const candidate of Array.isArray(raw?.signals) ? raw.signals.slice(0, 2) : []) {
            const dimension = cleanString(candidate?.dimension, 80);
            const pole = cleanString(candidate?.pole, 80);
            const stanceStrength = Number(candidate?.stanceStrength);
            const confidence = Number(candidate?.confidence);
            const positionStatus = cleanString(candidate?.positionStatus, 40);
            const contextBucket = cleanString(candidate?.contextBucket, 80);
            const ids = Array.isArray(candidate?.evidenceMessageIds)
                ? candidate.evidenceMessageIds.map((value) => String(value).toLowerCase())
                : [];
            const excerpt = cleanString(candidate?.evidenceExcerpt, 1200);
            const summary = cleanString(candidate?.positionSummary, 1600);

            if (!MIRROR_DIMENSIONS.includes(dimension) || !validPole(dimension, pole)) continue;
            if (!Number.isFinite(stanceStrength) || stanceStrength < 0 || stanceStrength > 1) continue;
            if (!Number.isFinite(confidence) || confidence < EVIDENCE_CONFIDENCE_THRESHOLD || confidence > 1) continue;
            if (!['opening', 'maintained', 'final', 'mixed'].includes(positionStatus)) continue;
            if (!MIRROR_CONTEXT_BUCKETS.includes(contextBucket)) continue;
            if (!excerpt || !summary || ids.length === 0) continue;

            const evidenceMessageId = ids.find((id) => {
                const message = userMessages.get(id);
                return message && exactExcerptInMessage(message, excerpt);
            });
            if (!evidenceMessageId) continue;

            signals.push({
                dimension, pole, stanceStrength, confidence, positionStatus,
                contextBucket, evidenceMessageId, evidenceExcerpt: excerpt,
                positionSummary: summary,
            });
        }

        let revision = null;
        const candidate = raw?.revisionEvent;
        if (candidate && typeof candidate === 'object') {
            const dimension = cleanString(candidate.dimension, 80);
            const beforePole = cleanString(candidate.beforePole, 80);
            const afterPole = cleanString(candidate.afterPole, 80);
            const revisionStrength = Number(candidate.revisionStrength);
            const confidence = Number(candidate.confidence);
            const beforeMessageId = cleanString(candidate.beforeMessageId, 64).toLowerCase();
            const afterMessageId = cleanString(candidate.afterMessageId, 64).toLowerCase();
            const beforeExcerpt = cleanString(candidate.beforeExcerpt, 1200);
            const afterExcerpt = cleanString(candidate.afterExcerpt, 1200);
            const summary = cleanString(candidate.revisionSummary, 1600);
            const beforeMessage = userMessages.get(beforeMessageId);
            const afterMessage = userMessages.get(afterMessageId);

            if (
                MIRROR_DIMENSIONS.includes(dimension) &&
                validPole(dimension, beforePole) && validPole(dimension, afterPole) &&
                Number.isFinite(revisionStrength) && revisionStrength >= 0 && revisionStrength <= 1 &&
                Number.isFinite(confidence) && confidence >= EVIDENCE_CONFIDENCE_THRESHOLD && confidence <= 1 &&
                beforeMessage && afterMessage && beforeExcerpt && afterExcerpt && summary &&
                exactExcerptInMessage(beforeMessage, beforeExcerpt) && exactExcerptInMessage(afterMessage, afterExcerpt)
            ) {
                revision = {
                    dimension, beforePole, afterPole, revisionStrength, confidence,
                    beforeMessageId, afterMessageId, beforeExcerpt, afterExcerpt,
                    revisionSummary: summary,
                };
            }
        }

        return { signals, revision };
    }

    async function evidenceRowForProcessing(evidenceId) {
        const result = await pool.query(
            `
            SELECT e.*, h.philosopher_name, h.topic, h.messages,
                   h.last_synced_from_installation_id
            FROM account_mirror_debate_evidence e
            JOIN account_debate_history h ON h.id=e.debate_history_id
            WHERE e.id=$1
            `,
            [evidenceId]
        );
        return result.rows[0] || null;
    }

    async function processOneEvidence(evidenceId) {
        const claimed = await pool.query(
            `UPDATE account_mirror_debate_evidence
             SET status='processing', processing_started_at=NOW(), attempts=attempts+1, updated_at=NOW()
             WHERE id=$1 AND status IN ('pending','failed') AND attempts < $2
             RETURNING id`,
            [evidenceId, EVIDENCE_MAX_ATTEMPTS]
        );
        if (claimed.rowCount === 0) return;

        const row = await evidenceRowForProcessing(evidenceId);
        if (!row) return;
        const messages = parseJson(row.messages, []);

        try {
            const ai = await mirrorAI.extractDebateEvidence({
                accountId: row.account_id,
                installationId: row.last_synced_from_installation_id || null,
                evidenceId,
                sourceType: row.source_type,
                philosopherName: row.philosopher_name,
                topic: row.topic,
                messages,
            });
            const validated = validateEvidenceExtraction(ai.value, messages);
            const accepted = validated.signals.length > 0 || validated.revision != null;

            await withTransaction(async (tx) => {
                await tx.query(`DELETE FROM account_mirror_evidence_signals WHERE evidence_id=$1`, [evidenceId]);
                await tx.query(`DELETE FROM account_mirror_revision_events WHERE evidence_id=$1`, [evidenceId]);

                for (let index = 0; index < validated.signals.length; index += 1) {
                    const signal = validated.signals[index];
                    await tx.query(
                        `INSERT INTO account_mirror_evidence_signals (
                            evidence_id, ordinal, dimension, pole, stance_strength, confidence,
                            position_status, context_bucket, evidence_message_id, evidence_excerpt,
                            position_summary, validated
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
                        [evidenceId, index + 1, signal.dimension, signal.pole, signal.stanceStrength,
                         signal.confidence, signal.positionStatus, signal.contextBucket,
                         signal.evidenceMessageId, signal.evidenceExcerpt, signal.positionSummary]
                    );
                }

                if (validated.revision) {
                    const r = validated.revision;
                    await tx.query(
                        `INSERT INTO account_mirror_revision_events (
                            evidence_id, dimension, before_pole, after_pole,
                            revision_strength, confidence, before_message_id, after_message_id,
                            before_excerpt, after_excerpt, revision_summary, validated
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)`,
                        [evidenceId, r.dimension, r.beforePole, r.afterPole, r.revisionStrength,
                         r.confidence, r.beforeMessageId, r.afterMessageId, r.beforeExcerpt,
                         r.afterExcerpt, r.revisionSummary]
                    );
                }

                await tx.query(
                    `UPDATE account_mirror_debate_evidence SET
                        status=$2,
                        model_name=$3,
                        no_evidence_reason=$4,
                        raw_result=$5::jsonb,
                        processed_at=NOW(),
                        processing_started_at=NULL,
                        input_tokens=$6,
                        output_tokens=$7,
                        estimated_cost_usd=$8,
                        latency_ms=$9,
                        last_error=NULL,
                        updated_at=NOW()
                     WHERE id=$1`,
                    [evidenceId, accepted ? 'accepted' : 'no_evidence', ai.model,
                     accepted ? null : (ai.value.noEvidenceReason || 'no_validated_signal'),
                     JSON.stringify(ai.value), ai.usage.inputTokens, ai.usage.outputTokens,
                     ai.estimatedCostUsd, ai.latencyMs]
                );
            });
        } catch (error) {
            await pool.query(
                `UPDATE account_mirror_debate_evidence
                 SET status='failed', processing_started_at=NULL, last_error=$2,
                     processed_at=NOW(), updated_at=NOW()
                 WHERE id=$1`,
                [evidenceId, sanitizeError(error)]
            );
            throw error;
        }
    }

    async function processPendingEvidenceForAccount({ accountId, cycleId = null, includeFailed = false }) {
        const lockKey = `${accountId}:${cycleId || 'current'}`;
        if (evidenceLocks.has(lockKey)) return evidenceLocks.get(lockKey);

        const task = (async () => {
            await pool.query(
                `UPDATE account_mirror_debate_evidence
                 SET status='pending', processing_started_at=NULL, updated_at=NOW()
                 WHERE account_id=$1 AND status='processing'
                   AND processing_started_at < NOW() - ($2::text || ' milliseconds')::interval`,
                [accountId, String(STALE_PROCESSING_MS)]
            );

            const params = [accountId];
            let cycleFilter = '';
            if (cycleId) {
                params.push(cycleId);
                cycleFilter = `AND cycle_id=$${params.length}`;
            }
            const statusFilter = includeFailed ? `status IN ('pending','failed')` : `status='pending'`;
            const result = await pool.query(
                `SELECT id FROM account_mirror_debate_evidence
                 WHERE account_id=$1 ${cycleFilter} AND ${statusFilter}
                   AND attempts < ${EVIDENCE_MAX_ATTEMPTS}
                 ORDER BY debate_completed_at ASC, id ASC`,
                params
            );

            for (const row of result.rows) {
                try { await processOneEvidence(String(row.id)); }
                catch (error) {
                    console.error('[Mirror] Evidence extraction failed:', { evidenceId: row.id, error: sanitizeError(error) });
                }
            }
        })().finally(() => evidenceLocks.delete(lockKey));

        evidenceLocks.set(lockKey, task);
        return task;
    }

    async function handleDebateHistorySync({ accountId }) {
        const cycle = await findCurrentCycle(accountId);
        if (!cycle || cycle.cycleNumber <= 1) return;
        const access = await currentPro(accountId);
        if (!access.hasProAccess) return;
        await enqueueEligibleDebatesForAccount({ accountId, cycleId: cycle.id });
        await processPendingEvidenceForAccount({ accountId, cycleId: cycle.id });
    }

    async function loadCalculationEvidence(cycleId) {
        const signalResult = await pool.query(
            `SELECT s.*, e.debate_completed_at, e.source_type, e.saved_debate_id,
                    e.id AS source_evidence_id
             FROM account_mirror_evidence_signals s
             JOIN account_mirror_debate_evidence e ON e.id=s.evidence_id
             WHERE e.cycle_id=$1 AND e.status='accepted'
               AND s.validated=TRUE AND s.excluded_by_user=FALSE
             ORDER BY e.debate_completed_at ASC, s.ordinal ASC`,
            [cycleId]
        );
        const revisionResult = await pool.query(
            `SELECT r.*, e.debate_completed_at, e.source_type, e.saved_debate_id,
                    e.id AS source_evidence_id
             FROM account_mirror_revision_events r
             JOIN account_mirror_debate_evidence e ON e.id=r.evidence_id
             WHERE e.cycle_id=$1 AND e.status='accepted'
               AND r.validated=TRUE AND r.excluded_by_user=FALSE
             ORDER BY e.debate_completed_at ASC`,
            [cycleId]
        );
        return {
            signals: signalResult.rows.map((row) => ({
                dimension: row.dimension,
                pole: row.pole,
                stanceStrength: Number(row.stance_strength),
                confidence: Number(row.confidence),
                contextBucket: row.context_bucket,
                validated: true,
                occurredAt: row.debate_completed_at,
                sourceId: row.source_evidence_id,
                evidenceExcerpt: row.evidence_excerpt,
                positionSummary: row.position_summary,
                sourceType: row.source_type,
                savedDebateId: row.saved_debate_id,
            })),
            revisions: revisionResult.rows.map((row) => ({
                revisionStrength: Number(row.revision_strength),
                confidence: Number(row.confidence),
                validated: true,
                occurredAt: row.debate_completed_at,
                sourceId: row.source_evidence_id,
                dimension: row.dimension,
                beforePole: row.before_pole,
                afterPole: row.after_pole,
                beforeExcerpt: row.before_excerpt,
                afterExcerpt: row.after_excerpt,
                revisionSummary: row.revision_summary,
                sourceType: row.source_type,
                savedDebateId: row.saved_debate_id,
            })),
        };
    }

    async function previousSnapshotAndScores(cycle) {
        if (cycle.cycleNumber <= 1) return { snapshot: null, scores: {} };
        const result = await pool.query(
            `SELECT s.* FROM account_mirror_snapshots s
             WHERE s.account_id=$1 AND s.cycle_number=$2 LIMIT 1`,
            [cycle.accountId, cycle.cycleNumber - 1]
        );
        const snapshot = result.rows[0] || null;
        if (!snapshot) return { snapshot: null, scores: {} };
        const rows = await dimensionResults(snapshot.cycle_id);
        return {
            snapshot,
            scores: Object.fromEntries(rows.map((item) => [item.dimension, item.finalScore])),
        };
    }

    async function persistDimensionResults(cycle, qScores, adjustments, finalScores, previousScores) {
        await withTransaction(async (tx) => {
            await tx.query(`DELETE FROM account_mirror_dimension_results WHERE cycle_id=$1`, [cycle.id]);
            for (const dimension of MIRROR_DIMENSIONS) {
                const previous = previousScores[dimension] ?? null;
                const current = finalScores[dimension];
                const item = adjustments[dimension];
                await tx.query(
                    `INSERT INTO account_mirror_dimension_results (
                        cycle_id, dimension, questionnaire_score, debate_adjustment, final_score,
                        evidence_strength, evidence_consistency, evidence_breadth,
                        previous_final_score, change_from_previous
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                    [cycle.id, dimension, qScores[dimension], item.adjustment, current,
                     item.evidenceStrength, item.consistency, item.breadth,
                     previous, previous == null ? null : current - previous]
                );
            }
        });
    }

    async function mirrorContinuityContext(accountId, beforeCycleNumber) {
        const empty = {
            priorMirrors: [],
            recurringPositions: [],
            recurringContexts: [],
            recentUserLanguage: [],
        };

        if (!Number.isInteger(beforeCycleNumber) || beforeCycleNumber <= 1) {
            return empty;
        }

        const [snapshotResult, positionResult, contextResult, languageResult] =
            await Promise.all([
                pool.query(
                    `
                    WITH recent_snapshots AS (
                        SELECT *
                        FROM account_mirror_snapshots
                        WHERE account_id=$1
                          AND cycle_number < $2
                        ORDER BY cycle_number DESC
                        LIMIT 4
                    )
                    SELECT
                        rs.cycle_number,
                        rs.primary_archetype_name,
                        rs.secondary_archetype_name,
                        rs.blend_status,
                        rs.analysis_json,
                        rs.generated_at,
                        d.dimension,
                        d.questionnaire_score,
                        d.debate_adjustment,
                        d.final_score,
                        d.change_from_previous
                    FROM recent_snapshots rs
                    LEFT JOIN account_mirror_dimension_results d
                      ON d.cycle_id=rs.cycle_id
                    ORDER BY rs.cycle_number ASC, d.dimension ASC
                    `,
                    [accountId, beforeCycleNumber]
                ),
                pool.query(
                    `
                    SELECT
                        s.dimension,
                        s.pole,
                        COUNT(*)::int AS occurrence_count
                    FROM account_mirror_evidence_signals s
                    JOIN account_mirror_debate_evidence e
                      ON e.id=s.evidence_id
                    JOIN account_mirror_cycles c
                      ON c.id=e.cycle_id
                    WHERE e.account_id=$1
                      AND c.cycle_number < $2
                      AND e.status='accepted'
                      AND s.validated=TRUE
                      AND s.excluded_by_user=FALSE
                    GROUP BY s.dimension, s.pole
                    ORDER BY occurrence_count DESC, s.dimension ASC, s.pole ASC
                    LIMIT 10
                    `,
                    [accountId, beforeCycleNumber]
                ),
                pool.query(
                    `
                    SELECT
                        s.context_bucket,
                        COUNT(*)::int AS occurrence_count
                    FROM account_mirror_evidence_signals s
                    JOIN account_mirror_debate_evidence e
                      ON e.id=s.evidence_id
                    JOIN account_mirror_cycles c
                      ON c.id=e.cycle_id
                    WHERE e.account_id=$1
                      AND c.cycle_number < $2
                      AND e.status='accepted'
                      AND s.validated=TRUE
                      AND s.excluded_by_user=FALSE
                    GROUP BY s.context_bucket
                    ORDER BY occurrence_count DESC, s.context_bucket ASC
                    LIMIT 8
                    `,
                    [accountId, beforeCycleNumber]
                ),
                pool.query(
                    `
                    SELECT
                        c.cycle_number,
                        s.dimension,
                        s.pole,
                        s.context_bucket,
                        s.evidence_excerpt,
                        s.position_summary,
                        e.debate_completed_at
                    FROM account_mirror_evidence_signals s
                    JOIN account_mirror_debate_evidence e
                      ON e.id=s.evidence_id
                    JOIN account_mirror_cycles c
                      ON c.id=e.cycle_id
                    WHERE e.account_id=$1
                      AND c.cycle_number < $2
                      AND e.status='accepted'
                      AND s.validated=TRUE
                      AND s.excluded_by_user=FALSE
                    ORDER BY e.debate_completed_at DESC, s.ordinal ASC
                    LIMIT 8
                    `,
                    [accountId, beforeCycleNumber]
                ),
            ]);

        const priorByCycle = new Map();
        for (const row of snapshotResult.rows) {
            const cycleNumber = Number(row.cycle_number);
            let item = priorByCycle.get(cycleNumber);
            if (!item) {
                const analysis = parseJson(row.analysis_json, {});
                item = {
                    cycleNumber,
                    primaryArchetypeName: row.primary_archetype_name,
                    secondaryArchetypeName: row.secondary_archetype_name,
                    blendStatus: row.blend_status,
                    headline: cleanString(analysis?.summary?.headline, 240),
                    overview: cleanString(analysis?.summary?.overview, 700),
                    reflection: cleanString(analysis?.reflection, 1400),
                    generatedAt: toIso(row.generated_at),
                    dimensions: [],
                };
                priorByCycle.set(cycleNumber, item);
            }

            if (row.dimension) {
                item.dimensions.push({
                    dimension: row.dimension,
                    questionnaireScore: Number(row.questionnaire_score),
                    debateAdjustment: Number(row.debate_adjustment),
                    finalScore: Number(row.final_score),
                    changeFromPrevious:
                        row.change_from_previous == null
                            ? null
                            : Number(row.change_from_previous),
                });
            }
        }

        return {
            priorMirrors: Array.from(priorByCycle.values()),
            recurringPositions: positionResult.rows.map((row) => ({
                dimension: row.dimension,
                pole: row.pole,
                occurrenceCount: Number(row.occurrence_count),
            })),
            recurringContexts: contextResult.rows.map((row) => ({
                contextBucket: row.context_bucket,
                occurrenceCount: Number(row.occurrence_count),
            })),
            recentUserLanguage: languageResult.rows
                .slice()
                .reverse()
                .map((row) => ({
                    cycleNumber: Number(row.cycle_number),
                    dimension: row.dimension,
                    pole: row.pole,
                    contextBucket: row.context_bucket,
                    evidenceExcerpt: cleanString(row.evidence_excerpt, 320),
                    positionSummary: cleanString(row.position_summary, 500),
                    occurredAt: toIso(row.debate_completed_at),
                })),
        };
    }

    async function deterministicAnalysisInput(cycle, answers, qScores, adjustments, finalScores, archetype, evidence, previous) {
        const summary = await evidenceSummary(cycle.id);
        const previousArchetype = previous.snapshot ? snapshotSummaryFromRow(previous.snapshot) : null;
        const answered = Object.fromEntries(answers.map((a) => [a.questionId, a.answerValue]));
        const questionnaire = MIRROR_QUESTIONS.map((question) => ({
            questionId: question.id,
            dimension: question.dimension,
            question: question.text,
            response: RESPONSE_LABELS[answered[question.id]] || 'Unknown',
        }));
        const dimensions = MIRROR_DIMENSIONS.map((dimension) => {
            const previousScore = previous.scores[dimension] ?? null;
            const finalScore = finalScores[dimension];
            return {
                dimension,
                questionnaireScore: qScores[dimension],
                debateAdjustment: adjustments[dimension].adjustment,
                finalScore,
                previousFinalScore: previousScore,
                changeFromPrevious: previousScore == null ? null : finalScore - previousScore,
                changeBand: previousScore == null ? 'baseline' : meaningfulChangeBand(finalScore - previousScore),
                evidenceStrength: adjustments[dimension].evidenceStrength,
                evidenceConsistency: adjustments[dimension].consistency,
                evidenceBreadth: adjustments[dimension].breadth,
            };
        });
        const completedAt = cycle.questionnaireCompletedAt || new Date(now());
        const elapsedDays = cycle.windowStartedAt
            ? Math.max(0, Math.round((completedAt.getTime() - cycle.windowStartedAt.getTime()) / 86_400_000))
            : null;

        return {
            cycleNumber: cycle.cycleNumber,
            mirrorType: cycle.cycleNumber === 1 ? 'starting' : 'recurring',
            elapsedDays,
            questionnaireVersion: MIRROR_QUESTIONNAIRE_VERSION,
            archetypeModelVersion: MIRROR_ARCHETYPE_VERSION,
            evidenceEngineVersion: MIRROR_EVIDENCE_ENGINE_VERSION,
            currentArchetype: archetype,
            archetypeStability: archetype.stability,
            previousArchetype,
            dimensions,
            questionnaire,
            evidenceSummary: summary,
            evidenceBreadth: evidenceBreadthSummary(adjustments),
            continuityMemory: await mirrorContinuityContext(
                cycle.accountId,
                cycle.cycleNumber
            ),
            priorEvidenceCorrections: await priorEvidenceCorrections(
                cycle.accountId,
                cycle.cycleNumber
            ),
            evidenceSignals: evidence.signals.map((signal) => ({
                dimension: signal.dimension,
                pole: signal.pole,
                contextBucket: signal.contextBucket,
                stanceStrength: signal.stanceStrength,
                confidence: signal.confidence,
                positionSummary: signal.positionSummary,
                evidenceExcerpt: signal.evidenceExcerpt,
                sourceType: signal.sourceType,
            })),
            explorationTargets: cycle.cycleNumber === 1
                ? []
                : buildMirrorExplorationTargets({
                    questionnaireScoreMap: qScores,
                    finalScoreMap: finalScores,
                    adjustmentMap: adjustments,
                    signals: evidence.signals,
                    cycleNumber: cycle.cycleNumber,
                }),
            revisionEvents: evidence.revisions.map((revision) => ({
                dimension: revision.dimension,
                beforePole: revision.beforePole,
                afterPole: revision.afterPole,
                revisionStrength: revision.revisionStrength,
                confidence: revision.confidence,
                revisionSummary: revision.revisionSummary,
                beforeExcerpt: revision.beforeExcerpt,
                afterExcerpt: revision.afterExcerpt,
                sourceType: revision.sourceType,
            })),
        };
    }

    async function markCycleFailure(cycleId, code, error) {
        await pool.query(
            `UPDATE account_mirror_cycles SET status='failed', failure_code=$2,
             failure_message=$3, failed_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [cycleId, code, sanitizeError(error)]
        );
    }

    async function finalizeAndGenerate({ accountId, cycleId, installationId, languageCode = 'en' }) {
        let cycle = cycleFromRow((await pool.query(
            `SELECT * FROM account_mirror_cycles WHERE id=$1 AND account_id=$2`,
            [cycleId, accountId]
        )).rows[0]);
        if (!cycle) return;
        const existing = await pool.query(`SELECT * FROM account_mirror_snapshots WHERE cycle_id=$1`, [cycleId]);
        if (existing.rows[0]) return;
        if (!cycle.questionnaireCompletedAt) return;

        try {
            if (cycle.cycleNumber > 1) {
                await enqueueEligibleDebatesForAccount({ accountId, cycleId });
                await processPendingEvidenceForAccount({ accountId, cycleId, includeFailed: true });
            }

            await pool.query(
                `UPDATE account_mirror_cycles SET status='analysis_generating', updated_at=NOW()
                 WHERE id=$1 AND status <> 'completed'`,
                [cycleId]
            );
            cycle = cycleFromRow((await pool.query(`SELECT * FROM account_mirror_cycles WHERE id=$1`, [cycleId])).rows[0]);

            const answers = await answerRows(cycleId);
            const qScores = questionnaireScores(answers, { requireComplete: true });
            const evidence = cycle.cycleNumber === 1
                ? { signals: [], revisions: [] }
                : await loadCalculationEvidence(cycleId);
            const adjustments = cycle.cycleNumber === 1
                ? calculateDebateAdjustments([], [])
                : calculateDebateAdjustments(evidence.signals, evidence.revisions);
            const finalScores = finalMirrorScores(qScores, adjustments);
            const previous = await previousSnapshotAndScores(cycle);
            const archetype = matchMirrorArchetypes(finalScores, {
                previousPrimaryArchetypeId:
                    previous.snapshot?.primary_archetype_id || null,
            });

            await persistDimensionResults(cycle, qScores, adjustments, finalScores, previous.scores);
            const input = await deterministicAnalysisInput(
                cycle, answers, qScores, adjustments, finalScores, archetype, evidence, previous
            );
            const ai = await mirrorAI.generateMirrorAnalysis({
                accountId,
                installationId,
                cycleId,
                deterministicInput: input,
                languageCode,
            });

            await withTransaction(async (tx) => {
                await tx.query(
                    `INSERT INTO account_mirror_snapshots (
                        cycle_id, account_id, cycle_number,
                        primary_archetype_id, primary_archetype_name, primary_fit,
                        secondary_archetype_id, secondary_archetype_name, secondary_fit,
                        blend_status, analysis_json, analysis_language_code, sonnet_model,
                        input_tokens, output_tokens, estimated_cost_usd, latency_ms, generated_at
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,NOW())
                     ON CONFLICT (cycle_id) DO NOTHING`,
                    [cycleId, accountId, cycle.cycleNumber,
                     archetype.primary.id, archetype.primary.name, archetype.primary.fit,
                     archetype.secondary.id, archetype.secondary.name, archetype.secondary.fit,
                     archetype.blendStatus, JSON.stringify(ai.value),
                     normalizeMirrorLanguageCode(languageCode), ai.model,
                     ai.usage.inputTokens, ai.usage.outputTokens, ai.estimatedCostUsd, ai.latencyMs]
                );
                await tx.query(
                    `UPDATE account_mirror_cycles SET status='completed', updated_at=NOW(),
                     failure_code=NULL, failure_message=NULL, failed_at=NULL WHERE id=$1`,
                    [cycleId]
                );

                const nextStart = cycle.questionnaireCompletedAt;
                await createCycle(tx, {
                    accountId,
                    cycleNumber: cycle.cycleNumber + 1,
                    previousCycleId: cycle.id,
                    windowStartedAt: nextStart,
                    eligibleAt: new Date(nextStart.getTime() + THIRTY_DAYS_MS),
                });
            });
        } catch (error) {
            await markCycleFailure(cycleId, 'mirror_generation_failed', error);
            throw error;
        }
    }

    async function kickGeneration({ accountId, cycleId, installationId, languageCode = 'en' }) {
        const key = String(cycleId);
        if (generationLocks.has(key)) return generationLocks.get(key);
        const task = finalizeAndGenerate({ accountId, cycleId, installationId, languageCode })
            .finally(() => generationLocks.delete(key));
        generationLocks.set(key, task);
        return task;
    }

    async function retryGeneration({ installationId, accessToken, languageCode = 'en' }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        const cycle = await findCurrentCycle(auth.accountId);
        if (!cycle || !cycle.questionnaireCompletedAt) {
            fail('mirror_retry_unavailable', 'There is no Mirror analysis to retry.', { status: 409 });
        }
        await pool.query(
            `UPDATE account_mirror_cycles SET status='evidence_finalizing', failure_code=NULL,
             failure_message=NULL, failed_at=NULL, updated_at=NOW() WHERE id=$1`,
            [cycle.id]
        );
        void kickGeneration({ accountId: auth.accountId, cycleId: cycle.id, installationId, languageCode });
        return { cycleId: cycle.id, status: 'evidence_finalizing' };
    }

    async function getHistory({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        const rows = await listHistoryRows(auth.accountId, 100);
        return { accountId: auth.accountId, snapshots: rows.map(snapshotSummaryFromRow) };
    }

    async function getSnapshot({ installationId, accessToken, cycleNumber, languageCode = 'en' }) {
        const auth = await authorize({ installationId, accessToken });
        const number = Number(cycleNumber);
        if (!Number.isInteger(number) || number < 1) {
            fail('invalid_mirror_cycle', 'The Mirror cycle is invalid.', { status: 400 });
        }
        const result = await pool.query(
            `SELECT * FROM account_mirror_snapshots WHERE account_id=$1 AND cycle_number=$2 LIMIT 1`,
            [auth.accountId, number]
        );
        if (!result.rows[0]) {
            fail('mirror_snapshot_not_found', 'That Mirror could not be found.', { status: 404 });
        }
        return {
            accountId: auth.accountId,
            snapshot: await serializeSnapshot(result.rows[0], { languageCode, installationId }),
        };
    }

    async function setEvidenceExclusion({
        installationId,
        accessToken,
        kind,
        evidenceItemId,
        excluded,
    }) {
        const auth = await authorize({ installationId, accessToken });
        const itemId = requireUuid(evidenceItemId, 'evidenceItemId');
        const shouldExclude = excluded === true;

        let result;

        if (kind === 'signal') {
            result = await pool.query(
                `
                UPDATE account_mirror_evidence_signals s
                SET excluded_by_user=$3,
                    excluded_at=CASE WHEN $3 THEN NOW() ELSE NULL END
                FROM account_mirror_debate_evidence e
                WHERE s.id=$1
                  AND s.evidence_id=e.id
                  AND e.account_id=$2
                  AND s.validated=TRUE
                RETURNING s.id, s.excluded_by_user, s.excluded_at, e.cycle_id
                `,
                [itemId, auth.accountId, shouldExclude]
            );
        } else if (kind === 'revision') {
            result = await pool.query(
                `
                UPDATE account_mirror_revision_events r
                SET excluded_by_user=$3,
                    excluded_at=CASE WHEN $3 THEN NOW() ELSE NULL END
                FROM account_mirror_debate_evidence e
                WHERE r.id=$1
                  AND r.evidence_id=e.id
                  AND e.account_id=$2
                  AND r.validated=TRUE
                RETURNING r.id, r.excluded_by_user, r.excluded_at, e.cycle_id
                `,
                [itemId, auth.accountId, shouldExclude]
            );
        } else {
            fail(
                'invalid_mirror_evidence_kind',
                'The Mirror evidence kind is invalid.',
                { status: 400 }
            );
        }

        const row = result.rows[0];
        if (!row) {
            fail(
                'mirror_evidence_not_found',
                'That Mirror evidence item could not be found.',
                { status: 404 }
            );
        }

        const snapshotResult = await pool.query(
            `SELECT 1 FROM account_mirror_snapshots WHERE cycle_id=$1 LIMIT 1`,
            [row.cycle_id]
        );

        return {
            kind,
            evidenceItemId: String(row.id),
            excludedFromFuture: row.excluded_by_user === true,
            excludedAt: row.excluded_at ? toIso(row.excluded_at) : null,
            historicalSnapshotUnchanged: snapshotResult.rowCount > 0,
        };
    }

    async function testMakeEligibleNow({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        if (!isTestAllowed(auth.accountId, installationId)) {
            fail('mirror_test_forbidden', 'Mirror testing controls are not available for this account.', { status: 403 });
        }
        const cycle = await bootstrapStartingCycle(auth.accountId);
        await pool.query(
            `UPDATE account_mirror_cycles SET test_eligible_override=TRUE,
             test_override_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [cycle.id]
        );
        return { cycleId: cycle.id, cycleNumber: cycle.cycleNumber, eligibleNow: true };
    }

    async function testReset({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        if (!isTestAllowed(auth.accountId, installationId)) {
            fail('mirror_test_forbidden', 'Mirror testing controls are not available for this account.', { status: 403 });
        }
        await pool.query(`DELETE FROM account_mirror_cycles WHERE account_id=$1`, [auth.accountId]);
        const cycle = await bootstrapStartingCycle(auth.accountId);
        return { reset: true, currentCycleId: cycle.id };
    }

    async function testReprocessEvidence({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        await requirePro(auth.accountId);
        if (!isTestAllowed(auth.accountId, installationId)) {
            fail('mirror_test_forbidden', 'Mirror testing controls are not available for this account.', { status: 403 });
        }
        const cycle = await findCurrentCycle(auth.accountId);
        if (!cycle || cycle.cycleNumber <= 1) return { resetCount: 0 };
        const result = await withTransaction(async (tx) => {
            const evidence = await tx.query(
                `SELECT id FROM account_mirror_debate_evidence WHERE cycle_id=$1`,
                [cycle.id]
            );
            await tx.query(
                `DELETE FROM account_mirror_evidence_signals WHERE evidence_id IN
                 (SELECT id FROM account_mirror_debate_evidence WHERE cycle_id=$1)`,
                [cycle.id]
            );
            await tx.query(
                `DELETE FROM account_mirror_revision_events WHERE evidence_id IN
                 (SELECT id FROM account_mirror_debate_evidence WHERE cycle_id=$1)`,
                [cycle.id]
            );
            await tx.query(
                `UPDATE account_mirror_debate_evidence SET status='pending', attempts=0,
                 processing_started_at=NULL, processed_at=NULL, last_error=NULL,
                 no_evidence_reason=NULL, raw_result=NULL, updated_at=NOW()
                 WHERE cycle_id=$1`,
                [cycle.id]
            );
            return evidence.rowCount;
        });
        void processPendingEvidenceForAccount({ accountId: auth.accountId, cycleId: cycle.id });
        return { resetCount: result };
    }

    async function testState({ installationId, accessToken }) {
        const auth = await authorize({ installationId, accessToken });
        if (!isTestAllowed(auth.accountId, installationId)) {
            fail('mirror_test_forbidden', 'Mirror testing controls are not available for this account.', { status: 403 });
        }
        const cycle = await findCurrentCycle(auth.accountId);
        if (!cycle) return { cycle: null, evidence: [] };
        const evidence = await pool.query(
            `SELECT e.id, e.saved_debate_id, e.source_type, e.debate_completed_at,
                    e.status, e.model_name, e.no_evidence_reason, e.attempts,
                    e.input_tokens, e.output_tokens, e.estimated_cost_usd,
                    e.latency_ms, e.last_error,
                    COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                        'dimension', s.dimension,
                        'pole', s.pole,
                        'confidence', s.confidence,
                        'stanceStrength', s.stance_strength,
                        'contextBucket', s.context_bucket,
                        'excerpt', s.evidence_excerpt
                    )) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS signals
             FROM account_mirror_debate_evidence e
             LEFT JOIN account_mirror_evidence_signals s ON s.evidence_id=e.id
             WHERE e.cycle_id=$1
             GROUP BY e.id
             ORDER BY e.debate_completed_at ASC`,
            [cycle.id]
        );
        return {
            cycle: {
                ...cycle,
                eligibleNow: cycleEligibleNow(cycle, new Date(now())),
                answers: await answerRows(cycle.id),
                evidenceSummary: await evidenceSummary(cycle.id),
            },
            evidence: evidence.rows,
        };
    }

    return Object.freeze({
        getState,
        saveAnswer,
        submitQuestionnaire,
        retryGeneration,
        getHistory,
        getSnapshot,
        setEvidenceExclusion,
        handleDebateHistorySync,
        enqueueEligibleDebatesForAccount,
        processPendingEvidenceForAccount,
        testMakeEligibleNow,
        testReset,
        testReprocessEvidence,
        testState,
    });
}
