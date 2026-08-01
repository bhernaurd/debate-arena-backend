import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routesSource = await readFile(
    new URL('../accountDebateHistoryRoutes.js', import.meta.url),
    'utf8'
);
const serverSource = await readFile(
    new URL('../server.js', import.meta.url),
    'utf8'
);
const migrationSource = await readFile(
    new URL(
        '../migrations/003_account_debate_history.sql',
        import.meta.url
    ),
    'utf8'
);
const rankedHistoryMigrationSource = await readFile(
    new URL(
        '../migrations/015_ranked_history_metadata.sql',
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

test('history sync route requires installation and strict Bearer authentication', () => {
    assert.match(
        routesSource,
        /X-Installation-ID header is required/
    );
    assert.match(
        routesSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
});

test('history router exposes authenticated upload and paginated download', () => {
    assert.match(
        routesSource,
        /router\.post\(\s*'\/debates\/sync'/
    );
    assert.match(
        routesSource,
        /router\.get\(\s*'\/debates'/
    );
    assert.match(
        routesSource,
        /service\.listDebates\(\{/
    );
    assert.match(routesSource, /nextCursor/);
    assert.match(routesSource, /hasMore/);
    assert.doesNotMatch(routesSource, /router\.delete\(/);
});

test('history download validates single bounded query values', () => {
    assert.match(
        routesSource,
        /function optionalQueryString\(/
    );
    assert.match(routesSource, /req\.query\.limit/);
    assert.match(routesSource, /req\.query\.cursor/);
    assert.match(
        routesSource,
        /invalid_debate_history_query/
    );
});

test('history responses disable caching', () => {
    assert.match(routesSource, /Cache-Control', 'no-store'/);
    assert.match(routesSource, /Pragma', 'no-cache'/);
    assert.match(routesSource, /X-Content-Type-Options', 'nosniff'/);
});

test('history errors never log request bodies or debate content', () => {
    const logFunctionStart = positionOf(
        routesSource,
        'function logUnexpectedError(logger, error, req)'
    );
    const routerStart = positionOf(
        routesSource,
        'export function createAccountDebateHistoryRouter'
    );
    const logFunctionSource = routesSource.slice(
        logFunctionStart,
        routerStart
    );

    assert.doesNotMatch(logFunctionSource, /req\.body/);
    assert.doesNotMatch(logFunctionSource, /JSON\.stringify\(req/);
    assert.match(
        logFunctionSource,
        /Never log debate messages, topics, reports, access tokens/
    );
});

test('server rate-limits history uploads before using the larger parser', () => {
    const historyLimiter = positionOf(
        serverSource,
        "const accountHistoryLimiter = rateLimit({"
    );
    const historyParser = positionOf(
        serverSource,
        `  accountHistoryLimiter,
  express.json({ limit: '2mb' })`
    );
    const globalParser = positionOf(
        serverSource,
        "app.use(express.json({ limit: '50kb' }));"
    );

    assert.ok(historyLimiter < historyParser);
    assert.ok(historyParser < globalParser);
});

test('server shares account authorization with the history service', () => {
    assert.match(
        serverSource,
        /createAccountDebateHistoryService\(\{[\s\S]*?pool,[\s\S]*?accountAuthService/
    );
    assert.match(
        serverSource,
        /createAccountDebateHistoryRouter\(\{[\s\S]*?service: accountDebateHistoryService/
    );
});

test('history router mounts before the generic account router', () => {
    const historyRouter = positionOf(
        serverSource,
        'createAccountDebateHistoryRouter({'
    );
    const accountMount = positionOf(
        serverSource,
        "app.use('/api/account', accountAuthRouter);"
    );

    assert.ok(historyRouter < accountMount);
});

test('migration makes account and SavedDebate UUID the idempotent key', () => {
    assert.match(
        migrationSource,
        /UNIQUE \(account_id, saved_debate_id\)/
    );
});

test('migration preserves messages and reports as validated JSONB', () => {
    assert.match(migrationSource, /messages JSONB NOT NULL/);
    assert.match(migrationSource, /report JSONB/);
    assert.match(
        migrationSource,
        /jsonb_typeof\(messages\) = 'array'/
    );
    assert.match(
        migrationSource,
        /report IS NULL[\s\S]*?jsonb_typeof\(report\) = 'object'/
    );
});

test('migration preserves origin installation and newer-content precedence metadata', () => {
    assert.match(
        migrationSource,
        /origin_installation_id TEXT NOT NULL/
    );
    assert.match(
        migrationSource,
        /content_updated_at TIMESTAMPTZ NOT NULL/
    );
    assert.match(
        migrationSource,
        /content_sha256 TEXT NOT NULL/
    );
});


test('Ranked history migration stores complete validated result metadata', () => {
    assert.match(
        rankedHistoryMigrationSource,
        /ranked_debate_id UUID/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /ranked_debate_kind TEXT/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /ranked_outcome TEXT/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /ranked_report_context JSONB/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /ranked_debate_id = saved_debate_id/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /jsonb_typeof\(ranked_report_context\) = 'object'/
    );
    assert.match(
        rankedHistoryMigrationSource,
        /is_daily_challenge = FALSE/
    );
});
