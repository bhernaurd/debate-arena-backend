// pushRoutes.js
// Mount in server.js:
// import { createPushRouter } from './pushRoutes.js';
// app.use(createPushRouter(pool));
//
// Endpoints:
//   POST /api/push/register                  — store/update device token
//   POST /api/push/complete-daily-challenge  — mark challenge done for this device/user
//   POST /api/push/test                      — send a test push immediately
//   GET  /api/push/tokens                    — admin-only token list
//   GET  /api/push/tokens/debug              — admin-only token chunks
//   GET  /api/push/token-status              — admin-only one-token debug
//
// Main fix:
//   - iOS should send userId from identifierForVendor.
//   - Backend stores user_id.
//   - When a new token registers, older tokens for the same userId/installId are disabled.
//   - Bad APNs tokens can be disabled when sendPush returns permanent APNs failures.

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

const PERMANENT_APNS_FAILURES = new Set([
    'BadDeviceToken',
    'Unregistered',
    'DeviceTokenNotForTopic',
    'BadCertificateEnvironment',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeDeviceToken(token) {
    return String(token || '').trim();
}

function normalizePlatform(platform) {
    const value = String(platform || '').trim().toLowerCase();
    return value || 'ios';
}

function normalizeText(value) {
    const s = String(value || '').trim();
    return s || null;
}

function safeTimezone(rawTimezone) {
    const candidate = String(rawTimezone || '').trim();

    if (!candidate) return DEFAULT_TIMEZONE;

    const test = DateTime.now().setZone(candidate);
    return test.isValid ? candidate : DEFAULT_TIMEZONE;
}

function normalizeApnsEnvironment(value) {
    const raw = String(value || process.env.APNS_ENVIRONMENT || 'production')
        .trim()
        .toLowerCase();

    if (raw === 'development' || raw === 'sandbox') return 'development';
    return 'production';
}

function isValidDeviceToken(token) {
    return typeof token === 'string' && DEVICE_TOKEN_RE.test(token);
}

function getAdminKey() {
    return process.env.ANALYTICS_ADMIN_KEY || '';
}

function isAuthorizedAdmin(req) {
    const adminKey = getAdminKey();

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

        installId: row.install_id || null,
        userId: row.user_id || null,
        appVersion: row.app_version || null,
        buildNumber: row.build_number || null,
        apnsEnvironment: row.apns_environment || null,

        registeredAt: row.registered_at || row.created_at || null,
        updatedAt: row.updated_at || row.last_registered_at || null,
        createdAt: row.created_at || null,
        lastRegisteredAt: row.last_registered_at || null,
        lastSuccessAt: row.last_success_at || null,
        lastFailureAt: row.last_failure_at || null,
        failureReason: row.failure_reason || null,
    };
}

// ─── Compatibility JSON writer ────────────────────────────────────────────────
// Legacy compatibility only. The current scheduler reads from Postgres, but this
// can remain safely until you decide to remove it.

async function syncPushTokensJson(pool) {
    try {
        const result = await pool.query(
            `SELECT *
             FROM push_tokens
             WHERE notifications_enabled = true
             ORDER BY updated_at DESC NULLS LAST, last_registered_at DESC NULLS LAST`
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

                installId: record.installId,
                userId: record.userId,
                appVersion: record.appVersion,
                buildNumber: record.buildNumber,
                apnsEnvironment: record.apnsEnvironment,
            };
        }

        fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');

        console.log(`[Push] Synced push_tokens.json compatibility file. Count=${Object.keys(tokens).length}`);
    } catch (err) {
        console.error('[Push] Failed to sync push_tokens.json compatibility file:', err.message);
    }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function pruneOlderTokensForSameTarget(client, {
    deviceToken,
    installId,
    userId,
    apnsEnvironment,
}) {
    const finalUserId = normalizeText(userId);
    const finalInstallId = normalizeText(installId);
    const finalEnvironment = normalizeApnsEnvironment(apnsEnvironment);

    const values = [
        deviceToken,
        finalEnvironment,
    ];

    const conditions = [];

    if (finalUserId) {
        values.push(finalUserId);
        conditions.push(`user_id = $${values.length}`);
    }

    if (finalInstallId) {
        values.push(finalInstallId);
        conditions.push(`install_id = $${values.length}`);
    }

    if (conditions.length === 0) {
        return 0;
    }

    const result = await client.query(
        `UPDATE push_tokens
         SET
            notifications_enabled = false,
            last_failure_at = now(),
            failure_reason = 'superseded_by_new_token_registration',
            updated_at = now()
         WHERE notifications_enabled = true
           AND device_token <> $1
           AND apns_environment = $2
           AND (${conditions.join(' OR ')})
         RETURNING device_token`,
        values
    );

    return result.rowCount;
}

async function upsertPushToken(pool, {
    deviceToken,
    platform,
    timezone,
    installId,
    userId,
    appVersion,
    buildNumber,
    apnsEnvironment,
}) {
    const finalInstallId = normalizeText(installId) || deviceToken;
    const finalUserId = normalizeText(userId);
    const finalEnvironment = normalizeApnsEnvironment(apnsEnvironment);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Insert/update by installId + environment.
        // This handles app deletion/reinstall cases where the APNs token changes
        // but the backend still has the same install/environment row.
        const result = await client.query(
            `INSERT INTO push_tokens (
                device_token,
                platform,
                timezone,
                notifications_enabled,
                install_id,
                user_id,
                app_version,
                build_number,
                apns_environment,
                registered_at,
                updated_at,
                created_at,
                last_registered_at,
                last_failure_at,
                failure_reason
             )
             VALUES (
                $1,
                $2,
                $3,
                true,
                $4,
                $5,
                $6,
                $7,
                $8,
                now(),
                now(),
                now(),
                now(),
                NULL,
                NULL
             )
             ON CONFLICT ON CONSTRAINT push_tokens_install_env_unique
             DO UPDATE SET
                device_token = EXCLUDED.device_token,
                platform = EXCLUDED.platform,
                timezone = EXCLUDED.timezone,
                notifications_enabled = true,
                user_id = COALESCE(EXCLUDED.user_id, push_tokens.user_id),
                app_version = EXCLUDED.app_version,
                build_number = EXCLUDED.build_number,
                apns_environment = EXCLUDED.apns_environment,
                last_registered_at = now(),
                updated_at = now(),
                last_failure_at = NULL,
                failure_reason = NULL
             RETURNING *`,
            [
                deviceToken,
                platform,
                timezone,
                finalInstallId,
                finalUserId,
                normalizeText(appVersion),
                normalizeText(buildNumber),
                finalEnvironment,
            ]
        );

        const row = result.rows[0];

        const effectiveUserId = finalUserId || row?.user_id || null;
        const effectiveInstallId = finalInstallId || row?.install_id || null;

        const prunedCount = await pruneOlderTokensForSameTarget(client, {
            deviceToken,
            installId: effectiveInstallId,
            userId: effectiveUserId,
            apnsEnvironment: finalEnvironment,
        });

        await client.query('COMMIT');

        if (prunedCount > 0) {
            console.log(
                `[Push] Disabled ${prunedCount} older token(s) for same target ` +
                `(userId=${effectiveUserId || 'none'}, installId=${effectiveInstallId || 'none'}, env=${finalEnvironment})`
            );
        }

        return {
            ...rowToTokenRecord(row),
            prunedCount,
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function markCompleted(pool, {
    deviceToken,
    challengeId,
    challengeDate,
    userId,
    installId,
    apnsEnvironment,
}) {
    const normalizedUserId = normalizeText(userId);
    const normalizedInstallId = normalizeText(installId);
    const normalizedEnvironment = normalizeApnsEnvironment(apnsEnvironment);

    const existing = await pool.query(
        `SELECT user_id, install_id, apns_environment
         FROM push_tokens
         WHERE device_token = $1
         LIMIT 1`,
        [deviceToken]
    );

    const existingRow = existing.rows[0];

    const finalUserId = normalizedUserId || existingRow?.user_id || null;
    const finalInstallId = normalizedInstallId || existingRow?.install_id || null;
    const finalEnvironment = normalizeApnsEnvironment(
        existingRow?.apns_environment || normalizedEnvironment
    );

    const values = [
        deviceToken,
        challengeId,
        challengeDate,
    ];

    const conditions = [`device_token = $1`];

    if (finalUserId) {
        values.push(finalUserId);
        values.push(finalEnvironment);

        conditions.push(
            `(user_id = $${values.length - 1} AND apns_environment = $${values.length})`
        );
    }

    if (finalInstallId) {
        values.push(finalInstallId);
        values.push(finalEnvironment);

        conditions.push(
            `(install_id = $${values.length - 1} AND apns_environment = $${values.length})`
        );
    }

    const result = await pool.query(
        `UPDATE push_tokens
         SET
            last_completed_challenge_id = $2,
            last_completed_challenge_date = COALESCE($3::date, last_completed_challenge_date),
            updated_at = now()
         WHERE ${conditions.join(' OR ')}
         RETURNING *`,
        values
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
         ORDER BY updated_at DESC NULLS LAST, last_registered_at DESC NULLS LAST`
    );

    return result.rows.map(rowToTokenRecord).filter(Boolean);
}

async function markTestPushSuccess(pool, deviceToken) {
    await pool.query(
        `UPDATE push_tokens
         SET
            last_success_at = now(),
            last_failure_at = NULL,
            failure_reason = NULL,
            updated_at = now()
         WHERE device_token = $1`,
        [deviceToken]
    );
}

async function markTestPushFailure(pool, deviceToken, reason) {
    const cleanReason = String(reason || 'Test push failed').slice(0, 500);
    const shouldDisable = PERMANENT_APNS_FAILURES.has(cleanReason);

    await pool.query(
        `UPDATE push_tokens
         SET
            last_failure_at = now(),
            failure_reason = $2,
            notifications_enabled = CASE WHEN $3 THEN false ELSE notifications_enabled END,
            updated_at = now()
         WHERE device_token = $1`,
        [
            deviceToken,
            cleanReason,
            shouldDisable,
        ]
    );

    if (shouldDisable) {
        console.log(`[Push] Disabled bad token after test failure: ${tokenPreview(deviceToken)} — ${cleanReason}`);
    }
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createPushRouter(pool) {
    const router = express.Router();

    // ─── POST /api/push/register ──────────────────────────────────────────────

    router.post('/api/push/register', async (req, res) => {
        try {
            const {
                deviceToken,
                platform,
                timezone,
                installId,
                userId,
                appVersion,
                buildNumber,
                apnsEnvironment,
            } = req.body || {};

            const normalizedToken = normalizeDeviceToken(deviceToken);

            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const record = await upsertPushToken(pool, {
                deviceToken: normalizedToken,
                platform: normalizePlatform(platform),
                timezone: safeTimezone(timezone),
                installId,
                userId,
                appVersion,
                buildNumber,
                apnsEnvironment,
            });

            await syncPushTokensJson(pool);

            console.log(
                `[Push] Registered token: ${tokenPreview(normalizedToken)} ` +
                `(length=${normalizedToken.length}, timezone=${record.timezone}, ` +
                `userId=${record.userId || 'none'}, installId=${record.installId || 'none'}, ` +
                `env=${record.apnsEnvironment || 'unknown'}, appVersion=${record.appVersion || 'unknown'}, ` +
                `build=${record.buildNumber || 'unknown'}, pruned=${record.prunedCount || 0})`
            );

            return res.json({
                success: true,
                tokenPreview: tokenPreview(normalizedToken),
                tokenLength: normalizedToken.length,
                timezone: record.timezone,
                userId: record.userId || null,
                installId: record.installId || null,
                apnsEnvironment: record.apnsEnvironment || null,
                appVersion: record.appVersion || null,
                buildNumber: record.buildNumber || null,
                prunedCount: record.prunedCount || 0,
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
            const {
                deviceToken,
                challengeId,
                challengeDate,
                userId,
                installId,
                apnsEnvironment,
            } = req.body || {};

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
                userId,
                installId,
                apnsEnvironment,
            });

            if (!updated) {
                return res.json({
                    success: true,
                    note: 'Token not found — no update needed.',
                });
            }

            await syncPushTokensJson(pool);

            console.log(
                `[Push] Marked completed: ${normalizedChallengeId} for ` +
                `${tokenPreview(normalizedToken)} ` +
                `(userId=${updated.userId || 'none'}, installId=${updated.installId || 'none'})`
            );

            return res.json({
                success: true,
                challengeId: updated.lastCompletedChallengeId,
                challengeDate: updated.lastCompletedChallengeDate,
                userId: updated.userId || null,
                installId: updated.installId || null,
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

            const outcome = await sendPush(normalizedToken, pushTitle, pushBody);
            const ok = outcome === true || outcome?.ok === true;

            const reason =
                typeof outcome === 'object' && outcome?.reason
                    ? outcome.reason
                    : 'Test push failed';

            if (ok) {
                await markTestPushSuccess(pool, normalizedToken);

                return res.json({
                    success: true,
                    message: 'Push sent.',
                    tokenPreview: tokenPreview(normalizedToken),
                });
            }

            await markTestPushFailure(pool, normalizedToken, reason);

            return res.status(500).json({
                success: false,
                message: 'Push failed — check Railway logs.',
                reason,
                tokenPreview: tokenPreview(normalizedToken),
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

                installId: record.installId || null,
                userId: record.userId || null,
                appVersion: record.appVersion || null,
                buildNumber: record.buildNumber || null,
                apnsEnvironment: record.apnsEnvironment || null,

                registeredAt: record.registeredAt || null,
                updatedAt: record.updatedAt || null,
                createdAt: record.createdAt || null,
                lastRegisteredAt: record.lastRegisteredAt || null,
                lastSuccessAt: record.lastSuccessAt || null,
                lastFailureAt: record.lastFailureAt || null,
                failureReason: record.failureReason || null,
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

                    installId: record.installId || null,
                    userId: record.userId || null,
                    appVersion: record.appVersion || null,
                    buildNumber: record.buildNumber || null,
                    apnsEnvironment: record.apnsEnvironment || null,

                    registeredAt: record.registeredAt || null,
                    updatedAt: record.updatedAt || null,
                    createdAt: record.createdAt || null,
                    lastRegisteredAt: record.lastRegisteredAt || null,
                    lastSuccessAt: record.lastSuccessAt || null,
                    lastFailureAt: record.lastFailureAt || null,
                    failureReason: record.failureReason || null,
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

                installId: record.installId || null,
                userId: record.userId || null,
                appVersion: record.appVersion || null,
                buildNumber: record.buildNumber || null,
                apnsEnvironment: record.apnsEnvironment || null,

                registeredAt: record.registeredAt,
                updatedAt: record.updatedAt,
                createdAt: record.createdAt,
                lastRegisteredAt: record.lastRegisteredAt,
                lastSuccessAt: record.lastSuccessAt,
                lastFailureAt: record.lastFailureAt,
                failureReason: record.failureReason,
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
