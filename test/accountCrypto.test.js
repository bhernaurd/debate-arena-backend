import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';

import {
    AccountCryptoError,
    decryptAppleRefreshToken,
    encryptAppleRefreshToken,
    generateAgoraRefreshToken,
    hashToken,
    isSha256Hex,
    issueAgoraAccessToken,
    loadAccountCryptoConfig,
    verifyAgoraAccessToken,
} from '../lib/accountCrypto.js';

const encryptionKeyV1 = crypto.randomBytes(32);
const encryptionKeyV2 = crypto.randomBytes(32);
const signingKeyV1 = crypto.randomBytes(64);
const signingKeyV2 = crypto.randomBytes(64);

const encryptionConfig = {
    activeVersion: 2,
    keys: new Map([
        [1, encryptionKeyV1],
        [2, encryptionKeyV2],
    ]),
};

const signingConfig = {
    activeVersion: 2,
    keys: new Map([
        [1, signingKeyV1],
        [2, signingKeyV2],
    ]),
};

const claims = {
    accountId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    installationId: 'version-check-client-001',
    authVersion: 1,
};

function expectCryptoError(code) {
    return (error) => {
        assert.ok(error instanceof AccountCryptoError);
        assert.equal(error.code, code);
        return true;
    };
}

test('loads versioned crypto keys from environment', () => {
    const config = loadAccountCryptoConfig({
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION: '2',
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V1:
            encryptionKeyV1.toString('base64'),
        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V2:
            encryptionKeyV2.toString('base64'),
        AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION: '2',
        AGORA_ACCESS_TOKEN_SIGNING_KEY_V1:
            signingKeyV1.toString('base64'),
        AGORA_ACCESS_TOKEN_SIGNING_KEY_V2:
            signingKeyV2.toString('base64'),
    });

    assert.equal(
        config.appleRefreshTokenEncryption.activeVersion,
        2
    );
    assert.equal(
        config.appleRefreshTokenEncryption.keys.size,
        2
    );
    assert.equal(
        config.agoraAccessTokenSigning.activeVersion,
        2
    );
    assert.equal(
        config.agoraAccessTokenSigning.keys.size,
        2
    );
});

test('rejects an active key version that is missing', () => {
    assert.throws(
        () => loadAccountCryptoConfig({
            APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION: '2',
            APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V1:
                encryptionKeyV1.toString('base64'),
            AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION: '1',
            AGORA_ACCESS_TOKEN_SIGNING_KEY_V1:
                signingKeyV1.toString('base64'),
        }),
        expectCryptoError('invalid_key')
    );
});

test('encrypts and decrypts an Apple refresh token', () => {
    const plaintext = 'apple-refresh-token-example';
    const encrypted = encryptAppleRefreshToken(
        plaintext,
        encryptionConfig
    );

    assert.notEqual(encrypted, plaintext);
    assert.match(encrypted, /^agoraenc\.1\.2\./);
    assert.equal(
        decryptAppleRefreshToken(encrypted, encryptionConfig),
        plaintext
    );
});

test('uses a unique IV for every Apple refresh-token encryption', () => {
    const first = encryptAppleRefreshToken(
        'same-token',
        encryptionConfig
    );
    const second = encryptAppleRefreshToken(
        'same-token',
        encryptionConfig
    );

    assert.notEqual(first, second);
    assert.equal(
        decryptAppleRefreshToken(first, encryptionConfig),
        'same-token'
    );
    assert.equal(
        decryptAppleRefreshToken(second, encryptionConfig),
        'same-token'
    );
});

test('decrypts data encrypted under a previous key version', () => {
    const encryptedWithV1 = encryptAppleRefreshToken(
        'old-refresh-token',
        {
            activeVersion: 1,
            keys: encryptionConfig.keys,
        }
    );

    assert.equal(
        decryptAppleRefreshToken(
            encryptedWithV1,
            encryptionConfig
        ),
        'old-refresh-token'
    );
});

test('rejects tampered encrypted Apple refresh tokens', () => {
    const encrypted = encryptAppleRefreshToken(
        'sensitive-token',
        encryptionConfig
    );
    const parts = encrypted.split('.');
    parts[4] = `${parts[4].slice(0, -1)}${
        parts[4].endsWith('A') ? 'B' : 'A'
    }`;

    assert.throws(
        () => decryptAppleRefreshToken(
            parts.join('.'),
            encryptionConfig
        ),
        expectCryptoError('decryption_failed')
    );
});

test('rejects encrypted data when the required key version is unavailable', () => {
    const encrypted = encryptAppleRefreshToken(
        'token',
        {
            activeVersion: 1,
            keys: new Map([[1, encryptionKeyV1]]),
        }
    );

    assert.throws(
        () => decryptAppleRefreshToken(
            encrypted,
            {
                activeVersion: 2,
                keys: new Map([[2, encryptionKeyV2]]),
            }
        ),
        expectCryptoError('unknown_key_version')
    );
});

test('generates high-entropy URL-safe Agora refresh tokens', () => {
    const first = generateAgoraRefreshToken();
    const second = generateAgoraRefreshToken();

    assert.match(first, /^[A-Za-z0-9_-]{64}$/);
    assert.match(second, /^[A-Za-z0-9_-]{64}$/);
    assert.notEqual(first, second);
});

test('hashes tokens as SHA-256 hexadecimal without storing plaintext', () => {
    const token = generateAgoraRefreshToken();
    const hash = hashToken(token);

    assert.equal(hash.length, 64);
    assert.equal(isSha256Hex(hash), true);
    assert.notEqual(hash, token);
    assert.equal(hashToken(token), hash);
});

test('issues and verifies an Agora access token', () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    const issued = issueAgoraAccessToken(
        claims,
        signingConfig,
        {
            nowMilliseconds: now,
            expiresInSeconds: 900,
        }
    );

    const verified = verifyAgoraAccessToken(
        issued.token,
        signingConfig,
        {
            nowMilliseconds: now + 60_000,
            clockToleranceSeconds: 0,
        }
    );

    assert.equal(verified.accountId, claims.accountId);
    assert.equal(verified.sessionId, claims.sessionId);
    assert.equal(
        verified.installationId,
        claims.installationId
    );
    assert.equal(verified.authVersion, 1);
    assert.equal(verified.keyVersion, 2);
    assert.equal(
        verified.expiresAt.toISOString(),
        '2026-07-28T12:15:00.000Z'
    );
});

test('verifies access tokens issued under a previous signing key', () => {
    const issued = issueAgoraAccessToken(
        claims,
        {
            activeVersion: 1,
            keys: signingConfig.keys,
        }
    );

    const verified = verifyAgoraAccessToken(
        issued.token,
        signingConfig
    );

    assert.equal(verified.keyVersion, 1);
});

test('rejects tampered access-token payloads', () => {
    const issued = issueAgoraAccessToken(
        claims,
        signingConfig
    );
    const parts = issued.token.split('.');
    const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    payload.av = 999;
    parts[1] = Buffer.from(
        JSON.stringify(payload)
    ).toString('base64url');

    assert.throws(
        () => verifyAgoraAccessToken(
            parts.join('.'),
            signingConfig
        ),
        expectCryptoError('invalid_signature')
    );
});

test('rejects access tokens signed by an unknown key version', () => {
    const issued = issueAgoraAccessToken(
        claims,
        {
            activeVersion: 1,
            keys: new Map([[1, signingKeyV1]]),
        }
    );

    assert.throws(
        () => verifyAgoraAccessToken(
            issued.token,
            {
                activeVersion: 2,
                keys: new Map([[2, signingKeyV2]]),
            }
        ),
        expectCryptoError('unknown_key_version')
    );
});

test('rejects expired access tokens', () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    const issued = issueAgoraAccessToken(
        claims,
        signingConfig,
        {
            nowMilliseconds: now,
            expiresInSeconds: 60,
        }
    );

    assert.throws(
        () => verifyAgoraAccessToken(
            issued.token,
            signingConfig,
            {
                nowMilliseconds: now + 61_000,
                clockToleranceSeconds: 0,
            }
        ),
        expectCryptoError('token_expired')
    );
});

test('rejects access tokens issued too far in the future', () => {
    const now = Date.UTC(2026, 6, 28, 12, 0, 0);
    const issued = issueAgoraAccessToken(
        claims,
        signingConfig,
        {
            nowMilliseconds: now + 120_000,
            expiresInSeconds: 900,
        }
    );

    assert.throws(
        () => verifyAgoraAccessToken(
            issued.token,
            signingConfig,
            {
                nowMilliseconds: now,
                clockToleranceSeconds: 30,
            }
        ),
        expectCryptoError('token_not_yet_valid')
    );
});

test('rejects invalid account, session, installation, and auth-version claims', () => {
    assert.throws(
        () => issueAgoraAccessToken(
            {
                ...claims,
                accountId: 'not-a-uuid',
            },
            signingConfig
        ),
        expectCryptoError('invalid_claims')
    );

    assert.throws(
        () => issueAgoraAccessToken(
            {
                ...claims,
                sessionId: 'not-a-uuid',
            },
            signingConfig
        ),
        expectCryptoError('invalid_claims')
    );

    assert.throws(
        () => issueAgoraAccessToken(
            {
                ...claims,
                installationId: 'bad',
            },
            signingConfig
        ),
        expectCryptoError('invalid_claims')
    );

    assert.throws(
        () => issueAgoraAccessToken(
            {
                ...claims,
                authVersion: 0,
            },
            signingConfig
        ),
        expectCryptoError('invalid_input')
    );
});

test('limits Agora access-token lifetime to one hour', () => {
    assert.throws(
        () => issueAgoraAccessToken(
            claims,
            signingConfig,
            { expiresInSeconds: 3_601 }
        ),
        expectCryptoError('invalid_input')
    );
});
