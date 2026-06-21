// pushRoutes.js
// Mount in server.js:
// import { createPushRouter } from './pushRoutes.js';
// app.use(createPushRouter(pool));
//
// Endpoints:
//   POST /api/push/register                  — store/update device token
//   POST /api/push/complete-daily-challenge  — mark challenge done for this device
//   POST /api/push/test                      — send a test push immediately
//   GET  /api/push/tokens                    — admin-only token list
//   GET  /api/push/tokens/debug              — admin-only token chunks
//
// Storage:
//   - Postgres push_tokens table is now the source of truth.
//   - push_tokens.json is still written as a temporary compatibility file
//     so the current pushScheduler.js does not break until we update it.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { sendPush } from './apnsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, 'push_tokens.json');

const DEFAULT_TIMEZONE = 'America/Chicago';
const DEVICE_TOKEN_RE = /^[A-Za-z0-9:_-]{32,512}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDeviceToken(token) {
    return String(token || '').trim();
}

function normalizePlatform(platform) {
    const value = String(platform || '').trim().toLowerCase();
    return value || 'ios';
}

function safeTimezone(rawTimezone) {
    const candidate = String(rawTimezone || '').trim();

    if (!candidate) return DEFAULT_TIMEZONE;

    const test = DateTime.now().setZone(candidate);
    return test.isValid ? candidate : DEFAULT_TIMEZONE;
}

function isValidDeviceToken(token) {
    return typeof token === 'string' && DEVICE_TOKEN_RE.test(token);
}

function getAdminKey() {
    return process.env.ANALYTICS_ADMIN_KEY || '';
}

function isAuthorizedAdmin(req) {
    const adminKey = getAdminKey();

    // Important:
    // If no admin key is configured, deny admin endpoints by default.
    if (!adminKey) return false;

    const supplied =
        req.query.adminKey ||
        req.headers['x-admin-key'];

    return supplied === adminKey;
}

function tokenPreview(token) {
    const clean = normalizeDeviceToken(token);

    if (clean.length <= 16) return clean;

    return `${clean.slice(0, 8)}...${clean.slice(-8)}`;
}

function normalizeDateString(value) {
    if (!value) return null;

    const s = String(value).trim();
    if (!s) return null;

    return s.slice(0, 10);
}

function rowToTokenRecord(row) {
    if (!row) return null;

    return {
        deviceToken: row.device_token,
        platform: row.platform || 'ios',
        timezone: row.timezone || DEFAULT_TIMEZONE,
        notificationsEnabled: row.notifications_enabled !== false,
        lastCompletedChallengeId: row.last_completed_challenge_id || null,
        lastCompletedChallengeDate: row.last_completed_challenge_date
            ? String(row.last_completed_challenge_date).slice(0, 10)
            : null,
        registeredAt: row.registered_at || null,
        updatedAt: row.updated_at || null,
    };
}

// ─── Compatibility JSON writer ────────────────────────────────────────────────
// Temporary only.
// Current pushScheduler.js reads push_tokens.json.
// Once pushScheduler.js is moved to Postgres, this can be removed.

async function syncPushTokensJson(pool) {
    try {
        const result = await pool.query(
            `SELECT *
             FROM push_tokens
             ORDER BY updated_at DESC`
        );

        const tokens = {};

        for (const row of result.rows) {
            const record = rowToTokenRecord(row);
            if (!record?.deviceToken) continue;

            tokens[record.deviceToken] = {
                deviceToken: record.deviceToken,
                platform: record.platform,
                timezone: record.timezone,
                notificationsEnabled: record.notificationsEnabled,
                lastCompletedChallengeId: record.lastCompletedChallengeId,
                lastCompletedChallengeDate: record.lastCompletedChallengeDate,
                registeredAt: record.registeredAt,
                updatedAt: record.updatedAt,
            };
        }

        fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');

        console.log(`[Push] Synced push_tokens.json compatibility file. Count=${Object.keys(tokens).length}`);
    } catch (err) {
        console.error('[Push] Failed to sync push_tokens.json compatibility file:', err.message);
    }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertPushToken(pool, {
    deviceToken,
    platform,
    timezone,
}) {
    const result = await pool.query(
        `INSERT INTO push_tokens (
            device_token,
            platform,
            timezone,
            notifications_enabled,
            registered_at,
            updated_at
         )
         VALUES (
            $1,
            $2,
            $3,
            true,
            now(),
            now()
         )
         ON CONFLICT (device_token)
         DO UPDATE SET
            platform = EXCLUDED.platform,
            timezone = EXCLUDED.timezone,
            notifications_enabled = true,
            updated_at = now()
         RETURNING *`,
        [
            deviceToken,
            platform,
            timezone,
        ]
    );

    return rowToTokenRecord(result.rows[0]);
}

async function markCompleted(pool, {
    deviceToken,
    challengeId,
    challengeDate,
}) {
    const result = await pool.query(
        `UPDATE push_tokens
         SET
            last_completed_challenge_id = $2,
            last_completed_challenge_date = COALESCE($3::date, last_completed_challenge_date),
            updated_at = now()
         WHERE device_token = $1
         RETURNING *`,
        [
            deviceToken,
            challengeId,
            challengeDate,
        ]
    );

    return rowToTokenRecord(result.rows[0]);
}

async function getToken(pool, deviceToken) {
    const result = await pool.query(
        `SELECT *
         FROM push_tokens
         WHERE device_token = $1
         LIMIT 1`,
        [deviceToken]
    );

    return rowToTokenRecord(result.rows[0]);
}

async function listTokens(pool) {
    const result = await pool.query(
        `SELECT *
         FROM push_tokens
         ORDER BY updated_at DESC`
    );

    return result.rows.map(rowToTokenRecord).filter(Boolean);
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createPushRouter(pool) {
    const router = express.Router();

    // ─── POST /api/push/register ──────────────────────────────────────────────

    router.post('/api/push/register', async (req, res) => {
        try {
            const { deviceToken, platform, timezone } = req.body || {};

            const normalizedToken = normalizeDeviceToken(deviceToken);

            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const record = await upsertPushToken(pool, {
                deviceToken: normalizedToken,
                platform: normalizePlatform(platform),
                timezone: safeTimezone(timezone),
            });

            await syncPushTokensJson(pool);

            console.log(
                `[Push] Registered token: ${tokenPreview(normalizedToken)} ` +
                `(length=${normalizedToken.length}, timezone=${record.timezone})`
            );

            return res.json({
                success: true,
                tokenPreview: tokenPreview(normalizedToken),
                tokenLength: normalizedToken.length,
                timezone: record.timezone,
            });
        } catch (err) {
            console.error('[Push] Register error:', err.message);
            return res.status(500).json({
                success: false,
                error: 'Failed to register push token.',
            });
        }
    });

    // ─── POST /api/push/complete-daily-challenge ──────────────────────────────

    router.post('/api/push/complete-daily-challenge', async (req, res) => {
        try {
            const { deviceToken, challengeId, challengeDate } = req.body || {};

            const normalizedToken = normalizeDeviceToken(deviceToken);
            const normalizedChallengeId = String(challengeId || '').trim();
            const normalizedChallengeDate = normalizeDateString(challengeDate);

            if (!isValidDeviceToken(normalizedToken) || !normalizedChallengeId) {
                return res.status(400).json({
                    error: 'deviceToken and challengeId are required.',
                });
            }

            const updated = await markCompleted(pool, {
                deviceToken: normalizedToken,
                challengeId: normalizedChallengeId,
                challengeDate: normalizedChallengeDate,
            });

            if (!updated) {
                // Token not registered yet — that's fine, nothing to update.
                return res.json({
                    success: true,
                    note: 'Token not found — no update needed.',
                });
            }

            await syncPushTokensJson(pool);

            console.log(
                `[Push] Marked completed: ${normalizedChallengeId} for ` +
                `${tokenPreview(normalizedToken)}`
            );

            return res.json({
                success: true,
                challengeId: updated.lastCompletedChallengeId,
                challengeDate: updated.lastCompletedChallengeDate,
            });
        } catch (err) {
            console.error('[Push] Complete daily challenge error:', err.message);
            return res.status(500).json({
                success: false,
                error: 'Failed to mark challenge completed.',
            });
        }
    });

    // ─── POST /api/push/test ──────────────────────────────────────────────────
    // Send a test push immediately to a specific device token.
    // Body:
    // {
    //   "deviceToken": "...",
    //   "title": "...",
    //   "body": "..."
    // }

    router.post('/api/push/test', async (req, res) => {
        try {
            const { deviceToken, title, body } = req.body || {};

            const normalizedToken = normalizeDeviceToken(deviceToken);

            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const pushTitle = title || 'A question enters the Agora';
            const pushBody = body || 'Nietzsche is waiting. Bring your answer.';

            console.log(
                `[Push] Sending test push to ${tokenPreview(normalizedToken)} ` +
                `(length=${normalizedToken.length})`
            );

            const ok = await sendPush(normalizedToken, pushTitle, pushBody);

            if (ok) {
                return res.json({
                    success: true,
                    message: 'Push sent.',
                    tokenPreview: tokenPreview(normalizedToken),
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Push failed — check Railway logs.',
            });
        } catch (err) {
            console.error('[Push] Test push error:', err.message);
            return res.status(500).json({
                success: false,
                error: 'Push failed.',
            });
        }
    });

    // ─── GET /api/push/tokens ─────────────────────────────────────────────────
    // Admin-only.
    // Use:
    // /api/push/tokens?adminKey=YOUR_ANALYTICS_ADMIN_KEY

    router.get('/api/push/tokens', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) {
                return res.status(401).json({ error: 'Unauthorized.' });
            }

            const records = await listTokens(pool);

            const list = records.map((record) => ({
                token: record.deviceToken,
                tokenPreview: tokenPreview(record.deviceToken),
                tokenLength: record.deviceToken.length,
                timezone: record.timezone || 'unknown',
                platform: record.platform || 'ios',
                notificationsEnabled: record.notificationsEnabled,
                completedId: record.lastCompletedChallengeId || null,
                completedDate: record.lastCompletedChallengeDate || null,
                registeredAt: record.registeredAt || null,
                updatedAt: record.updatedAt || null,
            }));

            return res.json({
                count: list.length,
                tokens: list,
            });
        } catch (err) {
            console.error('[Push] Token list error:', err.message);
            return res.status(500).json({
                error: 'Failed to list tokens.',
            });
        }
    });

    // ─── GET /api/push/tokens/debug ───────────────────────────────────────────
    // Admin-only.
    // Returns token chunks to make copying easier if browser/Railway wraps text.
    // Use:
    // /api/push/tokens/debug?adminKey=YOUR_ANALYTICS_ADMIN_KEY

    router.get('/api/push/tokens/debug', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) {
                return res.status(401).json({ error: 'Unauthorized.' });
            }

            const records = await listTokens(pool);

            const list = records.map((record) => {
                const token = record.deviceToken;
                const chunks = [];
                const chunkSize = 40;

                for (let i = 0; i < token.length; i += chunkSize) {
                    chunks.push(token.slice(i, i + chunkSize));
                }

                return {
                    tokenPreview: tokenPreview(token),
                    tokenLength: token.length,
                    chunks,
                    timezone: record.timezone || 'unknown',
                    platform: record.platform || 'ios',
                    notificationsEnabled: record.notificationsEnabled,
                    completedId: record.lastCompletedChallengeId || null,
                    completedDate: record.lastCompletedChallengeDate || null,
                    registeredAt: record.registeredAt || null,
                    updatedAt: record.updatedAt || null,
                };
            });

            return res.json({
                count: list.length,
                tokens: list,
            });
        } catch (err) {
            console.error('[Push] Token debug list error:', err.message);
            return res.status(500).json({
                error: 'Failed to list debug tokens.',
            });
        }
    });

    // ─── GET /api/push/token-status ───────────────────────────────────────────
    // Optional helper for debugging one token without exposing all tokens.
    // Admin-only.
    // Use:
    // /api/push/token-status?adminKey=KEY&deviceToken=TOKEN

    router.get('/api/push/token-status', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) {
                return res.status(401).json({ error: 'Unauthorized.' });
            }

            const normalizedToken = normalizeDeviceToken(req.query.deviceToken);

            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const record = await getToken(pool, normalizedToken);

            if (!record) {
                return res.json({
                    found: false,
                    tokenPreview: tokenPreview(normalizedToken),
                });
            }

            return res.json({
                found: true,
                tokenPreview: tokenPreview(record.deviceToken),
                tokenLength: record.deviceToken.length,
                timezone: record.timezone,
                platform: record.platform,
                notificationsEnabled: record.notificationsEnabled,
                completedId: record.lastCompletedChallengeId,
                completedDate: record.lastCompletedChallengeDate,
                registeredAt: record.registeredAt,
                updatedAt: record.updatedAt,
            });
        } catch (err) {
            console.error('[Push] Token status error:', err.message);
            return res.status(500).json({
                error: 'Failed to read token status.',
            });
        }
    });

    return router;
}

export default createPushRouter;
