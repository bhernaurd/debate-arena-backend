import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createAppleWebAuthFlow,
    loadAppleWebAuthFlowConfig,
} from '../lib/appleWebAuthFlow.js';

const flowKey = Buffer.alloc(32, 7).toString('base64');

function config() {
    return loadAppleWebAuthFlowConfig({
        APPLE_SIGN_IN_WEB_CLIENT_ID: 'com.bhernaurd.theagora.web',
        APPLE_SIGN_IN_WEB_REDIRECT_URI:
            'https://example.com/api/account/apple/web/callback',
        APPLE_SIGN_IN_WEB_FLOW_KEY: flowKey,
        APPLE_SIGN_IN_ANDROID_RETURN_URI: 'theagora://auth/apple',
    });
}

test('web auth stays disabled when its dedicated environment is absent', () => {
    const loaded = loadAppleWebAuthFlowConfig({});
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.missing.length, 3);
});

test('web auth start binds Apple nonce, Services ID, redirect URI, and encrypted state', () => {
    const now = 1_800_000_000_000;
    const flow = createAppleWebAuthFlow(config(), { now: () => now });
    const result = flow.createAuthorizationStart({
        installationId: '11111111-1111-4111-8111-111111111111',
        purpose: 'sign_in_with_apple',
        challengeId: '22222222-2222-4222-8222-222222222222',
        nonceSha256: 'a'.repeat(64),
        challengeExpiresAt: new Date(now + 9 * 60 * 1000).toISOString(),
    });

    const url = new URL(result.authorizationUrl);
    assert.equal(url.origin + url.pathname, 'https://appleid.apple.com/auth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'com.bhernaurd.theagora.web');
    assert.equal(
        url.searchParams.get('redirect_uri'),
        'https://example.com/api/account/apple/web/callback'
    );
    assert.equal(url.searchParams.get('nonce'), 'a'.repeat(64));
    assert.equal(url.searchParams.get('response_type'), 'code id_token');
    assert.equal(url.searchParams.get('response_mode'), 'form_post');
    assert.equal(url.searchParams.get('scope'), 'name email');
    assert.match(url.searchParams.get('state') ?? '', /^agoraweb\.1\.state\./);
});

test('Apple callback returns only an opaque installation-bound handoff to the app', () => {
    const now = 1_800_000_000_000;
    const flow = createAppleWebAuthFlow(config(), { now: () => now });
    const start = flow.createAuthorizationStart({
        installationId: '11111111-1111-4111-8111-111111111111',
        purpose: 'sign_in_with_apple',
        challengeId: '22222222-2222-4222-8222-222222222222',
        nonceSha256: 'b'.repeat(64),
        challengeExpiresAt: new Date(now + 9 * 60 * 1000).toISOString(),
    });
    const state = new URL(start.authorizationUrl).searchParams.get('state');
    const returnUrl = flow.completeAuthorizationCallback({
        state,
        code: 'secret-authorization-code',
        identityToken: 'secret.identity.token',
        user: JSON.stringify({
            name: { firstName: 'Ada', lastName: 'Lovelace' },
        }),
    });

    assert.match(returnUrl, /^theagora:\/\/auth\/apple\?/);
    assert.equal(returnUrl.includes('secret-authorization-code'), false);
    assert.equal(returnUrl.includes('secret.identity.token'), false);

    const handoff = new URL(returnUrl).searchParams.get('handoff');
    assert.match(handoff ?? '', /^agoraweb\.1\.handoff\./);

    const credential = flow.redeemHandoff({
        handoff,
        installationId: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(credential.purpose, 'sign_in_with_apple');
    assert.equal(credential.challengeId, '22222222-2222-4222-8222-222222222222');
    assert.equal(credential.authorizationCode, 'secret-authorization-code');
    assert.equal(credential.identityToken, 'secret.identity.token');
    assert.equal(credential.displayName, 'Ada Lovelace');

    assert.throws(
        () => flow.redeemHandoff({
            handoff,
            installationId: '33333333-3333-4333-8333-333333333333',
        }),
        /another installation/
    );
});

test('delete-account authorization omits name/email scope and preserves purpose', () => {
    const now = 1_800_000_000_000;
    const flow = createAppleWebAuthFlow(config(), { now: () => now });
    const start = flow.createAuthorizationStart({
        installationId: '11111111-1111-4111-8111-111111111111',
        purpose: 'delete_account',
        challengeId: '22222222-2222-4222-8222-222222222222',
        nonceSha256: 'c'.repeat(64),
        challengeExpiresAt: new Date(now + 9 * 60 * 1000).toISOString(),
    });
    const url = new URL(start.authorizationUrl);
    assert.equal(url.searchParams.has('scope'), false);

    const returnUrl = flow.completeAuthorizationCallback({
        state: url.searchParams.get('state'),
        code: 'delete-code',
        identityToken: 'delete.identity.token',
    });
    assert.equal(new URL(returnUrl).searchParams.get('purpose'), 'delete_account');
});
