import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    AppleSignInError,
    appleSignInConstants,
    createAppleClientSecret,
    createAppleIdentityTokenVerifier,
    exchangeAppleAuthorizationCode,
    loadAppleSignInConfig,
    revokeAppleToken,
    validateAppleRefreshToken,
} from '../lib/appleSignIn.js';

const NOW_SECONDS = 1_800_000_000;
const NOW_MS = NOW_SECONDS * 1000;

function makeAppleClientConfig() {
    const {
        privateKey,
        publicKey,
    } = crypto.generateKeyPairSync(
        'ec',
        {
            namedCurve:
                'prime256v1',
        }
    );

    const privateKeyPem =
        privateKey.export({
            type: 'pkcs8',
            format: 'pem',
        });

    const config =
        loadAppleSignInConfig({
            APPLE_SIGN_IN_TEAM_ID:
                'TEAM123456',
            APPLE_SIGN_IN_KEY_ID:
                'KEY123456',
            APPLE_SIGN_IN_CLIENT_ID:
                'com.example.TheAgora',
            APPLE_SIGN_IN_PRIVATE_KEY:
                privateKeyPem,
        });

    return {
        config,
        publicKey,
        privateKeyPem,
    };
}

function decodeJwt(token) {
    const [
        encodedHeader,
        encodedPayload,
        encodedSignature,
    ] = token.split('.');

    return {
        encodedHeader,
        encodedPayload,
        encodedSignature,
        header: JSON.parse(
            Buffer.from(
                encodedHeader,
                'base64url'
            ).toString('utf8')
        ),
        payload: JSON.parse(
            Buffer.from(
                encodedPayload,
                'base64url'
            ).toString('utf8')
        ),
        signature: Buffer.from(
            encodedSignature,
            'base64url'
        ),
        signingInput:
            `${encodedHeader}.${encodedPayload}`,
    };
}

function makeIdentityTokenFixture(
    kid =
        `apple-test-${crypto.randomUUID()}`
) {
    const {
        privateKey,
        publicKey,
    } = crypto.generateKeyPairSync(
        'rsa',
        {
            modulusLength: 2048,
        }
    );

    const publicJwk =
        publicKey.export({
            format: 'jwk',
        });

    const jwk = {
        ...publicJwk,
        kid,
        use: 'sig',
        key_ops: ['verify'],
        alg: 'RS256',
    };

    function signToken(
        overrides = {},
        headerOverrides = {}
    ) {
        const header = {
            alg: 'RS256',
            kid,
            typ: 'JWT',
            ...headerOverrides,
        };

        const payload = {
            iss:
                appleSignInConstants
                    .issuer,
            aud:
                'com.example.TheAgora',
            sub:
                'apple-user-subject',
            iat: NOW_SECONDS - 5,
            exp: NOW_SECONDS + 300,
            nonce: 'a'.repeat(64),
            email:
                'relay@example.com',
            email_verified: 'true',
            is_private_email: 'true',
            ...overrides,
        };

        const encodedHeader =
            Buffer.from(
                JSON.stringify(header)
            ).toString('base64url');

        const encodedPayload =
            Buffer.from(
                JSON.stringify(payload)
            ).toString('base64url');

        const signingInput =
            `${encodedHeader}.${encodedPayload}`;

        const signature = crypto.sign(
            'RSA-SHA256',
            Buffer.from(
                signingInput,
                'utf8'
            ),
            privateKey
        );

        return `${signingInput}.${signature.toString('base64url')}`;
    }

    return {
        jwk,
        kid,
        signToken,
    };
}

function jsonResponse(
    body,
    { status = 200 } = {}
) {
    return new Response(
        JSON.stringify(body),
        {
            status,
            headers: {
                'Content-Type':
                    'application/json',
            },
        }
    );
}

function textResponse(
    body,
    { status = 200 } = {}
) {
    return new Response(body, {
        status,
        headers: {
            'Content-Type':
                'text/plain',
        },
    });
}

function formToObject(body) {
    return Object.fromEntries(
        new URLSearchParams(body)
            .entries()
    );
}

function expectAppleError(
    code,
    {
        status,
        retryable,
        appleCode,
    } = {}
) {
    return (error) => {
        assert.ok(
            error instanceof
                AppleSignInError
        );

        assert.equal(
            error.code,
            code
        );

        if (status !== undefined) {
            assert.equal(
                error.status,
                status
            );
        }

        if (
            retryable !== undefined
        ) {
            assert.equal(
                error.retryable,
                retryable
            );
        }

        if (
            appleCode !== undefined
        ) {
            assert.equal(
                error.appleCode,
                appleCode
            );
        }

        return true;
    };
}

test(
    'loads Apple configuration without exposing private-key material',
    () => {
        const {
            config,
            privateKeyPem,
        } = makeAppleClientConfig();

        assert.equal(
            config.teamId,
            'TEAM123456'
        );

        assert.equal(
            config.keyId,
            'KEY123456'
        );

        assert.equal(
            config.clientId,
            'com.example.TheAgora'
        );

        assert.equal(
            'privateKeyPem' in config,
            false
        );

        assert.equal(
            'privateKey' in config,
            false
        );

        assert.equal(
            JSON.stringify(config)
                .includes(
                    privateKeyPem
                ),
            false
        );
    }
);

test(
    'rejects a non-EC Apple private key',
    () => {
        const { privateKey } =
            crypto.generateKeyPairSync(
                'rsa',
                {
                    modulusLength:
                        2048,
                }
            );

        assert.throws(
            () =>
                loadAppleSignInConfig({
                    APPLE_SIGN_IN_TEAM_ID:
                        'TEAM123456',
                    APPLE_SIGN_IN_KEY_ID:
                        'KEY123456',
                    APPLE_SIGN_IN_CLIENT_ID:
                        'com.example.TheAgora',
                    APPLE_SIGN_IN_PRIVATE_KEY:
                        privateKey.export({
                            type: 'pkcs8',
                            format: 'pem',
                        }),
                }),
            expectAppleError(
                'invalid_configuration'
            )
        );
    }
);

test(
    'creates a correctly signed short-lived Apple client secret',
    () => {
        const {
            config,
            publicKey,
        } = makeAppleClientConfig();

        const token =
            createAppleClientSecret(
                config,
                {
                    nowSeconds:
                        NOW_SECONDS,
                    lifetimeSeconds:
                        300,
                }
            );

        const parsed =
            decodeJwt(token);

        assert.deepEqual(
            parsed.header,
            {
                alg: 'ES256',
                kid: 'KEY123456',
                typ: 'JWT',
            }
        );

        assert.deepEqual(
            parsed.payload,
            {
                iss: 'TEAM123456',
                iat: NOW_SECONDS,
                exp:
                    NOW_SECONDS + 300,
                aud:
                    appleSignInConstants
                        .issuer,
                sub:
                    'com.example.TheAgora',
            }
        );

        assert.equal(
            crypto.verify(
                'sha256',
                Buffer.from(
                    parsed.signingInput,
                    'utf8'
                ),
                {
                    key: publicKey,
                    dsaEncoding:
                        'ieee-p1363',
                },
                parsed.signature
            ),
            true
        );
    }
);

test(
    'limits Apple client-secret lifetime to one hour',
    () => {
        const { config } =
            makeAppleClientConfig();

        assert.throws(
            () =>
                createAppleClientSecret(
                    config,
                    {
                        nowSeconds:
                            NOW_SECONDS,
                        lifetimeSeconds:
                            3_601,
                    }
                ),
            expectAppleError(
                'invalid_input'
            )
        );
    }
);

test(
    'verifies a valid Apple identity token and normalizes claims',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                fixture.jwk,
                            ],
                        }),
                now: () => NOW_MS,
            });

        const result =
            await verify(
                fixture.signToken(),
                {
                    expectedNonceHash:
                        'a'.repeat(64),
                }
            );

        assert.equal(
            result.subject,
            'apple-user-subject'
        );

        assert.equal(
            result.emailVerified,
            true
        );

        assert.equal(
            result.isPrivateEmail,
            true
        );

        assert.equal(
            'rawClaims' in result,
            false
        );
    }
);

test(
    'accepts an audience array containing the native client ID',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                fixture.jwk,
                            ],
                        }),
                now: () => NOW_MS,
            });

        const result =
            await verify(
                fixture.signToken({
                    aud: [
                        'another-client',
                        config.clientId,
                    ],
                })
            );

        assert.equal(
            result.audience,
            config.clientId
        );
    }
);

test(
    'rejects an invalid Apple identity-token signature',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const trusted =
            makeIdentityTokenFixture();

        const untrusted =
            makeIdentityTokenFixture();

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                {
                                    ...trusted.jwk,
                                    kid:
                                        untrusted.kid,
                                },
                            ],
                        }),
                now: () => NOW_MS,
            });

        await assert.rejects(
            () =>
                verify(
                    untrusted.signToken()
                ),
            expectAppleError(
                'invalid_identity_token',
                { status: 401 }
            )
        );
    }
);

test(
    'rejects incorrect issuer, audience, expiration, and future issue time',
    async (t) => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        async function rejectClaims(
            overrides,
            code =
                'invalid_identity_token'
        ) {
            const verify =
                createAppleIdentityTokenVerifier({
                    config,
                    fetchImpl:
                        async () =>
                            jsonResponse({
                                keys: [
                                    fixture.jwk,
                                ],
                            }),
                    now: () =>
                        NOW_MS,
                });

            await assert.rejects(
                () =>
                    verify(
                        fixture.signToken(
                            overrides
                        )
                    ),
                expectAppleError(
                    code,
                    { status: 401 }
                )
            );
        }

        await t.test(
            'issuer',
            () =>
                rejectClaims({
                    iss:
                        'https://evil.example',
                })
        );

        await t.test(
            'audience',
            () =>
                rejectClaims({
                    aud:
                        'wrong-client',
                })
        );

        await t.test(
            'expiration',
            () =>
                rejectClaims(
                    {
                        exp:
                            NOW_SECONDS -
                            120,
                    },
                    'identity_token_expired'
                )
        );

        await t.test(
            'future iat',
            () =>
                rejectClaims({
                    iat:
                        NOW_SECONDS +
                        120,
                })
        );
    }
);

test(
    'rejects nonce and subject mismatches',
    async (t) => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        function verifier() {
            return createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                fixture.jwk,
                            ],
                        }),
                now: () => NOW_MS,
            });
        }

        await t.test(
            'nonce',
            async () => {
                await assert.rejects(
                    () =>
                        verifier()(
                            fixture.signToken(),
                            {
                                expectedNonceHash:
                                    'b'.repeat(
                                        64
                                    ),
                            }
                        ),
                    expectAppleError(
                        'identity_nonce_mismatch',
                        { status: 401 }
                    )
                );
            }
        );

        await t.test(
            'subject',
            async () => {
                await assert.rejects(
                    () =>
                        verifier()(
                            fixture.signToken(),
                            {
                                expectedSubject:
                                    'different-subject',
                            }
                        ),
                    expectAppleError(
                        'identity_subject_mismatch',
                        { status: 401 }
                    )
                );
            }
        );
    }
);

test(
    'rejects malformed Apple-controlled subject, nonce, email, and boolean claims',
    async (t) => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        function verifier() {
            return createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                fixture.jwk,
                            ],
                        }),
                now: () => NOW_MS,
            });
        }

        const cases = [
            {
                name: 'subject',
                overrides: {
                    sub: 123,
                },
                options: {},
            },
            {
                name: 'nonce',
                overrides: {
                    nonce: 'not-a-hash',
                },
                options: {
                    expectedNonceHash:
                        'a'.repeat(64),
                },
            },
            {
                name: 'email',
                overrides: {
                    email: 123,
                },
                options: {},
            },
            {
                name:
                    'email_verified',
                overrides: {
                    email_verified:
                        'maybe',
                },
                options: {},
            },
        ];

        for (const entry of cases) {
            await t.test(
                entry.name,
                async () => {
                    await assert.rejects(
                        () =>
                            verifier()(
                                fixture.signToken(
                                    entry.overrides
                                ),
                                entry.options
                            ),
                        (error) =>
                            error instanceof
                                AppleSignInError &&
                            [
                                'invalid_identity_token',
                                'identity_nonce_mismatch',
                            ].includes(
                                error.code
                            ) &&
                            error.status ===
                                401
                    );
                }
            );
        }
    }
);

test(
    'rejects Apple JWKs that are not signing keys',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () =>
                        jsonResponse({
                            keys: [
                                {
                                    ...fixture.jwk,
                                    use: 'enc',
                                },
                            ],
                        }),
                now: () => NOW_MS,
            });

        await assert.rejects(
            () =>
                verify(
                    fixture.signToken()
                ),
            expectAppleError(
                'apple_jwks_failed',
                {
                    status: 503,
                    retryable: true,
                }
            )
        );
    }
);

test(
    'caches Apple JWKS and refreshes once for an unknown key ID',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const first =
            makeIdentityTokenFixture();

        const second =
            makeIdentityTokenFixture();

        let calls = 0;

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () => {
                        calls += 1;

                        return jsonResponse({
                            keys:
                                calls === 1
                                    ? [
                                        first.jwk,
                                    ]
                                    : [
                                        first.jwk,
                                        second.jwk,
                                    ],
                        });
                    },
                now: () => NOW_MS,
            });

        await verify(
            first.signToken()
        );

        await verify(
            first.signToken()
        );

        assert.equal(calls, 1);

        await verify(
            second.signToken()
        );

        assert.equal(calls, 2);
    }
);

test(
    'shares one in-flight JWKS request across concurrent verifications',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        let calls = 0;

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () => {
                        calls += 1;

                        await new Promise(
                            (resolve) =>
                                setTimeout(
                                    resolve,
                                    10
                                )
                        );

                        return jsonResponse({
                            keys: [
                                fixture.jwk,
                            ],
                        });
                    },
                now: () => NOW_MS,
            });

        await Promise.all([
            verify(
                fixture.signToken()
            ),
            verify(
                fixture.signToken()
            ),
        ]);

        assert.equal(calls, 1);
    }
);

test(
    'uses a bounded stale cached Apple key during a temporary JWKS outage',
    async () => {
        const { config } =
            makeAppleClientConfig();

        const fixture =
            makeIdentityTokenFixture();

        let currentTime = NOW_MS;
        let calls = 0;

        const verify =
            createAppleIdentityTokenVerifier({
                config,
                fetchImpl:
                    async () => {
                        calls += 1;

                        if (calls === 1) {
                            return jsonResponse({
                                keys: [
                                    fixture.jwk,
                                ],
                            });
                        }

                        throw new Error(
                            'temporary outage'
                        );
                    },
                now: () =>
                    currentTime,
                jwksTtlMs: 100,
                jwksStaleTtlMs:
                    1_000,
            });

        await verify(
            fixture.signToken()
        );

        currentTime += 150;

        const result =
            await verify(
                fixture.signToken()
            );

        assert.equal(
            result.subject,
            'apple-user-subject'
        );

        assert.equal(calls, 2);
    }
);

test(
    'exchanges an Apple authorization code using the native client ID',
    async () => {
        const { config } =
            makeAppleClientConfig();

        let captured;

        const result =
            await exchangeAppleAuthorizationCode({
                authorizationCode:
                    'authorization-code',
                config,
                nowSeconds:
                    NOW_SECONDS,
                fetchImpl:
                    async (
                        url,
                        options
                    ) => {
                        captured = {
                            url,
                            options,
                            form:
                                formToObject(
                                    options.body
                                ),
                        };

                        return jsonResponse({
                            access_token:
                                'apple-access-token',
                            token_type:
                                'Bearer',
                            expires_in:
                                3600,
                            refresh_token:
                                'apple-refresh-token',
                            id_token:
                                'apple-identity-token',
                        });
                    },
            });

        assert.equal(
            captured.url,
            appleSignInConstants
                .tokenUrl
        );

        assert.equal(
            captured.form.client_id,
            config.clientId
        );

        assert.equal(
            captured.form.code,
            'authorization-code'
        );

        assert.equal(
            captured.form.grant_type,
            'authorization_code'
        );

        assert.ok(
            captured.form.client_secret
        );

        assert.equal(
            result.refreshToken,
            'apple-refresh-token'
        );

        assert.equal(
            result.identityToken,
            'apple-identity-token'
        );

        assert.equal(
            result.expiresIn,
            3600
        );
    }
);

test(
    'rejects incomplete initial Apple authorization responses',
    async (t) => {
        const { config } =
            makeAppleClientConfig();

        const complete = {
            access_token:
                'apple-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token:
                'apple-refresh-token',
            id_token:
                'apple-identity-token',
        };

        const cases = [
            [
                'refresh_token',
                {
                    ...complete,
                    refresh_token:
                        undefined,
                },
            ],
            [
                'id_token',
                {
                    ...complete,
                    id_token:
                        undefined,
                },
            ],
            [
                'token_type',
                {
                    ...complete,
                    token_type: 'MAC',
                },
            ],
            [
                'expires_in',
                {
                    ...complete,
                    expires_in: 0,
                },
            ],
        ];

        for (const [
            name,
            responseBody,
        ] of cases) {
            await t.test(
                name,
                async () => {
                    await assert.rejects(
                        () =>
                            exchangeAppleAuthorizationCode({
                                authorizationCode:
                                    'authorization-code',
                                config,
                                nowSeconds:
                                    NOW_SECONDS,
                                fetchImpl:
                                    async () =>
                                        jsonResponse(
                                            responseBody
                                        ),
                            }),
                        expectAppleError(
                            'invalid_apple_token_response',
                            {
                                status: 502,
                            }
                        )
                    );
                }
            );
        }
    }
);

test(
    'validates an Apple refresh token without requiring a replacement refresh token',
    async () => {
        const { config } =
            makeAppleClientConfig();

        let form;

        const result =
            await validateAppleRefreshToken({
                refreshToken:
                    'stored-refresh-token',
                config,
                nowSeconds:
                    NOW_SECONDS,
                fetchImpl:
                    async (
                        _url,
                        options
                    ) => {
                        form =
                            formToObject(
                                options.body
                            );

                        return jsonResponse({
                            access_token:
                                'new-access-token',
                            token_type:
                                'Bearer',
                            expires_in:
                                3600,
                        });
                    },
            });

        assert.equal(
            form.grant_type,
            'refresh_token'
        );

        assert.equal(
            form.refresh_token,
            'stored-refresh-token'
        );

        assert.equal(
            result.accessToken,
            'new-access-token'
        );

        assert.equal(
            result.refreshToken,
            null
        );
    }
);

test(
    'revokes an Apple refresh token',
    async () => {
        const { config } =
            makeAppleClientConfig();

        let captured;

        const result =
            await revokeAppleToken({
                token:
                    'stored-refresh-token',
                config,
                nowSeconds:
                    NOW_SECONDS,
                fetchImpl:
                    async (
                        url,
                        options
                    ) => {
                        captured = {
                            url,
                            form:
                                formToObject(
                                    options.body
                                ),
                        };

                        return jsonResponse(
                            {}
                        );
                    },
            });

        assert.equal(
            captured.url,
            appleSignInConstants
                .revokeUrl
        );

        assert.equal(
            captured.form
                .token_type_hint,
            'refresh_token'
        );

        assert.equal(
            result.success,
            true
        );
    }
);

test(
    'classifies Apple OAuth failures without exposing credentials',
    async (t) => {
        const { config } =
            makeAppleClientConfig();

        const cases = [
            {
                name:
                    'invalid_grant',
                appleCode:
                    'invalid_grant',
                responseStatus: 400,
                expectedStatus: 401,
                retryable: false,
            },
            {
                name:
                    'invalid_request',
                appleCode:
                    'invalid_request',
                responseStatus: 400,
                expectedStatus: 400,
                retryable: false,
            },
            {
                name:
                    'invalid_client',
                appleCode:
                    'invalid_client',
                responseStatus: 400,
                expectedStatus: 503,
                retryable: false,
            },
            {
                name:
                    'rate_limit',
                appleCode:
                    'server_error',
                responseStatus: 429,
                expectedStatus: 503,
                retryable: true,
            },
            {
                name:
                    'server_error',
                appleCode:
                    'server_error',
                responseStatus: 500,
                expectedStatus: 503,
                retryable: true,
            },
        ];

        for (const entry of cases) {
            await t.test(
                entry.name,
                async () => {
                    await assert.rejects(
                        () =>
                            exchangeAppleAuthorizationCode({
                                authorizationCode:
                                    'secret-code',
                                config,
                                nowSeconds:
                                    NOW_SECONDS,
                                fetchImpl:
                                    async () =>
                                        jsonResponse(
                                            {
                                                error:
                                                    entry.appleCode,
                                            },
                                            {
                                                status:
                                                    entry.responseStatus,
                                            }
                                        ),
                            }),
                        (error) => {
                            assert.ok(
                                error instanceof
                                    AppleSignInError
                            );

                            assert.equal(
                                error.code,
                                'apple_code_exchange_failed'
                            );

                            assert.equal(
                                error.status,
                                entry.expectedStatus
                            );

                            assert.equal(
                                error.retryable,
                                entry.retryable
                            );

                            assert.equal(
                                error.appleCode,
                                entry.appleCode
                            );

                            assert.equal(
                                error.message.includes(
                                    'secret-code'
                                ),
                                false
                            );

                            return true;
                        }
                    );
                }
            );
        }
    }
);

test(
    'reports Apple request timeouts as retryable service failures',
    async () => {
        const { config } =
            makeAppleClientConfig();

        await assert.rejects(
            () =>
                exchangeAppleAuthorizationCode({
                    authorizationCode:
                        'authorization-code',
                    config,
                    timeoutMs: 5,
                    nowSeconds:
                        NOW_SECONDS,
                    fetchImpl:
                        async (
                            _url,
                            options
                        ) =>
                            new Promise(
                                (
                                    _resolve,
                                    reject
                                ) => {
                                    options.signal
                                        .addEventListener(
                                            'abort',
                                            () => {
                                                const error =
                                                    new Error(
                                                        'aborted'
                                                    );

                                                error.name =
                                                    'AbortError';

                                                reject(
                                                    error
                                                );
                                            }
                                        );
                                }
                            ),
                }),
            expectAppleError(
                'apple_request_timeout',
                {
                    status: 503,
                    retryable: true,
                }
            )
        );
    }
);

test(
    'rejects invalid JSON returned by Apple',
    async () => {
        const { config } =
            makeAppleClientConfig();

        await assert.rejects(
            () =>
                exchangeAppleAuthorizationCode({
                    authorizationCode:
                        'authorization-code',
                    config,
                    nowSeconds:
                        NOW_SECONDS,
                    fetchImpl:
                        async () =>
                            textResponse(
                                'not-json'
                            ),
                }),
            expectAppleError(
                'apple_code_exchange_failed',
                {
                    status: 502,
                    retryable: true,
                }
            )
        );
    }
);
