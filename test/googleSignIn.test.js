import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    GoogleSignInError,
    createGoogleIdTokenVerifier,
} from '../lib/googleSignIn.js';

const CLIENT_ID = 'agora-android-test.apps.googleusercontent.com';
const NOW_MS = Date.parse('2026-08-19T23:00:00.000Z');

function fixture() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = 'agora-google-test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const fetchImpl = async () => ({
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'cache-control' ? 'public, max-age=3600' : null },
        json: async () => ({ keys: [jwk] }),
    });

    return { privateKey, fetchImpl };
}

function encode(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function signToken(privateKey, overrides = {}) {
    const nowSeconds = Math.floor(NOW_MS / 1000);
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'agora-google-test-key' });
    const payload = encode({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'google-subject-123456789',
        email: 'android@example.com',
        email_verified: true,
        name: 'Android Tester',
        nonce: 'nonce-for-this-attempt',
        iat: nowSeconds - 30,
        exp: nowSeconds + 3600,
        ...overrides,
    });
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign(
        'RSA-SHA256',
        Buffer.from(signingInput, 'ascii'),
        privateKey
    ).toString('base64url');
    return `${signingInput}.${signature}`;
}

test('verifies a Google ID token and returns the stable sub identity', async () => {
    const { privateKey, fetchImpl } = fixture();
    const verify = createGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        fetchImpl,
        now: () => NOW_MS,
    });

    const identity = await verify(signToken(privateKey), {
        expectedNonce: 'nonce-for-this-attempt',
    });

    assert.equal(identity.issuer, 'https://accounts.google.com');
    assert.equal(identity.audience, CLIENT_ID);
    assert.equal(identity.subject, 'google-subject-123456789');
    assert.equal(identity.email, 'android@example.com');
    assert.equal(identity.displayName, 'Android Tester');
});

test('rejects a token issued for a different OAuth audience', async () => {
    const { privateKey, fetchImpl } = fixture();
    const verify = createGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        fetchImpl,
        now: () => NOW_MS,
    });

    await assert.rejects(
        verify(signToken(privateKey, { aud: 'different-client.apps.googleusercontent.com' }), {
            expectedNonce: 'nonce-for-this-attempt',
        }),
        (error) => error instanceof GoogleSignInError && error.code === 'invalid_google_credential'
    );
});

test('rejects a token whose nonce does not belong to this sign-in attempt', async () => {
    const { privateKey, fetchImpl } = fixture();
    const verify = createGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        fetchImpl,
        now: () => NOW_MS,
    });

    await assert.rejects(
        verify(signToken(privateKey), { expectedNonce: 'different-nonce' }),
        (error) => error instanceof GoogleSignInError && error.code === 'invalid_google_credential'
    );
});

test('rejects an expired Google ID token', async () => {
    const { privateKey, fetchImpl } = fixture();
    const verify = createGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        fetchImpl,
        now: () => NOW_MS,
    });
    const nowSeconds = Math.floor(NOW_MS / 1000);

    await assert.rejects(
        verify(signToken(privateKey, { exp: nowSeconds - 120 }), {
            expectedNonce: 'nonce-for-this-attempt',
        }),
        (error) => error instanceof GoogleSignInError && error.code === 'invalid_google_credential'
    );
});

test('rejects a token with a tampered signature', async () => {
    const { privateKey, fetchImpl } = fixture();
    const verify = createGoogleIdTokenVerifier({
        clientId: CLIENT_ID,
        fetchImpl,
        now: () => NOW_MS,
    });
    const token = signToken(privateKey);
    const parts = token.split('.');
    parts[1] = encode({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: 'attacker',
        nonce: 'nonce-for-this-attempt',
        iat: Math.floor(NOW_MS / 1000) - 30,
        exp: Math.floor(NOW_MS / 1000) + 3600,
    });

    await assert.rejects(
        verify(parts.join('.'), { expectedNonce: 'nonce-for-this-attempt' }),
        (error) => error instanceof GoogleSignInError && error.code === 'invalid_google_credential'
    );
});
