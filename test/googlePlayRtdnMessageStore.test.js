import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createGooglePlayRtdnMessageStore } from '../lib/googlePlayRtdnMessageStore.js';

function createFakePool() {
    const rows = new Map();
    const calls = [];

    return {
        rows,
        calls,
        async query(sql, params = []) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            calls.push({ sql: normalized, params });
            const messageId = params[0];

            if (normalized.startsWith('INSERT INTO google_play_rtdn_messages')) {
                if (rows.has(messageId)) return { rowCount: 0, rows: [] };
                rows.set(messageId, {
                    status: 'processing',
                    updated_at: new Date(),
                    package_name: params[1],
                    notification_type: params[2],
                    event_time_millis: params[3],
                    purchase_token_sha256: params[4],
                    error_code: null,
                });
                return { rowCount: 1, rows: [{ message_id: messageId }] };
            }

            if (normalized.startsWith('SELECT status, updated_at')) {
                const row = rows.get(messageId);
                return { rows: row ? [{ status: row.status, updated_at: row.updated_at }] : [] };
            }

            if (normalized.includes("status = 'processing'") && normalized.startsWith('UPDATE google_play_rtdn_messages')) {
                const row = rows.get(messageId);
                if (!row || row.status !== 'failed') return { rowCount: 0, rows: [] };
                row.status = 'processing';
                row.error_code = null;
                row.updated_at = new Date();
                return { rowCount: 1, rows: [{ message_id: messageId }] };
            }

            if (normalized.includes('status = $2')) {
                const row = rows.get(messageId);
                if (row) {
                    row.status = params[1];
                    row.error_code = null;
                    row.updated_at = new Date();
                }
                return { rowCount: row ? 1 : 0, rows: [] };
            }

            if (normalized.includes("status = 'failed'")) {
                const row = rows.get(messageId);
                if (row) {
                    row.status = 'failed';
                    row.error_code = params[1];
                    row.updated_at = new Date();
                }
                return { rowCount: row ? 1 : 0, rows: [] };
            }

            throw new Error(`Unexpected SQL in fake RTDN store: ${normalized}`);
        },
    };
}

test('RTDN message store claims once and ignores an already completed Pub/Sub message ID', async () => {
    const pool = createFakePool();
    const store = createGooglePlayRtdnMessageStore({ pool });
    const purchaseTokenSha256 = 'a'.repeat(64);

    const first = await store.claim({
        messageId: 'pubsub-message-1',
        packageName: 'com.bhernaurd.theagora',
        notificationType: 4,
        eventTimeMillis: 1788300000000,
        purchaseTokenSha256,
    });
    assert.deepEqual(first, {
        claimed: true,
        duplicate: false,
        inProgress: false,
    });

    await store.complete('pubsub-message-1', { processed: true });

    const duplicate = await store.claim({
        messageId: 'pubsub-message-1',
        packageName: 'com.bhernaurd.theagora',
        notificationType: 4,
        eventTimeMillis: 1788300000000,
        purchaseTokenSha256,
    });
    assert.deepEqual(duplicate, {
        claimed: false,
        duplicate: true,
        inProgress: false,
    });
});

test('failed RTDN messages can be reclaimed for a Pub/Sub retry', async () => {
    const pool = createFakePool();
    const store = createGooglePlayRtdnMessageStore({ pool });

    await store.claim({ messageId: 'pubsub-message-2' });
    await store.markFailed('pubsub-message-2', 'publisher_unavailable');

    const retry = await store.claim({ messageId: 'pubsub-message-2' });
    assert.deepEqual(retry, {
        claimed: true,
        duplicate: true,
        inProgress: false,
    });
    assert.equal(pool.rows.get('pubsub-message-2').status, 'processing');
});

test('RTDN dedupe migration stores only a token fingerprint and never a raw purchase token', async () => {
    const migration = await readFile(
        new URL('../migrations/034_google_play_rtdn_messages.sql', import.meta.url),
        'utf8'
    );

    assert.match(migration, /message_id TEXT PRIMARY KEY/);
    assert.match(migration, /purchase_token_sha256 TEXT/);
    assert.doesNotMatch(migration, /\bpurchase_token\s+TEXT\b/);
    assert.match(migration, /processed/);
    assert.match(migration, /ignored/);
    assert.match(migration, /failed/);
});

test('RTDN route claims Pub/Sub messageId before entitlement processing and completes it after success', async () => {
    const source = await readFile(
        new URL('../googlePlaySubscriptionRoutes.js', import.meta.url),
        'utf8'
    );
    const routeStart = source.indexOf("router.post('/rtdn'");
    const messageIdCall = source.indexOf('requirePubSubMessageId(req.body)', routeStart);
    const claimCall = source.indexOf('googlePlayRtdnMessageStore.claim(', routeStart);
    const processCall = source.indexOf('rtdnService.processNotification(notification)', routeStart);
    const completeCall = source.indexOf('googlePlayRtdnMessageStore.complete(messageId', routeStart);

    assert.ok(routeStart >= 0);
    assert.ok(messageIdCall > routeStart);
    assert.ok(claimCall > messageIdCall);
    assert.ok(processCall > claimCall);
    assert.ok(completeCall > processCall);
});
