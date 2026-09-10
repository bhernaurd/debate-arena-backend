import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
    new URL('../migrations/036_account_manual_pro_grants.sql', import.meta.url),
    'utf8'
);
const service = await readFile(
    new URL('../lib/accountProAccessService.js', import.meta.url),
    'utf8'
);
const cli = await readFile(
    new URL('../scripts/manageManualProGrant.js', import.meta.url),
    'utf8'
);

test('manual Pro grants are account-owned, revocable, and separate from store transactions', () => {
    assert.match(migration, /CREATE TABLE account_manual_pro_grants/);
    assert.match(migration, /REFERENCES accounts\(id\)/);
    assert.match(migration, /ON DELETE CASCADE/);
    assert.match(migration, /play_review/);
    assert.match(migration, /support/);
    assert.match(migration, /internal/);
    assert.match(migration, /WHERE revoked_at IS NULL/);
    assert.doesNotMatch(migration, /google_play_subscription_entitlements/);
    assert.doesNotMatch(migration, /subscription_entitlements/);
    assert.doesNotMatch(migration, /affiliate_subscription_attributions/);
});

test('account Pro resolver checks manual grant before Apple and Google Play and tolerates staged migration', () => {
    const manualIndex = service.indexOf('account-pro-access:find-current-manual-grant');
    const appleIndex = service.indexOf('account-pro-access:find-current-entitlement');
    const playIndex = service.indexOf('account-pro-access:find-current-google-play-entitlement');

    assert.ok(manualIndex >= 0);
    assert.ok(appleIndex > manualIndex);
    assert.ok(playIndex > appleIndex);
    assert.match(service, /account_manual_pro_grants/);
    assert.match(service, /grant\.revoked_at IS NULL/);
    assert.match(service, /account\.status = 'active'/);
    assert.match(service, /error\?\.code !== '42P01'/);
});

test('manual grant CLI requires an active verified account and does not log Google email', () => {
    assert.match(cli, /Provide exactly one of --account-id or --google-email/);
    assert.match(cli, /account_google_identities/);
    assert.match(cli, /identity\.email_verified = TRUE/);
    assert.match(cli, /account\.status = 'active'/);
    assert.match(cli, /account_manual_pro_grants/);
    assert.match(cli, /ON CONFLICT \(account_id\)/);
    assert.match(cli, /revoked_at = NOW\(\)/);

    const outputStart = cli.indexOf("console.log('[ManualProGrant]'");
    assert.notEqual(outputStart, -1);
    const outputBlock = cli.slice(outputStart, cli.indexOf('});', outputStart) + 3);
    assert.doesNotMatch(outputBlock, /email/i);
    assert.doesNotMatch(outputBlock, /DATABASE_URL/);
    assert.doesNotMatch(outputBlock, /process\.env/);
});
