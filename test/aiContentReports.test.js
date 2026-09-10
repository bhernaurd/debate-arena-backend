import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    AiContentReportError,
    aiContentReportConstants,
    createAiContentReportService,
} from '../lib/aiContentReportService.js';

const routeSource = await readFile(
    new URL('../aiContentReportRoutes.js', import.meta.url),
    'utf8'
);
const migrationSource = await readFile(
    new URL('../migrations/035_ai_content_reports.sql', import.meta.url),
    'utf8'
);
const serverSource = await readFile(
    new URL('../server.js', import.meta.url),
    'utf8'
);

const accountId = '11111111-1111-4111-8111-111111111111';
const debateId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';

function fakeDependencies() {
    const calls = [];
    const accountAuthService = {
        async authorizeAccessToken(input) {
            calls.push({ kind: 'auth', input });
            return { accountId };
        },
    };
    const pool = {
        async query(sql, values) {
            calls.push({ kind: 'query', sql, values });
            return {
                rows: [{
                    id: '44444444-4444-4444-8444-444444444444',
                    created_at: new Date('2026-09-02T16:00:00.000Z'),
                    last_reported_at: new Date('2026-09-02T16:00:00.000Z'),
                }],
            };
        },
    };
    return { calls, accountAuthService, pool };
}

function validReport(overrides = {}) {
    return {
        debateId,
        messageId,
        philosopherId: 'nietzsche',
        debateKind: 'standard',
        reason: 'offensive_or_harmful',
        responseText: 'A response selected by the user for moderation.',
        ...overrides,
    };
}

test('report service authenticates the Agora account and persists only bounded report metadata', async () => {
    const deps = fakeDependencies();
    const service = createAiContentReportService({
        pool: deps.pool,
        accountAuthService: deps.accountAuthService,
        now: () => new Date('2026-09-02T16:00:00.000Z'),
    });

    const result = await service.submitReport({
        installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        accessToken: 'aaa.bbb.ccc',
        report: validReport(),
        clientPlatform: 'android',
        appVersion: '4.2',
        appBuild: '1',
    });

    assert.equal(result.accepted, true);
    assert.equal(deps.calls[0].kind, 'auth');
    const query = deps.calls.find((call) => call.kind === 'query');
    assert.ok(query);
    assert.match(query.sql, /INSERT INTO ai_content_reports/);
    assert.match(query.sql, /ON CONFLICT \(account_id, message_id\)/);
    assert.equal(query.values[0], accountId);
    assert.equal(query.values[2], debateId);
    assert.equal(query.values[3], messageId);
    assert.equal(query.values[7], 'offensive_or_harmful');
    assert.equal(query.values[10], 'android');
});

test('long AI responses are capped instead of blocking the user report', async () => {
    const deps = fakeDependencies();
    const service = createAiContentReportService({
        pool: deps.pool,
        accountAuthService: deps.accountAuthService,
    });
    const longResponse = 'x'.repeat(
        aiContentReportConstants.maximumResponseCharacters + 500
    );

    const result = await service.submitReport({
        installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        accessToken: 'aaa.bbb.ccc',
        report: validReport({ responseText: longResponse }),
        clientPlatform: 'android',
    });

    const query = deps.calls.find((call) => call.kind === 'query');
    assert.equal(
        query.values[8].length,
        aiContentReportConstants.maximumResponseCharacters
    );
    assert.equal(query.values[9], true);
    assert.equal(result.responseTruncated, true);
});

test('all generative debate surfaces are supported', () => {
    assert.deepEqual(
        new Set(aiContentReportConstants.debateKinds),
        new Set(['standard', 'daily_challenge', 'ranked'])
    );
});

test('offensive/harmful reporting is an explicit reason', () => {
    assert.ok(
        aiContentReportConstants.reasons.includes('offensive_or_harmful')
    );
});

test('invalid report categories never reach storage', async () => {
    const deps = fakeDependencies();
    const service = createAiContentReportService({
        pool: deps.pool,
        accountAuthService: deps.accountAuthService,
    });

    await assert.rejects(
        service.submitReport({
            installationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            accessToken: 'aaa.bbb.ccc',
            report: validReport({ reason: 'made_up_reason' }),
        }),
        (error) =>
            error instanceof AiContentReportError &&
            error.code === 'invalid_ai_content_report'
    );

    assert.equal(
        deps.calls.filter((call) => call.kind === 'query').length,
        0
    );
});

test('route requires installation identity and strict Bearer authentication', () => {
    assert.match(routeSource, /X-Installation-ID is required/);
    assert.match(
        routeSource,
        /\^Bearer \(\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\\\.\[A-Za-z0-9_-\]\+\)\$/
    );
});

test('route never logs report bodies, response text, or authorization credentials', () => {
    const loggingBlock = routeSource.slice(
        routeSource.indexOf('function logUnexpectedError'),
        routeSource.indexOf('export function createAiContentReportRouter')
    );
    assert.doesNotMatch(loggingBlock, /req\.body/);
    assert.doesNotMatch(loggingBlock, /responseText/);
    assert.doesNotMatch(loggingBlock, /Authorization/);
    assert.match(loggingBlock, /Never log access tokens, request bodies/);
});

test('migration deletes reports with the account and stores only the selected bounded response', () => {
    assert.match(migrationSource, /REFERENCES accounts\(id\)[\s\S]*?ON DELETE CASCADE/);
    assert.match(migrationSource, /response_text TEXT NOT NULL/);
    assert.match(migrationSource, /response_truncated BOOLEAN NOT NULL/);
    assert.match(migrationSource, /CHAR_LENGTH\(response_text\) BETWEEN 1 AND 12000/);
    assert.doesNotMatch(migrationSource, /conversation_json/i);
    assert.doesNotMatch(migrationSource, /access_token/i);
    assert.doesNotMatch(migrationSource, /ip_address/i);
});

test('server mounts authenticated AI content reports before the generic account router', () => {
    const reportMount = serverSource.indexOf("'/api/account/ai-content-reports'");
    const genericAccountMount = serverSource.indexOf(
        "app.use('/api/account', accountAuthRouter);"
    );
    assert.notEqual(reportMount, -1);
    assert.ok(reportMount < genericAccountMount);
    assert.match(serverSource, /const aiContentReportLimiter = rateLimit\(\{/);
    assert.match(serverSource, /too_many_ai_content_reports/);
});
