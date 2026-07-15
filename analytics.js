import express from 'express';

const APP_TIMEZONE = 'America/Chicago';

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
  'report_progressive_started',
  'report_progressive_insight_visible',
  'report_full_content_visible',

  // Paywall / StoreKit funnel
  'paywall_viewed',
  'paywall_closed',
  'paywall_plan_selected',
  'purchase_started',
  'purchase_completed',
  'purchase_cancelled',
  'purchase_pending',
  'purchase_failed',
  'restore_started',
  'restore_completed',
  'restore_failed',
]);

const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const MAX_METADATA_BYTES = 4096;

function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

function resolveRequestUserId(req, bodyUserId) {
  const headerUserId = typeof req.get('x-installation-id') === 'string'
    ? req.get('x-installation-id').trim().slice(0, 128)
    : '';
  const cleanBodyUserId = typeof bodyUserId === 'string'
    ? bodyUserId.trim().slice(0, 128)
    : '';

  if (
    headerUserId &&
    cleanBodyUserId &&
    headerUserId !== cleanBodyUserId
  ) {
    return {
      userId: null,
      statusCode: 403,
      error: 'installation ID header/body mismatch',
    };
  }

  const userId = headerUserId || cleanBodyUserId;

  if (!isValidUserId(userId)) {
    return {
      userId: null,
      statusCode: 400,
      error: 'invalid userId',
    };
  }

  return { userId, statusCode: 200, error: null };
}

function sanitizeMetadata(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  if (JSON.stringify(meta).length > MAX_METADATA_BYTES) return undefined;
  return meta;
}

function isEntitlementUsable(row) {
  if (!row) return false;

  const status = String(row.status || '').toLowerCase();
  const now = Date.now();
  const expiresAt = row.expires_date
    ? new Date(row.expires_date).getTime()
    : null;
  const graceExpiresAt = row.grace_period_expires_date
    ? new Date(row.grace_period_expires_date).getTime()
    : null;

  if (status === 'trial' || status === 'active') {
    return expiresAt !== null && expiresAt > now;
  }

  if (status === 'grace_period') {
    return graceExpiresAt !== null && graceExpiresAt > now;
  }

  return false;
}

export function createAnalyticsRouter(pool, options = {}) {
  const router = express.Router();
  const adminKey = options.adminKey || process.env.ANALYTICS_ADMIN_KEY;

  router.use(express.json({ limit: '16kb' }));

  async function recordActiveDay(userId) {
    await pool.query(
      `INSERT INTO user_activity_days (user_id, active_date)
       VALUES ($1, (now() AT TIME ZONE $2)::date)
       ON CONFLICT (user_id, active_date) DO NOTHING`,
      [userId, APP_TIMEZONE]
    );
  }

  async function subscriptionContext(userId) {
    const result = await pool.query(
      `
      SELECT
        se.status,
        se.is_trial,
        se.product_id,
        se.environment,
        se.expires_date,
        se.grace_period_expires_date,
        se.auto_renew_enabled
      FROM subscription_entitlements se
      WHERE se.user_id = $1
         OR EXISTS (
           SELECT 1
           FROM subscription_installation_links link
           WHERE link.original_transaction_id = se.original_transaction_id
             AND link.environment = se.environment
             AND link.user_id = $1
         )
      ORDER BY
        CASE
          WHEN se.status IN ('trial', 'active')
            AND se.expires_date > NOW()
            THEN 0
          WHEN se.status = 'grace_period'
            AND se.grace_period_expires_date > NOW()
            THEN 0
          ELSE 1
        END,
        CASE WHEN se.environment = 'Production' THEN 0 ELSE 1 END,
        se.updated_at DESC
      LIMIT 1
      `,
      [userId]
    );

    const entitlement = result.rows[0] || null;
    const usable = isEntitlementUsable(entitlement);

    let analyticsAccessTier = 'free';

    if (usable && entitlement?.is_trial) {
      analyticsAccessTier = 'trial';
    } else if (usable) {
      analyticsAccessTier = 'paid_pro';
    }

    return {
      analyticsAccessTier,
      subscriptionStatus: entitlement?.status || 'none',
      subscriptionProductId: entitlement?.product_id || null,
      subscriptionEnvironment: entitlement?.environment || null,
      subscriptionAutoRenewEnabled:
        entitlement?.auto_renew_enabled ?? null,
      revenueEligible:
        entitlement?.environment === 'Production' &&
        analyticsAccessTier === 'paid_pro',
      analyticsVersion: 'july31_analytics_v1',
    };
  }

  async function recordEvent(userId, eventName, metadata) {
    const context = await subscriptionContext(userId);

    const enrichedMetadata = {
      ...(metadata || {}),
      ...context,
    };

    await pool.query(
      `INSERT INTO user_events (user_id, event_name, metadata)
       VALUES ($1, $2, $3::jsonb)`,
      [userId, eventName, JSON.stringify(enrichedMetadata)]
    );
  }

  router.post('/app-open', async (req, res) => {
    try {
      const identity = resolveRequestUserId(
        req,
        req.body?.userId
      );

      if (!identity.userId) {
        return res.status(identity.statusCode).json({
          success: false,
          error: identity.error,
        });
      }

      const userId = identity.userId;

      await recordActiveDay(userId);
      await recordEvent(userId, 'app_opened', null);

      return res.json({ success: true });
    } catch (err) {
      console.error('[analytics] app-open:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  router.post('/event', async (req, res) => {
    try {
      const { eventName, metadata } = req.body || {};
      const identity = resolveRequestUserId(
        req,
        req.body?.userId
      );

      if (!identity.userId) {
        return res.status(identity.statusCode).json({
          success: false,
          error: identity.error,
        });
      }

      const userId = identity.userId;

      if (
        typeof eventName !== 'string' ||
        !ALLOWED_EVENTS.has(eventName)
      ) {
        return res.status(400).json({
          success: false,
          error: 'invalid eventName',
        });
      }

      const cleanMeta = sanitizeMetadata(metadata);

      if (cleanMeta === undefined) {
        return res.status(400).json({
          success: false,
          error: 'invalid metadata',
        });
      }

      await recordEvent(userId, eventName, cleanMeta);
      await recordActiveDay(userId);

      return res.json({ success: true });
    } catch (err) {
      console.error('[analytics] event:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  router.get('/summary', async (req, res) => {
    if (!adminKey || req.get('x-admin-key') !== adminKey) {
      return res.status(401).json({
        success: false,
        error: 'unauthorized',
      });
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
         FROM user_activity_days a
         CROSS JOIN t
         WHERE NOT EXISTS (
           SELECT 1
           FROM excluded_analytics_users x
           WHERE x.user_id = a.user_id
         )`,
        [tz]
      );

      const todayQ = pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_name = 'app_opened')                    AS app_opens_today,
           COUNT(DISTINCT COALESCE(NULLIF(metadata->>'debateId', ''), id::text))
             FILTER (WHERE event_name = 'debate_started')                       AS debate_starts_today,
           COUNT(DISTINCT COALESCE(NULLIF(metadata->>'debateId', ''), id::text))
             FILTER (WHERE event_name = 'debate_completed')                     AS debate_completions_today,
           COUNT(*) FILTER (WHERE event_name = 'daily_challenge_completed')     AS daily_challenge_completions_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_started')     AS report_generation_started_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_completed')   AS report_generation_completed_today,
           COUNT(*) FILTER (WHERE event_name = 'report_generation_failed')      AS report_generation_failed_today,
           COUNT(*) FILTER (WHERE event_name = 'paywall_viewed')                AS paywall_views_today,
           COUNT(*) FILTER (WHERE event_name = 'purchase_completed')            AS purchases_completed_today
         FROM user_events e
         WHERE (e.created_at AT TIME ZONE $1)::date =
               (now() AT TIME ZONE $1)::date
           AND NOT EXISTS (
             SELECT 1
             FROM excluded_analytics_users x
             WHERE x.user_id = e.user_id
           )`,
        [tz]
      );

      const tierQ = pool.query(
        `WITH ranked AS (
           SELECT
             e.user_id,
             COALESCE(e.metadata->>'analyticsAccessTier', 'legacy_unknown') AS tier,
             ROW_NUMBER() OVER (
               PARTITION BY e.user_id
               ORDER BY e.created_at DESC
             ) AS rn
           FROM user_events e
           WHERE (e.created_at AT TIME ZONE $1)::date =
                 (now() AT TIME ZONE $1)::date
             AND NOT EXISTS (
               SELECT 1
               FROM excluded_analytics_users x
               WHERE x.user_id = e.user_id
             )
         )
         SELECT
           COUNT(*) FILTER (WHERE tier = 'free') AS free_dau,
           COUNT(*) FILTER (WHERE tier = 'trial') AS trial_dau,
           COUNT(*) FILTER (WHERE tier = 'paid_pro') AS paid_pro_dau,
           COUNT(*) FILTER (WHERE tier = 'legacy_unknown') AS unknown_dau
         FROM ranked
         WHERE rn = 1`,
        [tz]
      );

      const subscriptionsQ = pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status IN ('trial', 'grace_period')
               AND is_trial = true
               AND (
                 (status = 'trial' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_trials,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_paid_subscribers,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND product_id = 'agora_pro_monthly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS paid_monthly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND product_id = 'agora_pro_yearly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS paid_yearly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status IN ('active', 'trial', 'grace_period')
               AND auto_renew_enabled = false
               AND (
                 (status IN ('trial', 'active') AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_auto_renew_off,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status = 'billing_retry'
           ) AS billing_retry_subscriptions
         FROM subscription_entitlements se
         WHERE NOT EXISTS (
           SELECT 1
           FROM excluded_analytics_users x
           WHERE x.user_id = se.user_id
              OR EXISTS (
                SELECT 1
                FROM subscription_installation_links link
                WHERE link.original_transaction_id = se.original_transaction_id
                  AND link.environment = se.environment
                  AND link.user_id = x.user_id
              )
         )`
      );

      const retentionQ = pool.query(
        `WITH first_seen AS (
           SELECT a.user_id, MIN(a.active_date) AS cohort_date
           FROM user_activity_days a
           WHERE NOT EXISTS (
             SELECT 1
             FROM excluded_analytics_users x
             WHERE x.user_id = a.user_id
           )
           GROUP BY a.user_id
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

      const [
        users,
        today,
        tier,
        subscriptions,
        retention,
      ] = await Promise.all([
        usersQ,
        todayQ,
        tierQ,
        subscriptionsQ,
        retentionQ,
      ]);

      return res.json({
        success: true,
        timezone: tz,
        users: users.rows[0],
        today: today.rows[0],
        todayByTier: tier.rows[0],
        subscriptions: subscriptions.rows[0],
        retention: retention.rows[0],
      });
    } catch (err) {
      console.error('[analytics] summary:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  return router;
}
