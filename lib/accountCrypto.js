import crypto from 'crypto';

const ACCESS_TOKEN_HEADER = Object.freeze({
    alg: 'HS256',
    typ: 'AGORA',
    v: 1,
});

const ACCESS_TOKEN_TTL_SECONDS_DEFAULT = 15 * 60;
const ACCESS_TOKEN_TTL_SECONDS_MAX = 60 * 60;
const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS_DEFAULT = 30;

const ACCESS_TOKEN_ISSUER_DEFAULT =
    'com.bhernaurd.TheAgora.backend';
const ACCESS_TOKEN_AUDIENCE_DEFAULT =
    'com.bhernaurd.TheAgora';

const APPLE_REFRESH_TOKEN_ENVELOPE_VERSION = 2;
const APPLE_REFRESH_TOKEN_AAD_PREFIX =
    'agora:apple-refresh-token:v2';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CANONICAL_POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;

const CONFIG_STATE = new WeakMap();

export class AccountCryptoError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AccountCryptoError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new AccountCryptoError(code, message);
}

function requireNonEmptyString(
    value,
    fieldName,
    maxLength = 16_384
) {
    if (typeof value !== 'string') {
        fail('invalid_input', `${fieldName} must be a string.`);
    }

    const cleaned = value.trim();

    if (!cleaned) {
        fail('invalid_input', `${fieldName} must not be empty.`);
    }

    if (cleaned.length > maxLength) {
        fail('invalid_input', `${fieldName} is too long.`);
    }

    return cleaned;
}

function parseCanonicalPositiveInteger(
    value,
    fieldName,
    errorCode = 'invalid_input'
) {
    if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0
    ) {
        return value;
    }

    if (
        typeof value === 'string' &&
        CANONICAL_POSITIVE_INTEGER_RE.test(value)
    ) {
        const parsed = Number(value);

        if (Number.isSafeInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }

    fail(
        errorCode,
        `${fieldName} must be a canonical positive integer.`
    );
}

function decodeStrictBase64(
    value,
    expectedBytes,
    fieldName
) {
    const cleaned = requireNonEmptyString(
        value,
        fieldName,
        4_096
    );

    if (
        cleaned.length % 4 !== 0 ||
        !BASE64_RE.test(cleaned)
    ) {
        fail('invalid_key', `${fieldName} is not valid Base64.`);
    }

    const decoded = Buffer.from(cleaned, 'base64');

    if (decoded.toString('base64') !== cleaned) {
        fail(
            'invalid_key',
            `${fieldName} is not canonical Base64.`
        );
    }

    if (decoded.length !== expectedBytes) {
        fail(
            'invalid_key',
            `${fieldName} must decode to exactly ${expectedBytes} bytes.`
        );
    }

    return Buffer.from(decoded);
}

function base64urlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64urlDecodeCanonical(value, fieldName) {
    if (
        typeof value !== 'string' ||
        !value ||
        !BASE64URL_RE.test(value)
    ) {
        fail(
            'malformed_token',
            `${fieldName} is not valid Base64URL.`
        );
    }

    let decoded;

    try {
        decoded = Buffer.from(value, 'base64url');
    } catch {
        fail(
            'malformed_token',
            `${fieldName} is not valid Base64URL.`
        );
    }

    if (decoded.toString('base64url') !== value) {
        fail(
            'malformed_token',
            `${fieldName} is not canonical Base64URL.`
        );
    }

    return decoded;
}

function parseJsonObjectSegment(segment, fieldName) {
    const decoded = base64urlDecodeCanonical(
        segment,
        fieldName
    );

    try {
        const parsed = JSON.parse(decoded.toString('utf8'));

        if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed)
        ) {
            throw new Error('Expected a JSON object.');
        }

        return parsed;
    } catch {
        fail(
            'malformed_token',
            `${fieldName} is not valid JSON.`
        );
    }
}

function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        leftBuffer,
        rightBuffer
    );
}

function loadVersionedKeysFromEnvironment(
    env,
    {
        keyPrefix,
        activeVersionName,
        expectedBytes,
    }
) {
    const activeVersion = parseCanonicalPositiveInteger(
        env[activeVersionName],
        activeVersionName,
        'invalid_key'
    );

    const escapedPrefix = keyPrefix.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
    );

    const keyPattern = new RegExp(
        `^${escapedPrefix}_V([0-9]+)$`
    );

    const keys = new Map();

    for (const [name, rawValue] of Object.entries(env)) {
        const match = keyPattern.exec(name);

        if (
            !match ||
            rawValue == null ||
            rawValue === ''
        ) {
            continue;
        }

        const version = parseCanonicalPositiveInteger(
            match[1],
            `${name} version`,
            'invalid_key'
        );

        if (keys.has(version)) {
            fail(
                'invalid_key',
                `Duplicate ${keyPrefix} key version ${version}.`
            );
        }

        keys.set(
            version,
            decodeStrictBase64(
                rawValue,
                expectedBytes,
                name
            )
        );
    }

    if (!keys.has(activeVersion)) {
        fail(
            'invalid_key',
            `${keyPrefix}_V${activeVersion} is required by ${activeVersionName}.`
        );
    }

    return {
        activeVersion,
        keys,
    };
}

function publicKeyMetadata(keyState) {
    return Object.freeze({
        activeVersion: keyState.activeVersion,
        availableVersions: Object.freeze(
            [...keyState.keys.keys()].sort(
                (left, right) => left - right
            )
        ),
    });
}

function requireCryptoState(config) {
    const state = CONFIG_STATE.get(config);

    if (!state) {
        fail(
            'invalid_key',
            'A valid account crypto configuration is required.'
        );
    }

    return state;
}

function requireUuid(value, fieldName) {
    const cleaned = requireNonEmptyString(
        value,
        fieldName,
        64
    );

    if (!UUID_RE.test(cleaned)) {
        fail(
            'invalid_input',
            `${fieldName} must be a UUID.`
        );
    }

    return cleaned.toLowerCase();
}

function normalizeAppleRefreshTokenBinding(binding) {
    if (
        !binding ||
        typeof binding !== 'object' ||
        Array.isArray(binding)
    ) {
        fail(
            'invalid_input',
            'Apple refresh-token binding must be an object.'
        );
    }

    return Object.freeze({
        identityId: requireUuid(
            binding.identityId,
            'identityId'
        ),
        accountId: requireUuid(
            binding.accountId,
            'accountId'
        ),
        issuer: requireNonEmptyString(
            binding.issuer,
            'issuer',
            255
        ),
        audience: requireNonEmptyString(
            binding.audience,
            'audience',
            255
        ),
        subject: requireNonEmptyString(
            binding.subject,
            'subject',
            255
        ),
    });
}

function encryptionAad(keyVersion, binding) {
    const normalizedBinding =
        normalizeAppleRefreshTokenBinding(binding);

    return Buffer.from(
        JSON.stringify({
            prefix: APPLE_REFRESH_TOKEN_AAD_PREFIX,
            keyVersion,
            identityId: normalizedBinding.identityId,
            accountId: normalizedBinding.accountId,
            issuer: normalizedBinding.issuer,
            audience: normalizedBinding.audience,
            subject: normalizedBinding.subject,
        }),
        'utf8'
    );
}

function normalizeAccessTokenClaims(claims) {
    if (
        !claims ||
        typeof claims !== 'object' ||
        Array.isArray(claims)
    ) {
        fail(
            'invalid_claims',
            'Access-token claims must be an object.'
        );
    }

    const accountId = requireNonEmptyString(
        claims.accountId,
        'accountId',
        64
    );
    const sessionId = requireNonEmptyString(
        claims.sessionId,
        'sessionId',
        64
    );
    const installationId = requireNonEmptyString(
        claims.installationId,
        'installationId',
        128
    );
    const authVersion = parseCanonicalPositiveInteger(
        claims.authVersion,
        'authVersion'
    );

    if (!UUID_RE.test(accountId)) {
        fail(
            'invalid_claims',
            'accountId must be a UUID.'
        );
    }

    if (!UUID_RE.test(sessionId)) {
        fail(
            'invalid_claims',
            'sessionId must be a UUID.'
        );
    }

    if (!INSTALLATION_ID_RE.test(installationId)) {
        fail(
            'invalid_claims',
            'installationId has an invalid format.'
        );
    }

    return {
        accountId: accountId.toLowerCase(),
        sessionId: sessionId.toLowerCase(),
        installationId,
        authVersion,
    };
}

function validateTokenIdentifier(value) {
    if (
        typeof value !== 'string' ||
        !BASE64URL_RE.test(value)
    ) {
        fail(
            'invalid_claims',
            'Access-token ID is invalid.'
        );
    }

    const decoded = base64urlDecodeCanonical(
        value,
        'access-token ID'
    );

    if (decoded.length !== 16) {
        fail(
            'invalid_claims',
            'Access-token ID is invalid.'
        );
    }

    return value;
}

export function loadAccountCryptoConfig(
    env = process.env
) {
    if (!env || typeof env !== 'object') {
        fail(
            'invalid_input',
            'env must be an object.'
        );
    }

    const encryptionState =
        loadVersionedKeysFromEnvironment(env, {
            keyPrefix:
                'APPLE_REFRESH_TOKEN_ENCRYPTION_KEY',
            activeVersionName:
                'APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION',
            expectedBytes: 32,
        });

    const signingState =
        loadVersionedKeysFromEnvironment(env, {
            keyPrefix:
                'AGORA_ACCESS_TOKEN_SIGNING_KEY',
            activeVersionName:
                'AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION',
            expectedBytes: 64,
        });

    const issuer = env.AGORA_ACCESS_TOKEN_ISSUER
        ? requireNonEmptyString(
            env.AGORA_ACCESS_TOKEN_ISSUER,
            'AGORA_ACCESS_TOKEN_ISSUER',
            255
        )
        : ACCESS_TOKEN_ISSUER_DEFAULT;

    const audience = env.AGORA_ACCESS_TOKEN_AUDIENCE
        ? requireNonEmptyString(
            env.AGORA_ACCESS_TOKEN_AUDIENCE,
            'AGORA_ACCESS_TOKEN_AUDIENCE',
            255
        )
        : ACCESS_TOKEN_AUDIENCE_DEFAULT;

    const config = Object.freeze({
        appleRefreshTokenEncryption:
            publicKeyMetadata(encryptionState),
        agoraAccessTokenSigning:
            publicKeyMetadata(signingState),
        accessTokenIssuer: issuer,
        accessTokenAudience: audience,
    });

    CONFIG_STATE.set(config, {
        appleRefreshTokenEncryption:
            encryptionState,
        agoraAccessTokenSigning:
            signingState,
        accessTokenIssuer: issuer,
        accessTokenAudience: audience,
    });

    return config;
}

export function encryptAppleRefreshToken(
    plaintext,
    config,
    binding
) {
    const cleanPlaintext = requireNonEmptyString(
        plaintext,
        'Apple refresh token',
        16_384
    );

    const state = requireCryptoState(config);
    const encryptionState =
        state.appleRefreshTokenEncryption;
    const keyVersion =
        encryptionState.activeVersion;
    const key = encryptionState.keys.get(keyVersion);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        key,
        iv,
        { authTagLength: 16 }
    );

    cipher.setAAD(
        encryptionAad(keyVersion, binding)
    );

    const ciphertext = Buffer.concat([
        cipher.update(cleanPlaintext, 'utf8'),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        'agoraenc',
        String(
            APPLE_REFRESH_TOKEN_ENVELOPE_VERSION
        ),
        String(keyVersion),
        base64urlEncode(iv),
        base64urlEncode(ciphertext),
        base64urlEncode(authTag),
    ].join('.');
}

export function decryptAppleRefreshToken(
    serialized,
    config,
    binding
) {
    const cleanSerialized = requireNonEmptyString(
        serialized,
        'Encrypted Apple refresh token',
        32_768
    );

    const parts = cleanSerialized.split('.');

    if (
        parts.length !== 6 ||
        parts[0] !== 'agoraenc' ||
        parts[1] !== String(
            APPLE_REFRESH_TOKEN_ENVELOPE_VERSION
        )
    ) {
        fail(
            'malformed_ciphertext',
            'Encrypted Apple refresh token has an unsupported format.'
        );
    }

    const keyVersion =
        parseCanonicalPositiveInteger(
            parts[2],
            'encrypted token key version',
            'malformed_ciphertext'
        );

    const state = requireCryptoState(config);
    const key =
        state.appleRefreshTokenEncryption.keys.get(
            keyVersion
        );

    if (!key) {
        fail(
            'unknown_key_version',
            `No Apple refresh-token encryption key exists for V${keyVersion}.`
        );
    }

    const iv = base64urlDecodeCanonical(
        parts[3],
        'encryption IV'
    );
    const ciphertext = base64urlDecodeCanonical(
        parts[4],
        'encrypted token ciphertext'
    );
    const authTag = base64urlDecodeCanonical(
        parts[5],
        'encrypted token authentication tag'
    );

    if (
        iv.length !== 12 ||
        authTag.length !== 16 ||
        ciphertext.length === 0
    ) {
        fail(
            'malformed_ciphertext',
            'Encrypted Apple refresh token has invalid AES-GCM parameters.'
        );
    }

    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            iv,
            { authTagLength: 16 }
        );

        decipher.setAAD(
            encryptionAad(keyVersion, binding)
        );
        decipher.setAuthTag(authTag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');

        if (!plaintext) {
            fail(
                'decryption_failed',
                'Decrypted Apple refresh token was empty.'
            );
        }

        return plaintext;
    } catch (error) {
        if (error instanceof AccountCryptoError) {
            throw error;
        }

        fail(
            'decryption_failed',
            'Encrypted Apple refresh token could not be authenticated.'
        );
    }
}

export function generateAgoraRefreshToken() {
    return base64urlEncode(
        crypto.randomBytes(48)
    );
}

export function hashToken(token) {
    const cleanToken = requireNonEmptyString(
        token,
        'Token',
        32_768
    );

    return crypto
        .createHash('sha256')
        .update(cleanToken, 'utf8')
        .digest('hex');
}

export function issueAgoraAccessToken(
    claims,
    config,
    options = {}
) {
    const normalizedClaims =
        normalizeAccessTokenClaims(claims);
    const state = requireCryptoState(config);
    const signingState =
        state.agoraAccessTokenSigning;
    const keyVersion = signingState.activeVersion;
    const signingKey =
        signingState.keys.get(keyVersion);

    const nowMilliseconds =
        options.nowMilliseconds ?? Date.now();

    if (
        !Number.isFinite(nowMilliseconds) ||
        nowMilliseconds < 0
    ) {
        fail(
            'invalid_input',
            'nowMilliseconds is invalid.'
        );
    }

    const expiresInSeconds =
        options.expiresInSeconds ??
        ACCESS_TOKEN_TTL_SECONDS_DEFAULT;

    if (
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds <= 0 ||
        expiresInSeconds >
            ACCESS_TOKEN_TTL_SECONDS_MAX
    ) {
        fail(
            'invalid_input',
            `expiresInSeconds must be between 1 and ${ACCESS_TOKEN_TTL_SECONDS_MAX}.`
        );
    }

    const issuedAt = Math.floor(
        nowMilliseconds / 1_000
    );
    const expiresAt =
        issuedAt + expiresInSeconds;

    const header = {
        ...ACCESS_TOKEN_HEADER,
        kid: String(keyVersion),
    };

    const payload = {
        iss: state.accessTokenIssuer,
        aud: state.accessTokenAudience,
        sub: normalizedClaims.accountId,
        sid: normalizedClaims.sessionId,
        iid: normalizedClaims.installationId,
        av: normalizedClaims.authVersion,
        iat: issuedAt,
        exp: expiresAt,
        jti: base64urlEncode(
            crypto.randomBytes(16)
        ),
    };

    const encodedHeader = base64urlEncode(
        JSON.stringify(header)
    );
    const encodedPayload = base64urlEncode(
        JSON.stringify(payload)
    );
    const signingInput =
        `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
        .createHmac('sha256', signingKey)
        .update(signingInput, 'utf8')
        .digest();

    return {
        token:
            `${signingInput}.${base64urlEncode(signature)}`,
        expiresAt: new Date(expiresAt * 1_000),
        issuedAt: new Date(issuedAt * 1_000),
        keyVersion,
    };
}

export function verifyAgoraAccessToken(
    token,
    config,
    options = {}
) {
    const cleanToken = requireNonEmptyString(
        token,
        'Access token',
        16_384
    );

    const parts = cleanToken.split('.');

    if (parts.length !== 3) {
        fail(
            'malformed_token',
            'Access token must have three segments.'
        );
    }

    const [
        encodedHeader,
        encodedPayload,
        encodedSignature,
    ] = parts;

    const header = parseJsonObjectSegment(
        encodedHeader,
        'access-token header'
    );

    const payload = parseJsonObjectSegment(
        encodedPayload,
        'access-token payload'
    );

    if (
        header.alg !== ACCESS_TOKEN_HEADER.alg ||
        header.typ !== ACCESS_TOKEN_HEADER.typ ||
        header.v !== ACCESS_TOKEN_HEADER.v
    ) {
        fail(
            'unsupported_token',
            'Access token header is unsupported.'
        );
    }

    const keyVersion =
        parseCanonicalPositiveInteger(
            header.kid,
            'access-token key version',
            'unsupported_token'
        );

    const state = requireCryptoState(config);
    const signingKey =
        state.agoraAccessTokenSigning.keys.get(
            keyVersion
        );

    if (!signingKey) {
        fail(
            'unknown_key_version',
            `No Agora access-token signing key exists for V${keyVersion}.`
        );
    }

    const providedSignature =
        base64urlDecodeCanonical(
            encodedSignature,
            'access-token signature'
        );

    const signingInput =
        `${encodedHeader}.${encodedPayload}`;

    const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(signingInput, 'utf8')
        .digest();

    if (
        !constantTimeEqual(
            providedSignature,
            expectedSignature
        )
    ) {
        fail(
            'invalid_signature',
            'Access-token signature is invalid.'
        );
    }

    if (
        payload.iss !== state.accessTokenIssuer ||
        payload.aud !== state.accessTokenAudience
    ) {
        fail(
            'invalid_claims',
            'Access-token issuer or audience is invalid.'
        );
    }

    const normalizedClaims =
        normalizeAccessTokenClaims({
            accountId: payload.sub,
            sessionId: payload.sid,
            installationId: payload.iid,
            authVersion: payload.av,
        });

    if (
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp <= payload.iat
    ) {
        fail(
            'invalid_claims',
            'Access-token time claims are invalid.'
        );
    }

    const tokenLifetimeSeconds =
        payload.exp - payload.iat;

    if (
        tokenLifetimeSeconds >
        ACCESS_TOKEN_TTL_SECONDS_MAX
    ) {
        fail(
            'invalid_claims',
            'Access-token lifetime exceeds the maximum.'
        );
    }

    const tokenId = validateTokenIdentifier(
        payload.jti
    );

    const nowMilliseconds =
        options.nowMilliseconds ?? Date.now();

    if (
        !Number.isFinite(nowMilliseconds) ||
        nowMilliseconds < 0
    ) {
        fail(
            'invalid_input',
            'nowMilliseconds is invalid.'
        );
    }

    const clockToleranceSeconds =
        options.clockToleranceSeconds ??
        ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS_DEFAULT;

    if (
        !Number.isSafeInteger(
            clockToleranceSeconds
        ) ||
        clockToleranceSeconds < 0 ||
        clockToleranceSeconds > 300
    ) {
        fail(
            'invalid_input',
            'clockToleranceSeconds must be between 0 and 300.'
        );
    }

    const nowSeconds = Math.floor(
        nowMilliseconds / 1_000
    );

    if (
        payload.iat >
        nowSeconds + clockToleranceSeconds
    ) {
        fail(
            'token_not_yet_valid',
            'Access token was issued in the future.'
        );
    }

    if (
        payload.exp <=
        nowSeconds - clockToleranceSeconds
    ) {
        fail(
            'token_expired',
            'Access token has expired.'
        );
    }

    return Object.freeze({
        issuer: payload.iss,
        audience: payload.aud,
        accountId: normalizedClaims.accountId,
        sessionId: normalizedClaims.sessionId,
        installationId:
            normalizedClaims.installationId,
        authVersion:
            normalizedClaims.authVersion,
        issuedAt:
            new Date(payload.iat * 1_000),
        expiresAt:
            new Date(payload.exp * 1_000),
        tokenId,
        keyVersion,
    });
}

export function isSha256Hex(value) {
    return (
        typeof value === 'string' &&
        SHA256_HEX_RE.test(value)
    );
}

export const accountCryptoConstants =
    Object.freeze({
        accessTokenIssuer:
            ACCESS_TOKEN_ISSUER_DEFAULT,
        accessTokenAudience:
            ACCESS_TOKEN_AUDIENCE_DEFAULT,
        accessTokenMaximumLifetimeSeconds:
            ACCESS_TOKEN_TTL_SECONDS_MAX,
        appleRefreshTokenEnvelopeVersion:
            APPLE_REFRESH_TOKEN_ENVELOPE_VERSION,
    });
