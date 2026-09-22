import https from 'https';

import { appendAgoraAiSafetyPolicy } from './aiSafetyPolicy.js';
import {
    MIRROR_ANALYSIS_PROMPT_VERSION,
    MIRROR_CONTEXT_BUCKETS,
    MIRROR_DIMENSIONS,
    MIRROR_EXTRACTOR_VERSION,
    MIRROR_POLES,
} from './mirrorScoring.js';

const DEFAULT_HAIKU_MODEL =
    process.env.MIRROR_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const DEFAULT_SONNET_MODEL =
    process.env.MIRROR_SONNET_MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const ANTHROPIC_HOST = 'api.anthropic.com';
const ANTHROPIC_PATH = '/v1/messages';

const MODEL_PRICING_USD_PER_MTOK = Object.freeze({
    'claude-haiku-4-5-20251001': Object.freeze({ input: 1, output: 5 }),
    'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15 }),
});

const LIVE_RECOMMENDATION_PHILOSOPHERS = Object.freeze([
    'Socrates',
    'Plato',
    'Aristotle',
    'Nietzsche',
    'Marcus Aurelius',
    'Carl Jung',
    'Albert Camus',
    'Fyodor Dostoevsky',
    'Søren Kierkegaard',
    'Arthur Schopenhauer',
]);

function cleanString(value, maximum = 100_000) {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return '{}';
    }
}

function extractText(response) {
    if (!response || !Array.isArray(response.content)) return '';
    return response.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
}

function parseJsonObject(text) {
    const clean = cleanString(text, 250_000);
    if (!clean) throw new Error('Claude returned an empty response.');

    const candidates = [clean];
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(clean);
    if (fenced?.[1]) candidates.push(fenced[1].trim());

    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.push(clean.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            // Try the next bounded candidate.
        }
    }

    throw new Error('Claude did not return valid JSON.');
}

function usageFromResponse(response) {
    const usage = response?.usage || {};
    return {
        inputTokens: Number(usage.input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        cacheCreationInputTokens: Number(usage.cache_creation_input_tokens || 0),
        cacheReadInputTokens: Number(usage.cache_read_input_tokens || 0),
        rawUsage: usage,
    };
}

function estimateCost(model, usage) {
    const pricing = MODEL_PRICING_USD_PER_MTOK[model];
    if (!pricing) return null;
    const total =
        (usage.inputTokens / 1_000_000) * pricing.input +
        (usage.outputTokens / 1_000_000) * pricing.output;
    return Math.round(total * 100_000_000) / 100_000_000;
}

function requestAnthropic({ apiKey, payload, timeoutMs = 60_000 }) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const startedAt = Date.now();
        const request = https.request(
            {
                hostname: ANTHROPIC_HOST,
                path: ANTHROPIC_PATH,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                    'x-api-key': apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                },
                timeout: timeoutMs,
            },
            (response) => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => {
                    text += chunk;
                    if (text.length > 2_500_000) {
                        request.destroy(new Error('Anthropic response exceeded the maximum size.'));
                    }
                });
                response.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = text ? JSON.parse(text) : null;
                    } catch {
                        parsed = null;
                    }

                    const statusCode = Number(response.statusCode || 0);
                    const requestId =
                        response.headers['request-id'] ||
                        response.headers['x-request-id'] ||
                        null;
                    const latencyMs = Math.max(0, Date.now() - startedAt);

                    if (statusCode < 200 || statusCode >= 300 || !parsed) {
                        const error = new Error(
                            parsed?.error?.message ||
                            `Anthropic request failed with status ${statusCode || 'unknown'}.`
                        );
                        error.statusCode = statusCode;
                        error.requestId = requestId;
                        error.latencyMs = latencyMs;
                        reject(error);
                        return;
                    }

                    resolve({ response: parsed, requestId, latencyMs, statusCode });
                });
            }
        );

        request.on('timeout', () => {
            request.destroy(new Error('Anthropic request timed out.'));
        });
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

async function callWithRetry({ apiKey, payload, timeoutMs }) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await requestAnthropic({ apiKey, payload, timeoutMs });
        } catch (error) {
            lastError = error;
            const retryable =
                !error?.statusCode ||
                error.statusCode === 408 ||
                error.statusCode === 409 ||
                error.statusCode === 429 ||
                error.statusCode >= 500;
            if (!retryable || attempt >= 2) throw error;
            await new Promise((resolve) => setTimeout(resolve, 700 * (2 ** attempt)));
        }
    }
    throw lastError;
}

async function logUsage(pool, {
    model,
    feature,
    statusCode,
    success,
    accountId,
    installationId,
    entityType,
    entityId,
    requestId,
    usage,
    estimatedCostUsd,
    metadata,
}) {
    if (!pool || typeof pool.query !== 'function') return;
    try {
        const pricing = MODEL_PRICING_USD_PER_MTOK[model] || null;
        await pool.query(
            `
            INSERT INTO api_usage_logs (
                provider,
                model,
                feature,
                endpoint,
                transport,
                status_code,
                success,
                input_tokens,
                output_tokens,
                cache_creation_input_tokens,
                cache_read_input_tokens,
                estimated_cost_usd,
                pricing_version,
                input_usd_per_mtok,
                output_usd_per_mtok,
                account_id,
                installation_id,
                entity_type,
                entity_id,
                anthropic_request_id,
                raw_usage,
                metadata
            )
            VALUES (
                'anthropic', $1, $2, $3, 'https', $4, $5,
                $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb
            )
            ON CONFLICT (anthropic_request_id) WHERE anthropic_request_id IS NOT NULL
            DO NOTHING
            `,
            [
                model,
                feature,
                ANTHROPIC_PATH,
                statusCode || null,
                success === true,
                usage?.inputTokens || 0,
                usage?.outputTokens || 0,
                usage?.cacheCreationInputTokens || 0,
                usage?.cacheReadInputTokens || 0,
                estimatedCostUsd,
                'anthropic-public-pricing-2026-09',
                pricing?.input ?? null,
                pricing?.output ?? null,
                accountId || null,
                installationId || null,
                entityType || null,
                entityId ? String(entityId) : null,
                requestId || null,
                safeJson(usage?.rawUsage || {}),
                safeJson(metadata || {}),
            ]
        );
    } catch (error) {
        console.error('[MirrorAI] Usage logging failed:', error?.message || error);
    }
}

function extractionSystemPrompt() {
    const poles = Object.entries(MIRROR_POLES)
        .map(([dimension, value]) => `${dimension}: ${value.left} | ${value.right}`)
        .join('\n');

    return appendAgoraAiSafetyPolicy(`
You are The Agora's Mirror evidence extractor.
Your job is narrow: identify explicit philosophical positions the USER actually endorses in one completed philosophical discussion.
Do not profile the user beyond those explicit positions.

RULES:
- Return JSON only. No markdown and no prose outside the JSON object.
- Return zero, one, or two ordinary signals. Never invent a second signal to fill space.
- A question, hypothetical, quotation, philosopher summary, devil's-advocate position, roleplay position, or explicitly rejected view is not the user's belief.
- If ownership is ambiguous, do not extract it.
- Do not infer personality, psychology, motives, mental health, intelligence, morality, character, relationship advice, political affiliation, voting preference, religion, demographic identity, or future behavior.
- Do not infer one belief merely because it would make another belief philosophically consistent. Contradictions are valid evidence.
- confidence means confidence that the user actually endorsed the extracted position.
- stanceStrength means how strongly the user committed to that side, independent of extraction confidence.
- Use only the supplied six dimensions and their allowed poles.
- evidenceExcerpt must be a short exact verbatim substring from the referenced USER message.
- The optional revisionEvent is for a genuine change or meaningful qualification of a defended position during this discussion. It is not ordinary uncertainty.

DIMENSIONS AND POLES:
${poles}

ALLOWED CONTEXT BUCKETS:
${MIRROR_CONTEXT_BUCKETS.join(', ')}

OUTPUT SCHEMA:
{
  "schemaVersion": "${MIRROR_EXTRACTOR_VERSION}",
  "qualifiesForEvidence": true,
  "noEvidenceReason": null,
  "signals": [
    {
      "dimension": "one allowed dimension",
      "pole": "one allowed pole for that dimension",
      "stanceStrength": 0.0,
      "confidence": 0.0,
      "positionStatus": "opening | maintained | final | mixed",
      "contextBucket": "one allowed context bucket",
      "evidenceMessageIds": ["one or more supplied user message IDs"],
      "evidenceExcerpt": "exact short quote from one referenced user message",
      "positionSummary": "one factual sentence describing the endorsed philosophical position"
    }
  ],
  "revisionEvent": {
    "dimension": "one allowed dimension",
    "beforePole": "one allowed pole for that dimension",
    "afterPole": "one allowed pole for that dimension",
    "revisionStrength": 0.0,
    "confidence": 0.0,
    "beforeMessageId": "supplied USER message ID",
    "afterMessageId": "supplied USER message ID",
    "beforeExcerpt": "exact short quote from the before user message",
    "afterExcerpt": "exact short quote from the after user message",
    "revisionSummary": "one factual sentence describing the revision"
  }
}

Use revisionEvent=null when no genuine revision occurred.
When there is no sufficiently clear endorsed philosophical position, return qualifiesForEvidence=false, signals=[], revisionEvent=null, and a short noEvidenceReason.
`);
}

function analysisSystemPrompt() {
    return appendAgoraAiSafetyPolicy(`
You write The Agora's Mirror philosophical reflection from deterministic data already calculated by the backend.
You do not calculate scores, choose archetypes, diagnose the user, or tell the user what life decision to make.

PRINCIPLES:
- Describe, explain, and challenge. Never authorize behavior or prescribe relationships, work, treatment, or major life decisions.
- Use probabilistic language such as "your responses suggest" when appropriate.
- Treat the archetype as shorthand for the six coordinates, not a personality type or permanent identity.
- archetypeStability is deterministic backend output. When hysteresisApplied=true, the previous primary archetype remains primary because a new challenger did not establish the required meaningful lead. Explain that as stability amid a close match, not as proof the user has not changed.
- Never invent numbers or change any supplied score, archetype, evidence count, date, or trend.
- Contradictions are philosophically interesting. Describe them without secretly resolving them.
- Stability is meaningful and should not be framed as a failure to change.
- For the Starting Mirror, there is no prior profile and no debate evidence. Describe the baseline profile, tensions within the six coordinates, philosophical connections, and useful questions to test. Leave change/comparison sections empty rather than inventing a history.
- For recurring Mirrors, distinguish questionnaire movement from debate evidence.
- priorEvidenceCorrections contains evidence interpretations the user explicitly marked as not representing their view. Never cite, rely on, reinforce, or treat those corrected items as support for a current or longitudinal conclusion. Historical snapshot scores remain unchanged and must not be recalculated.
- Recommend exploration, not ideological conversion.
- For recurring Mirrors, recommendation ideas must come only from the supplied explorationTargets. Do not invent a different gap, tension, or challenge target.
- Use at most one recommendation per supplied explorationTarget and preserve its target id.
- Every supplied explorationTarget includes suggestedPhilosopher. Copy that exact philosopher name into the recommendation. Do not choose a different philosopher.
- The topic must be a concise, debate-ready philosophical question that directly pressure-tests the supplied target.
- Only recommend philosophers from the supplied allowed list.
- For the Starting Mirror, explorationTargets will be empty. Return recommendations=[].
- Return JSON only. No markdown and no prose outside the JSON object.

OUTPUT SCHEMA:
{
  "schemaVersion": "${MIRROR_ANALYSIS_PROMPT_VERSION}",
  "summary": {"headline": "short title", "overview": "2-4 sentences"},
  "archetypeAnalysis": {"summary": "2-3 sentences", "changeExplanation": null},
  "dimensions": [
    {
      "dimension": "one of the six supplied dimensions",
      "interpretation": "1-3 sentences",
      "changeExplanation": null,
      "evidenceRelationship": "questionnaire_only | aligned | mixed | tension | insufficient_evidence"
    }
  ],
  "meaningfulChanges": [{"title": "...", "explanation": "..."}],
  "stablePatterns": [{"title": "...", "explanation": "..."}],
  "questionnaireDebateAgreements": [{"title": "...", "explanation": "..."}],
  "tensions": [{"title": "...", "explanation": "..."}],
  "reconsideredBeliefs": [{"title": "...", "explanation": "..."}],
  "philosophicalConnections": [{"philosopher": "...", "connection": "...", "difference": "..."}],
  "evidenceBreadthInterpretation": "1-2 sentences",
  "nextQuestions": [{"question": "...", "reason": "..."}],
  "recommendations": [
    {
      "targetId": "id copied exactly from one supplied explorationTarget",
      "kind": "philosopher | topic | tension",
      "title": "short display title",
      "philosopher": "exact suggestedPhilosopher copied from the target",
      "topic": "a debate-ready philosophical question",
      "reason": "why this directly addresses the supplied target"
    }
  ]
}

Return exactly six dimension entries. Return 2-3 nextQuestions and no more than 3 recommendations. Empty arrays are valid when a section is unsupported by the supplied data.
`);
}

function validateExtractionResult(parsed) {
    const signals = Array.isArray(parsed?.signals) ? parsed.signals.slice(0, 2) : [];
    return {
        schemaVersion: MIRROR_EXTRACTOR_VERSION,
        qualifiesForEvidence: parsed?.qualifiesForEvidence === true,
        noEvidenceReason: cleanString(parsed?.noEvidenceReason, 300) || null,
        signals,
        revisionEvent: parsed?.revisionEvent && typeof parsed.revisionEvent === 'object'
            ? parsed.revisionEvent
            : null,
    };
}

function validateAnalysisResult(parsed, { explorationTargets = [] } = {}) {
    const dimensionItems = Array.isArray(parsed?.dimensions)
        ? parsed.dimensions.filter((item) => MIRROR_DIMENSIONS.includes(item?.dimension))
        : [];
    const dimensionMap = new Map();
    for (const item of dimensionItems) {
        if (!dimensionMap.has(item.dimension)) {
            dimensionMap.set(item.dimension, item);
        }
    }
    if (dimensionMap.size !== MIRROR_DIMENSIONS.length) {
        throw new Error('Mirror analysis did not return exactly one entry for each dimension.');
    }
    const dimensions = MIRROR_DIMENSIONS.map((dimension) => dimensionMap.get(dimension));

    const targetMap = new Map(
        (explorationTargets || [])
            .filter((target) => target?.id)
            .map((target) => [String(target.id), target])
    );
    const targetIds = new Set(targetMap.keys());
    const recommendations = Array.isArray(parsed?.recommendations)
        ? parsed.recommendations.filter((item) => {
            if (!['philosopher', 'topic', 'tension'].includes(item?.kind)) return false;
            const targetId = String(item?.targetId || '');
            const target = targetMap.get(targetId);
            if (!target) return false;

            const philosopher = String(item?.philosopher || '');
            if (!LIVE_RECOMMENDATION_PHILOSOPHERS.includes(philosopher)) {
                return false;
            }
            if (philosopher !== String(target.suggestedPhilosopher || '')) {
                return false;
            }

            if (!cleanString(item?.topic, 500)) return false;
            if (!cleanString(item?.reason, 1200)) return false;
            return true;
        }).slice(0, Math.min(3, targetIds.size))
        : [];

    if (targetIds.size === 0 && recommendations.length > 0) {
        throw new Error('Starting Mirror analysis returned unexpected recommendations.');
    }

    return {
        schemaVersion: MIRROR_ANALYSIS_PROMPT_VERSION,
        summary: parsed?.summary || { headline: 'Your Mirror', overview: '' },
        archetypeAnalysis: parsed?.archetypeAnalysis || { summary: '', changeExplanation: null },
        dimensions,
        meaningfulChanges: Array.isArray(parsed?.meaningfulChanges) ? parsed.meaningfulChanges.slice(0, 6) : [],
        stablePatterns: Array.isArray(parsed?.stablePatterns) ? parsed.stablePatterns.slice(0, 6) : [],
        questionnaireDebateAgreements: Array.isArray(parsed?.questionnaireDebateAgreements) ? parsed.questionnaireDebateAgreements.slice(0, 6) : [],
        tensions: Array.isArray(parsed?.tensions) ? parsed.tensions.slice(0, 6) : [],
        reconsideredBeliefs: Array.isArray(parsed?.reconsideredBeliefs) ? parsed.reconsideredBeliefs.slice(0, 6) : [],
        philosophicalConnections: Array.isArray(parsed?.philosophicalConnections) ? parsed.philosophicalConnections.slice(0, 4) : [],
        evidenceBreadthInterpretation: cleanString(parsed?.evidenceBreadthInterpretation, 1600),
        nextQuestions: Array.isArray(parsed?.nextQuestions) ? parsed.nextQuestions.slice(0, 3) : [],
        recommendations,
    };
}

export function createMirrorAnthropicService({
    pool,
    apiKey = process.env.ANTHROPIC_API_KEY,
    haikuModel = DEFAULT_HAIKU_MODEL,
    sonnetModel = DEFAULT_SONNET_MODEL,
} = {}) {
    if (!cleanString(apiKey, 20_000)) {
        throw new Error('ANTHROPIC_API_KEY is required for The Mirror.');
    }

    async function callJson({
        model,
        maxTokens,
        system,
        userContent,
        feature,
        accountId,
        installationId,
        entityType,
        entityId,
        metadata,
        timeoutMs,
    }) {
        const payload = {
            model,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: userContent }],
        };

        try {
            const result = await callWithRetry({ apiKey, payload, timeoutMs });
            const usage = usageFromResponse(result.response);
            const estimatedCostUsd = estimateCost(model, usage);
            await logUsage(pool, {
                model,
                feature,
                statusCode: result.statusCode,
                success: true,
                accountId,
                installationId,
                entityType,
                entityId,
                requestId: result.requestId,
                usage,
                estimatedCostUsd,
                metadata,
            });
            return {
                parsed: parseJsonObject(extractText(result.response)),
                model,
                usage,
                estimatedCostUsd,
                latencyMs: result.latencyMs,
                requestId: result.requestId,
            };
        } catch (error) {
            await logUsage(pool, {
                model,
                feature,
                statusCode: error?.statusCode || null,
                success: false,
                accountId,
                installationId,
                entityType,
                entityId,
                requestId: error?.requestId || null,
                usage: null,
                estimatedCostUsd: null,
                metadata: { ...(metadata || {}), error: cleanString(error?.message, 300) },
            });
            throw error;
        }
    }

    return Object.freeze({
        haikuModel,
        sonnetModel,

        async extractDebateEvidence({
            accountId,
            installationId,
            evidenceId,
            sourceType,
            philosopherName,
            topic,
            messages,
        }) {
            const transcript = (messages || []).map((message) => ({
                id: String(message?.id || ''),
                role: message?.role,
                content: cleanString(message?.content, 20_000),
            }));

            const result = await callJson({
                model: haikuModel,
                maxTokens: 1200,
                system: extractionSystemPrompt(),
                userContent: safeJson({
                    sourceType,
                    philosopherName,
                    topic,
                    transcript,
                }),
                feature: 'mirror_evidence_extraction',
                accountId,
                installationId,
                entityType: 'mirror_evidence',
                entityId: evidenceId,
                metadata: { extractorVersion: MIRROR_EXTRACTOR_VERSION, sourceType },
                timeoutMs: 45_000,
            });

            return {
                ...result,
                value: validateExtractionResult(result.parsed),
            };
        },

        async generateMirrorAnalysis({
            accountId,
            installationId,
            cycleId,
            deterministicInput,
        }) {
            const result = await callJson({
                model: sonnetModel,
                maxTokens: 3200,
                system: analysisSystemPrompt(),
                userContent: safeJson({
                    ...deterministicInput,
                    allowedRecommendationPhilosophers: LIVE_RECOMMENDATION_PHILOSOPHERS,
                }),
                feature: deterministicInput?.cycleNumber === 1
                    ? 'mirror_starting_analysis'
                    : 'mirror_recurring_analysis',
                accountId,
                installationId,
                entityType: 'mirror_cycle',
                entityId: cycleId,
                metadata: {
                    promptVersion: MIRROR_ANALYSIS_PROMPT_VERSION,
                    cycleNumber: deterministicInput?.cycleNumber,
                },
                timeoutMs: 90_000,
            });

            return {
                ...result,
                value: validateAnalysisResult(result.parsed, {
                    explorationTargets:
                        deterministicInput?.explorationTargets || [],
                }),
            };
        },
    });
}
