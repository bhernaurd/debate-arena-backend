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
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
    });

    const privateKeyPem = privateKey.export({
        type: 'pkcs8',
        format: 'pem',
    });

    const env = {
        APPLE_SIGN_IN_TEAM_ID: 'TEAM123456',
        APPLE_SIGN_IN_KEY_ID: 'KEY123456',
        APPLE_SIGN_IN_CLIENT_ID: 'com.example.TheAgora',
        APPLE_SIGN_IN_PRIVATE_KEY: privateKeyPem,
    };

    return {
        config: loadAppleSignInConfig(env),
        publicKey,
    };
}

function decodeJwt(token) {
    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');

    return {
        encodedHeader,
        encodedPayload,
        encodedSignature,
        header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
        payload: JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')),
        signature: Buffer.from(encodedSignature, 'base64url'),
        signingInput: `${encodedHeader}.${encodedPayload}`,
    };
}

function makeIdentityTokenFixture(kid = `apple-test-${crypto.randomUUID()}`) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });

    const publicJwk = publicKey.export({ format: 'jwk' });

    const jwk = {
        ...publicJwk,
        kid,
        use: 'sig',
        alg: 'RS256',
    };

    function signToken(overrides = {}, headerOverrides = {}) {
        const header = {
            alg: 'RS256',
            kid,
            typ: 'JWT',
            ...headerOverrides,
        };

        const payload = {
            iss: appleSignInConstants.issuer,
            aud: 'com.example.TheAgora',
            sub: 'apple-user-subject',
            iat: NOW_SECONDS - 5,
            exp: NOW_SECONDS + 300,
            nonce: 'a'.repeat(64),
            email: 'relay@example.com',
            email_verified: 'true',
            is_private_email: 'true',
            ...overrides,
        };

        const encodedHeader = Buffer.from(
            JSON.stringify(header)
        ).toString('base64url');
        const encodedPayload = Buffer.from(
            JSON.stringify(payload)
        ).toString('base64url');
        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = crypto.sign(
            'RSA-SHA256',
            Buffer.from(signingInput, 'utf8'),
            privateKey
        );

        return `${signingInput}.${signature.toString('base64url')}`;
    }

    return { jwk, kid, signToken };
}

function jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function formToObject(body) {
    return Object.fromEntries(new URLSearchParams(body).entries());
}

test('loads and validates Apple Sign in configuration', () => {
    const { config } = makeAppleClientConfig();

    assert.equal(config.teamId, 'TEAM123456');
    assert.equal(config.keyId, 'KEY123456');
    assert.equal(config.clientId, 'com.example.TheAgora');
    assert.equal(config.privateKey.asymmetricKeyType, 'ec');
});

test('rejects a non-EC Apple private key', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });

    assert.throws(
        () => loadAppleSignInConfig({
            APPLE_SIGN_IN_TEAM_ID: 'TEAM123456',
            APPLE_SIGN_IN_KEY_ID: 'KEY123456',
            APPLE_SIGN_IN_CLIENT_ID: 'com.example.TheAgora',
            APPLE_SIGN_IN_PRIVATE_KEY: privateKey.export({
                type: 'pkcs8',
                format: 'pem',
            }),
        }),
        (error) => error instanceof AppleSignInError &&
            error.code === 'invalid_configuration'
    );
});

test('creates a correctly signed short-lived Apple client secret', () => {
    const { config, publicKey } = makeAppleClientConfig();
    const token = createAppleClientSecret(config, {
        nowSeconds: NOW_SECONDS,
        lifetimeSeconds: 300,
    });
    const parsed = decodeJwt(token);

    assert.deepEqual(parsed.header, {
        alg: 'ES256',
        kid: 'KEY123456',
        typ: 'JWT',
    });
    assert.deepEqual(parsed.payload, {
        iss: 'TEAM123456',
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 300,
        aud: appleSignInConstants.issuer,
        sub: 'com.example.TheAgora',
    });
    assert.equal(
        crypto.verify(
            'sha256',
            Buffer.from(parsed.signingInput, 'utf8'),
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            parsed.signature
        ),
        true
    );
});

test('limits Apple client-secret lifetime to one hour', () => {
    const { config } = makeAppleClientConfig();

    assert.throws(
        () => createAppleClientSecret(config, {
            nowSeconds: NOW_SECONDS,
            lifetimeSeconds: 3601,
        }),
        (error) => error instanceof AppleSignInError &&
            error.code === 'invalid_input'
    );
});

test('verifies a valid Apple identity token and normalizes claims', async () => {
    const { config } = makeAppleClientConfig();
    const fixture = makeIdentityTokenFixture();
    const fetchImpl = async () => jsonResponse({ keys: [fixture.jwk] });
    const verify = createAppleIdentityTokenVerifier({
        config,
        fetchImpl,
        now: () => NOW_MS,
    });

    const result = await verify(fixture.signToken(), {
        expectedNonceHash: 'a'.repeat(64),
    });

    assert.equal(result.subject, 'apple-user-subject');
    assert.equal(result.emailVerified, true);
    assert.equal(result.isPrivateEmail, true);
});

test('accepts an audience array containing the native client ID', async () => {
    const { config } = makeAppleClientConfig();
    const fixture = makeIdentityTokenFixture();
    const verify = createAppleIdentityTokenVerifier({
        config,
        fetchImpl: async () => jsonResponse({ keys: [fixture.jwk] }),
        now: () => NOW_MS,
    });

    const result = await verify(fixture.signToken({
        aud: ['another-client', config.clientId],
    }));

    assert.equal(result.audience, config.clientId);
});

test('rejects an invalid Apple identity-token signature', async () => {
    const { config } = makeAppleClientConfig();
    const trusted = makeIdentityTokenFixture();
    const untrusted = makeIdentityTokenFixture();
    const verify = createAppleIdentityTokenVerifier({
        config,
        fetchImpl: async () => jsonResponse({
            keys: [{ ...trusted.jwk, kid: untrusted.kid }],
        }),
        now: () => NOW_MS,
    });

    await assert.rejects(
        () => verify(untrusted.signToken()),
        (error) => error instanceof AppleSignInError &&
            error.code === 'invalid_identity_token'
    );
});

test('rejects incorrect issuer, audience, expiration, and future issue time', async (t) => {
    const { config } = makeAppleClientConfig();
    const fixture = makeIdentityTokenFixture();

    async function rejectClaims(overrides, code = 'invalid_identity_token') {
        const verify = createAppleIdentityTokenVerifier({
            config,
            fetchImpl: async () => jsonResponse({ keys: [fixture.jwk] }),
            now: () => NOW_MS,
        });

        await assert.rejects(
            () => verify(fixture.signToken(overrides)),
            (error) => error instanceof AppleSignInError &&
                error.code === code
        );
    }

    await t.test('issuer', () => rejectClaims({ iss: 'https://evil.example' }));
    await t.test('audience', () => rejectClaims({ aud: 'wrong-client' }));
    await t.test('expiration', () => rejectClaims(
        { exp: NOW_SECONDS - 120 },
        'identity_token_expired'
    ));
    await t.test('future iat', () => rejectClaims({ iat: NOW_SECONDS + 120 }));
});

test('rejects nonce and subject mismatches', async (t) => {
    const { config } = makeAppleClientConfig();
    const fixture = makeIdentityTokenFixture();

    function verifier() {
        return createAppleIdentityTokenVerifier({
            config,
            fetchImpl: async () => jsonResponse({ keys: [fixture.jwk] }),
            now: () => NOW_MS,
        });
    }

    await t.test('nonce', async () => {
        await assert.rejects(
            () => verifier()(fixture.signToken(), {
                expectedNonceHash: 'b'.repeat(64),
            }),
            (error) => error instanceof AppleSignInError &&
                error.code === 'identity_nonce_mismatch'
        );
    });

    await t.test('subject', async () => {
        await assert.rejects(
            () => verifier()(fixture.signToken(), {
                expectedSubject: 'different-subject',
            }),
            (error) => error instanceof AppleSignInError &&
                error.code === 'identity_subject_mismatch'
        );
    });
});

test('caches Apple JWKS and refreshes once for an unknown key id', async () => {
    const { config } = makeAppleClientConfig();
    const first = makeIdentityTokenFixture();
    const second = makeIdentityTokenFixture();
    let calls = 0;

    const verify = createAppleIdentityTokenVerifier({
        config,
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse({
                keys: calls === 1
                    ? [first.jwk]
                    : [first.jwk, second.jwk],
            });
        },
        now: () => NOW_MS,
    });

    await verify(first.signToken());
    await verify(first.signToken());
    assert.equal(calls, 1);

    await verify(second.signToken());
    assert.equal(calls, 2);
});

test('exchanges an Apple authorization code using the native client ID', async () => {
    const { config } = makeAppleClientConfig();
    let captured;

    const result = await exchangeAppleAuthorizationCode({
        authorizationCode: 'authorization-code',
        config,
        nowSeconds: NOW_SECONDS,
        fetchImpl: async (url, options) => {
            captured = { url, options, form: formToObject(options.body) };
            return jsonResponse({
                access_token: 'apple-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                refresh_token: 'apple-refresh-token',
                id_token: 'apple-identity-token',
            });
        },
    });

    assert.equal(captured.url, appleSignInConstants.tokenUrl);
    assert.equal(captured.form.client_id, config.clientId);
    assert.equal(captured.form.code, 'authorization-code');
    assert.equal(captured.form.grant_type, 'authorization_code');
    assert.ok(captured.form.client_secret);
    assert.equal(result.refreshToken, 'apple-refresh-token');
});

test('validates an Apple refresh token', async () => {
    const { config } = makeAppleClientConfig();
    let form;

    const result = await validateAppleRefreshToken({
        refreshToken: 'stored-refresh-token',
        config,
        nowSeconds: NOW_SECONDS,
        fetchImpl: async (_url, options) => {
            form = formToObject(options.body);
            return jsonResponse({
                access_token: 'new-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
            });
        },
    });

    assert.equal(form.grant_type, 'refresh_token');
    assert.equal(form.refresh_token, 'stored-refresh-token');
    assert.equal(result.accessToken, 'new-access-token');
});

test('revokes an Apple refresh token', async () => {
    const { config } = makeAppleClientConfig();
    let captured;

    const result = await revokeAppleToken({
        token: 'stored-refresh-token',
        config,
        nowSeconds: NOW_SECONDS,
        fetchImpl: async (url, options) => {
            captured = { url, form: formToObject(options.body) };
            return jsonResponse({});
        },
    });

    assert.equal(captured.url, appleSignInConstants.revokeUrl);
    assert.equal(captured.form.token_type_hint, 'refresh_token');
    assert.equal(result.success, true);
});

test('surfaces Apple token endpoint errors without exposing tokens', async () => {
    const { config } = makeAppleClientConfig();

    await assert.rejects(
        () => exchangeAppleAuthorizationCode({
            authorizationCode: 'bad-code',
            config,
            nowSeconds: NOW_SECONDS,
            fetchImpl: async () => jsonResponse(
                { error: 'invalid_grant' },
                { status: 400 }
            ),
        }),
        (error) => error instanceof AppleSignInError &&
            error.code === 'apple_code_exchange_failed' &&
            !error.message.includes('bad-code')
    );
});
