import {
    createHash,
} from 'node:crypto';
import https from 'node:https';

import {
    isRankedPhilosopherID,
    requireRankedPhilosopher,
} from './rankedPhilosopherCatalog.js';

const ALLOWED_MODES = Object.freeze([
    'guided',
    'balanced',
    'relentless',
]);

const DEFAULT_MODEL =
    process.env.RANKED_TOPIC_GENERATOR_MODEL ||
    process.env.QUESTION_GENERATOR_MODEL ||
    'claude-haiku-4-5-20251001';

const DEFAULT_GENERATOR_VERSION =
    process.env.RANKED_TOPIC_GENERATOR_VERSION ||
    'ranked-topic-v1';

const ANTHROPIC_VERSION =
    process.env.ANTHROPIC_VERSION ||
    '2023-06-01';

const MAX_RECENT_TOPICS = 50;
const MIN_TOPIC_LENGTH = 30;
const MAX_TOPIC_LENGTH = 220;

const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'being',
    'by', 'can', 'could', 'did', 'do', 'does', 'for',
    'from', 'had', 'has', 'have', 'he', 'her', 'his',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
    'of', 'on', 'or', 'our', 'should', 'so', 'than',
    'that', 'the', 'their', 'them', 'then', 'there',
    'these', 'they', 'this', 'those', 'through', 'to',
    'was', 'we', 'were', 'what', 'when', 'where',
    'whether', 'which', 'who', 'whom', 'whose', 'why',
    'will', 'with', 'without', 'would', 'you', 'your',
]);

export class RankedTopicGeneratorError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            cause,
        } = {}
    ) {
        super(
            message,
            cause
                ? { cause }
                : undefined
        );
        this.name =
            'RankedTopicGeneratorError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new RankedTopicGeneratorError(
        code,
        message,
        options
    );
}

function cleanString(
    value,
    fieldName,
    {
        maximumLength = 1_000,
        minimumLength = 1,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_ranked_topic_input',
            `${fieldName} must be a string.`,
            {
                status: 400,
                retryable: false,
            }
        );
    }

    const cleaned = value.trim();

    if (
        cleaned.length < minimumLength ||
        cleaned.length > maximumLength
    ) {
        fail(
            'invalid_ranked_topic_input',
            `${fieldName} is invalid.`,
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return cleaned;
}

function requireCanonicalPhilosopherID(value) {
    const philosopherID =
        cleanString(
            value,
            'philosopherId',
            {
                maximumLength: 100,
            }
        ).toLowerCase();

    if (
        !isRankedPhilosopherID(
            philosopherID
        )
    ) {
        fail(
            'invalid_ranked_philosopher_id',
            'A canonical Ranked philosopher ID is required.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return philosopherID;
}

function requireDebateMode(value) {
    const mode =
        cleanString(
            value,
            'debateMode',
            {
                maximumLength: 32,
            }
        ).toLowerCase();

    if (!ALLOWED_MODES.includes(mode)) {
        fail(
            'invalid_ranked_debate_mode',
            'The Ranked debate mode is invalid.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return mode;
}

function normalizeText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function contentWords(value) {
    return normalizeText(value)
        .split(' ')
        .map((word) => word.trim())
        .filter(Boolean)
        .filter(
            (word) =>
                !STOPWORDS.has(word)
        );
}

function tooSimilar(left, right) {
    const normalizedLeft =
        normalizeText(left);
    const normalizedRight =
        normalizeText(right);

    if (
        !normalizedLeft ||
        !normalizedRight
    ) {
        return false;
    }

    if (
        normalizedLeft ===
        normalizedRight
    ) {
        return true;
    }

    const leftWords =
        new Set(
            contentWords(
                normalizedLeft
            )
        );
    const rightWords =
        new Set(
            contentWords(
                normalizedRight
            )
        );

    if (
        leftWords.size === 0 ||
        rightWords.size === 0
    ) {
        return false;
    }

    let shared = 0;

    for (const word of leftWords) {
        if (rightWords.has(word)) {
            shared += 1;
        }
    }

    const smaller =
        Math.min(
            leftWords.size,
            rightWords.size
        );
    const overlap =
        shared / smaller;

    return (
        shared >= 4 &&
        overlap >= 0.75
    );
}

function normalizeRecentTopics(value) {
    if (value == null) {
        return Object.freeze([]);
    }

    if (!Array.isArray(value)) {
        fail(
            'invalid_ranked_topic_input',
            'recentTopics must be an array.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    if (
        value.length >
        MAX_RECENT_TOPICS
    ) {
        fail(
            'invalid_ranked_topic_input',
            'Too many recent Ranked topics were provided.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    const cleaned =
        value.map(
            (item, index) =>
                cleanString(
                    item,
                    `recentTopics[${index}]`,
                    {
                        maximumLength:
                            MAX_TOPIC_LENGTH,
                    }
                )
        );

    return Object.freeze(cleaned);
}

function parseJSONResponse(rawValue) {
    const raw =
        typeof rawValue === 'string'
            ? rawValue
            : '';

    const cleaned =
        raw
            .replace(/```json/gi, '')
            .replace(/```/g, '')
            .trim();

    if (!cleaned) {
        throw new Error(
            'The model returned an empty topic response.'
        );
    }

    try {
        return JSON.parse(cleaned);
    } catch {
        const firstBrace =
            cleaned.indexOf('{');
        const lastBrace =
            cleaned.lastIndexOf('}');

        if (
            firstBrace >= 0 &&
            lastBrace > firstBrace
        ) {
            return JSON.parse(
                cleaned.slice(
                    firstBrace,
                    lastBrace + 1
                )
            );
        }

        throw new Error(
            'The model did not return valid JSON.'
        );
    }
}

function validateGeneratedTopic(
    payload,
    recentTopics
) {
    if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
    ) {
        throw new Error(
            'The generated topic payload is invalid.'
        );
    }

    const topic =
        typeof payload.topic === 'string'
            ? payload.topic
                .trim()
                .replace(
                    /^[-*\d.)\s]+/,
                    ''
                )
                .trim()
            : '';

    const theme =
        typeof payload.theme === 'string'
            ? payload.theme.trim()
            : '';

    if (
        topic.length <
            MIN_TOPIC_LENGTH ||
        topic.length >
            MAX_TOPIC_LENGTH
    ) {
        throw new Error(
            'The generated topic has an invalid length.'
        );
    }

    if (
        !topic.endsWith('?') ||
        topic.includes('\n') ||
        topic.includes('```') ||
        topic.startsWith('"') ||
        topic.endsWith('?"')
    ) {
        throw new Error(
            'The generated topic must be one clean question.'
        );
    }

    if (
        theme.length < 2 ||
        theme.length > 120
    ) {
        throw new Error(
            'The generated topic theme is invalid.'
        );
    }

    if (
        recentTopics.some(
            (recentTopic) =>
                tooSimilar(
                    topic,
                    recentTopic
                )
        )
    ) {
        throw new Error(
            'The generated topic is too similar to a recent Ranked topic.'
        );
    }

    const normalized =
        normalizeText(topic);

    if (!normalized) {
        throw new Error(
            'The generated topic could not be normalized.'
        );
    }

    return Object.freeze({
        topic,
        theme,
        normalized,
    });
}

function isRetryableGenerationError(error) {
    const message =
        String(
            error?.message ??
            error ??
            ''
        ).toLowerCase();

    return (
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

function sleep(milliseconds) {
    return new Promise(
        (resolve) =>
            setTimeout(
                resolve,
                milliseconds
            )
    );
}

function extractMessageText(message) {
    return (
        message?.content?.find(
            (block) =>
                block?.type === 'text'
        )?.text ??
        ''
    );
}

function callAnthropicMessagesRaw(payload) {
    return new Promise(
        (resolve, reject) => {
            const apiKey =
                process.env
                    .ANTHROPIC_API_KEY;

            if (!apiKey) {
                reject(
                    new Error(
                        'Missing ANTHROPIC_API_KEY'
                    )
                );
                return;
            }

            const body =
                JSON.stringify(payload);

            const request =
                https.request(
                    {
                        hostname:
                            'api.anthropic.com',
                        path:
                            '/v1/messages',
                        method:
                            'POST',
                        headers: {
                            'Content-Type':
                                'application/json',
                            Accept:
                                'application/json',
                            'x-api-key':
                                apiKey,
                            'anthropic-version':
                                ANTHROPIC_VERSION,
                            'Content-Length':
                                Buffer.byteLength(
                                    body
                                ),
                            Connection:
                                'close',
                        },
                        timeout:
                            60_000,
                        agent:
                            new https.Agent({
                                keepAlive:
                                    false,
                                maxSockets:
                                    1,
                            }),
                    },
                    (response) => {
                        let raw = '';

                        response.setEncoding(
                            'utf8'
                        );

                        response.on(
                            'data',
                            (chunk) => {
                                raw += chunk;
                            }
                        );

                        response.on(
                            'end',
                            () => {
                                const statusCode =
                                    response.statusCode ??
                                    0;

                                if (
                                    !raw.trim()
                                ) {
                                    reject(
                                        new Error(
                                            `Anthropic empty response body. Status ${statusCode}`
                                        )
                                    );
                                    return;
                                }

                                let parsed;

                                try {
                                    parsed =
                                        JSON.parse(
                                            raw
                                        );
                                } catch {
                                    reject(
                                        new Error(
                                            `Anthropic returned non-JSON. Status ${statusCode}`
                                        )
                                    );
                                    return;
                                }

                                if (
                                    statusCode < 200 ||
                                    statusCode >= 300
                                ) {
                                    reject(
                                        new Error(
                                            parsed
                                                ?.error
                                                ?.message ||
                                            `Anthropic request failed with status ${statusCode}`
                                        )
                                    );
                                    return;
                                }

                                resolve(parsed);
                            }
                        );
                    }
                );

            request.on(
                'timeout',
                () => {
                    request.destroy(
                        new Error(
                            'Anthropic Ranked topic request timed out.'
                        )
                    );
                }
            );

            request.on(
                'error',
                reject
            );

            request.write(body);
            request.end();
        }
    );
}

function modeGuidance(mode) {
    switch (mode) {
    case 'guided':
        return (
            'The topic may be accessible, but it must still contain a real philosophical tension and cannot have an obvious answer.'
        );

    case 'balanced':
        return (
            'The topic should demand a clear position, meaningful reasoning, and engagement with a central idea from the philosopher.'
        );

    case 'relentless':
        return (
            'The topic should confront the user with one of the philosopher’s strongest and most difficult ideas without becoming obscure or academic.'
        );

    default:
        return '';
    }
}

function buildPrompt({
    philosopher,
    debateMode,
    recentTopics,
    previousRejectionReason,
}) {
    const exclusionBlock =
        recentTopics.length > 0
            ? recentTopics
                .map(
                    (topic, index) =>
                        `${index + 1}. ${topic}`
                )
                .join('\n')
            : 'No prior Ranked topics are available.';

    const retryBlock =
        previousRejectionReason
            ? `

The previous attempt was rejected:
${previousRejectionReason}

Generate a different topic that fixes the problem.`
            : '';

    return `You generate one official system-assigned Ranked debate topic for The Agora.

The user is not choosing or writing the topic. Return exactly one question.

Philosopher:
${philosopher.name}

Canonical philosopher ID:
${philosopher.id}

Philosophical themes:
${philosopher.themes}

Required debate mode:
${debateMode}

Mode guidance:
${modeGuidance(debateMode)}

Rules:
- Produce exactly one debate question.
- The question must be philosophically faithful to ${philosopher.name}.
- It must force the user to defend a position, not explain a concept.
- It must be personal enough to implicate the user's beliefs or choices.
- It must be understandable without academic philosophy training.
- It must not contain invented quotations or false attribution.
- It must not be trivia, a definition request, a journaling prompt, or generic self-help.
- It must not ask what ${philosopher.name} believed.
- It must not mention Ranked, scoring, placement, the app, AI, or ChatGPT.
- It must be one clean sentence ending in a question mark.
- Keep it under ${MAX_TOPIC_LENGTH} characters.
- Do not repeat or closely paraphrase any recent topic.
- For Camus or Dostoevsky, never romanticize suicide, death, despair, or suffering.

Recent Ranked topics to avoid:
${exclusionBlock}

Return only valid JSON with this exact shape:
{"topic":"string","theme":"string"}${retryBlock}`;
}

export function createRankedTopicGeneratorService({
    messageClient =
        callAnthropicMessagesRaw,
    model =
        DEFAULT_MODEL,
    generatorVersion =
        DEFAULT_GENERATOR_VERSION,
    now =
        () => Date.now(),
    retryDelay =
        sleep,
} = {}) {
    if (
        typeof messageClient !==
        'function'
    ) {
        fail(
            'invalid_ranked_topic_configuration',
            'messageClient must be a function.'
        );
    }

    const cleanModel =
        cleanString(
            model,
            'model',
            {
                maximumLength: 200,
            }
        );

    const cleanGeneratorVersion =
        cleanString(
            generatorVersion,
            'generatorVersion',
            {
                maximumLength: 100,
            }
        );

    if (typeof now !== 'function') {
        fail(
            'invalid_ranked_topic_configuration',
            'now must be a function.'
        );
    }

    if (
        typeof retryDelay !==
        'function'
    ) {
        fail(
            'invalid_ranked_topic_configuration',
            'retryDelay must be a function.'
        );
    }

    async function generateTopic({
        philosopherId,
        debateMode,
        recentTopics = [],
    }) {
        const canonicalPhilosopherID =
            requireCanonicalPhilosopherID(
                philosopherId
            );
        const philosopher =
            requireRankedPhilosopher(
                canonicalPhilosopherID
            );
        const mode =
            requireDebateMode(
                debateMode
            );
        const exclusions =
            normalizeRecentTopics(
                recentTopics
            );

        let previousRejectionReason =
            null;
        let lastError =
            null;

        for (
            let attempt = 1;
            attempt <= 3;
            attempt += 1
        ) {
            try {
                const response =
                    await messageClient({
                        model:
                            cleanModel,
                        max_tokens:
                            350,
                        messages: [
                            {
                                role:
                                    'user',
                                content:
                                    buildPrompt({
                                        philosopher,
                                        debateMode:
                                            mode,
                                        recentTopics:
                                            exclusions,
                                        previousRejectionReason,
                                    }),
                            },
                        ],
                    });

                const parsed =
                    parseJSONResponse(
                        extractMessageText(
                            response
                        )
                    );

                const generated =
                    validateGeneratedTopic(
                        parsed,
                        exclusions
                    );

                const timestampValue =
                    now();
                const generatedAt =
                    timestampValue instanceof
                    Date
                        ? timestampValue
                        : new Date(
                            timestampValue
                        );

                if (
                    Number.isNaN(
                        generatedAt.getTime()
                    )
                ) {
                    fail(
                        'invalid_ranked_topic_configuration',
                        'now() returned an invalid date.'
                    );
                }

                const fingerprint =
                    createHash(
                        'sha256'
                    )
                        .update(
                            generated.normalized,
                            'utf8'
                        )
                        .digest(
                            'hex'
                        );

                return Object.freeze({
                    philosopherId:
                        philosopher.id,
                    philosopherName:
                        philosopher.name,
                    debateMode:
                        mode,
                    topic:
                        generated.topic,
                    topicNormalized:
                        generated.normalized,
                    topicFingerprint:
                        fingerprint,
                    theme:
                        generated.theme,
                    model:
                        cleanModel,
                    generatorVersion:
                        cleanGeneratorVersion,
                    generatedAt,
                });
            } catch (error) {
                if (
                    error instanceof
                    RankedTopicGeneratorError
                ) {
                    throw error;
                }

                lastError = error;
                previousRejectionReason =
                    error?.message ||
                    'The topic failed validation.';

                if (
                    attempt < 3 &&
                    isRetryableGenerationError(
                        error
                    )
                ) {
                    await retryDelay(
                        700 * attempt
                    );
                }
            }
        }

        fail(
            'ranked_topic_generation_failed',
            'A fresh Ranked topic could not be generated.',
            {
                status: 503,
                retryable: true,
                cause: lastError,
            }
        );
    }

    return Object.freeze({
        generateTopic,
    });
}

export const rankedTopicGeneratorConstants =
    Object.freeze({
        allowedModes:
            ALLOWED_MODES,
        defaultModel:
            DEFAULT_MODEL,
        defaultGeneratorVersion:
            DEFAULT_GENERATOR_VERSION,
        minimumTopicLength:
            MIN_TOPIC_LENGTH,
        maximumTopicLength:
            MAX_TOPIC_LENGTH,
        maximumRecentTopics:
            MAX_RECENT_TOPICS,
    });
