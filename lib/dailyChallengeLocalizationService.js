import https from 'node:https';

import {
    languageName,
    normalizeLanguageCode,
    userVisibleLanguageContract,
} from './languageSupport.js';

const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';
const TRANSLATION_MODEL =
    process.env.DAILY_CHALLENGE_TRANSLATION_MODEL ||
    process.env.QUESTION_GENERATOR_MODEL ||
    'claude-haiku-4-5-20251001';

const LOCALIZED_FIELDS = Object.freeze([
    'theme',
    'title',
    'challengeQuestion',
    'userPositionPrompt',
    'opposingAngle',
    'shareHook',
    'educationalNote',
    'morningNotification',
    'afternoonNotification',
    'eveningNotification',
]);

const inFlightTranslations = new Map();

function callAnthropicMessagesRaw(payload) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.ANTHROPIC_API_KEY;

        if (!apiKey) {
            reject(new Error('Missing ANTHROPIC_API_KEY'));
            return;
        }

        const body = JSON.stringify(payload);
        const request = https.request(
            {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'Content-Length': Buffer.byteLength(body),
                    Connection: 'close',
                },
                timeout: 60_000,
                agent: new https.Agent({ keepAlive: false, maxSockets: 1 }),
            },
            (response) => {
                let raw = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { raw += chunk; });
                response.on('end', () => {
                    const statusCode = response.statusCode || 0;

                    if (!raw.trim()) {
                        reject(new Error(`Anthropic returned an empty localization response (${statusCode}).`));
                        return;
                    }

                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        reject(new Error(`Anthropic returned non-JSON localization transport data (${statusCode}).`));
                        return;
                    }

                    if (statusCode < 200 || statusCode >= 300) {
                        reject(new Error(parsed?.error?.message || `Anthropic localization request failed (${statusCode}).`));
                        return;
                    }

                    resolve(parsed);
                });
            }
        );

        request.on('timeout', () => request.destroy(new Error('Daily Challenge localization timed out.')));
        request.on('error', reject);
        request.write(body);
        request.end();
    });
}

function extractText(message) {
    return message?.content?.find((block) => block?.type === 'text')?.text || '';
}

function parseJSON(raw) {
    const clean = String(raw || '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    try {
        return JSON.parse(clean);
    } catch {
        const first = clean.indexOf('{');
        const last = clean.lastIndexOf('}');
        if (first >= 0 && last > first) return JSON.parse(clean.slice(first, last + 1));
        throw new Error('Daily Challenge localization was not valid JSON.');
    }
}

function canonicalLocalizationPayload(challenge) {
    const payload = {};
    for (const field of LOCALIZED_FIELDS) {
        payload[field] = String(challenge?.[field] ?? '').trim();
    }
    return payload;
}

function validateTranslation(payload, languageCode) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Daily Challenge localization payload is invalid.');
    }

    const result = {};
    for (const field of LOCALIZED_FIELDS) {
        const value = typeof payload[field] === 'string' ? payload[field].trim() : '';
        if (!value) throw new Error(`Daily Challenge localization is missing ${field}.`);
        result[field] = value;
    }

    return Object.freeze({
        language: normalizeLanguageCode(languageCode),
        ...result,
    });
}

function buildTranslationPrompt(challenge, languageCode) {
    const targetName = languageName(languageCode);
    const source = canonicalLocalizationPayload(challenge);

    return `You localize one Daily Challenge for The Agora, a philosophy debate app.\n\n${userVisibleLanguageContract(languageCode)}\n\nTranslate the user-visible JSON values below from English into ${targetName}.\n\nRules:\n- Preserve the exact philosophical meaning, tension, difficulty, and intended user action.\n- Preserve philosopher names, work titles, and established philosophical terminology naturally for the target language.\n- Do not add claims, quotations, explanations, or extra facts.\n- challengeQuestion must remain exactly one direct question.\n- Keep notification copy concise and natural for a phone notification.\n- Keep every JSON key exactly as supplied in English.\n- Return only valid JSON with every key present and string values only.\n\nJSON to localize:\n${JSON.stringify(source)}`;
}

async function generateTranslation(challenge, languageCode) {
    const response = await callAnthropicMessagesRaw({
        model: TRANSLATION_MODEL,
        max_tokens: 1_200,
        messages: [{
            role: 'user',
            content: buildTranslationPrompt(challenge, languageCode),
        }],
    });

    return validateTranslation(parseJSON(extractText(response)), languageCode);
}

async function readCachedTranslation(pool, challengeDate, languageCode) {
    const result = await pool.query(
        `SELECT translations -> $2 AS translation
         FROM daily_challenges
         WHERE challenge_date = $1::date
         LIMIT 1`,
        [challengeDate, languageCode]
    );

    const value = result.rows[0]?.translation;
    if (!value) return null;

    try {
        return validateTranslation(value, languageCode);
    } catch {
        return null;
    }
}

async function storeCachedTranslation(pool, challengeDate, languageCode, translation) {
    await pool.query(
        `UPDATE daily_challenges
         SET translations = jsonb_set(
            COALESCE(translations, '{}'::jsonb),
            ARRAY[$2::text],
            $3::jsonb,
            true
         )
         WHERE challenge_date = $1::date`,
        [challengeDate, languageCode, JSON.stringify(translation)]
    );
}

export async function localizeDailyChallenge(pool, challenge, requestedLanguage) {
    const languageCode = normalizeLanguageCode(requestedLanguage);

    if (!challenge || languageCode === 'en') {
        return {
            ...challenge,
            language: 'en',
            requestedLanguage: languageCode,
            localizationFallback: false,
        };
    }

    const challengeDate = String(challenge.date || challenge.challengeDate || '').slice(0, 10);
    if (!challengeDate) {
        return {
            ...challenge,
            language: 'en',
            requestedLanguage: languageCode,
            localizationFallback: true,
        };
    }

    const cached = await readCachedTranslation(pool, challengeDate, languageCode);
    if (cached) {
        return {
            ...challenge,
            ...cached,
            language: languageCode,
            requestedLanguage: languageCode,
            localizationFallback: false,
        };
    }

    const key = `${challengeDate}:${languageCode}`;
    let promise = inFlightTranslations.get(key);

    if (!promise) {
        promise = (async () => {
            const secondCheck = await readCachedTranslation(pool, challengeDate, languageCode);
            if (secondCheck) return secondCheck;

            const generated = await generateTranslation(challenge, languageCode);
            await storeCachedTranslation(pool, challengeDate, languageCode, generated);
            return generated;
        })().finally(() => {
            inFlightTranslations.delete(key);
        });
        inFlightTranslations.set(key, promise);
    }

    try {
        const translated = await promise;
        return {
            ...challenge,
            ...translated,
            language: languageCode,
            requestedLanguage: languageCode,
            localizationFallback: false,
        };
    } catch (error) {
        console.error(
            `[DailyChallengeLocalization] ${challengeDate} ${languageCode} failed:`,
            error?.message || error
        );

        return {
            ...challenge,
            language: 'en',
            requestedLanguage: languageCode,
            localizationFallback: true,
        };
    }
}

export const dailyChallengeLocalizationConstants = Object.freeze({
    model: TRANSLATION_MODEL,
    localizedFields: LOCALIZED_FIELDS,
});
