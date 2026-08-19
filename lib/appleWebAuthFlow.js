import crypto from 'crypto';

const APPLE_AUTHORIZE_URL = 'https://appleid.apple.com/auth/authorize';
const ENVELOPE_PREFIX = 'agoraweb';
const ENVELOPE_VERSION = '1';
const DEFAULT_STATE_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_HANDOFF_LIFETIME_MS = 5 * 60 * 1000;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PURPOSES = new Set(['sign_in_with_apple', 'delete_account']);

export class AppleWebAuthFlowError extends Error {
    constructor(code, message, { status = 400, retryable = false } = {}) {
        super(message);
        this.name = 'AppleWebAuthFlowError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AppleWebAuthFlowError(code, message, options);
}

function nonEmpty(value, fieldName, maxLength = 16_384) {
    if (typeof value !== 'string') {
        fail('invalid_request', `${fieldName} must be a string.`);
    }
    const cleaned = value.trim();
    if (!cleaned) {
        fail('invalid_request', `${fieldName} must not be empty.`);
    }
    if (cleaned.length > maxLength) {
        fail('invalid_request', `${fieldName} is too long.`);
    }
    return cleaned;
}

function optionalNonEmpty(value, fieldName, maxLength) {
    if (value == null) return null;
    return nonEmpty(value, fieldName, maxLength);
}

function validPurpose(value) {
    const purpose = nonEmpty(value, 'purpose', 64);
    if (!PURPOSES.has(purpose)) {
        fail('unsupported_auth_purpose', 'This Apple authentication purpose is not supported.');
    }
    return purpose;
}

function validInstallationId(value) {
    const installationId = nonEmpty(value, 'installationId', 128);
    if (!INSTALLATION_ID_RE.test(installationId)) {
        fail('invalid_installation_id', 'The installation identifier is invalid.');
    }
    return installationId;
}

function parseDateMillis(value, fieldName) {
    const text = nonEmpty(value, fieldName, 128);
    const millis = Date.parse(text);
    if (!Number.isFinite(millis)) {
        fail('invalid_request', `${fieldName} is invalid.`);
    }
    return millis;
}

function decodeCanonicalBase64(value, fieldName, expectedBytes) {
    const text = nonEmpty(value, fieldName, 4096);
    let decoded;
    try {
        decoded = Buffer.from(text, 'base64');
    } catch {
        fail('invalid_configuration', `${fieldName} is not valid Base64.`, { status: 500 });
    }
    if (
        decoded.length !== expectedBytes ||
        decoded.toString('base64') !== text
    ) {
        fail(
            'invalid_configuration',
            `${fieldName} must be canonical Base64 encoding exactly ${expectedBytes} bytes.`,
            { status: 500 }
        );
    }
    return decoded;
}

function parseHttpsUrl(value, fieldName) {
    const text = nonEmpty(value, fieldName, 2048);
    let url;
    try {
        url = new URL(text);
    } catch {
        fail('invalid_configuration', `${fieldName} is not a valid URL.`, { status: 500 });
    }
    if (url.protocol !== 'https:') {
        fail('invalid_configuration', `${fieldName} must use HTTPS.`, { status: 500 });
    }
    return url.toString();
}

function parseAppReturnUri(value) {
    const text = nonEmpty(value, 'APPLE_SIGN_IN_ANDROID_RETURN_URI', 2048);
    let url;
    try {
        url = new URL(text);
    } catch {
        fail('invalid_configuration', 'APPLE_SIGN_IN_ANDROID_RETURN_URI is invalid.', { status: 500 });
    }
    if (url.protocol !== 'theagora:') {
        fail('invalid_configuration', 'APPLE_SIGN_IN_ANDROID_RETURN_URI must use the theagora scheme.', { status: 500 });
    }
    return text;
}

export function loadAppleWebAuthFlowConfig(env = process.env) {
    const rawClientId = env?.APPLE_SIGN_IN_WEB_CLIENT_ID?.trim() ?? '';
    const rawRedirect = env?.APPLE_SIGN_IN_WEB_REDIRECT_URI?.trim() ?? '';
    const rawKey = env?.APPLE_SIGN_IN_WEB_FLOW_KEY?.trim() ?? '';
    const supplied = [rawClientId, rawRedirect, rawKey].filter(Boolean).length;

    if (supplied === 0) {
        return Object.freeze({
            enabled: false,
            clientId: null,
            redirectUri: null,
            androidReturnUri: 'theagora://auth/apple',
            missing: Object.freeze([
                'APPLE_SIGN_IN_WEB_CLIENT_ID',
                'APPLE_SIGN_IN_WEB_REDIRECT_URI',
                'APPLE_SIGN_IN_WEB_FLOW_KEY',
            ]),
        });
    }

    if (supplied !== 3) {
        const missing = [];
        if (!rawClientId) missing.push('APPLE_SIGN_IN_WEB_CLIENT_ID');
        if (!rawRedirect) missing.push('APPLE_SIGN_IN_WEB_REDIRECT_URI');
        if (!rawKey) missing.push('APPLE_SIGN_IN_WEB_FLOW_KEY');
        return Object.freeze({
            enabled: false,
            clientId: rawClientId || null,
            redirectUri: rawRedirect || null,
            androidReturnUri: 'theagora://auth/apple',
            missing: Object.freeze(missing),
        });
    }

    const key = decodeCanonicalBase64(
        rawKey,
        'APPLE_SIGN_IN_WEB_FLOW_KEY',
        32
    );
    const returnUri = parseAppReturnUri(
        env?.APPLE_SIGN_IN_ANDROID_RETURN_URI?.trim() ||
            'theagora://auth/apple'
    );

    return Object.freeze({
        enabled: true,
        clientId: nonEmpty(rawClientId, 'APPLE_SIGN_IN_WEB_CLIENT_ID', 255),
        redirectUri: parseHttpsUrl(
            rawRedirect,
            'APPLE_SIGN_IN_WEB_REDIRECT_URI'
        ),
        androidReturnUri: returnUri,
        key,
        missing: Object.freeze([]),
    });
}

export function createAppleWebAuthFlow(
    config,
    {
        now = () => Date.now(),
        stateLifetimeMs = DEFAULT_STATE_LIFETIME_MS,
        handoffLifetimeMs = DEFAULT_HANDOFF_LIFETIME_MS,
    } = {}
) {
    if (!config?.enabled || !Buffer.isBuffer(config.key)) {
        throw new AppleWebAuthFlowError(
            'apple_web_auth_disabled',
            'Android Sign in with Apple is not configured.',
            { status: 503 }
        );
    }

    const currentTime = () => {
        const value = Number(now());
        if (!Number.isFinite(value) || value < 0) {
            fail('invalid_configuration', 'now() returned an invalid value.', { status: 500 });
        }
        return value;
    };

    function seal(kind, payload) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', config.key, iv);
        const aad = Buffer.from(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${kind}`, 'utf8');
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(payload), 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return [
            ENVELOPE_PREFIX,
            ENVELOPE_VERSION,
            kind,
            iv.toString('base64url'),
            ciphertext.toString('base64url'),
            tag.toString('base64url'),
        ].join('.');
    }

    function open(kind, envelope) {
        const text = nonEmpty(envelope, `${kind} envelope`, 64_000);
        const parts = text.split('.');
        if (
            parts.length !== 6 ||
            parts[0] !== ENVELOPE_PREFIX ||
            parts[1] !== ENVELOPE_VERSION ||
            parts[2] !== kind
        ) {
            fail('invalid_auth_handoff', 'The Apple authentication handoff is invalid.', { status: 401 });
        }
        try {
            const iv = Buffer.from(parts[3], 'base64url');
            const ciphertext = Buffer.from(parts[4], 'base64url');
            const tag = Buffer.from(parts[5], 'base64url');
            if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
                throw new Error('Invalid encrypted envelope.');
            }
            const decipher = crypto.createDecipheriv('aes-256-gcm', config.key, iv);
            decipher.setAAD(Buffer.from(`${ENVELOPE_PREFIX}:${ENVELOPE_VERSION}:${kind}`, 'utf8'));
            decipher.setAuthTag(tag);
            const decoded = JSON.parse(
                Buffer.concat([
                    decipher.update(ciphertext),
                    decipher.final(),
                ]).toString('utf8')
            );
            if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
                throw new Error('Invalid encrypted payload.');
            }
            return decoded;
        } catch (error) {
            if (error instanceof AppleWebAuthFlowError) throw error;
            fail('invalid_auth_handoff', 'The Apple authentication handoff is invalid.', { status: 401 });
        }
    }

    function assertNotExpired(payload, errorCode = 'auth_handoff_expired') {
        if (!Number.isFinite(payload?.expiresAtMs) || payload.expiresAtMs <= currentTime()) {
            fail(errorCode, 'The Apple authentication handoff has expired.', { status: 401 });
        }
    }

    function createAuthorizationStart({
        installationId,
        purpose,
        challengeId,
        nonceSha256,
        challengeExpiresAt,
    }) {
        const installation = validInstallationId(installationId);
        const cleanPurpose = validPurpose(purpose);
        const challenge = nonEmpty(challengeId, 'challengeId', 64);
        if (!UUID_RE.test(challenge)) {
            fail('invalid_request', 'challengeId must be a UUID.');
        }
        const nonce = nonEmpty(nonceSha256, 'nonceSha256', 64);
        if (!SHA256_HEX_RE.test(nonce)) {
            fail('invalid_request', 'nonceSha256 must be a SHA-256 digest.');
        }
        const challengeExpiry = parseDateMillis(
            challengeExpiresAt,
            'challengeExpiresAt'
        );
        const nowMs = currentTime();
        if (challengeExpiry <= nowMs + 5_000) {
            fail('apple_challenge_expired', 'The Apple authentication challenge has expired.', { status: 401 });
        }

        const expiresAtMs = Math.min(
            challengeExpiry,
            nowMs + stateLifetimeMs
        );
        const state = seal('state', {
            installationId: installation,
            purpose: cleanPurpose,
            challengeId: challenge.toLowerCase(),
            nonceSha256: nonce,
            expiresAtMs,
        });

        const url = new URL(APPLE_AUTHORIZE_URL);
        url.searchParams.set('client_id', config.clientId);
        url.searchParams.set('redirect_uri', config.redirectUri);
        url.searchParams.set('response_type', 'code id_token');
        url.searchParams.set('response_mode', 'form_post');
        url.searchParams.set('state', state);
        url.searchParams.set('nonce', nonce);
        if (cleanPurpose === 'sign_in_with_apple') {
            url.searchParams.set('scope', 'name email');
        }

        return Object.freeze({
            authorizationUrl: url.toString(),
            purpose: cleanPurpose,
            expiresAt: new Date(expiresAtMs).toISOString(),
        });
    }

    function displayNameFromAppleUser(rawUser) {
        if (typeof rawUser !== 'string' || !rawUser.trim()) return null;
        try {
            const user = JSON.parse(rawUser);
            const name = user?.name;
            const first = typeof name?.firstName === 'string'
                ? name.firstName.trim()
                : '';
            const last = typeof name?.lastName === 'string'
                ? name.lastName.trim()
                : '';
            const joined = [first, last].filter(Boolean).join(' ').trim();
            return joined ? joined.slice(0, 100) : null;
        } catch {
            return null;
        }
    }

    function appReturnUrl(params) {
        const target = new URL(config.androidReturnUri);
        for (const [key, value] of Object.entries(params)) {
            if (value != null && String(value).trim()) {
                target.searchParams.set(key, String(value));
            }
        }
        return target.toString();
    }

    function completeAuthorizationCallback({
        state,
        code,
        identityToken,
        user = null,
        appleError = null,
        appleErrorDescription = null,
    }) {
        let statePayload;
        try {
            statePayload = open('state', state);
            assertNotExpired(statePayload, 'apple_challenge_expired');
        } catch (error) {
            return appReturnUrl({
                error: error.code || 'invalid_auth_handoff',
                message: error.message || 'Apple authentication could not be completed.',
            });
        }

        const purpose = validPurpose(statePayload.purpose);
        const installation = validInstallationId(statePayload.installationId);

        if (appleError) {
            const cancelled = appleError === 'access_denied' ||
                appleError === 'user_cancelled_authorize';
            return appReturnUrl({
                purpose,
                error: cancelled ? 'cancelled' : 'apple_authorization_failed',
                message: cancelled
                    ? null
                    : optionalNonEmpty(
                        appleErrorDescription,
                        'Apple error description',
                        500
                    ) || 'Apple authorization could not be completed.',
            });
        }

        let cleanCode;
        let cleanIdentityToken;
        try {
            cleanCode = nonEmpty(code, 'authorization code', 8192);
            cleanIdentityToken = nonEmpty(identityToken, 'identity token', 32768);
        } catch (error) {
            return appReturnUrl({
                purpose,
                error: 'missing_apple_credential',
                message: 'Apple did not return a valid sign-in credential.',
            });
        }

        const handoff = seal('handoff', {
            installationId: installation,
            purpose,
            challengeId: statePayload.challengeId,
            identityToken: cleanIdentityToken,
            authorizationCode: cleanCode,
            displayName: purpose === 'sign_in_with_apple'
                ? displayNameFromAppleUser(user)
                : null,
            expiresAtMs: currentTime() + handoffLifetimeMs,
        });

        return appReturnUrl({ purpose, handoff });
    }

    function redeemHandoff({ handoff, installationId }) {
        const installation = validInstallationId(installationId);
        const payload = open('handoff', handoff);
        assertNotExpired(payload);

        if (payload.installationId !== installation) {
            fail(
                'auth_handoff_installation_mismatch',
                'The Apple authentication handoff belongs to another installation.',
                { status: 401 }
            );
        }

        return Object.freeze({
            purpose: validPurpose(payload.purpose),
            challengeId: nonEmpty(payload.challengeId, 'challengeId', 64),
            identityToken: nonEmpty(payload.identityToken, 'identityToken', 32768),
            authorizationCode: nonEmpty(payload.authorizationCode, 'authorizationCode', 8192),
            displayName: optionalNonEmpty(payload.displayName, 'displayName', 100),
        });
    }

    return Object.freeze({
        createAuthorizationStart,
        completeAuthorizationCallback,
        redeemHandoff,
    });
}
