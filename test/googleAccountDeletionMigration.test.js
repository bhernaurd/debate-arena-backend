import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '027_google_account_deletion.sql'),
    'utf8'
);

function compact(value) {
    return value.replace(/\s+/g, ' ').trim();
}

test('Google account deletion migration dynamically releases push ownership without deleting the device row', () => {
    const sql = compact(migration);

    assert.match(sql, /to_regclass\('public\.push_tokens'\) IS NOT NULL/);
    assert.match(sql, /attname = 'user_id'/);
    assert.match(sql, /UPDATE public\.push_tokens SET user_id = NULL/);
    assert.doesNotMatch(sql, /DELETE FROM public\.push_tokens/);
});

test('Google account deletion clears Daily Challenge suppression when those push columns exist', () => {
    const sql = compact(migration);

    assert.match(sql, /attname = 'last_completed_challenge_id'/);
    assert.match(sql, /attname = 'last_completed_challenge_date'/);
    assert.match(
        sql,
        /SET user_id = NULL, last_completed_challenge_id = NULL, last_completed_challenge_date = NULL WHERE user_id = \$1/
    );
});
