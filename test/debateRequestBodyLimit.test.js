import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import {
    DEBATE_JSON_BODY_LIMIT,
    DEBATE_JSON_CREATE_ROUTES,
    debateJsonBodyParser,
    readablePayloadLimitError,
} from '../lib/debateRequestBodyLimit.js';

function fixtureApp() {
    const app = express();
    app.post(DEBATE_JSON_CREATE_ROUTES, debateJsonBodyParser);
    app.use(express.json({ limit: '50kb' }));
    app.post(['/api/ai-jobs', '/debate', '/api/account/session/refresh', '/api/ai-jobs/123/retry'],
        (req, res) => res.status(202).json({
            accepted: true,
            messageCount: req.body?.messages?.length ?? 0,
        })
    );
    app.use(readablePayloadLimitError);
    return app;
}

async function withServer(callback) {
    const server = fixtureApp().listen(0, '127.0.0.1');
    try {
        if (!server.listening) {
            await new Promise((resolve) => server.once('listening', resolve));
        }
        const address = server.address();
        return await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}

async function post(base, path, length) {
    const response = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            messages: [{ role: 'user', content: 'x'.repeat(length) }],
            systemPrompt: 'Debate with me.',
        }),
    });
    return { status: response.status, body: await response.json() };
}

test('larger normal debates work at the formerly failing 50 KB boundary', async () => {
    assert.equal(DEBATE_JSON_BODY_LIMIT, '512kb');
    await withServer(async (base) => {
        for (const route of ['/api/ai-jobs', '/debate']) {
            const result = await post(base, route, 100_000);
            assert.equal(result.status, 202);
            assert.equal(result.body.messageCount, 1);
        }
    });
});

test('unrelated endpoints retain their strict 50 KB limit', async () => {
    await withServer(async (base) => {
        for (const route of ['/api/account/session/refresh', '/api/ai-jobs/123/retry']) {
            const result = await post(base, route, 100_000);
            assert.equal(result.status, 413);
            assert.equal(result.body.code, 'request_payload_too_large');
            assert.equal(result.body.error, 'This request is too large to process.');
        }
    });
});

test('genuinely oversized debate payloads return safe JSON rather than HTML', async () => {
    await withServer(async (base) => {
        const result = await post(base, '/api/ai-jobs', 600_000);
        assert.equal(result.status, 413);
        assert.equal(result.body.success, false);
        assert.equal(result.body.code, 'debate_request_too_large');
        assert.equal(result.body.retryable, false);
        assert.equal(typeof result.body.error, 'string');
        assert.doesNotMatch(JSON.stringify(result.body), /<!DOCTYPE|<html|PayloadTooLargeError/i);
    });
});

test('large JSON handling stays route-scoped and occurs before the global parser', async () => {
    const { readFile } = await import('node:fs/promises');
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const scoped = server.indexOf('app.post(DEBATE_JSON_CREATE_ROUTES, debateJsonBodyParser);');
    const ordinary = server.indexOf("app.use(express.json({ limit: '50kb' }));");
    const handler = server.indexOf('app.use(readablePayloadLimitError);');
    assert.ok(scoped !== -1 && scoped < ordinary);
    assert.ok(handler > ordinary);
    assert.ok(handler > server.indexOf("app.use(aiJobsRouter);"));
});
