// pushRoutes.js
// Mount in server.js: import pushRouter from './pushRoutes.js'; app.use(pushRouter);
//
// Endpoints:
//   POST /api/push/register               — store/update device token
//   POST /api/push/complete-daily-challenge — mark challenge done for this device
//   POST /api/push/test                    — send a test push immediately

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
    } catch {
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

// ─── POST /api/push/register ──────────────────────────────────────────────────

router.post('/api/push/register', (req, res) => {
    const { deviceToken, platform, timezone } = req.body;

    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.trim() === '') {
        return res.status(400).json({ error: 'deviceToken is required.' });
    }

    const tokens = readTokens();

    // Upsert — preserve existing lastCompletedChallengeId if already stored
    const existing = tokens[deviceToken] || {};
    tokens[deviceToken] = {
        deviceToken: deviceToken.trim(),
        platform: platform || 'ios',
        timezone: timezone || 'America/Chicago',
        notificationsEnabled: true,
        lastCompletedChallengeId: existing.lastCompletedChallengeId ?? null,
        registeredAt: existing.registeredAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    writeTokens(tokens);
    console.log(`[Push] Registered token: ${deviceToken.slice(0, 8)}... (${timezone})`);
    return res.json({ success: true });
});

// ─── POST /api/push/complete-daily-challenge ──────────────────────────────────

router.post('/api/push/complete-daily-challenge', (req, res) => {
    const { deviceToken, challengeId } = req.body;

    if (!deviceToken || !challengeId) {
        return res.status(400).json({ error: 'deviceToken and challengeId are required.' });
    }

    const tokens = readTokens();
    if (!tokens[deviceToken]) {
        // Token not registered yet — that's fine, nothing to update
        return res.json({ success: true, note: 'Token not found — no update needed.' });
    }

    tokens[deviceToken].lastCompletedChallengeId = challengeId;
    tokens[deviceToken].updatedAt = new Date().toISOString();

    writeTokens(tokens);
    console.log(`[Push] Marked completed: ${challengeId} for ${deviceToken.slice(0, 8)}...`);
    return res.json({ success: true });
});

// ─── POST /api/push/test ──────────────────────────────────────────────────────
// Send a test push immediately to a specific device token.
// Use this to verify APNs is wired up before testing scheduled jobs.
//
// Body: { "deviceToken": "...", "title": "...", "body": "..." }

router.post('/api/push/test', async (req, res) => {
    const { deviceToken, title, body } = req.body;

    if (!deviceToken) {
        return res.status(400).json({ error: 'deviceToken is required.' });
    }

    const pushTitle = title || 'A question enters the Agora';
    const pushBody  = body  || 'Nietzsche is waiting. Bring your answer.';

    const ok = await sendPush(deviceToken, pushTitle, pushBody);
    if (ok) {
        return res.json({ success: true, message: 'Push sent.' });
    } else {
        return res.status(500).json({ success: false, message: 'Push failed — check Railway logs.' });
    }
});

export default router;
