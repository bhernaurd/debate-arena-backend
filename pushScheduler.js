// pushScheduler.js
// Scheduled cross-platform push jobs for Daily Challenge retention.
// iOS continues through APNs; Android is delivered through FCM HTTP v1.

import './env.js';

import cron from 'node-cron';
import pg from 'pg';
import { DateTime } from 'luxon';
import { sendPush } from './apnsService.js';
import { sendFcmPush } from './lib/fcmService.js';

const { Pool } = pg;

const DEFAULT_TIMEZONE = 'America/Chicago';
const DAILY_UNLOCK_HOUR = 5;

const SEND_SLOTS = {
    9: 'morning',
    14: 'afternoon',
    20: 'evening',
};

const PERMANENT_APNS_FAILURES = new Set([
    'BadDeviceToken',
    'Unregistered',
    'DeviceTokenNotForTopic',
    'BadCertificateEnvironment',
]);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

function schedulerApnsEnvironment() {
    const raw = String(process.env.APNS_ENVIRONMENT || 'production')
        .trim()
        .toLowerCase();
    if (raw === 'development' || raw === 'sandbox') return 'development';
    return 'production';
}

function safeTimezone(rawTimezone) {
    const candidate = String(rawTimezone || '').trim();
    if (!candidate) return DEFAULT_TIMEZONE;
    const test = DateTime.now().setZone(candidate);
    return test.isValid ? candidate : DEFAULT_TIMEZONE;
}

function getChallengeWindowForZone(rawZone, now = DateTime.now()) {
    const zone = safeTimezone(rawZone);
    const localNow = now.setZone(zone);
    const localStartToday = localNow.startOf('day').set({
        hour: DAILY_UNLOCK_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
    });
    const windowStart = localNow < localStartToday
        ? localStartToday.minus({ days: 1 })
        : localStartToday;
    const windowEnd = windowStart.plus({ days: 1 }).minus({ seconds: 1 });
    return {
        zone,
        date: windowStart.toISODate(),
        startsAt: windowStart.toISO(),
        expiresAt: windowEnd.toISO(),
    };
}

function normalizeDateValue(value) {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function toMillis(value) {
    if (!value) return 0;
    const date = value instanceof Date ? value : new Date(value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : 0;
}

function philosopherDisplayName(id) {
    const names = {
        aristotle: 'Aristotle',
        plato: 'Plato',
        nietzsche: 'Nietzsche',
        socrates: 'Socrates',
        jung: 'Carl Jung',
        aurelius: 'Marcus Aurelius',
    };
    return names[String(id || '').toLowerCase()] || 'The philosopher';
}

function possessiveName(name) {
    const clean = String(name || '').trim();
    if (!clean) return 'The philosopher’s';
    return clean.toLowerCase().endsWith('s') ? `${clean}'` : `${clean}'s`;
}

function tokenPreview(token) {
    const clean = String(token || '').trim();
    if (clean.length <= 16) return clean;
    return `${clean.slice(0, 8)}...${clean.slice(-8)}`;
}

function titleFor(timeOfDay, philosopherName) {
    if (timeOfDay === 'morning') return `${philosopherName} enters the Agora.`;
    if (timeOfDay === 'afternoon') return `${philosopherName} is waiting.`;
    return `${possessiveName(philosopherName)} time in the Agora is almost over.`;
}

function bodyKeyFor(timeOfDay) {
    if (timeOfDay === 'morning') return 'morning_notification';
    if (timeOfDay === 'afternoon') return 'afternoon_notification';
    return 'evening_notification';
}

function normalizedPlatform(record) {
    return String(record?.platform || 'ios').trim().toLowerCase() === 'android'
        ? 'android'
        : 'ios';
}

function targetKeyFor(record) {
    const platform = normalizedPlatform(record);
    const transportScope = platform === 'ios'
        ? (record.apnsEnvironment || schedulerApnsEnvironment())
        : 'fcm';

    if (record.userId) return `${platform}:${transportScope}:user:${record.userId}`;
    if (record.installId) return `${platform}:${transportScope}:install:${record.installId}`;
    return `${platform}:${transportScope}:token:${record.deviceToken}`;
}

function dedupeDueRecords(records) {
    const byTargetSlot = new Map();
    const skipped = [];
    for (const record of records) {
        const targetKey = targetKeyFor(record);
        const key = `${targetKey}:${record.challengeDate}:${record.timeOfDay}`;
        const existing = byTargetSlot.get(key);
        if (!existing) {
            byTargetSlot.set(key, { ...record, targetKey });
            continue;
        }
        const existingTime = Math.max(
            toMillis(existing.lastRegisteredAt),
            toMillis(existing.updatedAt),
            toMillis(existing.registeredAt)
        );
        const recordTime = Math.max(
            toMillis(record.lastRegisteredAt),
            toMillis(record.updatedAt),
            toMillis(record.registeredAt)
        );
        if (recordTime > existingTime) {
            skipped.push(existing);
            byTargetSlot.set(key, { ...record, targetKey });
        } else {
            skipped.push({ ...record, targetKey });
        }
    }
    return { kept: Array.from(byTargetSlot.values()), skipped };
}

async function ensureSchedulerTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS push_notification_deliveries (
            device_token TEXT NOT NULL,
            challenge_id TEXT NOT NULL,
            challenge_date DATE NOT NULL,
            time_of_day TEXT NOT NULL,
            timezone TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'claimed',
            claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            sent_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            error TEXT,
            target_key TEXT,
            PRIMARY KEY (device_token, challenge_id, time_of_day)
        );
    `);
    await pool.query(`ALTER TABLE push_notification_deliveries ADD COLUMN IF NOT EXISTS target_key TEXT;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_notification_deliveries_date ON push_notification_deliveries (challenge_date);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_notification_deliveries_status ON push_notification_deliveries (status);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_notification_deliveries_device_token ON push_notification_deliveries (device_token);`);
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_push_notification_deliveries_target_once
        ON push_notification_deliveries (target_key, challenge_id, challenge_date, time_of_day);
    `);
    console.log('[PushScheduler] Delivery log table ready');
}

async function getEnabledPushTokens() {
    const env = schedulerApnsEnvironment();
    const result = await pool.query(
        `SELECT
            device_token,
            platform,
            timezone,
            notifications_enabled,
            last_completed_challenge_id,
            last_completed_challenge_date,
            registered_at,
            updated_at,
            install_id,
            user_id,
            app_version,
            build_number,
            apns_environment,
            last_registered_at
         FROM push_tokens
         WHERE notifications_enabled = true
           AND (
                platform = 'android'
                OR (platform = 'ios' AND apns_environment = $1)
           )
         ORDER BY last_registered_at DESC NULLS LAST, updated_at DESC NULLS LAST`,
        [env]
    );

    return result.rows.map(row => ({
        deviceToken: row.device_token,
        platform: row.platform || 'ios',
        timezone: safeTimezone(row.timezone),
        notificationsEnabled: row.notifications_enabled !== false,
        lastCompletedChallengeId: row.last_completed_challenge_id || null,
        lastCompletedChallengeDate: normalizeDateValue(row.last_completed_challenge_date),
        registeredAt: row.registered_at || null,
        updatedAt: row.updated_at || null,
        installId: row.install_id || null,
        userId: row.user_id || null,
        appVersion: row.app_version || null,
        buildNumber: row.build_number || null,
        apnsEnvironment: row.apns_environment || null,
        lastRegisteredAt: row.last_registered_at || null,
    }));
}

async function getChallengeByDate(challengeDate) {
    const result = await pool.query(
        `SELECT
            challenge_date,
            id,
            philosopher_id,
            philosopher_name,
            morning_notification,
            afternoon_notification,
            evening_notification
         FROM daily_challenges
         WHERE challenge_date = $1::date
         LIMIT 1`,
        [challengeDate]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
        date: normalizeDateValue(row.challenge_date),
        id: row.id,
        philosopherId: row.philosopher_id,
        philosopherName: row.philosopher_name || philosopherDisplayName(row.philosopher_id),
        morning_notification: row.morning_notification,
        afternoon_notification: row.afternoon_notification,
        evening_notification: row.evening_notification,
    };
}

async function markTokenSuccess(deviceToken) {
    await pool.query(
        `UPDATE push_tokens
         SET last_success_at = now(), last_failure_at = NULL, failure_reason = NULL, updated_at = now()
         WHERE device_token = $1`,
        [deviceToken]
    );
}

async function markTokenFailure(deviceToken, error, { platform = 'ios', permanent = false } = {}) {
    const reason = String(error || 'Unknown push failure').slice(0, 500);
    const shouldDisable = permanent || (platform === 'ios' && PERMANENT_APNS_FAILURES.has(reason));
    await pool.query(
        `UPDATE push_tokens
         SET
            last_failure_at = now(),
            failure_reason = $2,
            notifications_enabled = CASE WHEN $3 THEN false ELSE notifications_enabled END,
            updated_at = now()
         WHERE device_token = $1`,
        [deviceToken, reason, shouldDisable]
    );
    if (shouldDisable) {
        console.log(`[PushScheduler] Disabled bad ${platform} token ${tokenPreview(deviceToken)} because: ${reason}`);
    }
}

async function claimDelivery({ targetKey, deviceToken, challengeId, challengeDate, timeOfDay, timezone }) {
    const result = await pool.query(
        `INSERT INTO push_notification_deliveries (
            target_key, device_token, challenge_id, challenge_date, time_of_day, timezone,
            status, claimed_at, updated_at
         )
         VALUES ($1, $2, $3, $4::date, $5, $6, 'claimed', now(), now())
         ON CONFLICT (target_key, challenge_id, challenge_date, time_of_day)
         DO NOTHING
         RETURNING target_key`,
        [targetKey, deviceToken, challengeId, challengeDate, timeOfDay, timezone]
    );
    return result.rowCount === 1;
}

async function markDeliverySent({ targetKey, challengeId, challengeDate, timeOfDay }) {
    await pool.query(
        `UPDATE push_notification_deliveries
         SET status = 'sent', sent_at = now(), updated_at = now(), error = NULL
         WHERE target_key = $1 AND challenge_id = $2 AND challenge_date = $3::date AND time_of_day = $4`,
        [targetKey, challengeId, challengeDate, timeOfDay]
    );
}

async function markDeliveryFailed({ targetKey, challengeId, challengeDate, timeOfDay, error }) {
    await pool.query(
        `UPDATE push_notification_deliveries
         SET status = 'failed', updated_at = now(), error = $5
         WHERE target_key = $1 AND challenge_id = $2 AND challenge_date = $3::date AND time_of_day = $4`,
        [targetKey, challengeId, challengeDate, timeOfDay, String(error || 'Unknown error').slice(0, 500)]
    );
}

function getDueSlotForToken(record, now) {
    const zone = safeTimezone(record.timezone);
    const localNow = now.setZone(zone);
    if (localNow.minute !== 0) return null;
    const timeOfDay = SEND_SLOTS[localNow.hour];
    if (!timeOfDay) return null;
    const challengeWindow = getChallengeWindowForZone(zone, now);
    return {
        timezone: zone,
        timeOfDay,
        challengeDate: challengeWindow.date,
        localTime: localNow.toFormat('yyyy-MM-dd HH:mm ZZZZ'),
    };
}

function hasCompletedChallenge(record, challenge) {
    if (!record || !challenge) return false;
    if (record.lastCompletedChallengeId && record.lastCompletedChallengeId === challenge.id) return true;
    const completedDate = normalizeDateValue(record.lastCompletedChallengeDate);
    return Boolean(completedDate && completedDate === challenge.date);
}

async function dispatchPush(record, title, body, payload) {
    if (normalizedPlatform(record) === 'android') {
        return sendFcmPush(record.deviceToken, title, body, {
            type: 'daily_challenge',
            dailyChallengeId: payload.challengeId,
            challengeId: payload.challengeId,
            dailyChallengeDate: payload.challengeDate,
            challengeDate: payload.challengeDate,
            philosopherId: payload.philosopherId,
            philosopher: payload.philosopher,
            timeOfDay: payload.timeOfDay,
            deepLink: 'theagora://daily',
        });
    }
    return sendPush(record.deviceToken, title, body, payload);
}

async function sendDueLocalPushes() {
    const now = DateTime.utc();
    const env = schedulerApnsEnvironment();
    let tokens = [];

    try {
        tokens = await getEnabledPushTokens();
    } catch (err) {
        console.error('[PushScheduler] Failed to read push tokens from Postgres:', err.message);
        return;
    }

    if (tokens.length === 0) {
        console.log(`[PushScheduler] Local check — no registered enabled push tokens (APNs env=${env})`);
        return;
    }

    const rawDueRecords = [];
    for (const record of tokens) {
        const dueSlot = getDueSlotForToken(record, now);
        if (dueSlot) rawDueRecords.push({ ...record, ...dueSlot });
    }

    if (rawDueRecords.length === 0) {
        console.log(
            `[PushScheduler] Local check ${now.toISO()} — no due local send slots ` +
            `(enabledTokens=${tokens.length}, APNs env=${env})`
        );
        return;
    }

    const { kept: dueRecords, skipped: preSendDuplicates } = dedupeDueRecords(rawDueRecords);
    console.log('──────────────────────────────────────────────');
    console.log(`[PushScheduler] Local send check ${now.toISO()}`);
    console.log(`[PushScheduler] APNs environment: ${env}`);
    console.log(`[PushScheduler] Enabled tokens: ${tokens.length}`);
    console.log(`[PushScheduler] Due tokens before dedupe: ${rawDueRecords.length}`);
    console.log(`[PushScheduler] Due tokens after dedupe: ${dueRecords.length}`);
    console.log(`[PushScheduler] Duplicate due records skipped before send: ${preSendDuplicates.length}`);
    console.log('──────────────────────────────────────────────');

    const challengeCache = new Map();
    let sent = 0;
    let skippedCompleted = 0;
    let skippedMissingChallenge = 0;
    let skippedDuplicate = preSendDuplicates.length;
    let failed = 0;

    for (const record of dueRecords) {
        let challenge = challengeCache.get(record.challengeDate);
        if (!challenge) {
            challenge = await getChallengeByDate(record.challengeDate);
            challengeCache.set(record.challengeDate, challenge);
        }

        if (!challenge) {
            skippedMissingChallenge++;
            console.log(
                `[PushScheduler] Missing challenge for ${record.challengeDate} ` +
                `(timezone=${record.timezone}, local=${record.localTime})`
            );
            continue;
        }

        if (hasCompletedChallenge(record, challenge)) {
            skippedCompleted++;
            console.log(
                `[PushScheduler] Skipping completed ${challenge.id} for ` +
                `${tokenPreview(record.deviceToken)} target=${record.targetKey}`
            );
            continue;
        }

        const bodyKey = bodyKeyFor(record.timeOfDay);
        const body = String(challenge[bodyKey] || '').trim();
        if (!body) {
            skippedMissingChallenge++;
            console.log(
                `[PushScheduler] Missing ${bodyKey} for challenge ${challenge.id}. ` +
                `Skipping ${tokenPreview(record.deviceToken)}`
            );
            continue;
        }

        const philosopherName = challenge.philosopherName || philosopherDisplayName(challenge.philosopherId);
        const title = titleFor(record.timeOfDay, philosopherName);
        const claimed = await claimDelivery({
            targetKey: record.targetKey,
            deviceToken: record.deviceToken,
            challengeId: challenge.id,
            challengeDate: challenge.date,
            timeOfDay: record.timeOfDay,
            timezone: record.timezone,
        });

        if (!claimed) {
            skippedDuplicate++;
            console.log(
                `[PushScheduler] Duplicate avoided for target=${record.targetKey} ` +
                `${challenge.id} ${record.timeOfDay}`
            );
            continue;
        }

        const payload = {
            challengeId: challenge.id,
            challengeDate: challenge.date || '',
            philosopherId: challenge.philosopherId,
            philosopher: philosopherName,
            timeOfDay: record.timeOfDay,
        };
        const platform = normalizedPlatform(record);
        console.log(
            `[PushScheduler] Sending ${record.timeOfDay} ${platform} push to ${tokenPreview(record.deviceToken)} ` +
            `(target=${record.targetKey}, timezone=${record.timezone}, local=${record.localTime}, ` +
            `challenge=${challenge.id}, installId=${record.installId || 'unknown'}, ` +
            `userId=${record.userId || 'unknown'}, appVersion=${record.appVersion || 'unknown'}, ` +
            `build=${record.buildNumber || 'unknown'}, env=${platform === 'ios' ? (record.apnsEnvironment || env) : 'fcm'})`
        );

        const outcome = await dispatchPush(record, title, body, payload);
        const ok = outcome === true || outcome?.ok === true;
        const failureReason = typeof outcome === 'object' && outcome?.reason
            ? outcome.reason
            : 'push transport returned false';

        if (ok) {
            sent++;
            await markDeliverySent({
                targetKey: record.targetKey,
                challengeId: challenge.id,
                challengeDate: challenge.date,
                timeOfDay: record.timeOfDay,
            });
            await markTokenSuccess(record.deviceToken);
        } else {
            failed++;
            await markDeliveryFailed({
                targetKey: record.targetKey,
                challengeId: challenge.id,
                challengeDate: challenge.date,
                timeOfDay: record.timeOfDay,
                error: failureReason,
            });
            await markTokenFailure(record.deviceToken, failureReason, {
                platform,
                permanent: Boolean(outcome?.permanent),
            });
        }
    }

    console.log(
        `[PushScheduler] Local run complete — sent: ${sent}, completed: ${skippedCompleted}, ` +
        `duplicates: ${skippedDuplicate}, missing: ${skippedMissingChallenge}, failed: ${failed}, APNs env=${env}`
    );
}

ensureSchedulerTables()
    .then(() => {
        console.log(`[PushScheduler] Startup ready — APNs environment: ${schedulerApnsEnvironment()}, Android transport: FCM`);
    })
    .catch((err) => {
        console.error('[PushScheduler] Startup table setup failed:', err.message);
    });

cron.schedule(
    '*/15 * * * *',
    () => {
        sendDueLocalPushes().catch((err) => {
            console.error('[PushScheduler] Local scheduler error:', err.message);
        });
    },
    { timezone: 'UTC' }
);

console.log(
    '[PushScheduler] Local-time cron registered — checks every 15 minutes for 9 AM / 2 PM / 8 PM in each device timezone'
);

export const pushSchedulerTestHelpers = Object.freeze({
    targetKeyFor,
    dedupeDueRecords,
    normalizedPlatform,
});
