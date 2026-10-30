import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {
    createFounderFeedbackTelegramService,
    formatFounderFeedbackTelegram,
} from '../lib/founderFeedbackTelegramService.js';
import { createFounderFeedbackRouter } from '../founderFeedbackRoutes.js';

const silentLogger = { info() {}, warn() {}, error() {} };

test('Android Telegram notifications label platform, version and escape feedback', () => {
    const message = formatFounderFeedbackTelegram({
        id: '314',
        client_platform: 'android',
        app_version: '4.3',
        app_build: 12,
        category: 'bug',
        display_name: 'Alex <developer>',
        message: 'App crashes when opening <Library> & notes.',
    });
    assert.match(message, /<b>App:<\/b> Android 4\.3 \(12\)/);
    assert.match(message, /Alex &lt;developer&gt;/);
    assert.match(message, /&lt;Library&gt; &amp; notes/);
    assert.doesNotMatch(message, /<b>App:<\/b> iOS/);
});

test('iOS Telegram notifications retain the correct platform label', () => {
    const message = formatFounderFeedbackTelegram({
        id: '315',
        client_platform: 'ios',
        app_version: '4.0',
        app_build: 44,
        category: 'feature_idea',
        message: 'Add bookmarks',
    });
    assert.match(message, /<b>App:<\/b> iOS 4\.0 \(44\)/);
});

test('failed Telegram sends remain queued for retry, with no user text in logs', async () => {
    const row = {
        id: '316', client_platform: 'android', category: 'bug',
        message: 'Private user feedback', telegram_attempts: 1,
    };
    const commands = [];
    let first = true;
    const pool = {
        async query(sql, args) {
            commands.push({ sql, args });
            if (sql.includes('WITH candidate AS')) return { rows: [{ ...row, telegram_attempts: first ? 1 : 2 }] };
            return { rows: [] };
        },
    };
    const logs = [];
    const sender = async () => {
        if (first) {
            first = false;
            throw new Error('Token is secret and message is private.');
        }
    };
    const notifier = createFounderFeedbackTelegramService({
        pool,
        sender,
        logger: {
            info(...args) { logs.push(args); },
            warn(...args) { logs.push(args); },
            error(...args) { logs.push(args); },
        },
    });
    const initial = await notifier.deliverId('316');
    assert.equal(initial.notificationStatus, 'queued');
    const retryQuery = commands.find(c => c.sql.includes('telegram_next_attempt_at ='));
    assert.ok(retryQuery);
    assert.equal(retryQuery.args[0], '316');
    assert.equal(retryQuery.args[2], 'Error');
    const later = await notifier.deliverId('316');
    assert.equal(later.notificationStatus, 'sent');
    assert.ok(commands.some(c => c.sql.includes('telegram_sent_at = NOW()')));
    assert.doesNotMatch(JSON.stringify(logs), /Private user feedback|Token is secret/);
});

test('feedback HTTP submission uses Android headers and returns durable queued status', async () => {
    let insertParameters;
    const pool = {
        async query(sql, args) {
            if (!sql.includes('INSERT INTO founder_feedback')) {
                throw new Error('Unexpected SQL in route integration test.');
            }
            insertParameters = args;
            return {
                rows: [{ id: 317, created_at: '2026-10-30T12:00:00.000Z' }],
            };
        },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/account/feedback', createFounderFeedbackRouter({
        pool,
        accountAuthService: {
            async authorizeAccessToken() {
                return { accountId: '93f82b06-4dc1-4655-abf6-509d0b892afd', displayName: 'Alex' };
            },
        },
        feedbackNotifier: {
            async deliverId(id) {
                assert.equal(id, '317');
                return { notificationStatus: 'queued' };
            },
        },
        logger: silentLogger,
    }));
    const server = app.listen(0, '127.0.0.1');
    try {
        if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/account/feedback', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer aaa.bbb.ccc',
                'X-Installation-ID': 'f73f1371-9050-48f2-b240-173e4e6f5cdd',
                'X-Client-Platform': 'android',
                'X-Android-Version': '4.3',
                'X-Android-Build': '12',
            },
            body: JSON.stringify({ category: 'bug', message: 'Reader crashes after tapping a note' }),
        });
        const body = await response.json();
        assert.equal(response.status, 201);
        assert.equal(body.success, true);
        assert.equal(body.notificationStatus, 'queued');
        assert.equal(insertParameters[4], 'android');
        assert.equal(insertParameters[5], '4.3');
        assert.equal(insertParameters[6], 12);
    } finally {
        await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
});

test('migration creates a retry queue without deleting or renaming feedback data', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(new URL('../migrations/061_founder_feedback_telegram_delivery.sql', import.meta.url), 'utf8');
    assert.match(sql, /ALTER TABLE founder_feedback/);
    assert.match(sql, /telegram_sent_at/);
    assert.match(sql, /telegram_lease_until/);
    assert.match(sql, /telegram_next_attempt_at/);
    assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/);
});
