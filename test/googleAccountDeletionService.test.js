import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createGoogleAccountDeletionService,
} from '../lib/googleAccountDeletionService.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = 'android-installation-001';
const CHALLENGE_ID = '22222222-2222-4222-8222-222222222222';
const DELETION_REQUEST_ID = '33333333-3333-4333-8333-333333333333';
const GOOGLE_AUDIENCE = 'google-web-client-id.apps.googleusercontent.com';
const GOOGLE_SUBJECT = 'google-subject-123';
const OTHER_GOOGLE_SUBJECT = 'google-subject-999';
const RAW_NONCE = 'deletion-nonce-value';
const NOW_MS = Date.UTC(2026, 7, 23, 5, 0, 0);

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeChallengeRow(overrides = {}) {
    return {
        id: CHALLENGE_ID,
        installation_id: INSTALLATION_ID,
        account_id: ACCOUNT_ID,
        purpose: 'delete_account',
        nonce_sha256: sha256(RAW_NONCE),
        expires_at: new Date(NOW_MS + 5 * 60 * 1000),
        consumed_at: null,
        failed_attempts: 0,
        ...overrides,
    };
}

function makePool({
    challengeRow = makeChallengeRow(),
    identitySubject = GOOGLE_SUBJECT,
} = {}) {
    const queries = [];

    const client = {
        async query(sql, params = []) {
            const text = String(sql).trim();
            queries.push({ scope: 'client', text, params });

            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
                return { rows: [], rowCount: 0 };
            }
            if (text.includes('FROM account_auth_challenges') && text.includes('FOR UPDATE')) {
                return {
                    rows: challengeRow ? [challengeRow] : [],
                    rowCount: challengeRow ? 1 : 0,
                };
            }
            if (text.includes('UPDATE account_auth_challenges') && text.includes('failed_attempts')) {
                return { rows: [], rowCount: 1 };
            }
            if (text.includes('UPDATE account_auth_challenges') && text.includes('RETURNING id')) {
                return { rows: [{ id: CHALLENGE_ID }], rowCount: 1 };
            }
            if (text.includes('JOIN account_google_identities')) {
                return {
                    rows: [{
                        identity_id: '44444444-4444-4444-8444-444444444444',
                        account_id: ACCOUNT_ID,
                        subject: identitySubject,
                        account_status: 'active',
                    }],
                    rowCount: 1,
                };
            }
            if (text.includes('INSERT INTO account_deletion_requests')) {
                return {
                    rows: [{ id: DELETION_REQUEST_ID }],
                    rowCount: 1,
                };
            }
            if (text.includes("status = 'deletion_pending'") && text.includes('RETURNING id')) {
                return { rows: [{ id: ACCOUNT_ID }], rowCount: 1 };
            }
            if (text.includes("status = 'deleted'") && text.includes('RETURNING id')) {
                return { rows: [{ id: ACCOUNT_ID }], rowCount: 1 };
            }
            if (text.includes("status = 'completed'") && text.includes('RETURNING id')) {
                return { rows: [{ id: DELETION_REQUEST_ID }], rowCount: 1 };
            }
            if (
                text.startsWith('UPDATE account_sessions') ||
                text.startsWith('UPDATE account_subscription_ownership') ||
                text.startsWith('DELETE FROM')
            ) {
                return { rows: [], rowCount: 1 };
            }
            throw new Error(`Unexpected client SQL: ${text}`);
        },
        release() {},
    };

    return {
        queries,
        async connect() {
            return client;
        },
        async query(sql, params = []) {
            const text = String(sql).trim();
            queries.push({ scope: 'pool', text, params });
            if (text.includes('INSERT INTO account_auth_challenges')) {
                return {
                    rows: [{
                        id: CHALLENGE_ID,
                        purpose: 'delete_account',
                        expires_at: new Date(NOW_MS + 10 * 60 * 1000),
                    }],
                    rowCount: 1,
                };
            }
            throw new Error(`Unexpected pool SQL: ${text}`);
        },
    };
}

function verifier(subject = GOOGLE_SUBJECT) {
    const calls = [];
    return {
        calls,
        verify: async (idToken, options) => {
            calls.push({ idToken, options });
            return {
                issuer: 'https://accounts.google.com',
                audience: GOOGLE_AUDIENCE,
                subject,
                email: null,
                emailVerified: null,
                displayName: null,
                pictureUrl: null,
            };
        },
    };
}

test('creates an account-bound Google deletion challenge with a hashed nonce', async () => {
    const pool = makePool();
    const google = verifier();
    const service = createGoogleAccountDeletionService({
        pool,
        verifyGoogleIdToken: google.verify,
        now: () => NOW_MS,
    });

    const challenge = await service.createChallenge({
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
    });

    assert.equal(challenge.challengeId, CHALLENGE_ID);
    assert.equal(challenge.purpose, 'delete_account');
    assert.match(challenge.nonceSha256, /^[0-9a-f]{64}$/);
    assert.equal(sha256(challenge.rawNonce), challenge.nonceSha256);
    assert.equal(
        new Date(challenge.expiresAt).getTime(),
        NOW_MS + 10 * 60 * 1000
    );

    const insert = pool.queries.find((query) =>
        query.text.includes('INSERT INTO account_auth_challenges')
    );
    assert.ok(insert);
    assert.equal(insert.params[0], INSTALLATION_ID);
    assert.equal(insert.params[1], ACCOUNT_ID);
    assert.equal(insert.params[2], challenge.nonceSha256);
    assert.equal(google.calls.length, 0);
});

test('requires a fresh Google token with the exact deletion nonce before cleanup', async () => {
    const pool = makePool();
    const google = verifier();
    const service = createGoogleAccountDeletionService({
        pool,
        verifyGoogleIdToken: google.verify,
        now: () => NOW_MS,
    });

    const result = await service.deleteAccount({
        accountId: ACCOUNT_ID,
        installationId: INSTALLATION_ID,
        challengeId: CHALLENGE_ID,
        rawNonce: RAW_NONCE,
        idToken: 'google-id-token',
    });

    assert.equal(result.status, 'deleted');
    assert.equal(result.accountId, ACCOUNT_ID);
    assert.equal(result.appleRevocationStatus, 'not_required');
    assert.equal(result.deletedAt.toISOString(), new Date(NOW_MS).toISOString());
    assert.deepEqual(google.calls, [{
        idToken: 'google-id-token',
        options: { expectedNonce: RAW_NONCE },
    }]);

    const deletionRequest = pool.queries.find((query) =>
        query.text.includes('INSERT INTO account_deletion_requests')
    );
    assert.ok(deletionRequest);
    assert.match(deletionRequest.text, /'android_app'/);
    assert.match(deletionRequest.text, /'not_required'/);

    const statements = pool.queries.map((query) => query.text);
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_achievement_unlocks')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_daily_challenge_progress')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_debate_history')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_sessions')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_installations')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_apple_identities')));
    assert.ok(statements.some((text) => text.includes('DELETE FROM account_google_identities')));
    assert.ok(statements.some((text) => text.includes("status = 'deleted'")));
});

test('a different Google identity cannot delete the authenticated Agora account', async () => {
    const pool = makePool({ identitySubject: GOOGLE_SUBJECT });
    const google = verifier(OTHER_GOOGLE_SUBJECT);
    const service = createGoogleAccountDeletionService({
        pool,
        verifyGoogleIdToken: google.verify,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.deleteAccount({
            accountId: ACCOUNT_ID,
            installationId: INSTALLATION_ID,
            challengeId: CHALLENGE_ID,
            rawNonce: RAW_NONCE,
            idToken: 'google-id-token-for-other-account',
        }),
        (error) => {
            assert.equal(error.code, 'invalid_google_credential');
            assert.equal(error.status, 401);
            return true;
        }
    );

    assert.equal(
        pool.queries.some((query) =>
            query.text.includes('INSERT INTO account_deletion_requests')
        ),
        false
    );
    assert.ok(pool.queries.some((query) => query.text === 'ROLLBACK'));
});

test('wrong nonce cannot reach Google verification or destructive SQL', async () => {
    const pool = makePool();
    const google = verifier();
    const service = createGoogleAccountDeletionService({
        pool,
        verifyGoogleIdToken: google.verify,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.deleteAccount({
            accountId: ACCOUNT_ID,
            installationId: INSTALLATION_ID,
            challengeId: CHALLENGE_ID,
            rawNonce: 'wrong-nonce',
            idToken: 'google-id-token',
        }),
        (error) => {
            assert.equal(error.code, 'invalid_challenge');
            assert.equal(error.status, 401);
            return true;
        }
    );

    assert.equal(google.calls.length, 0);
    assert.equal(
        pool.queries.some((query) =>
            query.text.includes('INSERT INTO account_deletion_requests')
        ),
        false
    );
    assert.ok(pool.queries.some((query) =>
        query.text.includes('failed_attempts = LEAST')
    ));
});

test('a consumed deletion challenge cannot be reused', async () => {
    const pool = makePool({
        challengeRow: makeChallengeRow({ consumed_at: new Date(NOW_MS - 1000) }),
    });
    const google = verifier();
    const service = createGoogleAccountDeletionService({
        pool,
        verifyGoogleIdToken: google.verify,
        now: () => NOW_MS,
    });

    await assert.rejects(
        service.deleteAccount({
            accountId: ACCOUNT_ID,
            installationId: INSTALLATION_ID,
            challengeId: CHALLENGE_ID,
            rawNonce: RAW_NONCE,
            idToken: 'google-id-token',
        }),
        (error) => {
            assert.equal(error.code, 'challenge_already_used');
            assert.equal(error.status, 409);
            return true;
        }
    );

    assert.equal(google.calls.length, 0);
});
