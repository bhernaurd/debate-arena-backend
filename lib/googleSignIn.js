import crypto from 'crypto';

const GOOGLE_ISSUERS = new Set([
    'https://accounts.google.com',
    'accounts.google.com',
]);
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export class GoogleSignInError extends Error {
    constructor(code, message, { status = 401, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GoogleSignInError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function decodeBase64UrlJson(value, label) {
    try {
        return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch (cause) {
        throw new GoogleSignInError(
            'invalid_google_credential',
            `The Google ${label} is malformed.`,
            { cause }
        );
    }
}

function parseMaxAge(cacheControl) {
    if (typeof cacheControl !== 'string') return null;
    const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function safeString(value, maximum = 32_768) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function safeOptionalString(value, maximum) {
    if (value == null) return null;
    return safeString(value, maximum);
}

function constantTimeStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left, 'utf8');
    const b = Buffer.from(right, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verifies Google OpenID Connect ID tokens without trusting client-supplied
 * identity fields. Signature keys come from Google's published JWKS endpoint;
 * issuer, audience, expiry and nonce are validated before returning the stable
 * Google `sub` identity.
 */
export function createGoogleIdTokenVerifier({
    clientId = process.env.GOOGLE_ANDROID_WEB_CLIENT_ID ?? '',
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    jwksUrl = GOOGLE_JWKS_URL,
} = {}) {
    const expectedAudience = safeString(clientId, 512);
    let cache = { keys: [], expiresAt: 0 };

    async function loadKeys(force = false) {
        const current = now();
        if (!force && cache.keys.length > 0 && cache.expiresAt > current) {
            return cache.keys;
        }
        if (typeof fetchImpl !== 'function') {
            throw new GoogleSignInError(
                'google_authentication_unavailable',
                'Google authentication is temporarily unavailable.',
                { status: 503, retryable: true }
            );
        }

        let response;
        try {
            response = await fetchImpl(jwksUrl, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(10_000),
            });
        } catch (cause) {
            throw new GoogleSignInError(
                'google_authentication_unavailable',
                'Google authentication is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }
        if (!response?.ok) {
            throw new GoogleSignInError(
                'google_authentication_unavailable',
                'Google authentication is temporarily unavailable.',
                { status: 503, retryable: true }
            );
        }

        let body;
        try {
            body = await response.json();
        } catch (cause) {
            throw new GoogleSignInError(
                'google_authentication_unavailable',
                'Google authentication is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }
        const keys = Array.isArray(body?.keys) ? body.keys.filter(Boolean) : [];
        if (keys.length === 0) {
            throw new GoogleSignInError(
                'google_authentication_unavailable',
                'Google authentication is temporarily unavailable.',
                { status: 503, retryable: true }
            );
        }
        const ttl = parseMaxAge(response.headers?.get?.('cache-control')) ?? DEFAULT_JWKS_TTL_MS;
        cache = { keys, expiresAt: current + Math.max(60_000, ttl) };
        return keys;
    }

    async function keyFor(header) {
        const kid = safeString(header?.kid, 512);
        if (header?.alg !== 'RS256' || !kid) {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }
        let keys = await loadKeys(false);
        let jwk = keys.find((candidate) => candidate?.kid === kid);
        if (!jwk) {
            keys = await loadKeys(true);
            jwk = keys.find((candidate) => candidate?.kid === kid);
        }
        if (!jwk || jwk.kty !== 'RSA') {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }
        return crypto.createPublicKey({ key: jwk, format: 'jwk' });
    }

    return async function verifyGoogleIdToken(idToken, { expectedNonce = null } = {}) {
        if (!expectedAudience) {
            throw new GoogleSignInError(
                'google_authentication_not_configured',
                'Google sign-in is not configured for this environment.',
                { status: 503, retryable: false }
            );
        }
        const token = safeString(idToken, 32_768);
        if (!token) {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }
        const parts = token.split('.');
        if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }

        const header = decodeBase64UrlJson(parts[0], 'token header');
        const payload = decodeBase64UrlJson(parts[1], 'token payload');
        const publicKey = await keyFor(header);
        const verified = crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
            publicKey,
            Buffer.from(parts[2], 'base64url')
        );
        if (!verified) {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }

        const issuer = safeString(payload?.iss, 255);
        const subject = safeString(payload?.sub, 255);
        const audience = typeof payload?.aud === 'string' ? payload.aud : null;
        const currentSeconds = Math.floor(now() / 1000);
        const expiry = Number(payload?.exp);
        const issuedAt = Number(payload?.iat);
        if (
            !issuer || !GOOGLE_ISSUERS.has(issuer) ||
            !subject || !audience || !constantTimeStringEqual(audience, expectedAudience) ||
            !Number.isFinite(expiry) || expiry <= currentSeconds - CLOCK_SKEW_SECONDS ||
            !Number.isFinite(issuedAt) || issuedAt > currentSeconds + CLOCK_SKEW_SECONDS
        ) {
            throw new GoogleSignInError(
                'invalid_google_credential',
                'The Google sign-in credential could not be verified.'
            );
        }

        if (expectedNonce != null) {
            const nonce = safeString(payload?.nonce, 1024);
            const requiredNonce = safeString(expectedNonce, 1024);
            if (!nonce || !requiredNonce || !constantTimeStringEqual(nonce, requiredNonce)) {
                throw new GoogleSignInError(
                    'invalid_google_credential',
                    'The Google sign-in credential could not be verified.'
                );
            }
        }

        return Object.freeze({
            issuer,
            audience,
            subject,
            email: safeOptionalString(payload?.email, 320),
            emailVerified: typeof payload?.email_verified === 'boolean'
                ? payload.email_verified
                : null,
            displayName: safeOptionalString(payload?.name, 100),
            pictureUrl: safeOptionalString(payload?.picture, 2048),
        });
    };
}
