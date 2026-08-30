const SUPPORTED_LANGUAGE_CODES = Object.freeze([
    'en',
    'es',
    'pt-BR',
    'fr',
    'de',
    'ja',
    'ko',
    'zh-Hans',
]);

const SUPPORTED_LANGUAGE_SET = new Set(SUPPORTED_LANGUAGE_CODES);

const LANGUAGE_NAMES = Object.freeze({
    en: 'English',
    es: 'Spanish',
    'pt-BR': 'Brazilian Portuguese',
    fr: 'French',
    de: 'German',
    ja: 'Japanese',
    ko: 'Korean',
    'zh-Hans': 'Simplified Chinese',
});

function baseLanguageCandidate(value) {
    return String(value ?? '')
        .trim()
        .replace(/_/g, '-');
}

export function normalizeLanguageCode(value, fallback = 'en') {
    const raw = baseLanguageCandidate(value);
    if (!raw) return fallback;

    const lower = raw.toLowerCase();

    if (lower === 'system') return fallback;
    if (lower === 'en' || lower.startsWith('en-')) return 'en';
    if (lower === 'es' || lower.startsWith('es-')) return 'es';
    if (lower === 'fr' || lower.startsWith('fr-')) return 'fr';
    if (lower === 'de' || lower.startsWith('de-')) return 'de';
    if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
    if (lower === 'ko' || lower.startsWith('ko-')) return 'ko';
    if (lower === 'pt' || lower === 'pt-br' || lower.startsWith('pt-br-')) return 'pt-BR';

    if (
        lower === 'zh' ||
        lower === 'zh-hans' ||
        lower.startsWith('zh-hans-') ||
        lower === 'zh-cn' ||
        lower.startsWith('zh-cn-') ||
        lower === 'zh-sg' ||
        lower.startsWith('zh-sg-')
    ) {
        return 'zh-Hans';
    }

    return SUPPORTED_LANGUAGE_SET.has(raw) ? raw : fallback;
}

export function normalizeLanguagePreference(value, fallback = 'system') {
    const raw = baseLanguageCandidate(value);
    if (!raw) return fallback;
    if (raw.toLowerCase() === 'system') return 'system';

    const normalized = normalizeLanguageCode(raw, '');
    return normalized || fallback;
}

export function parseAcceptLanguage(value, fallback = 'en') {
    const header = String(value ?? '').trim();
    if (!header) return fallback;

    const candidates = header
        .split(',')
        .map((part) => {
            const [tagPart, ...params] = part.trim().split(';');
            let quality = 1;

            for (const param of params) {
                const match = param.trim().match(/^q=([0-9.]+)$/i);
                if (match) {
                    const parsed = Number(match[1]);
                    if (Number.isFinite(parsed)) quality = parsed;
                }
            }

            return { tag: tagPart.trim(), quality };
        })
        .filter((entry) => entry.tag && entry.quality > 0)
        .sort((a, b) => b.quality - a.quality);

    for (const candidate of candidates) {
        const normalized = normalizeLanguageCode(candidate.tag, '');
        if (normalized) return normalized;
    }

    return fallback;
}

export function resolveRequestLanguage(req, fallback = 'en') {
    const candidates = [
        req?.headers?.['x-agora-language'],
        req?.body?.language,
        req?.query?.language,
    ];

    for (const candidate of candidates) {
        const normalized = normalizeLanguageCode(candidate, '');
        if (normalized) return normalized;
    }

    return parseAcceptLanguage(req?.headers?.['accept-language'], fallback);
}

export function languageName(languageCode) {
    const code = normalizeLanguageCode(languageCode);
    return LANGUAGE_NAMES[code] || LANGUAGE_NAMES.en;
}

export function userVisibleLanguageContract(languageCode, {
    preserveMachineReadable = true,
} = {}) {
    const code = normalizeLanguageCode(languageCode);
    const name = languageName(code);

    if (code === 'en') {
        return preserveMachineReadable
            ? 'USER EXPERIENCE LANGUAGE: English (en). Write all user-visible natural-language prose in English. Keep every machine-readable token, enum, key, and protocol marker exactly as specified elsewhere in this prompt.'
            : 'USER EXPERIENCE LANGUAGE: English (en). Write all user-visible natural-language prose in English.';
    }

    return [
        `USER EXPERIENCE LANGUAGE: ${name} (${code}).`,
        `Write all user-visible natural-language prose in natural ${name}.`,
        'Preserve the philosopher’s actual positions, historical context, argumentative method, and level of rigor rather than translating literally when a natural equivalent is needed.',
        preserveMachineReadable
            ? 'Keep every machine-readable token, enum, JSON key, and protocol marker exactly as specified elsewhere in this prompt. Translate only user-visible natural-language values and prose.'
            : '',
    ].filter(Boolean).join(' ');
}

export function usesCjkCharacterCounting(languageCode) {
    const code = normalizeLanguageCode(languageCode);
    return code === 'ja' || code === 'zh-Hans';
}

export function countQuestionMarks(text) {
    return (String(text ?? '').match(/[?？]/gu) ?? []).length;
}

export function endsWithQuestionMark(text) {
    return /[?？]$/u.test(String(text ?? '').trim());
}

export function localizedPushTitle(timeOfDay, philosopherName, languageCode) {
    const code = normalizeLanguageCode(languageCode);
    const name = String(philosopherName || '').trim() || 'The philosopher';

    const templates = {
        en: {
            morning: `${name} enters the Agora.`,
            afternoon: `${name} is waiting.`,
            evening: `${possessiveEnglish(name)} time in the Agora is almost over.`,
        },
        es: {
            morning: `${name} entra en el Ágora.`,
            afternoon: `${name} te espera.`,
            evening: `El tiempo de ${name} en el Ágora está por terminar.`,
        },
        'pt-BR': {
            morning: `${name} entra na Ágora.`,
            afternoon: `${name} está esperando por você.`,
            evening: `O tempo de ${name} na Ágora está quase acabando.`,
        },
        fr: {
            morning: `${name} entre dans l’Agora.`,
            afternoon: `${name} vous attend.`,
            evening: `Le temps de ${name} dans l’Agora touche à sa fin.`,
        },
        de: {
            morning: `${name} betritt die Agora.`,
            afternoon: `${name} wartet auf dich.`,
            evening: `Die Zeit mit ${name} in der Agora läuft bald ab.`,
        },
        ja: {
            morning: `${name}がアゴラに現れました。`,
            afternoon: `${name}が待っています。`,
            evening: `アゴラでの${name}との時間がもうすぐ終わります。`,
        },
        ko: {
            morning: `${name}가 아고라에 들어왔습니다.`,
            afternoon: `${name}가 기다리고 있습니다.`,
            evening: `아고라에서 ${name}와 함께할 시간이 곧 끝납니다.`,
        },
        'zh-Hans': {
            morning: `${name} 来到了阿戈拉。`,
            afternoon: `${name} 正在等你。`,
            evening: `${name} 在阿戈拉的时间快结束了。`,
        },
    };

    return templates[code]?.[timeOfDay] || templates.en[timeOfDay] || templates.en.evening;
}

function possessiveEnglish(name) {
    return name.toLowerCase().endsWith('s') ? `${name}'` : `${name}'s`;
}

export { SUPPORTED_LANGUAGE_CODES, LANGUAGE_NAMES };
