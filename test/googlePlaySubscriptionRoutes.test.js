import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesSource = await readFile(
    new URL(
        '../googlePlaySubscriptionRoutes.js',
        import.meta.url
    ),
    'utf8'
);
const serviceSource = await readFile(
    new URL(
        '../lib/googlePlaySubscriptionService.js',
        import.meta.url
    ),
    'utf8'
);
const serverSource = await readFile(
    new URL('../server.js', import.meta.url),
    'utf8'
);
const migrationSource = await readFile(
    new URL(
        '../migrations/033_google_play_subscription_entitlements.sql',
        import.meta.url
    ),
    'utf8'
);

function positionOf(source, fragment) {
    const position = source.indexOf(fragment);
    assert.notEqual(
        position,
        -1,
        `Expected source to contain: ${fragment}`
    );
    return position;
}

test('Google Play sync requires installation-bound Bearer authentication', () => {
    assert.match(
        routesSource,
        /X-Installation-ID header is required/
    );
    assert.match(
        routesSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
    assert.match(
        routesSource,
        /accountAuthService\.authorizeAccessToken\(\{[\s\S]*?installationId,[\s\S]*?accessToken/
    );
});

test('Google Play sync route disables response caching', () => {
    assert.match(
        routesSource,
        /Cache-Control'[\s\S]*?'no-store'/
    );
    assert.match(
        routesSource,
        /Pragma'[\s\S]*?'no-cache'/
    );
    assert.match(
        routesSource,
        /X-Content-Type-Options'[\s\S]*?'nosniff'/
    );
});

test('Google Play route error logging excludes request bodies and credentials', () => {
    const loggerCallStart = positionOf(
        routesSource,
        "logger.error("
    );
    const loggerCallEnd = positionOf(
        routesSource,
        "return res\n                .status(response.status)"
    );
    const loggingSource = routesSource.slice(
        loggerCallStart,
        loggerCallEnd
    );

    assert.doesNotMatch(loggingSource, /req\.body/);
    assert.doesNotMatch(loggingSource, /purchaseToken/);
    assert.doesNotMatch(loggingSource, /Authorization/);
    assert.doesNotMatch(loggingSource, /accessToken/);
    assert.doesNotMatch(loggingSource, /privateKey/);
});

test('Google Play persistence stores purchase-token fingerprints, not raw tokens', () => {
    assert.match(
        migrationSource,
        /purchase_token_sha256 TEXT PRIMARY KEY/
    );
    assert.doesNotMatch(
        migrationSource,
        /\bpurchase_token\s+TEXT\b/
    );
    assert.match(
        serviceSource,
        /const purchaseTokenSha256 = sha256Hex\(token\)/
    );
    assert.doesNotMatch(
        serviceSource,
        /INSERT INTO google_play_subscription_entitlements[\s\S]{0,1200}\bpurchase_token\b/
    );
});

test('verified Google account ID is required to match the authenticated Agora account hash', () => {
    assert.match(
        serviceSource,
        /expectedObfuscatedAccountId = sha256Hex\(accountId\)/
    );
    assert.match(
        serviceSource,
        /obfuscatedExternalAccountId/
    );
    assert.match(
        serviceSource,
        /constantTimeHexEqual\([\s\S]*?verifiedObfuscatedAccountId,[\s\S]*?expectedObfuscatedAccountId/
    );
    assert.match(
        serviceSource,
        /google_play_account_mismatch/
    );
});

test('server mounts Google Play sync before the generic account router and rate-limits it', () => {
    const googlePlayMount = positionOf(
        serverSource,
        "'/api/account/google-play'"
    );
    const genericAccountMount = positionOf(
        serverSource,
        "app.use('/api/account', accountAuthRouter);"
    );

    assert.ok(googlePlayMount < genericAccountMount);
    assert.match(
        serverSource,
        /'\/api\/account\/google-play',[\s\S]*?subscriptionSyncLimiter,[\s\S]*?createGooglePlaySubscriptionRouter/
    );
});

test('Google acknowledgement remains after the database commit', () => {
    const commitPosition = positionOf(
        serviceSource,
        "await client.query('COMMIT');"
    );
    const acknowledgePosition = positionOf(
        serviceSource,
        '.acknowledgeSubscription({'
    );

    assert.ok(
        commitPosition < acknowledgePosition,
        'Verified entitlement must commit before Google acknowledgement.'
    );
});
