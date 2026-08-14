import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesUrl = new URL(
    '../appStoreSubscriptionRoutes.js',
    import.meta.url
);
const serverUrl = new URL('../server.js', import.meta.url);
const ownershipUrl = new URL(
    '../lib/accountSubscriptionOwnership.js',
    import.meta.url
);

const routesSource = await readFile(routesUrl, 'utf8');
const serverSource = await readFile(serverUrl, 'utf8');
const ownershipSource = await readFile(
    ownershipUrl,
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

test('subscription sync accepts an optional strict Bearer access token', () => {
    assert.match(
        routesSource,
        /function optionalBearerAccessToken\(req\)/
    );
    assert.match(
        routesSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
    assert.match(
        routesSource,
        /if \(authorization == null \|\| authorization === ''\)/
    );
});

test('legacy clients can still sync without an account access token', () => {
    assert.match(
        routesSource,
        /if \(accessToken\) \{[\s\S]*?authorizeSubscriptionSync/
    );
    assert.doesNotMatch(
        routesSource,
        /if \(!accessToken\)[\s\S]*?return res\.status\(401\)/
    );
});

test('authenticated sync uses the shared account authorization service', () => {
    assert.match(
        routesSource,
        /accountSubscriptionOwnershipService[\s\S]*?authorizeSubscriptionSync/
    );
    assert.match(
        routesSource,
        /installationId: requestedUserId,[\s\S]*?accessToken/
    );
});

test('ownership is claimed inside the same transaction after verified entitlement persistence', () => {
    const begin = positionOf(
        routesSource,
        "await client.query('BEGIN');"
    );
    const persist = positionOf(
        routesSource,
        'const result = await persistVerifiedSnapshot(client, {'
    );
    const claim = positionOf(
        routesSource,
        '.claimVerifiedSubscription({'
    );
    const commit = positionOf(
        routesSource,
        "await client.query('COMMIT');"
    );

    assert.ok(begin < persist);
    assert.ok(persist < claim);
    assert.ok(claim < commit);
});

test('legacy user_id resolution never promotes appAccountToken to installation identity', () => {
    assert.match(
        routesSource,
        /return existingUserId \|\| requestedUserId \|\| null;/
    );
    assert.doesNotMatch(
        routesSource,
        /return existingUserId \|\| tokenUserId/
    );
});

test('legacy subscription installation links exclude the account UUID appAccountToken', () => {
    assert.match(
        routesSource,
        /\[canonicalUserId, requestedUserId\]/
    );
    assert.doesNotMatch(
        routesSource,
        /\[canonicalUserId, requestedUserId, tokenUserId\]/
    );
});

test('account ownership errors remain backward-compatible JSON errors', () => {
    assert.match(
        routesSource,
        /success: false,[\s\S]*?error:[\s\S]*?errorCode:[\s\S]*?retryable:/
    );
});

test('ownership claims serialize first-time concurrent inserts with a PostgreSQL advisory transaction lock', () => {
    assert.match(
        ownershipSource,
        /pg_advisory_xact_lock/
    );

    const chainLock = positionOf(
        ownershipSource,
        'await repo.lockOwnershipChain({'
    );
    const rowLock = positionOf(
        ownershipSource,
        'const existing = await repo.lockOwnership({'
    );

    assert.ok(chainLock < rowLock);
});

test('server constructs one shared account service and passes it to both route families', () => {
    assert.match(
        serverSource,
        /const accountAuthService = createAccountAuthService\(\{ pool \}\);/
    );
    assert.match(
        serverSource,
        /createAccountAuthRouter\(pool, \{[\s\S]*?service: accountAuthService/
    );
    assert.match(
        serverSource,
        /createAccountSubscriptionOwnershipService\(\{[\s\S]*?accountAuthService/
    );
    assert.match(
        serverSource,
        /createAppStoreSubscriptionRouter\(pool, \{[\s\S]*?accountSubscriptionOwnershipService/
    );
});

test('App Store Server Notifications remain registered and do not require an Agora bearer token', () => {
    assert.match(
        routesSource,
        /router\.post\('\/api\/app-store\/notifications'/
    );

    const notificationStart = positionOf(
        routesSource,
        "router.post('/api/app-store/notifications'"
    );
    const notificationSource =
        routesSource.slice(notificationStart);

    assert.doesNotMatch(
        notificationSource,
        /optionalBearerAccessToken\(req\)/
    );
});


test('affiliate attribution is isolated by a savepoint so it cannot deny Apple-authoritative subscription access', () => {
    assert.match(
        routesSource,
        /async function observeAffiliateAttributionSafely[\s\S]*?SAVEPOINT[\s\S]*?observeVerifiedTransaction[\s\S]*?ROLLBACK TO SAVEPOINT/
    );

    const persistStart = positionOf(
        routesSource,
        'async function persistVerifiedSnapshot(client, {'
    );
    const persistSource = routesSource.slice(persistStart);
    const transactionUpsert = positionOf(
        persistSource,
        'const storedTransaction = await upsertTransaction(client, {'
    );
    const entitlementUpsert = positionOf(
        persistSource,
        'const entitlement = await upsertEntitlement(client, {'
    );
    const eventInsert = positionOf(
        persistSource,
        'await insertSubscriptionEvent(client, {'
    );
    const affiliateObserve = positionOf(
        persistSource,
        'await observeAffiliateAttributionSafely('
    );

    assert.ok(transactionUpsert < entitlementUpsert);
    assert.ok(entitlementUpsert < eventInsert);
    assert.ok(eventInsert < affiliateObserve);
});

test('server constructs, injects, and can emergency-disable affiliate subscription attribution', () => {
    assert.match(
        serverSource,
        /createAffiliateSubscriptionAttributionService/
    );
    assert.match(
        serverSource,
        /AFFILIATE_SUBSCRIPTION_ATTRIBUTION_ENABLED/
    );
    assert.match(
        serverSource,
        /affiliateSubscriptionAttributionEnabled[\s\S]*?createAffiliateSubscriptionAttributionService\(\{[\s\S]*?pool/
    );
    assert.match(
        serverSource,
        /createAppStoreSubscriptionRouter\(pool, \{[\s\S]*?affiliateSubscriptionAttributionService/
    );
});
