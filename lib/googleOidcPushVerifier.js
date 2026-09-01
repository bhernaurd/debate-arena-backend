import crypto from 'crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set([
    'accounts.google.com',
    'https://accounts.google.com',
]);
const MAX_JWT_LENGTH = 32_768;
const CLOCK_SKEW_SECONDS = 60;
const DEFAULT_JWKS_CACHE_MILLIS = 60 * 60 * 1000;

export class GoogleOidcPushVerificationError extends Error {
    constructor(code, message, { status = 401, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GoogleOidcPushVerificationError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GoogleOidcPushVerificationError(code, message, options);
}

function safeString(value, maximum = 512) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function decodeJsonPart(value) {
    try {
        const text = Buffer.from(value, 'base64url').toString('utf8');
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch {
        return null;
    }
}

function cacheLifetimeMillis(response) {
    const header = response?.headers?.get?.('cache-control') || '';
    const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header);
    if (!match) return DEFAULT_JWKS_CACHE_MILLIS;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return DEFAULT_JWKS_CACHE_MILLIS;
    }
    return Math.min(seconds * 1000, 24 * 60 * 60 * 1000);
}

export function createGoogleOidcPushVerifier({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    jwksUrl = GOOGLE_JWKS_URL,
    expectedAudienceProvider = () => process.env.GOOGLE_PLAY_RTDN_AUDIENCE,
    expectedEmailProvider = () =>
        process.env.GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL,
} = {}) {
    let jwksCache = null;

    async function loadJwks(force = false) {
        const current = Number(now());
        if (
            !force &&
            jwksCache?.keys &&
            jwksCache.expiresAt > current
        ) {
            return jwksCache.keys;
        }

        if (typeof fetchImpl !== 'function') {
            fail(
                'google_push_verification_unavailable',
                'Google push authentication is temporarily unavailable.',
                { status: 503, retryable: true }
            );
        }

        let response;
        try {
            response = await fetchImpl(jwksUrl, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(10_000),
            });
        } catch (cause) {
            fail(
                'google_push_verification_unavailable',
                'Google push authentication is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }

        if (!response.ok) {
            fail(
                'google_push_verification_unavailable',
                'Google push authentication is temporarily unavailable.',
                {
                    status: 503,
                    retryable: response.status === 429 || response.status >= 500,
                }
            );
        }

        let body;
        try {
            body = await response.json();
        } catch (cause) {
            fail(
                'google_push_verification_unavailable',
                'Google push authentication returned an invalid key set.',
                { status: 503, retryable: true, cause }
            );
        }

        const keys = Array.isArray(body?.keys)
            ? body.keys.filter((key) => key && typeof key === 'object')
            : [];
        if (keys.length === 0) {
            fail(
                'google_push_verification_unavailable',
                'Google push authentication returned an empty key set.',
                { status: 503, retryable: true }
            );
        }

        jwksCache = {
            keys,
            expiresAt: current + cacheLifetimeMillis(response),
        };
        return keys;
    }

    async function verifyBearerToken(tokenValue) {
        const token = safeString(tokenValue, MAX_JWT_LENGTH);
        const audience = safeString(expectedAudienceProvider?.(), 2048);
        const expectedEmail = safeString(expectedEmailProvider?.(), 512)?.toLowerCase();

        if (!audience || !expectedEmail) {
            fail(
                'google_push_not_configured',
                'Google Play real-time notifications are not configured.',
                { status: 503, retryable: false }
            );
        }

        const pieces = token?.split('.') || [];
        if (pieces.length !== 3) {
            fail('invalid_google_push_token', 'Invalid Google push authentication token.');
        }

        const header = decodeJsonPart(pieces[0]);
        const claims = decodeJsonPart(pieces[1]);
        if (!header || !claims || header.alg !== 'RS256') {
            fail('invalid_google_push_token', 'Invalid Google push authentication token.');
        }

        const keyId = safeString(header.kid, 512);
        if (!keyId) {
            fail('invalid_google_push_token', 'Invalid Google push authentication token.');
        }

        let keys = await loadJwks(false);
        let jwk = keys.find((candidate) => candidate.kid === keyId);
        if (!jwk) {
            keys = await loadJwks(true);
            jwk = keys.find((candidate) => candidate.kid === keyId);
        }
        if (!jwk) {
            fail('invalid_google_push_token', 'Invalid Google push authentication token.');
        }

        let verified = false;
        try {
            const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
            verified = crypto.verify(
                'RSA-SHA256',
                Buffer.from(`${pieces[0]}.${pieces[1]}`, 'ascii'),
                publicKey,
                Buffer.from(pieces[2], 'base64url')
            );
        } catch (cause) {
            fail(
                'invalid_google_push_token',
                'Invalid Google push authentication token.',
                { cause }
            );
        }
        if (!verified) {
            fail('invalid_google_push_token', 'Invalid Google push authentication token.');
        }

        const currentSeconds = Math.floor(Number(now()) / 1000);
        const expiry = Number(claims.exp);
        const issuedAt = Number(claims.iat);
        if (
            !Number.isFinite(expiry) ||
            expiry < currentSeconds - CLOCK_SKEW_SECONDS ||
            !Number.isFinite(issuedAt) ||
            issuedAt > currentSeconds + CLOCK_SKEW_SECONDS
        ) {
            fail('expired_google_push_token', 'Expired Google push authentication token.');
        }

        if (!GOOGLE_ISSUERS.has(claims.iss)) {
            fail('invalid_google_push_issuer', 'Invalid Google push token issuer.');
        }

        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!audiences.includes(audience)) {
            fail('invalid_google_push_audience', 'Invalid Google push token audience.');
        }

        const email = safeString(claims.email, 512)?.toLowerCase();
        const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
        if (email !== expectedEmail || !emailVerified) {
            fail('invalid_google_push_identity', 'Invalid Google push service account identity.');
        }

        return Object.freeze({
            issuer: claims.iss,
            audience,
            email,
            subject: safeString(claims.sub, 512),
        });
    }

    return Object.freeze({ verifyBearerToken });
}
