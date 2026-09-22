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
    'Dostoevsky',
    'Kierkegaard',
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
  "revisionEvent": null
}

When there is no sufficiently clear endorsed philosophical position, return qualifiesForEvidence=false, signals=[], revisionEvent=null, and a short noEvidenceReason.
`);
}

function analysisSystemPrompt() {
    return appendAgoraAiSafetyPolicy(`
You write The Agora's Mirror philosophical reflection from deterministic data already calculated by the backend.
You do not calculate scores, choose archetypes, diagnose the user, or tell the user what life decision to make.

PRINCIPLES:
- Describe, explain, and challenge. Never authorize behavior or prescribe relationships, work, treatment, or major life decisions.
- Use probabilistic language such as "y