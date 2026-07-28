import crypto from 'crypto';

const ACCESS_TOKEN_HEADER = Object.freeze({
    alg: 'HS256',
    typ: 'AGORA',
    v: 1,
});

const ACCESS_TOKEN_TTL_SECONDS_DEFAULT = 15 * 60;
const ACCESS_TOKEN_TTL_SECONDS_MAX = 60 * 60;
const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS_DEFAULT = 30;
const APPLE_REFRESH_TOKEN_AAD_PREFIX = 'agora:apple-refresh-token:v1';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

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

function requireNonEmptyString(value, fieldName, maxLength = 16_384) {
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

function requirePositiveSafeInteger(value, fieldName) {
    const numeric = typeof value === 'number'
        ? value
        : Number(value);

    if (
        !Number.isSafeInteger(numeric) ||
        numeric <= 0
    ) {
        fail(
            'invalid_input',
            `${fieldName} must be a positive safe integer.`
        );
    }

    return numeric;
}

function decodeStrictBase64(value, expectedBytes, fieldName) {
    const cleaned = requireNonEmptyString(value, fieldName, 4_096);

    if (
        cleaned.length % 4 !== 0 ||
        !BASE64_RE.test(cleaned)
    ) {
        fail('invalid_key', `${fieldName} is not valid Base64.`);
    }

    const decoded = Buffer.from(cleaned, 'base64');
    const normalized = decoded.toString('base64');

    if (normalized !== cleaned) {
        fail('invalid_key', `${fieldName} is not canonical Base64.`);
    }

    if (decoded.length !== expectedBytes) {
        fail(
            'invalid_key',
            `${fieldName} must decode to exactly ${expectedBytes} bytes.`
        );
    }

    return decoded;
}

function base64urlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64urlDecode(value, fieldName) {
    if (
        typeof value !== 'string' ||
        !value ||
        !BASE64URL_RE.test(value)
    ) {
        fail('malformed_token', `${fieldName} is not valid Base64URL.`);
    }

    try {
        return Buffer.from(value, 'base64url');
    } catch {
        fail('malformed_token', `${fieldName} is not valid Base64URL.`);
    }
}

function parseJsonSegment(segment, fieldName) {
    const decoded = base64urlDecode(segment, fieldName);

    try {
        return JSON.parse(decoded.toString('utf8'));
    } catch {
        fail('malformed_token', `${fieldName} is not valid JSON.`);
    }
}

function constantTimeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeKeyMap(keys, expectedBytes, fieldName) {
    if (!(keys instanceof Map) || keys.size === 0) {
        fail('invalid_key', `${fieldName} must be a non-empty Map.`);
    }

    const normalized = new Map();

    for (const [versionValue, keyValue] of keys.entries()) {
        const version = requirePositiveSafeInteger(
            versionValue,
            `${fieldName} version`
        );

        const key = Buffer.isBuffer(keyValue)
            ? Buffer.from(keyValue)
            : decodeStrictBase64(
                keyValue,
                expectedBytes,
                `${fieldName} V${version}`
            );

        if (key.length !== expectedBytes) {
            fail(
                'invalid_key',
                `${fieldName} V${version} must be ${expectedBytes} bytes.`
            );
        }

        normalized.set(version, key);
    }

    return normalized;
}

function loadVersionedKeysFromEnvironment(
    env,
    {
        keyPrefix,
        activeVersionName,
        expectedBytes,
    }
) {
    const activeVersion = requirePositiveSafeInteger(
        env[activeVersionName],
        activeVersionName
    );

    const keyPattern = new RegExp(
        `^${keyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_V(\\d+)$`
    );

    const keys = new Map();

    for (const [name, rawValue] of Object.entries(env)) {
        const match = keyPattern.exec(name);

        if (!match || rawValue == null || rawValue === '') {
            continue;
        }

        const version = requirePositiveSafeInteger(
            match[1],
            `${name} version`
        );

        keys.set(
            version,
            decodeStrictBase64(rawValue, expectedBytes, name)
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

export function loadAccountCryptoConfig(env = process.env) {
    if (!env || typeof env !== 'object') {
        fail('invalid_input', 'env must be an object.');
    }

    return {
        appleRefreshTokenEncryption:
            loadVersionedKeysFromEnvironment(env, {
                keyPrefix: 'APPLE_REFRESH_TOKEN_ENCRYPTION_KEY',
                activeVersionName:
                    'APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION',
                expectedBytes: 32,
            }),

        agoraAccessTokenSigning:
            loadVersionedKeysFromEnvironment(env, {
                keyPrefix: 'AGORA_ACCESS_TOKEN_SIGNING_KEY',
                activeVersionName:
                    'AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION',
                expectedBytes: 64,
            }),
    };
}

function encryptionAad(keyVersion) {
    return Buffer.from(
        `${APPLE_REFRESH_TOKEN_AAD_PREFIX}:key:${keyVersion}`,
        'utf8'
    );
}

export function encryptAppleRefreshToken(
    plaintext,
    encryptionConfig
) {
    const cleanPlaintext = requireNonEmptyString(
        plaintext,
        'Apple refresh token',
        16_384
    );

    const activeVersion = requirePositiveSafeInteger(
        encryptionConfig?.activeVersion,
        'encryption activeVersion'
    );

    const keys = normalizeKeyMap(
        encryptionConfig?.keys,
        32,
        'Apple refresh-token encryption keys'
    );

    const key = keys.get(activeVersion);

    if (!key) {
        fail(
            'invalid_key',
            `Missing Apple refresh-token encryption key V${activeVersion}.`
        );
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        key,
        iv,
        { authTagLength: 16 }
    );

    cipher.setAAD(encryptionAad(activeVersion));

    const ciphertext = Buffer.concat([
        cipher.update(cleanPlaintext, 'utf8'),
        cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    return [
        'agoraenc',
        '1',
        String(activeVersion),
        base64urlEncode(iv),
        base64urlEncode(ciphertext),
        base64urlEncode(authTag),
    ].join('.');
}

export function decryptAppleRefreshToken(
    serialized,
    encryptionConfig
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
        parts[1] !== '1'
    ) {
        fail(
            'malformed_ciphertext',
            'Encrypted Apple refresh token has an unsupported format.'
        );
    }

    const keyVersion = requirePositiveSafeInteger(
        parts[2],
        'encrypted token key version'
    );

    const keys = normalizeKeyMap(
        encryptionConfig?.keys,
        32,
        'Apple refresh-token encryption keys'
    );

    const key = keys.get(keyVersion);

    if (!key) {
        fail(
            'unknown_key_version',
            `No Apple refresh-token encryption key exists for V${keyVersion}.`
        );
    }

    const iv = base64urlDecode(parts[3], 'encryption IV');
    const ciphertext = base64urlDecode(
        parts[4],
        'encrypted token ciphertext'
    );
    const authTag = base64urlDecode(
        parts[5],
        'encrypted token authentication tag'
    );

    if (iv.length !== 12 || authTag.length !== 16) {
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

        decipher.setAAD(encryptionAad(keyVersion));
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
    return base64urlEncode(crypto.randomBytes(48));
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

function normalizeAccessTokenClaims(claims) {
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
        fail('invalid_claims', 'Access-token claims must be an object.');
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
    const authVersion = requirePositiveSafeInteger(
        claims.authVersion,
        'authVersion'
    );

    if (!UUID_RE.test(accountId)) {
        fail('invalid_claims', 'accountId must be a UUID.');
    }

    if (!UUID_RE.test(sessionId)) {
        fail('invalid_claims', 'sessionId must be a UUID.');
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

export function issueAgoraAccessToken(
    claims,
    signingConfig,
    options = {}
) {
    const normalizedClaims = normalizeAccessTokenClaims(claims);
    const activeVersion = requirePositiveSafeInteger(
        signingConfig?.activeVersion,
        'signing activeVersion'
    );
    const keys = normalizeKeyMap(
        signingConfig?.keys,
        64,
        'Agora access-token signing keys'
    );
    const signingKey = keys.get(activeVersion);

    if (!signingKey) {
        fail(
            'invalid_key',
            `Missing Agora access-token signing key V${activeVersion}.`
        );
    }

    const nowMilliseconds = options.nowMilliseconds ?? Date.now();

    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
        fail('invalid_input', 'nowMilliseconds is invalid.');
    }

    const expiresInSeconds = options.expiresInSeconds ??
        ACCESS_TOKEN_TTL_SECONDS_DEFAULT;

    if (
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds <= 0 ||
        expiresInSeconds > ACCESS_TOKEN_TTL_SECONDS_MAX
    ) {
        fail(
            'invalid_input',
            `expiresInSeconds must be between 1 and ${ACCESS_TOKEN_TTL_SECONDS_MAX}.`
        );
    }

    const issuedAt = Math.floor(nowMilliseconds / 1_000);
    const expiresAt = issuedAt + expiresInSeconds;

    const header = {
        ...ACCESS_TOKEN_HEADER,
        kid: String(activeVersion),
    };

    const payload = {
        sub: normalizedClaims.accountId,
        sid: normalizedClaims.sessionId,
        iid: normalizedClaims.installationId,
        av: normalizedClaims.authVersion,
        iat: issuedAt,
        exp: expiresAt,
        jti: base64urlEncode(crypto.randomBytes(16)),
    };

    const encodedHeader = base64urlEncode(
        JSON.stringify(header)
    );
    const encodedPayload = base64urlEncode(
        JSON.stringify(payload)
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto
        .createHmac('sha256', signingKey)
        .update(signingInput, 'utf8')
        .digest();

    return {
        token: `${signingInput}.${base64urlEncode(signature)}`,
        expiresAt: new Date(expiresAt * 1_000),
        issuedAt: new Date(issuedAt * 1_000),
        keyVersion: activeVersion,
    };
}

export function verifyAgoraAccessToken(
    token,
    signingConfig,
    options = {}
) {
    const cleanToken = requireNonEmptyString(
        token,
        'Access token',
        16_384
    );
    const parts = cleanToken.split('.');

    if (parts.length !== 3) {
        fail('malformed_token', 'Access token must have three segments.');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJsonSegment(encodedHeader, 'access-token header');
    const payload = parseJsonSegment(encodedPayload, 'access-token payload');

    if (
        !header ||
        header.alg !== ACCESS_TOKEN_HEADER.alg ||
        header.typ !== ACCESS_TOKEN_HEADER.typ ||
        header.v !== ACCESS_TOKEN_HEADER.v
    ) {
        fail(
            'unsupported_token',
            'Access token header is unsupported.'
        );
    }

    const keyVersion = requirePositiveSafeInteger(
        header.kid,
        'access-token key version'
    );
    const keys = normalizeKeyMap(
        signingConfig?.keys,
        64,
        'Agora access-token signing keys'
    );
    const signingKey = keys.get(keyVersion);

    if (!signingKey) {
        fail(
            'unknown_key_version',
            `No Agora access-token signing key exists for V${keyVersion}.`
        );
    }

    const providedSignature = base64urlDecode(
        encodedSignature,
        'access-token signature'
    );
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(signingInput, 'utf8')
        .digest();

    if (!constantTimeEqual(providedSignature, expectedSignature)) {
        fail('invalid_signature', 'Access-token signature is invalid.');
    }

    const normalizedClaims = normalizeAccessTokenClaims({
        accountId: payload?.sub,
        sessionId: payload?.sid,
        installationId: payload?.iid,
        authVersion: payload?.av,
    });

    if (
        !Number.isSafeInteger(payload?.iat) ||
        !Number.isSafeInteger(payload?.exp) ||
        payload.exp <= payload.iat ||
        typeof payload?.jti !== 'string' ||
        payload.jti.length < 16 ||
        !BASE64URL_RE.test(payload.jti)
    ) {
        fail('invalid_claims', 'Access-token time or ID claims are invalid.');
    }

    const nowMilliseconds = options.nowMilliseconds ?? Date.now();

    if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
        fail('invalid_input', 'nowMilliseconds is invalid.');
    }

    const clockToleranceSeconds =
        options.clockToleranceSeconds ??
        ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS_DEFAULT;

    if (
        !Number.isSafeInteger(clockToleranceSeconds) ||
        clockToleranceSeconds < 0 ||
        clockToleranceSeconds > 300
    ) {
        fail(
            'invalid_input',
            'clockToleranceSeconds must be between 0 and 300.'
        );
    }

    const nowSeconds = Math.floor(nowMilliseconds / 1_000);

    if (payload.iat > nowSeconds + clockToleranceSeconds) {
        fail('token_not_yet_valid', 'Access token was issued in the future.');
    }

    if (payload.exp <= nowSeconds - clockToleranceSeconds) {
        fail('token_expired', 'Access token has expired.');
    }

    return {
        accountId: normalizedClaims.accountId,
        sessionId: normalizedClaims.sessionId,
        installationId: normalizedClaims.installationId,
        authVersion: normalizedClaims.authVersion,
        issuedAt: new Date(payload.iat * 1_000),
        expiresAt: new Date(payload.exp * 1_000),
        tokenId: payload.jti,
        keyVersion,
    };
}

export function isSha256Hex(value) {
    return typeof value === 'string' && SHA256_HEX_RE.test(value);
}
