// pushRoutes.js
// Mount in server.js:
// import pushRouter from './pushRoutes.js';
// app.use(pushRouter);
//
// Endpoints:
//   POST /api/push/register                  — store/update device token
//   POST /api/push/complete-daily-challenge  — mark challenge done for this device
//   POST /api/push/test                      — send a test push immediately
//   GET  /api/push/tokens                    — temporary dev endpoint to list tokens

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendPush } from './apnsService.js';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, 'push_tokens.json');

// ─── Token store helpers ──────────────────────────────────────────────────────

function readTokens() {
    try {
        if (!fs.existsSync(TOKENS_PATH)) return {};
        return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch (err) {
        console.error('[Push] Token store read error:', err);
        return {};
    }
}

function writeTokens(data) {
    try {
        fs.writeFileSync(TOKENS_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('[Push] Token store write error:', err);
    }
}

function normalizeDeviceToken(token) {
    return String(token || '').trim();
}

// ─── POST /api/push/register ──────────────────────────────────────────────────

router.post('/api/push/register', (req, res) => {
    const { deviceToken, platform, timezone } = req.body;

    const normalizedToken = normalizeDeviceToken(deviceToken);

    if (!normalizedToken) {
        return res.status(400).json({ error: 'deviceToken is required.' });
    }

    const tokens = readTokens();

    // Upsert — preserve existing lastCompletedChallengeId if already stored
    const existing = tokens[normalizedToken] || {};

    tokens[normalizedToken] = {
        deviceToken: normalizedToken,
        platform: platform || existing.platform || 'ios',
        timezone: timezone || existing.timezone || 'America/Chicago',
        notificationsEnabled: true,
        lastCompletedChallengeId: existing.lastCompletedChallengeId ?? null,
        registeredAt: existing.registeredAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    writeTokens(tokens);

    console.log(
        `[Push] Registered token: ${normalizedToken.slice(0, 8)}...${normalizedToken.slice(-8)} ` +
        `(length=${normalizedToken.length}, timezone=${tokens[normalizedToken].timezone})`
    );

    return res.json({
        success: true,
        tokenPreview: `${normalizedToken.slice(0, 8)}...${normalizedToken.slice(-8)}`,
        tokenLength: normalizedToken.length,
    });
});

// ─── POST /api/push/complete-daily-challenge ──────────────────────────────────

router.post('/api/push/complete-daily-challenge', (req, res) => {
    const { deviceToken, challengeId } = req.body;

    const normalizedToken = normalizeDeviceToken(deviceToken);

    if (!normalizedToken || !challengeId) {
        return res.status(400).json({
            error: 'deviceToken and challengeId are required.',
        });
    }

    const tokens = readTokens();

    if (!tokens[normalizedToken]) {
        // Token not registered yet — that's fine, nothing to update
        return res.json({
            success: true,
            note: 'Token not found — no update needed.',
        });
    }

    tokens[normalizedToken].lastCompletedChallengeId = challengeId;
    tokens[normalizedToken].updatedAt = new Date().toISOString();

    writeTokens(tokens);

    console.log(
        `[Push] Marked completed: ${challengeId} for ` +
        `${normalizedToken.slice(0, 8)}...${normalizedToken.slice(-8)}`
    );

    return res.json({ success: true });
});

// ─── POST /api/push/test ──────────────────────────────────────────────────────
// Send a test push immediately to a specific device token.
// Body:
// {
//   "deviceToken": "...",
//   "title": "...",
//   "body": "..."
// }

router.post('/api/push/test', async (req, res) => {
    const { deviceToken, title, body } = req.body;

    const normalizedToken = normalizeDeviceToken(deviceToken);

    if (!normalizedToken) {
        return res.status(400).json({ error: 'deviceToken is required.' });
    }

    const pushTitle = title || 'A question enters the Agora';
    const pushBody = body || 'Nietzsche is waiting. Bring your answer.';

    console.log(
        `[Push] Sending test push to ${normalizedToken.slice(0, 8)}...${normalizedToken.slice(-8)} ` +
        `(length=${normalizedToken.length})`
    );

    const ok = await sendPush(normalizedToken, pushTitle, pushBody);

    if (ok) {
        return res.json({
            success: true,
            message: 'Push sent.',
            tokenPreview: `${normalizedToken.slice(0, 8)}...${normalizedToken.slice(-8)}`,
        });
    }

    return res.status(500).json({
        success: false,
        message: 'Push failed — check Railway logs.',
    });
});

// ─── GET /api/push/tokens ─────────────────────────────────────────────────────
// Temporary dev endpoint.
// Lists registered device tokens so you can copy the full token.
// Remove or protect this endpoint after testing.

router.get('/api/push/tokens', (req, res) => {
    const tokens = readTokens();

    const list = Object.keys(tokens).map((token) => ({
        token,
        tokenPreview: `${token.slice(0, 8)}...${token.slice(-8)}`,
        tokenLength: token.length,
        timezone: tokens[token].timezone || 'unknown',
        platform: tokens[token].platform || 'ios',
        notificationsEnabled: tokens[token].notificationsEnabled ?? false,
        completedId: tokens[token].lastCompletedChallengeId || null,
        registeredAt: tokens[token].registeredAt || null,
        updatedAt: tokens[token].updatedAt || null,
    }));

    return res.json({
        count: list.length,
        tokens: list,
    });
});

// ─── GET /api/push/tokens/debug ───────────────────────────────────────────────
// Temporary dev endpoint.
// Returns token chunks to make copying easier if browser/Railway wraps text.
// Remove or protect this endpoint after testing.

router.get('/api/push/tokens/debug', (req, res) => {
    const tokens = readTokens();

    const list = Object.keys(tokens).map((token) => {
        const chunks = [];
        const chunkSize = 40;

        for (let i = 0; i < token.length; i += chunkSize) {
            chunks.push(token.slice(i, i + chunkSize));
        }

        return {
            tokenPreview: `${token.slice(0, 8)}...${token.slice(-8)}`,
            tokenLength: token.length,
            chunks,
            timezone: tokens[token].timezone || 'unknown',
            platform: tokens[token].platform || 'ios',
            notificationsEnabled: tokens[token].notificationsEnabled ?? false,
            completedId: tokens[token].lastCompletedChallengeId || null,
            registeredAt: tokens[token].registeredAt || null,
            updatedAt: tokens[token].updatedAt || null,
        };
    });

    return res.json({
        count: list.length,
        tokens: list,
    });
});

export default router;
