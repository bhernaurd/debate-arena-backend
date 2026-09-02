import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptSource = await readFile(
    new URL('../scripts/checkGooglePlayReadiness.js', import.meta.url),
    'utf8'
);
const packageSource = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
);

test('Google Play readiness check covers production Android billing, AI reporting, reviewer access, and legal prerequisites', () => {
    assert.match(scriptSource, /com\.bhernaurd\.theagora/);
    assert.match(scriptSource, /GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
    assert.match(scriptSource, /GOOGLE_PLAY_RTDN_AUDIENCE/);
    assert.match(scriptSource, /GOOGLE_PLAY_RTDN_PUSH_SERVICE_ACCOUNT_EMAIL/);
    assert.match(scriptSource, /FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON/);
    assert.match(scriptSource, /FIREBASE_PROJECT_ID/);
    assert.match(scriptSource, /schema_migrations/);
    assert.match(scriptSource, /033_google_play_subscription_entitlements\.sql/);
    assert.match(scriptSource, /034_google_play_rtdn_messages\.sql/);
    assert.match(scriptSource, /035_ai_content_reports\.sql/);
    assert.match(scriptSource, /036_account_manual_pro_grants\.sql/);
    assert.match(scriptSource, /google_play_subscription_entitlements/);
    assert.match(scriptSource, /google_play_rtdn_messages/);
    assert.match(scriptSource, /ai_content_reports/);
    assert.match(scriptSource, /account_manual_pro_grants/);
    assert.match(scriptSource, /purchase_token_sha256/);
    assert.match(scriptSource, /obfuscated_external_account_id/);
    assert.match(scriptSource, /rtdnMessageTableReady/);
    assert.match(scriptSource, /aiContentReportTableReady/);
    assert.match(scriptSource, /manualProGrantTableReady/);
    assert.match(scriptSource, /aiContentReportRoutes\.js/);
    assert.match(scriptSource, /lib\/aiContentReportService\.js/);
    assert.match(scriptSource, /scripts\/manageManualProGrant\.js/);
    assert.match(scriptSource, /public\/privacy-policy\/index\.html/);
    assert.match(scriptSource, /public\/account-deletion\/index\.html/);
    assert.match(scriptSource, /public\/terms-of-use\/index\.html/);
    assert.match(scriptSource, /termsOfUseResource/);
});

test('Google Play readiness output reports only state, never secret, report, or reviewer credential values', () => {
    const outputBlockStart = scriptSource.indexOf("console.log('[GooglePlayReadiness]'");
    assert.notEqual(outputBlockStart, -1);
    const outputBlock = scriptSource.slice(outputBlockStart);

    assert.doesNotMatch(outputBlock, /process\.env\.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON/);
    assert.doesNotMatch(outputBlock, /process\.env\.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY/);
    assert.doesNotMatch(outputBlock, /process\.env\.FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON/);
    assert.doesNotMatch(outputBlock, /process\.env\.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY/);
    assert.doesNotMatch(outputBlock, /process\.env\.DATABASE_URL/);
    assert.doesNotMatch(outputBlock, /responseText/);
    assert.doesNotMatch(outputBlock, /google-email/);
});

test('package scripts expose readiness plus manual reviewer grant commands and syntax gates', () => {
    assert.equal(
        packageSource.scripts['google-play:check'],
        'node scripts/checkGooglePlayReadiness.js'
    );
    assert.equal(
        packageSource.scripts['account-pro:grant'],
        'node scripts/manageManualProGrant.js grant'
    );
    assert.equal(
        packageSource.scripts['account-pro:revoke'],
        'node scripts/manageManualProGrant.js revoke'
    );
    assert.match(
        packageSource.scripts.check,
        /node --check scripts\/checkGooglePlayReadiness\.js/
    );
    assert.match(
        packageSource.scripts.check,
        /node --check scripts\/manageManualProGrant\.js/
    );
    assert.match(
        packageSource.scripts.check,
        /node --check lib\/googlePlayRtdnMessageStore\.js/
    );
    assert.match(
        packageSource.scripts.check,
        /node --check aiContentReportRoutes\.js/
    );
    assert.match(
        packageSource.scripts.check,
        /node --check lib\/aiContentReportService\.js/
    );
});
