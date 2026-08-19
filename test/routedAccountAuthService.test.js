import assert from 'node:assert/strict';
import test from 'node:test';

import { createRoutedAccountAuthService } from '../lib/routedAccountAuthService.js';

function jwt(aud) {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ aud })).toString('base64url');
    return `${header}.${payload}.signature`;
}

function service(name) {
    return {
        createAppleChallenge: async () => name,
        signInWithApple: async () => name,
        refreshSession: async () => name,
        authorizeAccessToken: async () => name,
        deleteAccount: async () => name,
        decryptStoredAppleRefreshToken: async () => name,
    };
}

test('web Services ID credentials route to web auth while Agora sessions remain shared', async () => {
    const native = service('native');
    const web = service('web');
    const routed = createRoutedAccountAuthService({
        nativeService: native,
        webService: web,
        webClientId: 'com.bhernaurd.theagora.web',
    });

    assert.equal(
        await routed.signInWithApple({
            identityToken: jwt('com.bhernaurd.theagora.web'),
        }),
        'web'
    );
    assert.equal(
        await routed.deleteAccount({
            identityToken: jwt(['other', 'com.bhernaurd.theagora.web']),
        }),
        'web'
    );
    assert.equal(await routed.refreshSession({}), 'native');
    assert.equal(await routed.authorizeAccessToken({}), 'native');
});

test('native or malformed Apple credentials stay on the native verifier', async () => {
    const routed = createRoutedAccountAuthService({
        nativeService: service('native'),
        webService: service('web'),
        webClientId: 'com.bhernaurd.theagora.web',
    });

    assert.equal(
        await routed.signInWithApple({ identityToken: jwt('com.bhernaurd.TheAgora') }),
        'native'
    );
    assert.equal(
        await routed.signInWithApple({ identityToken: 'not-a-jwt' }),
        'native'
    );
});
