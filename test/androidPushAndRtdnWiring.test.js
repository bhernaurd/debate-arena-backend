import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Google Play RTDN bypasses only the app purchase-sync limiter', async () => {
    const source = await readFile(
        new URL('../server.js', import.meta.url),
        'utf8'
    );

    assert.match(
        source,
        /const googlePlaySubscriptionSyncLimiter = rateLimit\(\{[\s\S]*?skip:\s*\(req\)\s*=>\s*req\.path\s*===\s*['"]\/rtdn['"]/m
    );
    assert.match(
        source,
        /app\.use\(\s*['"]\/api\/account\/google-play['"],\s*googlePlaySubscriptionSyncLimiter,/m
    );
    assert.match(
        source,
        /app\.use\(['"]\/api\/app-store\/sync-transaction['"],\s*subscriptionSyncLimiter\);/m
    );
});

test('Daily Challenge scheduler reads Android tokens and routes by platform', async () => {
    const source = await readFile(
        new URL('../pushScheduler.js', import.meta.url),
        'utf8'
    );

    assert.match(source, /OR platform = 'android'/);
    assert.match(source, /sendPushForPlatform\(\{/);
    assert.match(source, /platform:\s*record\.platform/);
    assert.match(source, /deepLink:\s*'theagora:\/\/daily-challenge'/);
});

test('push registration honors Android reminder and notification-permission state', async () => {
    const source = await readFile(
        new URL('../pushRoutes.js', import.meta.url),
        'utf8'
    );

    assert.match(
        source,
        /notificationPermissionGranted === true[\s\S]*dailyChallengeRemindersEnabled === true/
    );
    assert.match(
        source,
        /notifications_enabled = EXCLUDED\.notifications_enabled/
    );
    assert.match(
        source,
        /COALESCE\(platform, 'ios'\) = \$3/
    );
});
