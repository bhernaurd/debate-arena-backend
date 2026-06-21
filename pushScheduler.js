// pushScheduler.js
// Scheduled APNs push jobs for Daily Challenge retention.
// Registered as side-effect import in server.js: import './pushScheduler.js';
//
// New behavior:
//   - Runs every 15 minutes.
//   - Checks each device's saved timezone.
//   - Sends at 9:00 AM / 2:00 PM / 8:00 PM in that device's local time.
//   - Uses the correct Daily Challenge for that user's local challenge window.
//   - Reads push tokens from Postgres.
//   - Reads Daily Challenges from Postgres.
//   - Prevents duplicate sends with push_notification_deliveries.
//
// This scheduler never generates new notification copy and never calls Claude.

import './env.js';

import cron from 'node-cron';
import pg from 'pg';
import { DateTime } from 'luxon';
import { sendPush } from './apnsService.js';

const { Pool } = pg;

const CHICAGO_ZONE = 'America/Chicago';
const DEFAULT_TIMEZONE = 'America/Chicago';
const DAILY_UNLOCK_HOUR = 5;

const SEND_SLOTS = {
    9: 'morning',
    14: 'afternoon',
    20: 'evening',
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
});

// ─── Time helpers ─────────────────────────────────────────────────────────────

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

    const windowStart =
        localNow < localStartToday
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

    if (typeof value === 'string') {
        return value.slice(0, 10);
    }

    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }

    return String(value).slice(0, 10);
}

// ─── Display helpers ──────────────────────────────────────────────────────────

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

    return clean.toLowerCase().endsWith('s')
        ? `${clean}'`
        : `${clean}'s`;
}

function tokenPreview(token) {
    const clean = String(token || '').trim();

    if (clean.length <= 16) return clean;

    return `${clean.slice(0, 8)}...${clean.slice(-8)}`;
}

function titleFor(timeOfDay, philosopherName) {
    if (timeOfDay === 'morning') {
        return `${philosopherName} enters the Agora.`;
    }

    if (timeOfDay === 'afternoon') {
        return `${philosopherName} is waiting.`;
    }

    return `${possessiveName(philosopherName)} time in the Agora is almost over.`;
}

function bodyKeyFor(timeOfDay) {
    if (timeOfDay === 'morning') return 'morning_notification';
    if (timeOfDay === 'afternoon') return 'afternoon_notification';
    return 'evening_notification';
}

// ─── Database setup ───────────────────────────────────────────────────────────

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
            PRIMARY KEY (device_token, challenge_id, time_of_day)
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_push_notification_deliveries_date
        ON push_notification_deliveries (challenge_date);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_push_notification_deliveries_status
        ON push_notification_deliveries (status);
    `);

    console.log('[PushScheduler] Delivery log table ready');
}

// ─── DB readers ───────────────────────────────────────────────────────────────

async function getEnabledPushTokens() {
    const result = await pool.query(
        `SELECT
            device_token,
            platform,
            timezone,
            notifications_enabled,
            last_completed_challenge_id,
            last_completed_challenge_date,
            registered_at,
            updated_at
         FROM push_tokens
         WHERE notifications_enabled = true
         ORDER BY updated_at DESC`
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

// ─── Delivery claiming ────────────────────────────────────────────────────────
// This prevents duplicate sends if Railway restarts or if the scheduler overlaps.
// We claim before sending. If the row already exists, this push was already handled.

async function claimDelivery({
    deviceToken,
    challengeId,
    challengeDate,
    timeOfDay,
    timezone,
}) {
    const result = await pool.query(
        `INSERT INTO push_notification_deliveries (
            device_token,
            challenge_id,
            challenge_date,
            time_of_day,
            timezone,
            status,
            claimed_at,
            updated_at
         )
         VALUES (
            $1,
            $2,
            $3::date,
            $4,
            $5,
            'claimed',
            now(),
            now()
         )
         ON CONFLICT (device_token, challenge_id, time_of_day)
         DO NOTHING
         RETURNING device_token`,
        [
            deviceToken,
            challengeId,
            challengeDate,
            timeOfDay,
            timezone,
        ]
    );

    return result.rowCount === 1;
}

async function markDeliverySent({
    deviceToken,
    challengeId,
    timeOfDay,
}) {
    await pool.query(
        `UPDATE push_notification_deliveries
         SET
            status = 'sent',
            sent_at = now(),
            updated_at = now(),
            error = NULL
         WHERE device_token = $1
           AND challenge_id = $2
           AND time_of_day = $3`,
        [
            deviceToken,
            challengeId,
            timeOfDay,
        ]
    );
}

async function markDeliveryFailed({
    deviceToken,
    challengeId,
    timeOfDay,
    error,
}) {
    await pool.query(
        `UPDATE push_notification_deliveries
         SET
            status = 'failed',
            updated_at = now(),
            error = $4
         WHERE device_token = $1
           AND challenge_id = $2
           AND time_of_day = $3`,
        [
            deviceToken,
            challengeId,
            timeOfDay,
            String(error || 'Unknown error').slice(0, 500),
        ]
    );
}

// ─── Due-token logic ──────────────────────────────────────────────────────────

function getDueSlotForToken(record, now) {
    const zone = safeTimezone(record.timezone);
    const localNow = now.setZone(zone);

    // Scheduler runs every 15 minutes so it can catch half-hour and 45-minute zones.
    // Only send when the user's local minute is exactly 0.
    if (localNow.minute !== 0) {
        return null;
    }

    const timeOfDay = SEND_SLOTS[localNow.hour];

    if (!timeOfDay) {
        return null;
    }

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

    if (
        record.lastCompletedChallengeId &&
        record.lastCompletedChallengeId === challenge.id
    ) {
        return true;
    }

    const completedDate = normalizeDateValue(record.lastCompletedChallengeDate);

    if (completedDate && completedDate === challenge.date) {
        return true;
    }

    return false;
}

// ─── Core scheduler run ───────────────────────────────────────────────────────

async function sendDueLocalPushes() {
    const now = DateTime.utc();

    let tokens = [];

    try {
        tokens = await getEnabledPushTokens();
    } catch (err) {
        console.error('[PushScheduler] Failed to read push tokens from Postgres:', err.message);
        return;
    }

    if (tokens.length === 0) {
        console.log('[PushScheduler] Local check — no registered enabled tokens');
        return;
    }

    const dueRecords = [];

    for (const record of tokens) {
        const dueSlot = getDueSlotForToken(record, now);

        if (!dueSlot) continue;

        dueRecords.push({
            ...record,
            ...dueSlot,
        });
    }

    if (dueRecords.length === 0) {
        console.log(`[PushScheduler] Local check ${now.toISO()} — no due local send slots`);
        return;
    }

    console.log('──────────────────────────────────────────────');
    console.log(`[PushScheduler] Local send check ${now.toISO()}`);
    console.log(`[PushScheduler] Enabled tokens: ${tokens.length}`);
    console.log(`[PushScheduler] Due tokens: ${dueRecords.length}`);
    console.log('──────────────────────────────────────────────');

    const challengeCache = new Map();

    let sent = 0;
    let skippedCompleted = 0;
    let skippedMissingChallenge = 0;
    let skippedDuplicate = 0;
    let failed = 0;

    for (const record of dueRecords) {
        const cacheKey = record.challengeDate;

        let challenge = challengeCache.get(cacheKey);

        if (!challenge) {
            challenge = await getChallengeByDate(record.challengeDate);
            challengeCache.set(cacheKey, challenge);
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
                `[PushScheduler] Skipping completed ${challenge.id} for ${tokenPreview(record.deviceToken)}`
            );

            continue;
        }

        const bodyKey = bodyKeyFor(record.timeOfDay);
        const body = String(challenge[bodyKey] || '').trim();

        if (!body) {
            skippedMissingChallenge++;

            console.log(
                `[PushScheduler] Missing ${bodyKey} for challenge ${challenge.id}. Skipping ${tokenPreview(record.deviceToken)}`
            );

            continue;
        }

        const philosopherName =
            challenge.philosopherName ||
            philosopherDisplayName(challenge.philosopherId);

        const title = titleFor(record.timeOfDay, philosopherName);

        const claimed = await claimDelivery({
            deviceToken: record.deviceToken,
            challengeId: challenge.id,
            challengeDate: challenge.date,
            timeOfDay: record.timeOfDay,
            timezone: record.timezone,
        });

        if (!claimed) {
            skippedDuplicate++;

            console.log(
                `[PushScheduler] Duplicate avoided for ${tokenPreview(record.deviceToken)} ` +
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

        console.log(
            `[PushScheduler] Sending ${record.timeOfDay} push to ${tokenPreview(record.deviceToken)} ` +
            `(timezone=${record.timezone}, local=${record.localTime}, challenge=${challenge.id})`
        );

        const ok = await sendPush(
            record.deviceToken,
            title,
            body,
            payload
        );

        if (ok) {
            sent++;

            await markDeliverySent({
                deviceToken: record.deviceToken,
                challengeId: challenge.id,
                timeOfDay: record.timeOfDay,
            });
        } else {
            failed++;

            await markDeliveryFailed({
                deviceToken: record.deviceToken,
                challengeId: challenge.id,
                timeOfDay: record.timeOfDay,
                error: 'sendPush returned false',
            });
        }
    }

    console.log(
        `[PushScheduler] Local run complete — sent: ${sent}, completed: ${skippedCompleted}, ` +
        `duplicates: ${skippedDuplicate}, missing: ${skippedMissingChallenge}, failed: ${failed}`
    );
}

// ─── Startup ──────────────────────────────────────────────────────────────────

ensureSchedulerTables()
    .then(() => {
        console.log('[PushScheduler] Startup ready');
    })
    .catch((err) => {
        console.error('[PushScheduler] Startup table setup failed:', err.message);
    });

// ─── Cron job ─────────────────────────────────────────────────────────────────
// Every 15 minutes catches all global timezones, including half-hour and
// 45-minute offsets.
// Example:
//   India 9:00 AM = UTC 3:30
//   Nepal 9:00 AM = UTC 3:15

cron.schedule(
    '*/15 * * * *',
    () => {
        sendDueLocalPushes().catch((err) => {
            console.error('[PushScheduler] Local scheduler error:', err.message);
        });
    },
    { timezone: 'UTC' }
);

console.log('[PushScheduler] Local-time cron registered — checks every 15 minutes for 9 AM / 2 PM / 8 PM in each device timezone');
