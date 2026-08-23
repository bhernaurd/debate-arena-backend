import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, '..', 'pushRoutes.js'), 'utf8');

function compact(value) {
    return value.replace(/\s+/g, ' ').trim();
}

test('Android push registration clears Daily completion state when Agora account ownership changes', () => {
    const sql = compact(source);

    assert.match(
        sql,
        /last_completed_challenge_id = CASE WHEN EXCLUDED\.platform = 'android' AND push_tokens\.user_id IS DISTINCT FROM EXCLUDED\.user_id THEN NULL ELSE push_tokens\.last_completed_challenge_id END/
    );
    assert.match(
        sql,
        /last_completed_challenge_date = CASE WHEN EXCLUDED\.platform = 'android' AND push_tokens\.user_id IS DISTINCT FROM EXCLUDED\.user_id THEN NULL ELSE push_tokens\.last_completed_challenge_date END/
    );
});

test('Android registration replaces account ownership while legacy iOS registration preserves the prior owner when no new user id is supplied', () => {
    const sql = compact(source);

    assert.match(
        sql,
        /user_id = CASE WHEN EXCLUDED\.platform = 'android' THEN EXCLUDED\.user_id ELSE COALESCE\(EXCLUDED\.user_id, push_tokens\.user_id\) END/
    );
});
