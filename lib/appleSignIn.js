import crypto from 'crypto';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

const DEFAULT_CLIENT_SECRET_LIFETIME_SECONDS = 5 * 60;
const MAX_CLIENT_SECRET_LIFETIME_SECONDS = 60 * 60;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export class AppleSignInError extends Error {
    constructor(code, message, { status = 500, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AppleSignInError';
        this.code = code;
        this.status = status;
    }
}

function fail(code, message, options) {
    throw new AppleSignInError(code, message, options);
}

function requireNonEmptyString(value, fieldName, maxLength = 16_384) {
    if (typeof value !== 'string') {
        fail('invalid_input', `${fieldName} must be a string.`, { status: 400 });
    }

    const cleaned = value.trim();

    if (!cleaned) {
        fail('invalid_input', `${fieldName} must not be empty.`, { status: 400 });
    }

    if (cleaned.length > maxLength) {
        fail('invalid_input', `${fieldName} is too long.`, { status: 400 });
    }

    return cleaned;
}

function requirePositiveSafeInteger(value, fieldName) {
    const numeric = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        fail(
            'invalid_configuration',
            `${fieldName} must be a positive safe integer.`
        );
    }

    return numeric;
}

function normalizePrivateKey(rawValue) {
    return requireNonEmptyString(
        rawValue,
        'APPLE_SIGN_IN_PRIVATE_KEY',
        32_768
    )
        .replace(/\\n/g, '\n')
        .trim();
}

export function loadAppleSignInConfig(env = process.env) {
    if (!env || typeof env !== 'object') {
        fail('invalid_configuration', 'env must be an object.');
    }

    const teamId = requireNonEmptyString(
        env.APPLE_SIGN_IN_TEAM_ID,
        'APPLE_SIGN_IN_TEAM_ID',
        64
    );
    const keyId = requireNonEmptyString(
        env.APPLE_SIGN_IN_KEY_ID,
        'APPLE_SIGN_IN_KEY_ID',
        64
    );
    const clientId = requireNonEmptyString(
        env.APPLE_SIGN_IN_CLIENT_ID,
        'APPLE_SIGN_IN_CLIENT_ID',
        255
    );
    const privateKeyPem = normalizePrivateKey(
        env.APPLE_SIGN_IN_PRIVATE_KEY
    );

    let privateKey;

    try {
        privateKey = crypto.createPrivateKey(privateKeyPem);
    } catch (error) {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY is not a valid private key.',
            { cause: error }
        );
    }

    if (privateKey.asymmetricKeyType !== 'ec') {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY must be an EC private key.'
        );
    }

    const namedCurve = privateKey.asymmetricKeyDetails?.namedCurve;

    if (namedCurve && namedCurve !== 'prime256v1') {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY must use the P-256 curve.'
        );
    }

    return Object.freeze({
        teamId,
        keyId,
        clientId,
        privateKeyPem,
        privateKey,
    });
}

function base64urlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function decodeBase64url(value, fieldName) {
    if (
        typeof value !== 'string' ||
        !value ||
        !BASE64URL_RE.test(value)
    ) {
        fail('invalid_identity_token', `${fieldName} is not valid Base64URL.`, {
            status: 401,
        });
    }

    try {
        return Buffer.from(value, 'base64url');
    } catch (error) {
        fail('invalid_identity_token', `${fieldName} is not valid Base64URL.`, {
            status: 401,
            cause: error,
        });
    }
}

function parseJsonSegment(segment, fieldName) {
    const decoded = decodeBase64url(segment, fieldName);

    try {
        const parsed = JSON.parse(decoded.toString('utf8'));

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Expected a JSON object.');
        }

        return parsed;
    } catch (error) {
        fail('invalid_identity_token', `${fieldName} is not valid JSON.`, {
            status: 401,
            cause: error,
        });
    }
}

function constantTimeStringEqual(left, right) {
    const leftBuffer = Buffer.from(String(left), 'utf8');
    const rightBuffer = Buffer.from(String(right), 'utf8');

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeBooleanClaim(value) {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return null;
}

function parseCompactJwt(token) {
    const cleaned = requireNonEmptyString(token, 'identityToken', 32_768);
    const segments = cleaned.split('.');

    if (segments.length !== 3 || segments.some((segment) => !segment)) {
        fail(
            'invalid_identity_token',
            'Apple identity token must contain three JWT segments.',
            { status: 401 }
        );
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;

    return {
        encodedHeader,
        encodedPayload,
        encodedSignature,
        signingInput: `${encodedHeader}.${encodedPayload}`,
        header: parseJsonSegment(encodedHeader, 'identity token header'),
        payload: parseJsonSegment(encodedPayload, 'identity token payload'),
        signature: decodeBase64url(
            encodedSignature,
            'identity token signature'
        ),
    };
}

export function createAppleClientSecret(
    config,
    {
        nowSeconds = Math.floor(Date.now() / 1000),
        lifetimeSeconds = DEFAULT_CLIENT_SECRET_LIFETIME_SECONDS,
    } = {}
) {
    if (!config?.privateKey || !config.teamId || !config.keyId || !config.clientId) {
        fail('invalid_configuration', 'A valid Apple Sign in configuration is required.');
    }

    const issuedAt = requirePositiveSafeInteger(nowSeconds, 'nowSeconds');
    const lifetime = requirePositiveSafeInteger(
        lifetimeSeconds,
        'lifetimeSeconds'
    );

    if (lifetime > MAX_CLIENT_SECRET_LIFETIME_SECONDS) {
        fail(
            'invalid_input',
            `Apple client-secret lifetime must not exceed ${MAX_CLIENT_SECRET_LIFETIME_SECONDS} seconds.`,
            { status: 400 }
        );
    }

    const header = {
        alg: 'ES256',
        kid: config.keyId,
        typ: 'JWT',
    };

    const payload = {
        iss: config.teamId,
        iat: issuedAt,
        exp: issuedAt + lifetime,
        aud: APPLE_ISSUER,
        sub: config.clientId,
    };

    const encodedHeader = base64urlEncode(JSON.stringify(header));
    const encodedPayload = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    let signature;

    try {
        signature = crypto.sign(
            'sha256',
            Buffer.from(signingInput, 'utf8'),
            {
                key: config.privateKey,
                dsaEncoding: 'ieee-p1363',
            }
        );
    } catch (error) {
        fail('client_secret_generation_failed', 'Unable to generate Apple client secret.', {
            cause: error,
        });
    }

    return `${signingInput}.${base64urlEncode(signature)}`;
}

async function fetchWithTimeout(
    fetchImpl,
    url,
    options,
    timeoutMs
) {
    if (typeof fetchImpl !== 'function') {
        fail('invalid_configuration', 'fetch implementation is required.');
    }

    const timeout = requirePositiveSafeInteger(timeoutMs, 'timeoutMs');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetchImpl(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            fail('apple_request_timeout', 'Apple authentication request timed out.', {
                status: 503,
                cause: error,
            });
        }

        fail('apple_request_failed', 'Apple authentication request failed.', {
            status: 503,
            cause: error,
        });
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonResponse(response, errorCode) {
    let bodyText = '';

    try {
        bodyText = await response.text();
    } catch (error) {
        fail(errorCode, 'Unable to read Apple response.', {
            status: 502,
            cause: error,
        });
    }

    if (!bodyText) {
        return {};
    }

    try {
        const decoded = JSON.parse(bodyText);

        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
            throw new Error('Expected a JSON object.');
        }

        return decoded;
    } catch (error) {
        fail(errorCode, 'Apple returned an invalid JSON response.', {
            status: 502,
            cause: error,
        });
    }
}

function normalizeAppleTokenResponse(decoded) {
    const normalized = {
        accessToken: typeof decoded.access_token === 'string'
            ? decoded.access_token
            : null,
        tokenType: typeof decoded.token_type === 'string'
            ? decoded.token_type
            : null,
        expiresIn: Number.isSafeInteger(decoded.expires_in)
            ? decoded.expires_in
            : Number.isSafeInteger(Number(decoded.expires_in))
                ? Number(decoded.expires_in)
                : null,
        refreshToken: typeof decoded.refresh_token === 'string'
            ? decoded.refresh_token
            : null,
        identityToken: typeof decoded.id_token === 'string'
            ? decoded.id_token
            : null,
    };

    if (!normalized.accessToken || !normalized.tokenType) {
        fail(
            'invalid_apple_token_response',
            'Apple token response is missing required fields.',
            { status: 502 }
        );
    }

    return normalized;
}

async function postAppleForm(
    url,
    params,
    {
        fetchImpl = globalThis.fetch,
        timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
        errorCode,
    }
) {
    const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams(params).toString(),
        },
        timeoutMs
    );

    const decoded = await readJsonResponse(response, errorCode);

    if (!response.ok || typeof decoded.error === 'string') {
        const appleCode = typeof decoded.error === 'string'
            ? decoded.error
            : 'unknown_error';

        fail(
            errorCode,
            `Apple rejected the authentication request: ${appleCode}.`,
            { status: 401 }
        );
    }

    return decoded;
}

export async function exchangeAppleAuthorizationCode(
    {
        authorizationCode,
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const code = requireNonEmptyString(
        authorizationCode,
        'authorizationCode',
        8_192
    );

    const clientSecret = createAppleClientSecret(config, { nowSeconds });

    const decoded = await postAppleForm(
        APPLE_TOKEN_URL,
        {
            client_id: config.clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
        },
        {
            fetchImpl,
            timeoutMs,
            errorCode: 'apple_code_exchange_failed',
        }
    );

    return normalizeAppleTokenResponse(decoded);
}

export async function validateAppleRefreshToken(
    {
        refreshToken,
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const token = requireNonEmptyString(
        refreshToken,
        'refreshToken',
        16_384
    );

    const clientSecret = createAppleClientSecret(config, { nowSeconds });

    const decoded = await postAppleForm(
        APPLE_TOKEN_URL,
        {
            client_id: config.clientId,
            client_secret: clientSecret,
            refresh_token: token,
            grant_type: 'refresh_token',
        },
        {
            fetchImpl,
            timeoutMs,
            errorCode: 'apple_refresh_validation_failed',
        }
    );

    return normalizeAppleTokenResponse(decoded);
}

export async function revokeAppleToken(
    {
        token,
        tokenTypeHint = 'refresh_token',
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const cleanToken = requireNonEmptyString(token, 'token', 16_384);

    if (!['refresh_token', 'access_token'].includes(tokenTypeHint)) {
        fail(
            'invalid_input',
            'tokenTypeHint must be refresh_token or access_token.',
            { status: 400 }
        );
    }

    const clientSecret = createAppleClientSecret(config, { nowSeconds });

    await postAppleForm(
        APPLE_REVOKE_URL,
        {
            client_id: config.clientId,
            client_secret: clientSecret,
            token: cleanToken,
            token_type_hint: tokenTypeHint,
        },
        {
            fetchImpl,
            timeoutMs,
            errorCode: 'apple_token_revocation_failed',
        }
    );

    return { success: true };
}

export function createAppleIdentityTokenVerifier(
    {
        config,
        fetchImpl = globalThis.fetch,
        now = () => Date.now(),
        jwksTtlMs = DEFAULT_JWKS_TTL_MS,
        timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
        clockToleranceSeconds = DEFAULT_CLOCK_TOLERANCE_SECONDS,
    }
) {
    if (!config?.clientId) {
        fail('invalid_configuration', 'A valid Apple Sign in configuration is required.');
    }

    const ttl = requirePositiveSafeInteger(jwksTtlMs, 'jwksTtlMs');
    const tolerance = requirePositiveSafeInteger(
        clockToleranceSeconds,
        'clockToleranceSeconds'
    );

    let cachedKeys = new Map();
    let cacheExpiresAt = 0;
    let inFlightFetch = null;

    async function fetchKeys(forceRefresh = false) {
        const currentTime = now();

        if (
            !forceRefresh &&
            cachedKeys.size > 0 &&
            currentTime < cacheExpiresAt
        ) {
            return cachedKeys;
        }

        if (inFlightFetch) {
            return inFlightFetch;
        }

        inFlightFetch = (async () => {
            const response = await fetchWithTimeout(
                fetchImpl,
                APPLE_JWKS_URL,
                {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                },
                timeoutMs
            );

            const decoded = await readJsonResponse(
                response,
                'apple_jwks_failed'
            );

            if (!response.ok || !Array.isArray(decoded.keys)) {
                fail('apple_jwks_failed', 'Unable to load Apple public keys.', {
                    status: 503,
                });
            }

            const nextKeys = new Map();

            for (const jwk of decoded.keys) {
                if (
                    !jwk ||
                    typeof jwk !== 'object' ||
                    typeof jwk.kid !== 'string' ||
                    jwk.kty !== 'RSA' ||
                    (jwk.alg && jwk.alg !== 'RS256')
                ) {
                    continue;
                }

                try {
                    nextKeys.set(
                        jwk.kid,
                        crypto.createPublicKey({
                            key: jwk,
                            format: 'jwk',
                        })
                    );
                } catch {
                    // Skip malformed individual keys. The full response is
                    // rejected below if no usable Apple key remains.
                }
            }

            if (nextKeys.size === 0) {
                fail('apple_jwks_failed', 'Apple returned no usable public keys.', {
                    status: 503,
                });
            }

            cachedKeys = nextKeys;
            cacheExpiresAt = now() + ttl;

            return cachedKeys;
        })();

        try {
            return await inFlightFetch;
        } finally {
            inFlightFetch = null;
        }
    }

    async function resolveKey(kid) {
        let keys = await fetchKeys(false);
        let key = keys.get(kid);

        if (!key) {
            keys = await fetchKeys(true);
            key = keys.get(kid);
        }

        if (!key) {
            fail('invalid_identity_token', 'Apple identity token uses an unknown signing key.', {
                status: 401,
            });
        }

        return key;
    }

    return async function verifyAppleIdentityToken(
        identityToken,
        {
            expectedNonceHash = null,
            expectedSubject = null,
        } = {}
    ) {
        const parsed = parseCompactJwt(identityToken);

        if (
            parsed.header.alg !== 'RS256' ||
            typeof parsed.header.kid !== 'string' ||
            !parsed.header.kid
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity token has an unsupported header.',
                { status: 401 }
            );
        }

        const key = await resolveKey(parsed.header.kid);
        const signatureValid = crypto.verify(
            'RSA-SHA256',
            Buffer.from(parsed.signingInput, 'utf8'),
            key,
            parsed.signature
        );

        if (!signatureValid) {
            fail('invalid_identity_token', 'Apple identity-token signature is invalid.', {
                status: 401,
            });
        }

        const claims = parsed.payload;
        const nowSeconds = Math.floor(now() / 1000);

        if (claims.iss !== APPLE_ISSUER) {
            fail('invalid_identity_token', 'Apple identity-token issuer is invalid.', {
                status: 401,
            });
        }

        const audiences = Array.isArray(claims.aud)
            ? claims.aud
            : [claims.aud];

        if (!audiences.includes(config.clientId)) {
            fail('invalid_identity_token', 'Apple identity-token audience is invalid.', {
                status: 401,
            });
        }

        if (!Number.isSafeInteger(claims.exp)) {
            fail('invalid_identity_token', 'Apple identity-token expiration is invalid.', {
                status: 401,
            });
        }

        if (claims.exp < nowSeconds - tolerance) {
            fail('identity_token_expired', 'Apple identity token has expired.', {
                status: 401,
            });
        }

        if (
            !Number.isSafeInteger(claims.iat) ||
            claims.iat > nowSeconds + tolerance
        ) {
            fail('invalid_identity_token', 'Apple identity-token issue time is invalid.', {
                status: 401,
            });
        }

        const subject = requireNonEmptyString(
            claims.sub,
            'Apple identity-token subject',
            255
        );

        if (
            expectedSubject &&
            !constantTimeStringEqual(subject, expectedSubject)
        ) {
            fail('identity_subject_mismatch', 'Apple identity-token subject does not match.', {
                status: 401,
            });
        }

        if (expectedNonceHash != null) {
            const expected = requireNonEmptyString(
                expectedNonceHash,
                'expectedNonceHash',
                64
            ).toLowerCase();

            if (!SHA256_HEX_RE.test(expected)) {
                fail('invalid_input', 'expectedNonceHash must be a lowercase SHA-256 hex digest.', {
                    status: 400,
                });
            }

            if (
                typeof claims.nonce !== 'string' ||
                !constantTimeStringEqual(claims.nonce.toLowerCase(), expected)
            ) {
                fail('identity_nonce_mismatch', 'Apple identity-token nonce does not match.', {
                    status: 401,
                });
            }
        }

        return Object.freeze({
            issuer: claims.iss,
            audience: config.clientId,
            subject,
            nonce: typeof claims.nonce === 'string'
                ? claims.nonce
                : null,
            email: typeof claims.email === 'string'
                ? claims.email
                : null,
            emailVerified: normalizeBooleanClaim(
                claims.email_verified
            ),
            isPrivateEmail: normalizeBooleanClaim(
                claims.is_private_email
            ),
            issuedAt: claims.iat,
            expiresAt: claims.exp,
            rawClaims: Object.freeze({ ...claims }),
        });
    };
}

export const appleSignInConstants = Object.freeze({
    issuer: APPLE_ISSUER,
    jwksUrl: APPLE_JWKS_URL,
    tokenUrl: APPLE_TOKEN_URL,
    revokeUrl: APPLE_REVOKE_URL,
});
