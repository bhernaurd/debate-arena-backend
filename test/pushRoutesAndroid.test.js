import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { createPushRouter } from '../pushRoutes.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'android-installation-001';
const ACCESS_TOKEN = 'aaa.bbb.ccc';
const FCM_TOKEN = 'fcm_token_abcdefghijklmnopqrstuvwxyz_0123456789';
const IOS_TOKEN = 'a'.repeat(64);

function createFakePool() {
    const state = {
        row: null,
        clientQueries: [],
        poolQueries: [],
    };

    const client = {
        async query(sql, values = []) {
            state.clientQueries.push({ sql, values });
            const compact = String(sql).replace(/\s+/g, ' ').trim();
            if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') {
                return { rowCount: 0, rows: [] };
            }
            if (compact.startsWith('INSERT INTO push_tokens')) {
                const [
                    deviceToken,
                    platform,
                    timezone,
                    notificationsEnabled,
                    installId,
                    userId,
                    appVersion,
                    buildNumber,
                    apnsEnvironment,
                ] = values;
                state.row = {
                    device_token: deviceToken,
                    platform,
                    timezone,
                    notifications_enabled: notificationsEnabled,
                    install_id: installId,
                    user_id: userId,
                    app_version: appVersion,
                    build_number: buildNumber,
                    apns_environment: apnsEnvironment,
                    registered_at: new Date('2026-08-22T23:00:00Z'),
                    updated_at: new Date('2026-08-22T23:00:00Z'),
                    created_at: new Date('2026-08-22T23:00:00Z'),
                    last_registered_at: new Date('2026-08-22T23:00:00Z'),
                    last_success_at: null,
                    last_failure_at: null,
                    failure_reason: null,
                    last_completed_challenge_id: null,
                    last_completed_challenge_date: null,
                };
                return { rowCount: 1, rows: [state.row] };
            }
            if (compact.startsWith('UPDATE push_tokens') && compact.includes('device_token <> $1')) {
                return { rowCount: 0, rows: [] };
            }
            throw new Error(`Unexpected client query: ${compact}`);
        },
        release() {},
    };

    const pool = {
        async connect() {
            return client;
        },
        async query(sql, values = []) {
            state.poolQueries.push({ sql, values });
            const compact = String(sql).replace(/\s+/g, ' ').trim();

            if (compact.startsWith('SELECT * FROM push_tokens') && !compact.includes('WHERE device_token')) {
                return { rowCount: state.row ? 1 : 0, rows: state.row ? [state.row] : [] };
            }
            if (compact.startsWith('SELECT user_id, install_id, apns_environment FROM push_tokens')) {
                const found = state.row && state.row.device_token === values[0];
                return {
                    rowCount: found ? 1 : 0,
                    rows: found ? [{
                        user_id: state.row.user_id,
                        install_id: state.row.install_id,
                        apns_environment: state.row.apns_environment,
                    }] : [],
                };
            }
            if (compact.startsWith('UPDATE push_tokens') && compact.includes('last_completed_challenge_id')) {
                if (!state.row) return { rowCount: 0, rows: [] };
                state.row = {
                    ...state.row,
                    last_completed_challenge_id: values[1],
                    last_completed_challenge_date: values[2],
                    updated_at: new Date('2026-08-22T23:01:00Z'),
                };
                return { rowCount: 1, rows: [state.row] };
            }
            if (compact.startsWith('SELECT * FROM push_tokens WHERE device_token')) {
                const found = state.row && state.row.device_token === values[0];
                return { rowCount: found ? 1 : 0, rows: found ? [state.row] : [] };
            }
            throw new Error(`Unexpected pool query: ${compact}`);
        },
    };

    return { pool, state };
}

function makeAuthService(overrides = {}) {
    return {
        async authorizeAccessToken(input) {
            return {
                accountId: ACCOUNT_ID,
                sessionId: '22222222-2222-4222-8222-222222222222',
                installationId: input.installationId,
            };
        },
        ...overrides,
    };
}

async function startServer({ fake = createFakePool(), accountAuthService = makeAuthService() } = {}) {
    const app = express();
    app.use(express.json({ limit: '50kb' }));
    app.use(createPushRouter(fake.pool, { accountAuthService }));
    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    return {
        fake,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

function androidHeaders(extra = {}) {
    return {
        'Content-Type': 'application/json',
        'X-Installation-ID': INSTALLATION_ID,
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        ...extra,
    };
}

async function readJson(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

test('authenticated Android registration accepts client aliases but stores server-derived account ownership', async (t) => {
    let authorizedInput = null;
    const fake = createFakePool();
    const server = await startServer({
        fake,
        accountAuthService: makeAuthService({
            async authorizeAccessToken(input) {
                authorizedInput = input;
                return { accountId: ACCOUNT_ID };
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/api/push/register`, {
        method: 'POST',
        headers: androidHeaders(),
        body: JSON.stringify({
            platform: 'android',
            installationId: INSTALLATION_ID,
            pushToken: FCM_TOKEN,
            appVersion: '3.9-android-parity',
            appBuild: 42,
            timeZone: 'America/Chicago',
            notificationPermissionGranted: true,
            dailyChallengeRemindersEnabled: true,
            userId: 'client-spoofed-account-id',
        }),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.platform, 'android');
    assert.equal(payload.userId, ACCOUNT_ID);
    assert.equal(payload.installId, INSTALLATION_ID);
    assert.equal(payload.notificationsEnabled, true);
    assert.deepEqual(authorizedInput, {
        accessToken: ACCESS_TOKEN,
        installationId: INSTALLATION_ID,
    });

    const insert = fake.state.clientQueries.find(({ sql }) => sql.includes('INSERT INTO push_tokens'));
    assert.ok(insert);
    assert.equal(insert.values[0], FCM_TOKEN);
    assert.equal(insert.values[1], 'android');
    assert.equal(insert.values[2], 'America/Chicago');
    assert.equal(insert.values[3], true);
    assert.equal(insert.values[4], INSTALLATION_ID);
    assert.equal(insert.values[5], ACCOUNT_ID, 'client userId must never replace authenticated Agora account ownership');
    assert.equal(insert.values[6], '3.9-android-parity');
    assert.equal(insert.values[7], '42');

    const prune = fake.state.clientQueries.find(({ sql }) => sql.includes('device_token <> $1'));
    assert.ok(prune);
    assert.match(prune.sql, /AND platform = \$3/);
    assert.equal(prune.values[2], 'android', 'Android registration must never supersede an iOS token');
});

test('Android registration disables backend reminders when permission or Daily Challenge reminders are off', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/api/push/register`, {
        method: 'POST',
        headers: androidHeaders(),
        body: JSON.stringify({
            platform: 'android',
            installationId: INSTALLATION_ID,
            pushToken: FCM_TOKEN,
            timeZone: 'America/Chicago',
            notificationPermissionGranted: false,
            dailyChallengeRemindersEnabled: true,
        }),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.notificationsEnabled, false);
    const insert = server.fake.state.clientQueries.find(({ sql }) => sql.includes('INSERT INTO push_tokens'));
    assert.equal(insert.values[3], false);
    assert.equal(
        server.fake.state.clientQueries.some(({ sql }) => sql.includes('device_token <> $1')),
        false,
        'a disabled registration should not retire another active same-platform token'
    );
});

test('authenticated Android completion marks the challenge for server reminder suppression', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const registration = await fetch(`${server.baseUrl}/api/push/register`, {
        method: 'POST',
        headers: androidHeaders(),
        body: JSON.stringify({
            platform: 'android',
            installationId: INSTALLATION_ID,
            pushToken: FCM_TOKEN,
            timeZone: 'America/Chicago',
            notificationPermissionGranted: true,
            dailyChallengeRemindersEnabled: true,
        }),
    });
    assert.equal(registration.status, 200);

    const completion = await fetch(`${server.baseUrl}/api/push/complete-daily-challenge`, {
        method: 'POST',
        headers: androidHeaders(),
        body: JSON.stringify({
            platform: 'android',
            installationId: INSTALLATION_ID,
            pushToken: FCM_TOKEN,
            challengeId: 'daily-2026-08-22',
            challengeDate: '2026-08-22',
        }),
    });
    const payload = await readJson(completion);

    assert.equal(completion.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.challengeId, 'daily-2026-08-22');
    assert.equal(payload.challengeDate, '2026-08-22');
    assert.equal(payload.userId, ACCOUNT_ID);
});

test('Android registration rejects a body installation ID that disagrees with X-Installation-ID', async (t) => {
    let authorizeCalls = 0;
    const server = await startServer({
        accountAuthService: makeAuthService({
            async authorizeAccessToken() {
                authorizeCalls += 1;
                return { accountId: ACCOUNT_ID };
            },
        }),
    });
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/api/push/register`, {
        method: 'POST',
        headers: androidHeaders(),
        body: JSON.stringify({
            platform: 'android',
            installationId: 'different-installation',
            pushToken: FCM_TOKEN,
            timeZone: 'America/Chicago',
        }),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 400);
    assert.equal(payload.errorCode, 'installation_id_mismatch');
    assert.equal(authorizeCalls, 0);
    assert.equal(server.fake.state.clientQueries.length, 0);
});

test('legacy unauthenticated iOS registration remains backward compatible', async (t) => {
    const server = await startServer();
    t.after(server.close);

    const response = await fetch(`${server.baseUrl}/api/push/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceToken: IOS_TOKEN,
            timezone: 'America/Chicago',
            installId: 'ios-installation-001',
            userId: 'legacy-ios-user-id',
            appVersion: '3.9',
            buildNumber: '390',
            apnsEnvironment: 'production',
        }),
    });
    const payload = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.platform, 'ios');
    assert.equal(payload.userId, 'legacy-ios-user-id');
    assert.equal(payload.installId, 'ios-installation-001');
    assert.equal(payload.notificationsEnabled, true);
});
