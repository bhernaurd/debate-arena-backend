import crypto from 'crypto';

const APPLE_ISSUER =
    'https://appleid.apple.com';
const APPLE_JWKS_URL =
    'https://appleid.apple.com/auth/keys';
const APPLE_TOKEN_URL =
    'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL =
    'https://appleid.apple.com/auth/revoke';

const DEFAULT_CLIENT_SECRET_LIFETIME_SECONDS =
    5 * 60;
const MAX_CLIENT_SECRET_LIFETIME_SECONDS =
    60 * 60;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_JWKS_TTL_MS =
    6 * 60 * 60 * 1000;
const DEFAULT_JWKS_STALE_TTL_MS =
    24 * 60 * 60 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const CONFIG_STATE = new WeakMap();

export class AppleSignInError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            appleCode = null,
            cause,
        } = {}
    ) {
        super(
            message,
            cause ? { cause } : undefined
        );

        this.name = 'AppleSignInError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.appleCode = appleCode;
    }
}

function fail(code, message, options) {
    throw new AppleSignInError(
        code,
        message,
        options
    );
}

function requireNonEmptyString(
    value,
    fieldName,
    maxLength = 16_384,
    {
        code = 'invalid_input',
        status = 400,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            code,
            `${fieldName} must be a string.`,
            { status }
        );
    }

    const cleaned = value.trim();

    if (!cleaned) {
        fail(
            code,
            `${fieldName} must not be empty.`,
            { status }
        );
    }

    if (cleaned.length > maxLength) {
        fail(
            code,
            `${fieldName} is too long.`,
            { status }
        );
    }

    return cleaned;
}

function requirePositiveSafeInteger(
    value,
    fieldName
) {
    const numeric =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isSafeInteger(numeric) ||
        numeric <= 0
    ) {
        fail(
            'invalid_configuration',
            `${fieldName} must be a positive safe integer.`
        );
    }

    return numeric;
}

function requireNonNegativeSafeInteger(
    value,
    fieldName
) {
    const numeric =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isSafeInteger(numeric) ||
        numeric < 0
    ) {
        fail(
            'invalid_configuration',
            `${fieldName} must be a non-negative safe integer.`
        );
    }

    return numeric;
}

function normalizePrivateKey(rawValue) {
    return requireNonEmptyString(
        rawValue,
        'APPLE_SIGN_IN_PRIVATE_KEY',
        32_768,
        {
            code: 'invalid_configuration',
            status: 500,
        }
    )
        .replace(/\\n/g, '\n')
        .trim();
}

function requireConfigState(config) {
    const state = CONFIG_STATE.get(config);

    if (!state) {
        fail(
            'invalid_configuration',
            'A valid Apple Sign in configuration is required.'
        );
    }

    return state;
}

export function loadAppleSignInConfig(
    env = process.env
) {
    if (!env || typeof env !== 'object') {
        fail(
            'invalid_configuration',
            'env must be an object.'
        );
    }

    const teamId = requireNonEmptyString(
        env.APPLE_SIGN_IN_TEAM_ID,
        'APPLE_SIGN_IN_TEAM_ID',
        64,
        {
            code: 'invalid_configuration',
            status: 500,
        }
    );

    const keyId = requireNonEmptyString(
        env.APPLE_SIGN_IN_KEY_ID,
        'APPLE_SIGN_IN_KEY_ID',
        64,
        {
            code: 'invalid_configuration',
            status: 500,
        }
    );

    const clientId = requireNonEmptyString(
        env.APPLE_SIGN_IN_CLIENT_ID,
        'APPLE_SIGN_IN_CLIENT_ID',
        255,
        {
            code: 'invalid_configuration',
            status: 500,
        }
    );

    const privateKeyPem = normalizePrivateKey(
        env.APPLE_SIGN_IN_PRIVATE_KEY
    );

    let privateKey;

    try {
        privateKey =
            crypto.createPrivateKey(privateKeyPem);
    } catch (error) {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY is not a valid private key.',
            { cause: error }
        );
    }

    if (
        privateKey.asymmetricKeyType !== 'ec'
    ) {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY must be an EC private key.'
        );
    }

    const namedCurve =
        privateKey.asymmetricKeyDetails?.namedCurve;

    if (
        namedCurve &&
        namedCurve !== 'prime256v1'
    ) {
        fail(
            'invalid_configuration',
            'APPLE_SIGN_IN_PRIVATE_KEY must use the P-256 curve.'
        );
    }

    const config = Object.freeze({
        teamId,
        keyId,
        clientId,
    });

    CONFIG_STATE.set(config, {
        privateKey,
    });

    return config;
}

function base64urlEncode(value) {
    return Buffer.from(value).toString(
        'base64url'
    );
}

function decodeBase64urlCanonical(
    value,
    fieldName
) {
    if (
        typeof value !== 'string' ||
        !value ||
        !BASE64URL_RE.test(value)
    ) {
        fail(
            'invalid_identity_token',
            `${fieldName} is not valid Base64URL.`,
            { status: 401 }
        );
    }

    let decoded;

    try {
        decoded = Buffer.from(
            value,
            'base64url'
        );
    } catch (error) {
        fail(
            'invalid_identity_token',
            `${fieldName} is not valid Base64URL.`,
            {
                status: 401,
                cause: error,
            }
        );
    }

    if (
        decoded.toString('base64url') !==
        value
    ) {
        fail(
            'invalid_identity_token',
            `${fieldName} is not canonical Base64URL.`,
            { status: 401 }
        );
    }

    return decoded;
}

function parseJsonObjectSegment(
    segment,
    fieldName
) {
    const decoded =
        decodeBase64urlCanonical(
            segment,
            fieldName
        );

    try {
        const parsed = JSON.parse(
            decoded.toString('utf8')
        );

        if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
        ) {
            throw new Error(
                'Expected a JSON object.'
            );
        }

        return parsed;
    } catch (error) {
        fail(
            'invalid_identity_token',
            `${fieldName} is not valid JSON.`,
            {
                status: 401,
                cause: error,
            }
        );
    }
}

function constantTimeStringEqual(
    left,
    right
) {
    const leftBuffer = Buffer.from(
        String(left),
        'utf8'
    );

    const rightBuffer = Buffer.from(
        String(right),
        'utf8'
    );

    if (
        leftBuffer.length !==
        rightBuffer.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        leftBuffer,
        rightBuffer
    );
}

function normalizeBooleanClaim(
    value,
    fieldName
) {
    if (value === undefined) {
        return null;
    }

    if (value === true || value === 'true') {
        return true;
    }

    if (
        value === false ||
        value === 'false'
    ) {
        return false;
    }

    fail(
        'invalid_identity_token',
        `${fieldName} claim is invalid.`,
        { status: 401 }
    );
}

function parseCompactJwt(token) {
    const cleaned = requireNonEmptyString(
        token,
        'identityToken',
        32_768
    );

    const segments = cleaned.split('.');

    if (
        segments.length !== 3 ||
        segments.some((segment) => !segment)
    ) {
        fail(
            'invalid_identity_token',
            'Apple identity token must contain three JWT segments.',
            { status: 401 }
        );
    }

    const [
        encodedHeader,
        encodedPayload,
        encodedSignature,
    ] = segments;

    return {
        encodedHeader,
        encodedPayload,
        encodedSignature,
        signingInput:
            `${encodedHeader}.${encodedPayload}`,
        header: parseJsonObjectSegment(
            encodedHeader,
            'identity token header'
        ),
        payload: parseJsonObjectSegment(
            encodedPayload,
            'identity token payload'
        ),
        signature:
            decodeBase64urlCanonical(
                encodedSignature,
                'identity token signature'
            ),
    };
}

export function createAppleClientSecret(
    config,
    {
        nowSeconds =
            Math.floor(Date.now() / 1000),
        lifetimeSeconds =
            DEFAULT_CLIENT_SECRET_LIFETIME_SECONDS,
    } = {}
) {
    if (
        !config?.teamId ||
        !config?.keyId ||
        !config?.clientId
    ) {
        fail(
            'invalid_configuration',
            'A valid Apple Sign in configuration is required.'
        );
    }

    const state = requireConfigState(config);

    const issuedAt =
        requirePositiveSafeInteger(
            nowSeconds,
            'nowSeconds'
        );

    const lifetime =
        requirePositiveSafeInteger(
            lifetimeSeconds,
            'lifetimeSeconds'
        );

    if (
        lifetime >
        MAX_CLIENT_SECRET_LIFETIME_SECONDS
    ) {
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

    const encodedHeader = base64urlEncode(
        JSON.stringify(header)
    );

    const encodedPayload = base64urlEncode(
        JSON.stringify(payload)
    );

    const signingInput =
        `${encodedHeader}.${encodedPayload}`;

    let signature;

    try {
        signature = crypto.sign(
            'sha256',
            Buffer.from(
                signingInput,
                'utf8'
            ),
            {
                key: state.privateKey,
                dsaEncoding: 'ieee-p1363',
            }
        );
    } catch (error) {
        fail(
            'client_secret_generation_failed',
            'Unable to generate Apple client secret.',
            { cause: error }
        );
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
        fail(
            'invalid_configuration',
            'fetch implementation is required.'
        );
    }

    const timeout =
        requirePositiveSafeInteger(
            timeoutMs,
            'timeoutMs'
        );

    const controller =
        new AbortController();

    const timer = setTimeout(
        () => controller.abort(),
        timeout
    );

    try {
        return await fetchImpl(url, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            fail(
                'apple_request_timeout',
                'Apple authentication request timed out.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        fail(
            'apple_request_failed',
            'Apple authentication request failed.',
            {
                status: 503,
                retryable: true,
                cause: error,
            }
        );
    } finally {
        clearTimeout(timer);
    }
}

async function readJsonResponse(
    response,
    errorCode
) {
    let bodyText = '';

    try {
        bodyText = await response.text();
    } catch (error) {
        fail(
            errorCode,
            'Unable to read Apple response.',
            {
                status: 502,
                retryable: true,
                cause: error,
            }
        );
    }

    if (!bodyText) {
        return {};
    }

    try {
        const decoded = JSON.parse(bodyText);

        if (
            !decoded ||
            typeof decoded !== 'object' ||
            Array.isArray(decoded)
        ) {
            throw new Error(
                'Expected a JSON object.'
            );
        }

        return decoded;
    } catch (error) {
        fail(
            errorCode,
            'Apple returned an invalid JSON response.',
            {
                status: 502,
                retryable: true,
                cause: error,
            }
        );
    }
}

function classifyAppleOAuthFailure(
    responseStatus,
    appleCode
) {
    if (appleCode === 'invalid_grant') {
        return {
            status: 401,
            retryable: false,
        };
    }

    if (appleCode === 'invalid_request') {
        return {
            status: 400,
            retryable: false,
        };
    }

    if (
        appleCode === 'invalid_client' ||
        appleCode ===
            'unauthorized_client' ||
        appleCode ===
            'unsupported_grant_type'
    ) {
        return {
            status: 503,
            retryable: false,
        };
    }

    if (
        responseStatus === 429 ||
        responseStatus >= 500 ||
        appleCode === 'server_error' ||
        appleCode ===
            'temporarily_unavailable'
    ) {
        return {
            status: 503,
            retryable: true,
        };
    }

    if (
        responseStatus >= 400 &&
        responseStatus < 500
    ) {
        return {
            status: 401,
            retryable: false,
        };
    }

    return {
        status: 502,
        retryable: true,
    };
}

async function postAppleForm(
    url,
    params,
    {
        fetchImpl = globalThis.fetch,
        timeoutMs =
            DEFAULT_HTTP_TIMEOUT_MS,
        errorCode,
    }
) {
    const response =
        await fetchWithTimeout(
            fetchImpl,
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded',
                    Accept: 'application/json',
                },
                body:
                    new URLSearchParams(params)
                        .toString(),
            },
            timeoutMs
        );

    const decoded =
        await readJsonResponse(
            response,
            errorCode
        );

    if (
        !response.ok ||
        typeof decoded.error === 'string'
    ) {
        const appleCode =
            typeof decoded.error === 'string'
                ? decoded.error
                : null;

        const classification =
            classifyAppleOAuthFailure(
                Number(response.status || 0),
                appleCode
            );

        fail(
            errorCode,
            'Apple rejected the authentication request.',
            {
                ...classification,
                appleCode,
            }
        );
    }

    return decoded;
}

function positiveExpiresIn(value) {
    const parsed =
        typeof value === 'number'
            ? value
            : Number(value);

    if (
        !Number.isSafeInteger(parsed) ||
        parsed <= 0
    ) {
        return null;
    }

    return parsed;
}

function normalizeBearerTokenResponse(
    decoded,
    {
        requireRefreshToken,
        requireIdentityToken,
    }
) {
    const accessToken =
        typeof decoded.access_token ===
            'string' &&
        decoded.access_token.trim()
            ? decoded.access_token
            : null;

    const tokenType =
        typeof decoded.token_type ===
            'string'
            ? decoded.token_type.trim()
            : '';

    const expiresIn =
        positiveExpiresIn(
            decoded.expires_in
        );

    const refreshToken =
        typeof decoded.refresh_token ===
            'string' &&
        decoded.refresh_token.trim()
            ? decoded.refresh_token
            : null;

    const identityToken =
        typeof decoded.id_token ===
            'string' &&
        decoded.id_token.trim()
            ? decoded.id_token
            : null;

    if (
        !accessToken ||
        tokenType.toLowerCase() !==
            'bearer' ||
        !expiresIn ||
        (
            requireRefreshToken &&
            !refreshToken
        ) ||
        (
            requireIdentityToken &&
            !identityToken
        )
    ) {
        fail(
            'invalid_apple_token_response',
            'Apple token response is missing required fields.',
            {
                status: 502,
                retryable: false,
            }
        );
    }

    return Object.freeze({
        accessToken,
        tokenType: 'Bearer',
        expiresIn,
        refreshToken,
        identityToken,
    });
}

export async function exchangeAppleAuthorizationCode(
    {
        authorizationCode,
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs =
            DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const code = requireNonEmptyString(
        authorizationCode,
        'authorizationCode',
        8_192
    );

    const clientSecret =
        createAppleClientSecret(
            config,
            { nowSeconds }
        );

    const decoded = await postAppleForm(
        APPLE_TOKEN_URL,
        {
            client_id: config.clientId,
            client_secret: clientSecret,
            code,
            grant_type:
                'authorization_code',
        },
        {
            fetchImpl,
            timeoutMs,
            errorCode:
                'apple_code_exchange_failed',
        }
    );

    return normalizeBearerTokenResponse(
        decoded,
        {
            requireRefreshToken: true,
            requireIdentityToken: true,
        }
    );
}

export async function validateAppleRefreshToken(
    {
        refreshToken,
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs =
            DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const token = requireNonEmptyString(
        refreshToken,
        'refreshToken',
        16_384
    );

    const clientSecret =
        createAppleClientSecret(
            config,
            { nowSeconds }
        );

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
            errorCode:
                'apple_refresh_validation_failed',
        }
    );

    return normalizeBearerTokenResponse(
        decoded,
        {
            requireRefreshToken: false,
            requireIdentityToken: false,
        }
    );
}

export async function revokeAppleToken(
    {
        token,
        tokenTypeHint =
            'refresh_token',
        config,
        fetchImpl = globalThis.fetch,
        timeoutMs =
            DEFAULT_HTTP_TIMEOUT_MS,
        nowSeconds,
    }
) {
    const cleanToken =
        requireNonEmptyString(
            token,
            'token',
            16_384
        );

    if (
        ![
            'refresh_token',
            'access_token',
        ].includes(tokenTypeHint)
    ) {
        fail(
            'invalid_input',
            'tokenTypeHint must be refresh_token or access_token.',
            { status: 400 }
        );
    }

    const clientSecret =
        createAppleClientSecret(
            config,
            { nowSeconds }
        );

    await postAppleForm(
        APPLE_REVOKE_URL,
        {
            client_id: config.clientId,
            client_secret: clientSecret,
            token: cleanToken,
            token_type_hint:
                tokenTypeHint,
        },
        {
            fetchImpl,
            timeoutMs,
            errorCode:
                'apple_token_revocation_failed',
        }
    );

    return Object.freeze({
        success: true,
    });
}

export function createAppleIdentityTokenVerifier(
    {
        config,
        fetchImpl = globalThis.fetch,
        now = () => Date.now(),
        jwksTtlMs = DEFAULT_JWKS_TTL_MS,
        jwksStaleTtlMs =
            DEFAULT_JWKS_STALE_TTL_MS,
        timeoutMs =
            DEFAULT_HTTP_TIMEOUT_MS,
        clockToleranceSeconds =
            DEFAULT_CLOCK_TOLERANCE_SECONDS,
    }
) {
    if (!config?.clientId) {
        fail(
            'invalid_configuration',
            'A valid Apple Sign in configuration is required.'
        );
    }

    const ttl =
        requirePositiveSafeInteger(
            jwksTtlMs,
            'jwksTtlMs'
        );

    const staleTtl =
        requireNonNegativeSafeInteger(
            jwksStaleTtlMs,
            'jwksStaleTtlMs'
        );

    const tolerance =
        requireNonNegativeSafeInteger(
            clockToleranceSeconds,
            'clockToleranceSeconds'
        );

    let cachedKeys = new Map();
    let cacheExpiresAt = 0;
    let cacheStaleUntil = 0;
    let inFlightFetch = null;

    async function refreshKeys() {
        if (inFlightFetch) {
            return inFlightFetch;
        }

        inFlightFetch = (async () => {
            const response =
                await fetchWithTimeout(
                    fetchImpl,
                    APPLE_JWKS_URL,
                    {
                        method: 'GET',
                        headers: {
                            Accept:
                                'application/json',
                        },
                    },
                    timeoutMs
                );

            const decoded =
                await readJsonResponse(
                    response,
                    'apple_jwks_failed'
                );

            if (
                !response.ok ||
                !Array.isArray(
                    decoded.keys
                )
            ) {
                fail(
                    'apple_jwks_failed',
                    'Unable to load Apple public keys.',
                    {
                        status: 503,
                        retryable: true,
                    }
                );
            }

            const nextKeys = new Map();

            for (const jwk of decoded.keys) {
                if (
                    !jwk ||
                    typeof jwk !==
                        'object' ||
                    typeof jwk.kid !==
                        'string' ||
                    !jwk.kid ||
                    jwk.kty !== 'RSA' ||
                    (
                        jwk.alg &&
                        jwk.alg !== 'RS256'
                    ) ||
                    (
                        jwk.use &&
                        jwk.use !== 'sig'
                    ) ||
                    (
                        Array.isArray(
                            jwk.key_ops
                        ) &&
                        !jwk.key_ops.includes(
                            'verify'
                        )
                    )
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
                    // Skip malformed individual
                    // keys. Reject the response
                    // below if no usable key
                    // remains.
                }
            }

            if (nextKeys.size === 0) {
                fail(
                    'apple_jwks_failed',
                    'Apple returned no usable public keys.',
                    {
                        status: 503,
                        retryable: true,
                    }
                );
            }

            const refreshedAt = now();

            cachedKeys = nextKeys;
            cacheExpiresAt =
                refreshedAt + ttl;
            cacheStaleUntil =
                cacheExpiresAt + staleTtl;

            return cachedKeys;
        })();

        try {
            return await inFlightFetch;
        } finally {
            inFlightFetch = null;
        }
    }

    async function resolveKey(kid) {
        const currentTime = now();
        const cachedKey =
            cachedKeys.get(kid);

        if (
            cachedKey &&
            currentTime < cacheExpiresAt
        ) {
            return cachedKey;
        }

        try {
            const refreshedKeys =
                await refreshKeys();

            const refreshedKey =
                refreshedKeys.get(kid);

            if (refreshedKey) {
                return refreshedKey;
            }
        } catch (error) {
            if (
                cachedKey &&
                currentTime <
                    cacheStaleUntil
            ) {
                return cachedKey;
            }

            throw error;
        }

        fail(
            'invalid_identity_token',
            'Apple identity token uses an unknown signing key.',
            { status: 401 }
        );
    }

    return async function verifyAppleIdentityToken(
        identityToken,
        {
            expectedNonceHash = null,
            expectedSubject = null,
        } = {}
    ) {
        const parsed =
            parseCompactJwt(identityToken);

        if (
            parsed.header.alg !==
                'RS256' ||
            typeof parsed.header.kid !==
                'string' ||
            !parsed.header.kid
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity token has an unsupported header.',
                { status: 401 }
            );
        }

        const key = await resolveKey(
            parsed.header.kid
        );

        const signatureValid =
            crypto.verify(
                'RSA-SHA256',
                Buffer.from(
                    parsed.signingInput,
                    'utf8'
                ),
                key,
                parsed.signature
            );

        if (!signatureValid) {
            fail(
                'invalid_identity_token',
                'Apple identity-token signature is invalid.',
                { status: 401 }
            );
        }

        const claims = parsed.payload;
        const nowSeconds =
            Math.floor(now() / 1000);

        if (claims.iss !== APPLE_ISSUER) {
            fail(
                'invalid_identity_token',
                'Apple identity-token issuer is invalid.',
                { status: 401 }
            );
        }

        const audiences =
            Array.isArray(claims.aud)
                ? claims.aud
                : [claims.aud];

        if (
            !audiences.every(
                (audience) =>
                    typeof audience ===
                    'string'
            ) ||
            !audiences.includes(
                config.clientId
            )
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity-token audience is invalid.',
                { status: 401 }
            );
        }

        if (
            !Number.isSafeInteger(
                claims.exp
            )
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity-token expiration is invalid.',
                { status: 401 }
            );
        }

        if (
            claims.exp <
            nowSeconds - tolerance
        ) {
            fail(
                'identity_token_expired',
                'Apple identity token has expired.',
                { status: 401 }
            );
        }

        if (
            !Number.isSafeInteger(
                claims.iat
            ) ||
            claims.iat >
                nowSeconds + tolerance
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity-token issue time is invalid.',
                { status: 401 }
            );
        }

        const subject =
            requireNonEmptyString(
                claims.sub,
                'Apple identity-token subject',
                255,
                {
                    code:
                        'invalid_identity_token',
                    status: 401,
                }
            );

        if (expectedSubject != null) {
            const expected =
                requireNonEmptyString(
                    expectedSubject,
                    'expectedSubject',
                    255
                );

            if (
                !constantTimeStringEqual(
                    subject,
                    expected
                )
            ) {
                fail(
                    'identity_subject_mismatch',
                    'Apple identity-token subject does not match.',
                    { status: 401 }
                );
            }
        }

        let nonce = null;

        if (
            typeof claims.nonce ===
            'string'
        ) {
            nonce = claims.nonce;
        } else if (
            claims.nonce !== undefined
        ) {
            fail(
                'invalid_identity_token',
                'Apple identity-token nonce is invalid.',
                { status: 401 }
            );
        }

        if (expectedNonceHash != null) {
            const expected =
                requireNonEmptyString(
                    expectedNonceHash,
                    'expectedNonceHash',
                    64
                );

            if (
                !SHA256_HEX_RE.test(
                    expected
                )
            ) {
                fail(
                    'invalid_input',
                    'expectedNonceHash must be a lowercase SHA-256 hex digest.',
                    { status: 400 }
                );
            }

            if (
                !nonce ||
                !SHA256_HEX_RE.test(nonce) ||
                !constantTimeStringEqual(
                    nonce,
                    expected
                )
            ) {
                fail(
                    'identity_nonce_mismatch',
                    'Apple identity-token nonce does not match.',
                    { status: 401 }
                );
            }
        }

        let email = null;

        if (claims.email !== undefined) {
            email =
                requireNonEmptyString(
                    claims.email,
                    'Apple identity-token email',
                    320,
                    {
                        code:
                            'invalid_identity_token',
                        status: 401,
                    }
                );
        }

        return Object.freeze({
            issuer: claims.iss,
            audience: config.clientId,
            subject,
            nonce,
            email,
            emailVerified:
                normalizeBooleanClaim(
                    claims.email_verified,
                    'email_verified'
                ),
            isPrivateEmail:
                normalizeBooleanClaim(
                    claims.is_private_email,
                    'is_private_email'
                ),
            issuedAt: claims.iat,
            expiresAt: claims.exp,
        });
    };
}

export const appleSignInConstants =
    Object.freeze({
        issuer: APPLE_ISSUER,
        jwksUrl: APPLE_JWKS_URL,
        tokenUrl: APPLE_TOKEN_URL,
        revokeUrl: APPLE_REVOKE_URL,
        maximumClientSecretLifetimeSeconds:
            MAX_CLIENT_SECRET_LIFETIME_SECONDS,
    });
