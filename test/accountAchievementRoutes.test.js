import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesSource = await readFile(
    new URL(
        '../accountAchievementRoutes.js',
        import.meta.url
    ),
    'utf8'
);
const serviceSource = await readFile(
    new URL(
        '../lib/accountAchievementService.js',
        import.meta.url
    ),
    'utf8'
);
const serverSource = await readFile(
    new URL(
        '../server.js',
        import.meta.url
    ),
    'utf8'
);
const migrationSource = await readFile(
    new URL(
        '../migrations/004_account_achievement_unlocks.sql',
        import.meta.url
    ),
    'utf8'
);

function positionOf(
    source,
    fragment
) {
    const position =
        source.indexOf(fragment);

    assert.notEqual(
        position,
        -1,
        `Expected source to contain: ${fragment}`
    );

    return position;
}

test('achievement route requires installation and strict Bearer authentication', () => {
    assert.match(
        routesSource,
        /X-Installation-ID header is required/
    );
    assert.match(
        routesSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
});

test('achievement router exposes one authenticated merge endpoint', () => {
    assert.match(
        routesSource,
        /router\.post\(\s*'\/sync'/
    );
    assert.match(
        routesSource,
        /service[\s\S]*?\.syncUnlocks\(\{/
    );
    assert.doesNotMatch(
        routesSource,
        /router\.delete\(/
    );
});

test('achievement responses disable caching', () => {
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

test('achievement errors never log request bodies or access tokens', () => {
    const start = positionOf(
        routesSource,
        'function logUnexpectedError'
    );
    const end = positionOf(
        routesSource,
        'export function createAccountAchievementRouter'
    );
    const logSource =
        routesSource.slice(
            start,
            end
        );

    assert.doesNotMatch(
        logSource,
        /req\.body/
    );
    assert.doesNotMatch(
        logSource,
        /Authorization/
    );
    assert.match(
        logSource,
        /Never log access tokens or request bodies/
    );
});

test('migration uses account and achievement id as the canonical key', () => {
    assert.match(
        migrationSource,
        /PRIMARY KEY \(account_id, achievement_id\)/
    );
});

test('migration stores only account-owned unlock metadata', () => {
    assert.match(
        migrationSource,
        /achievement_id TEXT NOT NULL/
    );
    assert.match(
        migrationSource,
        /unlocked_at TIMESTAMPTZ NOT NULL/
    );
    assert.match(
        migrationSource,
        /origin_installation_id TEXT NOT NULL/
    );
    assert.doesNotMatch(
        migrationSource,
        /title TEXT/
    );
    assert.doesNotMatch(
        migrationSource,
        /description TEXT/
    );
    assert.doesNotMatch(
        migrationSource,
        /current_value/
    );
});

test('repository preserves the earliest unlock date', () => {
    assert.match(
        serviceSource,
        /unlocked_at = LEAST\([\s\S]*?account_achievement_unlocks\.unlocked_at,[\s\S]*?EXCLUDED\.unlocked_at/
    );
});

test('empty record arrays remain valid for cross-device download', () => {
    assert.doesNotMatch(
        serviceSource,
        /records must contain at least one/
    );
    assert.match(
        serviceSource,
        /submittedCount:[\s\S]*?normalizedRecords\.length/
    );
});

test('server shares account authorization with the achievement service', () => {
    assert.match(
        serverSource,
        /createAccountAchievementService\(\{[\s\S]*?pool,[\s\S]*?accountAuthService/
    );
    assert.match(
        serverSource,
        /createAccountAchievementRouter\(\{[\s\S]*?service: accountAchievementService/
    );
});

test('achievement router mounts before the generic account router', () => {
    const achievementMount =
        positionOf(
            serverSource,
            "'/api/account/achievements'"
        );
    const genericAccountMount =
        positionOf(
            serverSource,
            "app.use('/api/account', accountAuthRouter);"
        );

    assert.ok(
        achievementMount <
            genericAccountMount
    );
});

test('server rate-limits account achievement sync', () => {
    assert.match(
        serverSource,
        /const accountAchievementLimiter = rateLimit\(\{/
    );
    assert.match(
        serverSource,
        /too_many_achievement_sync_requests/
    );
});
