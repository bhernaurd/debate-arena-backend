// analytics.js
import express from 'express';

// One source of truth for "a day". Matches your daily-challenge cron timezone
// so retention days and challenge days line up.
const APP_TIMEZONE = 'America/Chicago';

// Allowlist: only these names get written. Stops typos and junk/abuse from
// bloating the table, and keeps your queries trustworthy.
const ALLOWED_EVENTS = new Set([
  'app_opened',
  'daily_challenge_viewed',
  'daily_challenge_started',
  'daily_challenge_completed',
  'philosopher_selected',
  'topic_selected',
  'question_generated',
  'debate_started',
  'debate_completed',
  'report_viewed',
  'difficulty_selected',
  'share_card_created',

  // Debate Report performance measurement
  'report_generation_started',
  'report_generation_completed',
  'report_generation_failed',
]);

const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;   // UUIDs pass; garbage doesn't
const MAX_METADATA_BYTES = 4096;               // keep metadata tiny

function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

// Returns: the object (valid), null (none provided), or undefined (invalid → reject).
function sanitizeMetadata(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  if (JSON.stringify(meta).length > MAX_METADATA_BYTES) return undefined;
  return meta;
}

export function createAnalyticsRouter(pool, options = {}) {
  const router = express.Router();
  const adminKey = options.adminKey || process.env.ANALYTICS_ADMIN_KEY;

  // Defense-in-depth body limit even if global json() is larger.
  router.use(express.json({ limit: '16kb' }));

  // active_date is computed in Chicago time, server-side. Idempotent per day.
  async function recordActiveDay(userId) {
    await pool.query(
      `INSERT INTO user_activity_days (user_id, active_date)
       VALUES ($1, (now() AT TIME ZONE $2)::date)
       ON CONFLICT (user_id, active_date) DO NOTHING`,
      [userId, APP_TIMEZONE]
    );
  }

  async function recordEvent(userId, eventName, metadata) {
    await pool.query(
      `INSERT INTO user_events (user_id, event_name, metadata)
       VALUES ($1, $2, $3::jsonb)`,
      [userId, eventName, metadata ? JSON.stringify(metadata) : null]
    );
  }

  // POST /analytics/app-open
  router.post('/app-open', async (req, res) => {
    try {
      const { userId } = req.body || {};
      if (!isValidUserId(userId)) {
        return res.status(400).json({ success: false, error: 'invalid userId' });
      }
      await recordActiveDay(userId);
      await recordEvent(userId, 'app_opened', null);
      return res.json({ success: true });
    } catch (err) {
      console.error('[analytics] app-open:', err.message);
      return res.status(500).json({ success: false }); // client ignores this anyway
    }
  });

  // POST /analytics/event
  router.post('/event', async (req, res) => {
    try {
      const { userId, eventName, metadata } = req.body || {};

      if (!isValidUserId(userId)) {
        return res.status(400).json({ success: false, error: 'invalid userId' });
      }

      if (typeof eventName !== 'string' || !ALLOWED_EVENTS.has(eventName)) {
        return res.status(400).json({ success: false, error: 'invalid eventName' });
      }

      const cleanMeta = sanitizeMetadata(metadata);

      if (cleanMeta === undefined) {
        return res.status(400).json({ success: false, error: 'invalid metadata' });
      }

      await recordEvent(userId, eventName, cleanMeta);
      await recordActiveDay(userId);          // any event ⇒ active today

      return res.json({ success: true });
    } catch (err) {
      console.error('[analytics] event:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  // GET /analytics/summary  — admin only (send header: x-admin-key: <ANALYTICS_ADMIN_KEY>)
  router.get('/summary', async (req, res) => {
    if (!adminKey || req.get('x-admin-key') !== adminKey) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }

    try {
      const tz = APP_TIMEZONE;

      const usersQ = pool.query(
        `WITH t AS (SELECT (now() AT TIME ZONE $1)::date AS today)
         SELECT
           COUNT(DISTINCT a.user_id)                                              AS total_users,
           COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_date = t.today)        AS dau,
           COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_date >= t.today - 6)   AS wau,
           COUNT(DISTINCT a.user_id) FILTER (WHERE a.active_date >= t.today - 29)  AS mau
         FROM user_activity_days a CROSS JOIN t`,
        [tz]
      );

      const todayQ = pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_name = 'app_opened')                    AS app_opens_today,
           COUNT(*) FILTER (WHERE event_name = 'debate_started')                AS debate_starts_today,
           COUNT(*) FILTER (WHERE event_name = 'debate_completed')              AS debate_completions_today,
           COUNT(*) FILTER (WHERE event_name = 'daily_challenge_completed')     AS daily_challenge_completions_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_started')     AS report_generation_started_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_completed')   AS report_generation_completed_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_failed')      AS report_generation_failed_today
         FROM user_events
         WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
        [tz]
      );

      const retentionQ = pool.query(
        `WITH first_seen AS (
           SELECT user_id, MIN(active_date) AS cohort_date
           FROM user_activity_days GROUP BY user_id
         ),
         spans AS (
           SELECT fs.user_id, (ua.active_date - fs.cohort_date) AS day_n
           FROM first_seen fs
           JOIN user_activity_days ua ON ua.user_id = fs.user_id
         )
         SELECT
           COUNT(DISTINCT user_id) AS cohort_size,
           ROUND(COUNT(DISTINCT user_id) FILTER (WHERE day_n >= 1)::numeric
                 / NULLIF(COUNT(DISTINCT user_id),0), 3)  AS d1_plus,
           ROUND(COUNT(DISTINCT user_id) FILTER (WHERE day_n >= 7)::numeric
                 / NULLIF(COUNT(DISTINCT user_id),0), 3)  AS d7_plus,
           ROUND(COUNT(DISTINCT user_id) FILTER (WHERE day_n >= 30)::numeric
                 / NULLIF(COUNT(DISTINCT user_id),0), 3)  AS d30_plus
         FROM spans`
      );

      const [users, today, retention] = await Promise.all([usersQ, todayQ, retentionQ]);

      return res.json({
        success: true,
        timezone: tz,
        users: users.rows[0],
        today: today.rows[0],
        retention: retention.rows[0],
      });
    } catch (err) {
      console.error('[analytics] summary:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  return router;
}
