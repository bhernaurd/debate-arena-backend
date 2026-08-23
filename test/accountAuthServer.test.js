import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverUrl = new URL('../server.js', import.meta.url);
const serverPath = fileURLToPath(serverUrl);
const source = await readFile(serverUrl, 'utf8');

function positionOf(fragment) {
    const position = source.indexOf(fragment);

    assert.notEqual(
        position,
        -1,
        `Expected server.js to contain: ${fragment}`
    );

    return position;
}

function limiterBlock(name) {
    const expression = new RegExp(
        `const\\s+${name}\\s*=\\s*rateLimit\\(\\{([\\s\\S]*?)\\n\\}\\);`
    );
    const match = expression.exec(source);

    assert.ok(
        match,
        `Expected ${name} to be defined with rateLimit().`
    );
    return match[1];
}

test('server.js passes Node syntax validation', () => {
    const result = spawnSync(
        process.execPath,
        ['--check', serverPath],
        {
            encoding: 'utf8',
        }
    );

    assert.equal(
        result.status,
        0,
        result.stderr ||
            result.stdout ||
            'server.js syntax check failed.'
    );
});

test('env.js remains the first executable import', () => {
    const envImport = positionOf("import './env.js';");
    const expressImport = positionOf(
        "import express from 'express';"
    );
    const accountRouteImport = positionOf(
        "import { createAccountAuthRouter } from './accountAuthRoutes.js';"
    );

    assert.ok(envImport < expressImport);
    assert.ok(envImport < accountRouteImport);
});

test('server constructs one shared production account service', () => {
    assert.match(
        source,
        /import \{ createAccountAuthService \} from '\.\/lib\/accountAuthService\.js';/
    );

    const constructions = source.match(
        /createAccountAuthService\(\{ pool \}\)/g
    ) ?? [];

    assert.equal(constructions.length, 1);
    assert.match(
        source,
        /const accountAuthService = createAccountAuthService\(\{ pool \}\);/
    );
});

test('account routes and subscription ownership share the same account service', () => {
    assert.match(
        source,
        /createAccountAuthRouter\(pool, \{[\s\S]*?service: accountAuthService/
    );
    assert.match(
        source,
        /createAccountSubscriptionOwnershipService\(\{[\s\S]*?pool,[\s\S]*?accountAuthService/
    );
    assert.match(
        source,
        /createAppStoreSubscriptionRouter\(pool, \{[\s\S]*?accountSubscriptionOwnershipService/
    );
});

test('Apple challenge and sign-in endpoints have strict dedicated limits', () => {
    const challenge = limiterBlock(
        'accountChallengeLimiter'
    );
    const signIn = limiterBlock(
        'accountSignInLimiter'
    );

    for (const block of [challenge, signIn]) {
        assert.match(block, /windowMs:\s*60 \* 1000/);
        assert.match(block, /max:\s*10/);
        assert.match(block, /standardHeaders:\s*true/);
        assert.match(block, /legacyHeaders:\s*false/);
        assert.match(
            block,
            /too_many_authentication_requests/
        );
    }
});

test('session endpoints have a separate thirty-request limit', () => {
    const session = limiterBlock('accountSessionLimiter');

    assert.match(session, /windowMs:\s*60 \* 1000/);
    assert.match(session, /max:\s*30/);
    assert.match(session, /standardHeaders:\s*true/);
    assert.match(session, /legacyHeaders:\s*false/);
    assert.match(
        session,
        /too_many_authentication_requests/
    );
});

test('JSON parsing is registered before account authentication', () => {
    const jsonParser = positionOf(
        "app.use(express.json({ limit: '50kb' }));"
    );
    const serviceConstruction = positionOf(
        'const accountAuthService = createAccountAuthService({ pool });'
    );
    const routerMount = positionOf(
        "app.use('/api/account', accountAuthRouter);"
    );

    assert.ok(jsonParser < serviceConstruction);
    assert.ok(jsonParser < routerMount);
});

test('all account rate limiters run before the account router', () => {
    const challengeMount = positionOf(
        "app.use('/api/account/apple/challenge', accountChallengeLimiter);"
    );
    const signInMount = positionOf(
        "app.use('/api/account/apple/sign-in', accountSignInLimiter);"
    );
    const sessionMount = positionOf(
        "app.use('/api/account/session', accountSessionLimiter);"
    );
    const routerMount = positionOf(
        "app.use('/api/account', accountAuthRouter);"
    );

    assert.ok(challengeMount < routerMount);
    assert.ok(signInMount < routerMount);
    assert.ok(sessionMount < routerMount);
});

test('production wiring does not embed or log authentication secrets', () => {
    assert.doesNotMatch(
        source,
        /APPLE_SIGN_IN_PRIVATE_KEY\s*=/
    );
    assert.doesNotMatch(
        source,
        /AGORA_ACCESS_TOKEN_SIGNING_KEY_V\d+\s*=/
    );
    assert.doesNotMatch(
        source,
        /APPLE_REFRESH_TOKEN_ENCRYPTION_KEY_V\d+\s*=/
    );
    assert.doesNotMatch(
        source,
        /console\.(?:log|error)\([^\n]*(?:PRIVATE_KEY|SIGNING_KEY|ENCRYPTION_KEY)/
    );
});

test('existing application routers remain registered', () => {
    const requiredFragments = [
        'app.use(createPaywallConfigurationRouter());',
        'app.use(createDailyChallengeRouter(pool));',
        'app.use(createPushRouter(pool, { accountAuthService }));',
        'app.use(questionsRouter);',
        'app.use(aiJobsRouter);',
        'app.use(createAppStoreSubscriptionRouter(pool, {',
        "app.use('/analytics', createAnalyticsRouter(pool, {",
        "app.post('/debate', async (req, res) => {",
        "app.get('/health', (_, res) => {",
    ];

    for (const fragment of requiredFragments) {
        positionOf(fragment);
    }
});
