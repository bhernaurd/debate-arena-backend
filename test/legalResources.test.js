import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const privacy = await readFile(
    new URL('../public/privacy-policy/index.html', import.meta.url),
    'utf8'
);
const deletion = await readFile(
    new URL('../public/account-deletion/index.html', import.meta.url),
    'utf8'
);
const terms = await readFile(
    new URL('../public/terms-of-use/index.html', import.meta.url),
    'utf8'
);

const LEGACY_APP_NAME = 'The Agora: Philosophy Debates';
const CURRENT_APP_NAME = 'The Agora: Learn Philosophy';

function assertPublicDocument(source, title, appName = LEGACY_APP_NAME) {
    assert.match(source, /<!doctype html>/i);
    assert.match(source, /<meta name="viewport"/i);
    assert.ok(source.includes(appName));
    assert.ok(source.includes('Bhernaurd Maghirang'));
    assert.ok(source.includes(title));
}

test('public legal resources identify the app and operator', () => {
    assertPublicDocument(privacy, 'Privacy Policy', CURRENT_APP_NAME);
    assertPublicDocument(deletion, 'Account Deletion');
    assertPublicDocument(terms, 'Terms of Use');
});

test('privacy policy exposes the external account-deletion path', () => {
    assert.ok(privacy.includes('href="/account-deletion/"'));
    assert.match(privacy, /retention/i);
    assert.match(privacy, /Anthropic/);
    assert.match(privacy, /The Mirror and Philosophical Profile/i);
    assert.match(privacy, /cached Mirror translations/i);
});

test('Terms links users back to privacy and account deletion', () => {
    assert.ok(terms.includes('href="/privacy-policy/"'));
    assert.ok(terms.includes('href="/account-deletion/"'));
    assert.match(terms, /artificial intelligence/i);
    assert.match(terms, /subscriptions, trials, and billing/i);
    assert.match(terms, /Ranked and competitive integrity/i);
});

test('account-deletion resource clearly describes deletion and subscription separation', () => {
    assert.match(deletion, /delete/i);
    assert.match(deletion, /account/i);
    assert.match(deletion, /subscription/i);
});
