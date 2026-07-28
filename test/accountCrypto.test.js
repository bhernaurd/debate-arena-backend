import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    AccountCryptoError,
    accountCryptoConstants,
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

const env = {
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
};

const config = loadAccountCryptoConfig(env);

const claims = {
    accountId:
        '11111111-1111-4111-8111-111111111111',
    sessionId:
        '22222222-2222-4222-8222-222222222222',
    installationId:
        'version-check-client-001',
    authVersion: 1,
};

const binding = {
    identityId:
        '33333333-3333-4333-8333-333333333333',
    accountId: claims.accountId,
    issuer:
        'https://appleid.apple.com',
    audience:
        'com.bhernaurd.TheAgora',
    subject:
        'apple-user-subject',
};

function expectCryptoError(code) {
    return (error) => {
        assert.ok(
            error instanceof AccountCryptoError
        );
        assert.equal(error.code, code);
        return true;
    };
}

function rawAgoraToken({
    headerOverrides = {},
    payloadOverrides = {},
    signingKey = signingKeyV2,
} = {}) {
    const nowSeconds = 1_800_000_000;

    const header = {
        alg: 'HS256',
        typ: 'AGORA',
        v: 1,
        kid: '2',
        ...headerOverrides,
    };

    const payload = {
        iss:
            accountCryptoConstants
                .accessTokenIssuer,
        aud:
            accountCryptoConstants
                .accessTokenAudience,
        sub: claims.accountId,
        sid: claims.sessionId,
        iid: claims.installationId,
        av: claims.authVersion,
        iat: nowSeconds,
        exp: nowSeconds + 900,
        jti: crypto
            .randomBytes(16)
            .toString('base64url'),
        ...payloadOverrides,
    };

    const encodedHeader = Buffer.from(
        JSON.stringify(header)
    ).toString('base64url');

    const encodedPayload = Buffer.from(
        JSON.stringify(payload)
    ).toString('base64url');

    const signingInput =
        `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
        .createHmac('sha256', signingKey)
        .update(signingInput, 'utf8')
        .digest('base64url');

    return `${signingInput}.${signature}`;
}

test(
    'loads versioned keys without exposing key material',
    () => {
        assert.equal(
            config
                .appleRefreshTokenEncryption
                .activeVersion,
            2
        );

        assert.deepEqual(
            config
                .appleRefreshTokenEncryption
                .availableVersions,
            [1, 2]
        );

        assert.equal(
            config
                .agoraAccessTokenSigning
                .activeVersion,
            2
        );

        assert.equal(
            'keys' in
                config
                    .appleRefreshTokenEncryption,
            false
        );

        const serialized =
            JSON.stringify(config);

        assert.equal(
            serialized.includes(
                encryptionKeyV2.toString(
                    'base64'
                )
            ),
            false
        );

        assert.equal(
            serialized.includes(
                signingKeyV2.toString(
                    'base64'
                )
            ),
            false
        );
    }
);

test(
    'rejects a missing active key version',
    () => {
        assert.throws(
            () =>
                loadAccountCryptoConfig({
                    APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION:
                        '2',
                    APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V1:
                        encryptionKeyV1.toString(
                            'base64'
                        ),
                    AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION:
                        '1',
                    AGORA_ACCESS_TOKEN_SIGNING_KEY_V1:
                        signingKeyV1.toString(
                            'base64'
                        ),
                }),
            expectCryptoError('invalid_key')
        );
    }
);

test(
    'rejects noncanonical key versions',
    () => {
        for (const badVersion of [
            '01',
            '1.0',
            '1e0',
        ]) {
            assert.throws(
                () =>
                    loadAccountCryptoConfig({
                        ...env,
                        APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION:
                            badVersion,
                    }),
                expectCryptoError(
                    'invalid_key'
                )
            );
        }
    }
);

test(
    'encrypts and decrypts an Apple refresh token',
    () => {
        const plaintext =
            'apple-refresh-token-example';

        const encrypted =
            encryptAppleRefreshToken(
                plaintext,
                config,
                binding
            );

        assert.notEqual(
            encrypted,
            plaintext
        );

        assert.match(
            encrypted,
            /^agoraenc\.2\.2\./
        );

        assert.equal(
            decryptAppleRefreshToken(
                encrypted,
                config,
                binding
            ),
            plaintext
        );
    }
);

test(
    'uses a unique IV for every Apple refresh-token encryption',
    () => {
        const first =
            encryptAppleRefreshToken(
                'same-token',
                config,
                binding
            );

        const second =
            encryptAppleRefreshToken(
                'same-token',
                config,
                binding
            );

        assert.notEqual(first, second);
    }
);

test(
    'binds encrypted Apple refresh tokens to the identity owner',
    () => {
        const encrypted =
            encryptAppleRefreshToken(
                'owner-bound-token',
                config,
                binding
            );

        assert.throws(
            () =>
                decryptAppleRefreshToken(
                    encrypted,
                    config,
                    {
                        ...binding,
                        identityId:
                            '44444444-4444-4444-8444-444444444444',
                    }
                ),
            expectCryptoError(
                'decryption_failed'
            )
        );
    }
);

test(
    'decrypts data encrypted under a previous key version',
    () => {
        const previousEnv = {
            ...env,
            APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_VERSION:
                '1',
        };

        const previousConfig =
            loadAccountCryptoConfig(
                previousEnv
            );

        const encrypted =
            encryptAppleRefreshToken(
                'old-refresh-token',
                previousConfig,
                binding
            );

        assert.equal(
            decryptAppleRefreshToken(
                encrypted,
                config,
                binding
            ),
            'old-refresh-token'
        );
    }
);

test(
    'rejects tampered encrypted Apple refresh tokens',
    () => {
        const encrypted =
            encryptAppleRefreshToken(
                'sensitive-token',
                config,
                binding
            );

        const parts =
            encrypted.split('.');

        parts[4] =
            `${parts[4].slice(0, -1)}${
                parts[4].endsWith('A')
                    ? 'B'
                    : 'A'
            }`;

        assert.throws(
            () =>
                decryptAppleRefreshToken(
                    parts.join('.'),
                    config,
                    binding
                ),
            expectCryptoError(
                'decryption_failed'
            )
        );
    }
);

test(
    'rejects noncanonical encrypted-token segments',
    () => {
        const encrypted =
            encryptAppleRefreshToken(
                'token',
                config,
                binding
            );

        const parts =
            encrypted.split('.');

        parts[3] = 'A';

        assert.throws(
            () =>
                decryptAppleRefreshToken(
                    parts.join('.'),
                    config,
                    binding
                ),
            expectCryptoError(
                'malformed_token'
            )
        );
    }
);

test(
    'generates high-entropy URL-safe Agora refresh tokens',
    () => {
        const first =
            generateAgoraRefreshToken();

        const second =
            generateAgoraRefreshToken();

        assert.match(
            first,
            /^[A-Za-z0-9_-]{64}$/
        );

        assert.match(
            second,
            /^[A-Za-z0-9_-]{64}$/
        );

        assert.notEqual(first, second);
    }
);

test(
    'hashes refresh tokens as SHA-256 hexadecimal',
    () => {
        const token =
            generateAgoraRefreshToken();

        const hash = hashToken(token);

        assert.equal(hash.length, 64);
        assert.equal(
            isSha256Hex(hash),
            true
        );
        assert.notEqual(hash, token);
        assert.equal(
            hashToken(token),
            hash
        );
    }
);

test(
    'issues and verifies an Agora access token with issuer and audience',
    () => {
        const now =
            Date.UTC(
                2026,
                6,
                28,
                12,
                0,
                0
            );

        const issued =
            issueAgoraAccessToken(
                claims,
                config,
                {
                    nowMilliseconds: now,
                    expiresInSeconds: 900,
                }
            );

        const verified =
            verifyAgoraAccessToken(
                issued.token,
                config,
                {
                    nowMilliseconds:
                        now + 60_000,
                    clockToleranceSeconds:
                        0,
                }
            );

        assert.equal(
            verified.issuer,
            accountCryptoConstants
                .accessTokenIssuer
        );

        assert.equal(
            verified.audience,
            accountCryptoConstants
                .accessTokenAudience
        );

        assert.equal(
            verified.accountId,
            claims.accountId
        );

        assert.equal(
            verified.sessionId,
            claims.sessionId
        );

        assert.equal(
            verified.installationId,
            claims.installationId
        );

        assert.equal(
            verified.authVersion,
            1
        );

        assert.equal(
            verified.keyVersion,
            2
        );
    }
);

test(
    'verifies access tokens issued under a previous signing key',
    () => {
        const previousConfig =
            loadAccountCryptoConfig({
                ...env,
                AGORA_ACCESS_TOKEN_SIGNING_KEY_VERSION:
                    '1',
            });

        const issued =
            issueAgoraAccessToken(
                claims,
                previousConfig
            );

        const verified =
            verifyAgoraAccessToken(
                issued.token,
                config
            );

        assert.equal(
            verified.keyVersion,
            1
        );
    }
);

test(
    'rejects tampered access-token payloads',
    () => {
        const issued =
            issueAgoraAccessToken(
                claims,
                config
            );

        const parts =
            issued.token.split('.');

        const payload = JSON.parse(
            Buffer.from(
                parts[1],
                'base64url'
            ).toString('utf8')
        );

        payload.av = 999;

        parts[1] = Buffer.from(
            JSON.stringify(payload)
        ).toString('base64url');

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    parts.join('.'),
                    config
                ),
            expectCryptoError(
                'invalid_signature'
            )
        );
    }
);

test(
    'rejects access tokens signed by an unknown key version',
    () => {
        const unknownToken =
            rawAgoraToken({
                headerOverrides: {
                    kid: '3',
                },
            });

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    unknownToken,
                    config
                ),
            expectCryptoError(
                'unknown_key_version'
            )
        );
    }
);

test(
    'rejects expired access tokens',
    () => {
        const now =
            Date.UTC(
                2026,
                6,
                28,
                12,
                0,
                0
            );

        const issued =
            issueAgoraAccessToken(
                claims,
                config,
                {
                    nowMilliseconds: now,
                    expiresInSeconds: 60,
                }
            );

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    issued.token,
                    config,
                    {
                        nowMilliseconds:
                            now + 61_000,
                        clockToleranceSeconds:
                            0,
                    }
                ),
            expectCryptoError(
                'token_expired'
            )
        );
    }
);

test(
    'rejects access tokens issued too far in the future',
    () => {
        const now =
            Date.UTC(
                2026,
                6,
                28,
                12,
                0,
                0
            );

        const issued =
            issueAgoraAccessToken(
                claims,
                config,
                {
                    nowMilliseconds:
                        now + 120_000,
                    expiresInSeconds: 900,
                }
            );

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    issued.token,
                    config,
                    {
                        nowMilliseconds: now,
                        clockToleranceSeconds:
                            30,
                    }
                ),
            expectCryptoError(
                'token_not_yet_valid'
            )
        );
    }
);

test(
    'rejects an access token whose signed lifetime exceeds one hour',
    () => {
        const token =
            rawAgoraToken({
                payloadOverrides: {
                    exp:
                        1_800_000_000 +
                        3_601,
                },
            });

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    token,
                    config,
                    {
                        nowMilliseconds:
                            1_800_000_100 *
                            1000,
                        clockToleranceSeconds:
                            0,
                    }
                ),
            expectCryptoError(
                'invalid_claims'
            )
        );
    }
);

test(
    'rejects incorrect access-token issuer and audience',
    () => {
        for (const payloadOverrides of [
            {
                iss:
                    'https://evil.example',
            },
            {
                aud:
                    'com.example.OtherApp',
            },
        ]) {
            assert.throws(
                () =>
                    verifyAgoraAccessToken(
                        rawAgoraToken({
                            payloadOverrides,
                        }),
                        config,
                        {
                            nowMilliseconds:
                                1_800_000_100 *
                                1000,
                        }
                    ),
                expectCryptoError(
                    'invalid_claims'
                )
            );
        }
    }
);

test(
    'rejects noncanonical access-token key versions',
    () => {
        for (const kid of [
            '02',
            '2.0',
            '2e0',
        ]) {
            assert.throws(
                () =>
                    verifyAgoraAccessToken(
                        rawAgoraToken({
                            headerOverrides: {
                                kid,
                            },
                        }),
                        config,
                        {
                            nowMilliseconds:
                                1_800_000_100 *
                                1000,
                        }
                    ),
                expectCryptoError(
                    'unsupported_token'
                )
            );
        }
    }
);

test(
    'rejects noncanonical access-token Base64URL segments',
    () => {
        const issued =
            issueAgoraAccessToken(
                claims,
                config
            );

        const parts =
            issued.token.split('.');

        parts[2] = 'A';

        assert.throws(
            () =>
                verifyAgoraAccessToken(
                    parts.join('.'),
                    config
                ),
            expectCryptoError(
                'malformed_token'
            )
        );
    }
);

test(
    'rejects invalid account, session, installation, and auth-version claims',
    () => {
        const invalidClaims = [
            {
                ...claims,
                accountId:
                    'not-a-uuid',
            },
            {
                ...claims,
                sessionId:
                    'not-a-uuid',
            },
            {
                ...claims,
                installationId: 'bad',
            },
            {
                ...claims,
                authVersion: 0,
            },
        ];

        for (
            const candidate of invalidClaims
        ) {
            assert.throws(
                () =>
                    issueAgoraAccessToken(
                        candidate,
                        config
                    ),
                (error) =>
                    error instanceof
                        AccountCryptoError &&
                    [
                        'invalid_claims',
                        'invalid_input',
                    ].includes(error.code)
            );
        }
    }
);

test(
    'limits issued Agora access-token lifetime to one hour',
    () => {
        assert.throws(
            () =>
                issueAgoraAccessToken(
                    claims,
                    config,
                    {
                        expiresInSeconds:
                            3_601,
                    }
                ),
            expectCryptoError(
                'invalid_input'
            )
        );
    }
);
