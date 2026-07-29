import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesSource = await readFile(
    new URL(
        '../accountDailyChallengeProgressRoutes.js',
        import.meta.url
    ),
    'utf8'
);
const serviceSource = await readFile(
    new URL(
        '../lib/accountDailyChallengeProgressService.js',
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
        '../migrations/005_account_daily_challenge_progress.sql',
        import.meta.url
    ),
    'utf8'
);

function positionOf(source, fragment) {
    const position =
        source.indexOf(fragment);

    assert.notEqual(
        position,
        -1,
        `Expected source to contain: ${fragment}`
    );

    return position;
}

test('route requires installation and strict Bearer authentication', () => {
    assert.match(
        routesSource,
        /X-Installation-ID header is required/
    );
    assert.match(
        routesSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
});

test('route exposes one authenticated merge endpoint', () => {
    assert.match(
        routesSource,
        /router\.post\(\s*'\/sync'/
    );
    assert.match(
        routesSource,
        /service[\s\S]*?\.syncProgress\(\{/
    );
    assert.doesNotMatch(
        routesSource,
        /router\.delete\(/
    );
});

test('migration stores active snapshots and permanent clear tombstones', () => {
    assert.match(
        migrationSource,
        /status IN \('active', 'cleared'\)/
    );
    assert.match(
        migrationSource,
        /PRIMARY KEY \(account_id, challenge_id\)/
    );
    assert.match(
        migrationSource,
        /messages JSONB/
    );
});

test('service blocks resurrection after completion history exists', () => {
    assert.match(
        serviceSource,
        /account_debate_history/
    );
    assert.match(
        serviceSource,
        /completed_ignored/
    );
    assert.match(
        serviceSource,
        /status === 'cleared'/
    );
});

test('route logs no answers, messages, tokens, or bodies', () => {
    const start = positionOf(
        routesSource,
        'function logUnexpectedError'
    );
    const end = positionOf(
        routesSource,
        'export function createAccountDailyChallengeProgressRouter'
    );

    const logSource =
        routesSource.slice(start, end);

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
        /Never log challenge answers, messages, access tokens, or request bodies/
    );
});

test('server mounts progress route before generic account router', () => {
    const progressMount =
        positionOf(
            serverSource,
            "'/api/account/daily-challenge-progress'"
        );
    const genericMount =
        positionOf(
            serverSource,
            "app.use('/api/account', accountAuthRouter);"
        );

    assert.ok(
        progressMount < genericMount
    );
});

test('server gives progress payloads a route-specific parser and limiter', () => {
    assert.match(
        serverSource,
        /const accountDailyChallengeProgressLimiter = rateLimit\(\{/
    );
    assert.match(
        serverSource,
        /too_many_daily_challenge_progress_requests/
    );
    assert.match(
        serverSource,
        /daily-challenge-progress'[\s\S]*?express\.json\(\{ limit: '512kb' \}\)/
    );
});
