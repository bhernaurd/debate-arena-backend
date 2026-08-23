import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const schedulerSource = await readFile(
    new URL('../pushScheduler.js', import.meta.url),
    'utf8'
);

const routesSource = await readFile(
    new URL('../pushRoutes.js', import.meta.url),
    'utf8'
);

test('scheduler keeps iOS APNs environment filtering while also selecting Android tokens', () => {
    assert.match(
        schedulerSource,
        /platform = 'android'[\s\S]*?platform = 'ios' AND apns_environment = \$1/
    );
});

test('scheduler dispatches Android through FCM and leaves iOS on the existing APNs sender', () => {
    assert.match(
        schedulerSource,
        /normalizedPlatform\(record\) === 'android'[\s\S]*?sendFcmPush\(/
    );
    assert.match(
        schedulerSource,
        /return sendPush\(record\.deviceToken, title, body, payload\)/
    );
});

test('scheduler dedupe keys include platform transport so one account can receive on both iOS and Android', () => {
    assert.match(
        schedulerSource,
        /return `\$\{platform\}:\$\{transportScope\}:user:\$\{record\.userId\}`/
    );
    assert.match(
        schedulerSource,
        /platform === 'ios'[\s\S]*?record\.apnsEnvironment[\s\S]*?: 'fcm'/
    );
});

test('Android FCM data carries both canonical and compatibility Daily Challenge identifiers', () => {
    assert.match(schedulerSource, /type: 'daily_challenge'/);
    assert.match(schedulerSource, /dailyChallengeId: payload\.challengeId/);
    assert.match(schedulerSource, /challengeId: payload\.challengeId/);
    assert.match(schedulerSource, /dailyChallengeDate: payload\.challengeDate/);
    assert.match(schedulerSource, /challengeDate: payload\.challengeDate/);
    assert.match(schedulerSource, /deepLink: 'theagora:\/\/daily'/);
});

test('registration pruning is platform-scoped so Android never retires an iOS token', () => {
    assert.match(
        routesSource,
        /AND platform = \$3[\s\S]*?AND \(\$\{conditions\.join\(' OR '\)\}\)/
    );
});
