// pushRoutes.js
// Cross-platform device registration and Daily Challenge push state.
// Existing iOS/APNs callers remain backward compatible while Android/FCM callers
// can use Agora account authentication and Android naming aliases.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DateTime } from 'luxon';
import { sendPush } from './apnsService.js';
import { sendFcmPush } from './lib/fcmService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, 'push_tokens.json');

const DEFAULT_TIMEZONE = 'America/Chicago';
const DEVICE_TOKEN_RE = /^[A-Za-z0-9:_-]{32,512}$/;
const SUPPORTED_PLATFORMS = new Set(['ios', 'android']);

const PERMANENT_APNS_FAILURES = new Set([
    'BadDeviceToken',
    'Unregistered',
    'DeviceTokenNotForTopic',
    'BadCertificateEnvironment',
]);

class PushRouteError extends Error {
    constructor(code, message, { status = 400, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'PushRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function normalizeDeviceToken(token) {
    return String(token || '').trim();
}

function normalizePlatform(platform) {
    const value = String(platform || '').trim().toLowerCase() || 'ios';
    if (!SUPPORTED_PLATFORMS.has(value)) {
        throw new PushRouteError('unsupported_push_platform', 'Push platform must be ios or android.', {
            status: 400,
        });
    }
    return value;
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
    if (!adminKey) return false;
    const supplied = req.query.adminKey || req.headers['x-admin-key'];
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
    return s ? s.slice(0, 10) : null;
}

function firstDefined(body, ...keys) {
    for (const key of keys) {
        if (body?.[key] !== undefined && body?.[key] !== null) return body[key];
    }
    return null;
}

function requestInstallationId(req, body) {
    const headerValue = normalizeText(req.get('X-Installation-ID'));
    const bodyValue = normalizeText(firstDefined(body, 'installId', 'installationId'));
    if (headerValue && bodyValue && headerValue !== bodyValue) {
        throw new PushRouteError(
            'installation_id_mismatch',
            'X-Installation-ID does not match the push registration body.',
            { status: 400 }
        );
    }
    return headerValue || bodyValue;
}

function notificationsEnabledFor(body, platform) {
    if (typeof body?.notificationsEnabled === 'boolean') return body.notificationsEnabled;
    if (platform !== 'android') return true;

    const permission = body?.notificationPermissionGranted;
    const reminders = body?.dailyChallengeRemindersEnabled;
    if (typeof permission !== 'boolean' && typeof reminders !== 'boolean') return true;
    return permission !== false && reminders !== false;
}

async function resolveUserId({
    req,
    accountAuthService,
    platform,
    installationId,
    clientUserId,
}) {
    const authorization = normalizeText(req.get('Authorization'));
    if (!authorization) {
        // Legacy iOS registration used identifierForVendor as userId. Android must
        // not be able to claim an arbitrary Agora account ID without authentication.
        return platform === 'ios' ? normalizeText(clientUserId) : null;
    }

    if (!accountAuthService || typeof accountAuthService.authorizeAccessToken !== 'function') {
        throw new PushRouteError(
            'push_account_auth_unavailable',
            'Authenticated push registration is unavailable.',
            { status: 503, retryable: true }
        );
    }
    if (!installationId) {
        throw new PushRouteError(
            'missing_installation_id',
            'X-Installation-ID is required for authenticated push registration.',
            { status: 400 }
        );
    }

    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (!match || !match[1]?.trim()) {
        throw new PushRouteError(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }

    try {
        const authorized = await accountAuthService.authorizeAccessToken({
            accessToken: match[1].trim(),
            installationId,
        });
        return authorized.accountId;
    } catch (error) {
        throw new PushRouteError(
            error?.code || 'invalid_access_token',
            error?.message || 'The access token is invalid or expired.',
            {
                status: Number.isInteger(error?.status) ? error.status : 401,
                retryable: Boolean(error?.retryable),
                cause: error,
            }
        );
    }
}

function sendRouteFailure(res, error, fallbackMessage) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 500;
    const exposeMessage = status < 500;
    return res.status(status).json({
        success: false,
        error: exposeMessage ? error.message : fallbackMessage,
        errorCode: error?.code || null,
        retryable: Boolean(error?.retryable),
    });
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

async function pruneOlderTokensForSameTarget(client, {
    deviceToken,
    platform,
    installId,
    userId,
    apnsEnvironment,
}) {
    const finalUserId = normalizeText(userId);
    const finalInstallId = normalizeText(installId);
    const finalEnvironment = normalizeApnsEnvironment(apnsEnvironment);
    const finalPlatform = normalizePlatform(platform);
    const values = [deviceToken, finalEnvironment, finalPlatform];
    const conditions = [];

    if (finalUserId) {
        values.push(finalUserId);
        conditions.push(`user_id = $${values.length}`);
    }
    if (finalInstallId) {
        values.push(finalInstallId);
        conditions.push(`install_id = $${values.length}`);
    }
    if (conditions.length === 0) return 0;

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
           AND platform = $3
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
    notificationsEnabled,
    installId,
    userId,
    appVersion,
    buildNumber,
    apnsEnvironment,
}) {
    const finalPlatform = normalizePlatform(platform);
    const finalInstallId = normalizeText(installId) || deviceToken;
    const finalUserId = normalizeText(userId);
    const finalEnvironment = normalizeApnsEnvironment(apnsEnvironment);
    const finalNotificationsEnabled = notificationsEnabled !== false;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), now(), now(), NULL, NULL)
             ON CONFLICT (install_id, apns_environment)
             DO UPDATE SET
                device_token = EXCLUDED.device_token,
                platform = EXCLUDED.platform,
                timezone = EXCLUDED.timezone,
                notifications_enabled = EXCLUDED.notifications_enabled,
                user_id = CASE
                    WHEN EXCLUDED.platform = 'android' THEN EXCLUDED.user_id
                    ELSE COALESCE(EXCLUDED.user_id, push_tokens.user_id)
                END,
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
                finalPlatform,
                timezone,
                finalNotificationsEnabled,
                finalInstallId,
                finalUserId,
                normalizeText(appVersion),
                normalizeText(buildNumber),
                finalEnvironment,
            ]
        );

        const row = result.rows[0];
        const effectiveUserId = finalPlatform === 'android'
            ? finalUserId
            : finalUserId || row?.user_id || null;
        const effectiveInstallId = finalInstallId || row?.install_id || null;
        const prunedCount = finalNotificationsEnabled
            ? await pruneOlderTokensForSameTarget(client, {
                deviceToken,
                platform: finalPlatform,
                installId: effectiveInstallId,
                userId: effectiveUserId,
                apnsEnvironment: finalEnvironment,
            })
            : 0;

        await client.query('COMMIT');
        if (prunedCount > 0) {
            console.log(
                `[Push] Disabled ${prunedCount} older ${finalPlatform} token(s) for same target ` +
                `(userId=${effectiveUserId || 'none'}, installId=${effectiveInstallId || 'none'}, env=${finalEnvironment})`
            );
        }
        return { ...rowToTokenRecord(row), prunedCount };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function markCompleted(pool, {
    deviceToken,
    platform,
    challengeId,
    challengeDate,
    userId,
    installId,
    apnsEnvironment,
}) {
    const normalizedPlatform = normalizePlatform(platform);
    const normalizedUserId = normalizeText(userId);
    const normalizedInstallId = normalizeText(installId);
    const normalizedEnvironment = normalizeApnsEnvironment(apnsEnvironment);

    if (normalizedPlatform === 'android') {
        if (!normalizedInstallId) {
            throw new PushRouteError(
                'missing_installation_id',
                'X-Installation-ID is required for Android Daily Challenge completion.',
                { status: 400, retryable: false }
            );
        }

        const values = [
            deviceToken,
            challengeId,
            challengeDate,
            normalizedInstallId,
            normalizedEnvironment,
        ];
        let accountCondition = 'AND user_id IS NULL';
        if (normalizedUserId) {
            values.push(normalizedUserId);
            accountCondition = `AND user_id = $${values.length}`;
        }

        const result = await pool.query(
            `UPDATE push_tokens
             SET
                last_completed_challenge_id = $2,
                last_completed_challenge_date = COALESCE($3::date, last_completed_challenge_date),
                updated_at = now()
             WHERE device_token = $1
               AND platform = 'android'
               AND install_id = $4
               AND apns_environment = $5
               ${accountCondition}
             RETURNING *`,
            values
        );

        const updated = rowToTokenRecord(result.rows[0]);
        if (!updated) {
            throw new PushRouteError(
                'push_registration_ownership_mismatch',
                'The Android push registration no longer belongs to this Agora account session. Re-register the device and retry.',
                { status: 409, retryable: true }
            );
        }
        return updated;
    }

    // Preserve the existing iOS/APNs compatibility behavior. Legacy iOS callers
    // may identify the same push target by token, userId, or installation ID.
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
    const finalEnvironment = normalizeApnsEnvironment(existingRow?.apns_environment || normalizedEnvironment);
    const values = [deviceToken, challengeId, challengeDate];
    const conditions = [`device_token = $1`];

    if (finalUserId) {
        values.push(finalUserId, finalEnvironment);
        conditions.push(`(user_id = $${values.length - 1} AND apns_environment = $${values.length})`);
    }
    if (finalInstallId) {
        values.push(finalInstallId, finalEnvironment);
        conditions.push(`(install_id = $${values.length - 1} AND apns_environment = $${values.length})`);
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
        `SELECT * FROM push_tokens WHERE device_token = $1 LIMIT 1`,
        [deviceToken]
    );
    return rowToTokenRecord(result.rows[0]);
}

async function listTokens(pool) {
    const result = await pool.query(
        `SELECT * FROM push_tokens
         ORDER BY updated_at DESC NULLS LAST, last_registered_at DESC NULLS LAST`
    );
    return result.rows.map(rowToTokenRecord).filter(Boolean);
}

async function markTestPushSuccess(pool, deviceToken) {
    await pool.query(
        `UPDATE push_tokens
         SET last_success_at = now(), last_failure_at = NULL, failure_reason = NULL, updated_at = now()
         WHERE device_token = $1`,
        [deviceToken]
    );
}

async function markTestPushFailure(pool, deviceToken, reason, permanent = false) {
    const cleanReason = String(reason || 'Test push failed').slice(0, 500);
    const shouldDisable = permanent || PERMANENT_APNS_FAILURES.has(cleanReason);
    await pool.query(
        `UPDATE push_tokens
         SET
            last_failure_at = now(),
            failure_reason = $2,
            notifications_enabled = CASE WHEN $3 THEN false ELSE notifications_enabled END,
            updated_at = now()
         WHERE device_token = $1`,
        [deviceToken, cleanReason, shouldDisable]
    );
    if (shouldDisable) {
        console.log(`[Push] Disabled bad token after test failure: ${tokenPreview(deviceToken)} — ${cleanReason}`);
    }
}

async function sendTestPush(record, token, title, body) {
    if (record?.platform === 'android') {
        return sendFcmPush(token, title, body, {
            type: 'daily_challenge',
            deepLink: 'theagora://daily',
        });
    }
    return sendPush(token, title, body);
}

export function createPushRouter(pool, { accountAuthService = null } = {}) {
    const router = express.Router();

    router.post('/api/push/register', async (req, res) => {
        try {
            const body = req.body || {};
            const platform = normalizePlatform(body.platform);
            const deviceToken = firstDefined(body, 'deviceToken', 'pushToken');
            const timezone = firstDefined(body, 'timezone', 'timeZone');
            const buildNumber = firstDefined(body, 'buildNumber', 'appBuild');
            const installationId = requestInstallationId(req, body);
            const normalizedToken = normalizeDeviceToken(deviceToken);

            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const userId = await resolveUserId({
                req,
                accountAuthService,
                platform,
                installationId,
                clientUserId: body.userId,
            });
            const record = await upsertPushToken(pool, {
                deviceToken: normalizedToken,
                platform,
                timezone: safeTimezone(timezone),
                notificationsEnabled: notificationsEnabledFor(body, platform),
                installId: installationId,
                userId,
                appVersion: body.appVersion,
                buildNumber,
                apnsEnvironment: body.apnsEnvironment,
            });

            await syncPushTokensJson(pool);
            console.log(
                `[Push] Registered ${platform} token: ${tokenPreview(normalizedToken)} ` +
                `(length=${normalizedToken.length}, timezone=${record.timezone}, enabled=${record.notificationsEnabled}, ` +
                `userId=${record.userId || 'none'}, installId=${record.installId || 'none'}, ` +
                `env=${record.apnsEnvironment || 'unknown'}, appVersion=${record.appVersion || 'unknown'}, ` +
                `build=${record.buildNumber || 'unknown'}, pruned=${record.prunedCount || 0})`
            );

            return res.json({
                success: true,
                tokenPreview: tokenPreview(normalizedToken),
                tokenLength: normalizedToken.length,
                platform: record.platform,
                timezone: record.timezone,
                notificationsEnabled: record.notificationsEnabled,
                userId: record.userId || null,
                installId: record.installId || null,
                apnsEnvironment: record.apnsEnvironment || null,
                appVersion: record.appVersion || null,
                buildNumber: record.buildNumber || null,
                prunedCount: record.prunedCount || 0,
            });
        } catch (err) {
            console.error('[Push] Register error:', err.message);
            return sendRouteFailure(res, err, 'Failed to register push token.');
        }
    });

    router.post('/api/push/complete-daily-challenge', async (req, res) => {
        try {
            const body = req.body || {};
            const platform = normalizePlatform(body.platform);
            const deviceToken = firstDefined(body, 'deviceToken', 'pushToken');
            const installationId = requestInstallationId(req, body);
            const normalizedToken = normalizeDeviceToken(deviceToken);
            const normalizedChallengeId = String(body.challengeId || body.dailyChallengeId || '').trim();
            const normalizedChallengeDate = normalizeDateString(body.challengeDate || body.dailyChallengeDate);

            if (!isValidDeviceToken(normalizedToken) || !normalizedChallengeId) {
                return res.status(400).json({ error: 'deviceToken and challengeId are required.' });
            }

            const userId = await resolveUserId({
                req,
                accountAuthService,
                platform,
                installationId,
                clientUserId: body.userId,
            });
            const updated = await markCompleted(pool, {
                deviceToken: normalizedToken,
                platform,
                challengeId: normalizedChallengeId,
                challengeDate: normalizedChallengeDate,
                userId,
                installId: installationId,
                apnsEnvironment: body.apnsEnvironment,
            });

            if (!updated) {
                return res.json({ success: true, note: 'Token not found — no update needed.' });
            }

            await syncPushTokensJson(pool);
            console.log(
                `[Push] Marked completed: ${normalizedChallengeId} for ${tokenPreview(normalizedToken)} ` +
                `(platform=${platform}, userId=${updated.userId || 'none'}, installId=${updated.installId || 'none'})`
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
            return sendRouteFailure(res, err, 'Failed to mark challenge completed.');
        }
    });

    router.post('/api/push/test', async (req, res) => {
        try {
            const { deviceToken, title, body } = req.body || {};
            const normalizedToken = normalizeDeviceToken(deviceToken);
            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }

            const record = await getToken(pool, normalizedToken);
            const pushTitle = title || 'A question enters the Agora';
            const pushBody = body || 'Nietzsche is waiting. Bring your answer.';
            console.log(
                `[Push] Sending ${record?.platform || 'ios'} test push to ${tokenPreview(normalizedToken)} ` +
                `(length=${normalizedToken.length})`
            );

            const outcome = await sendTestPush(record, normalizedToken, pushTitle, pushBody);
            const ok = outcome === true || outcome?.ok === true;
            const reason = typeof outcome === 'object' && outcome?.reason
                ? outcome.reason
                : 'Test push failed';

            if (ok) {
                await markTestPushSuccess(pool, normalizedToken);
                return res.json({
                    success: true,
                    message: 'Push sent.',
                    platform: record?.platform || 'ios',
                    tokenPreview: tokenPreview(normalizedToken),
                });
            }

            await markTestPushFailure(pool, normalizedToken, reason, Boolean(outcome?.permanent));
            return res.status(500).json({
                success: false,
                message: 'Push failed — check Railway logs.',
                reason,
                retryable: Boolean(outcome?.retryable),
                tokenPreview: tokenPreview(normalizedToken),
            });
        } catch (err) {
            console.error('[Push] Test push error:', err.message);
            return res.status(500).json({ success: false, error: 'Push failed.' });
        }
    });

    router.get('/api/push/tokens', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) return res.status(401).json({ error: 'Unauthorized.' });
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
            return res.json({ count: list.length, tokens: list });
        } catch (err) {
            console.error('[Push] Token list error:', err.message);
            return res.status(500).json({ error: 'Failed to list tokens.' });
        }
    });

    router.get('/api/push/tokens/debug', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) return res.status(401).json({ error: 'Unauthorized.' });
            const records = await listTokens(pool);
            const list = records.map((record) => {
                const token = record.deviceToken;
                const chunks = [];
                for (let i = 0; i < token.length; i += 40) chunks.push(token.slice(i, i + 40));
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
            return res.json({ count: list.length, tokens: list });
        } catch (err) {
            console.error('[Push] Token debug list error:', err.message);
            return res.status(500).json({ error: 'Failed to list debug tokens.' });
        }
    });

    router.get('/api/push/token-status', async (req, res) => {
        try {
            if (!isAuthorizedAdmin(req)) return res.status(401).json({ error: 'Unauthorized.' });
            const normalizedToken = normalizeDeviceToken(req.query.deviceToken);
            if (!isValidDeviceToken(normalizedToken)) {
                return res.status(400).json({ error: 'A valid deviceToken is required.' });
            }
            const record = await getToken(pool, normalizedToken);
            if (!record) return res.json({ found: false, tokenPreview: tokenPreview(normalizedToken) });
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
            return res.status(500).json({ error: 'Failed to read token status.' });
        }
    });

    return router;
}

export const pushRouteTestHelpers = Object.freeze({
    normalizePlatform,
    notificationsEnabledFor,
    requestInstallationId,
});

export default createPushRouter;
