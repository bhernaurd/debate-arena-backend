import express from 'express';
import { CANONICAL_ACTIVITY_CTES } from './lib/analyticsIdentity.js';

const APP_TIMEZONE = 'America/Chicago';

export const ANALYTICS_ALLOWED_EVENTS = new Set([
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

  // Learn ecosystem
  'learn_hub_viewed',
  'learn_card_opened',
  'learn_item_started',
  'learn_item_completed',
  'learn_course_completed',

  // The Mirror funnel
  'mirror_questionnaire_started',
  'mirror_questionnaire_completed',
  'mirror_analysis_generation_started',
  'mirror_analysis_generated',
  'mirror_analysis_failed',
  'mirror_analysis_read_depth',
  'mirror_detail_expanded',
  'mirror_evidence_opened',
  'mirror_recommendation_tapped',
  'mirror_next_eligible_seen',
  'mirror_completed',
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

const ANALYTICS_CLIENT_PLATFORMS = new Set([
  'ios',
  'android',
]);
const MAX_CLIENT_HEADER_LENGTH = 100;

function cleanClientHeader(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().slice(0, MAX_CLIENT_HEADER_LENGTH);
  return clean || null;
}

export function analyticsClientContextFromHeaders(headers = {}) {
  const explicitPlatform = cleanClientHeader(
    headers.clientPlatform
  )?.toLowerCase() || null;
  const iosVersion = cleanClientHeader(headers.iosVersion);
  const iosBuild = cleanClientHeader(headers.iosBuild);
  const androidVersion = cleanClientHeader(headers.androidVersion);
  const androidBuild = cleanClientHeader(headers.androidBuild);

  let clientPlatform = 'unknown';
  let clientPlatformSource = 'unknown';

  if (
    explicitPlatform &&
    ANALYTICS_CLIENT_PLATFORMS.has(explicitPlatform)
  ) {
    clientPlatform = explicitPlatform;
    clientPlatformSource = 'x-client-platform';
  } else if (!explicitPlatform) {
    const hasIosHint = Boolean(iosVersion || iosBuild);
    const hasAndroidHint = Boolean(
      androidVersion || androidBuild
    );

    if (hasIosHint && !hasAndroidHint) {
      clientPlatform = 'ios';
      clientPlatformSource = 'ios-header-fallback';
    } else if (hasAndroidHint && !hasIosHint) {
      clientPlatform = 'android';
      clientPlatformSource = 'android-header-fallback';
    }
  }

  const clientVersion =
    clientPlatform === 'ios'
      ? iosVersion
      : clientPlatform === 'android'
        ? androidVersion
        : null;
  const clientBuild =
    clientPlatform === 'ios'
      ? iosBuild
      : clientPlatform === 'android'
        ? androidBuild
        : null;

  return Object.freeze({
    clientPlatform,
    clientVersion,
    clientBuild,
    clientPlatformSource,
    clientAnalyticsVersion: 'platform_v1',
  });
}

function analyticsClientContext(req) {
  return analyticsClientContextFromHeaders({
    clientPlatform: req.get('x-client-platform'),
    iosVersion: req.get('x-ios-version'),
    iosBuild: req.get('x-ios-build'),
    androidVersion: req.get('x-android-version'),
    androidBuild: req.get('x-android-build'),
  });
}


export function isEntitlementUsable(row) {
  if (!row) return false;

  const status = String(row.status || '').toLowerCase();
  const isLifetime =
    row.is_lifetime_pro === true ||
    row.product_id === 'agora_pro_lifetime';

  if (isLifetime) {
    return status === 'active' && !row.revocation_date;
  }

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
      WITH linked_account AS (
        SELECT ai.account_id
        FROM account_installations ai
        WHERE ai.installation_id = $1
          AND ai.unlinked_at IS NULL
        ORDER BY
          ai.updated_at DESC,
          ai.linked_at DESC
        LIMIT 1
      ),
      entitlement_candidates AS (
        SELECT
          se.status,
          se.is_trial,
          se.product_id,
          se.environment,
          se.expires_date,
          se.grace_period_expires_date,
          se.revocation_date,
          se.auto_renew_enabled,
          se.pro_access_source,
          se.is_recurring_pro,
          se.is_lifetime_pro,
          COALESCE(se.pricing_cohort, 'unknown')
            AS pricing_cohort,
          'app_store'::text AS subscription_store,
          se.updated_at
        FROM subscription_entitlements se
        WHERE se.user_id = $1
           OR EXISTS (
             SELECT 1
             FROM subscription_installation_links link
             WHERE link.original_transaction_id =
                   se.original_transaction_id
               AND link.environment = se.environment
               AND link.user_id = $1
           )

        UNION ALL

        SELECT
          gp.normalized_status AS status,
          gp.is_trial,
          gp.product_id,
          CASE
            WHEN gp.test_purchase = true
              THEN 'Test'
            ELSE 'Production'
          END AS environment,
          gp.expires_date,
          CASE
            WHEN gp.normalized_status = 'grace_period'
              THEN gp.expires_date
            ELSE NULL::timestamptz
          END AS grace_period_expires_date,
          NULL::timestamptz AS revocation_date,
          gp.auto_renew_enabled,
          'google_play'::text AS pro_access_source,
          TRUE AS is_recurring_pro,
          FALSE AS is_lifetime_pro,
          COALESCE(gp.pricing_cohort, 'unknown')
            AS pricing_cohort,
          'google_play'::text AS subscription_store,
          gp.updated_at
        FROM google_play_subscription_entitlements gp
        INNER JOIN linked_account account
          ON account.account_id = gp.account_id
      )
      SELECT
        status,
        is_trial,
        product_id,
        environment,
        expires_date,
        grace_period_expires_date,
        revocation_date,
        auto_renew_enabled,
        pro_access_source,
        is_recurring_pro,
        is_lifetime_pro,
        pricing_cohort,
        subscription_store
      FROM entitlement_candidates
      ORDER BY
        CASE
          WHEN is_lifetime_pro = true
            AND status = 'active'
            AND revocation_date IS NULL
            THEN 0
          WHEN status IN ('trial', 'active')
            AND expires_date > NOW()
            THEN 1
          WHEN status = 'grace_period'
            AND grace_period_expires_date > NOW()
            THEN 1
          ELSE 2
        END,
        CASE
          WHEN environment = 'Production'
            THEN 0
          ELSE 1
        END,
        updated_at DESC
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
      subscriptionStore:
        entitlement?.subscription_store || 'none',
      subscriptionAccessSource:
        entitlement?.pro_access_source || 'unknown',
      subscriptionIsRecurring:
        entitlement?.is_recurring_pro === true,
      subscriptionIsLifetime:
        entitlement?.is_lifetime_pro === true,
      subscriptionPricingCohort:
        entitlement?.pricing_cohort || 'unknown',
      subscriptionAutoRenewEnabled:
        entitlement?.auto_renew_enabled ?? null,
      revenueEligible:
        entitlement?.environment === 'Production' &&
        entitlement?.is_recurring_pro === true &&
        analyticsAccessTier === 'paid_pro',
      analyticsVersion: 'cross_platform_analytics_v2',
      pricingCohortAnalyticsVersion: 'founding_pricing_v1',
    };
  }

  async function recordEvent(
    userId,
    eventName,
    metadata,
    clientContext
  ) {
    const context = await subscriptionContext(userId);

    // Platform/build values are derived from request headers on the server.
    // Spread them last so arbitrary client metadata cannot spoof the platform.
    const enrichedMetadata = {
      ...(metadata || {}),
      ...context,
      ...(clientContext || {}),
    };

    await pool.query(
      `INSERT INTO user_events (user_id, event_name, metadata)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT DO NOTHING`,
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

      const clientContext =
        analyticsClientContext(req);

      await recordActiveDay(userId);
      await recordEvent(
        userId,
        'app_opened',
        null,
        clientContext
      );

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
        !ANALYTICS_ALLOWED_EVENTS.has(eventName)
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

      const clientContext =
        analyticsClientContext(req);

      await recordEvent(
        userId,
        eventName,
        cleanMeta,
        clientContext
      );
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
        `WITH t AS (
           SELECT (now() AT TIME ZONE $1)::date AS today
         ),
         ${CANONICAL_ACTIVITY_CTES}
         SELECT
           COUNT(DISTINCT activity.analytics_user_key) AS total_users,
           COUNT(DISTINCT activity.analytics_user_key)
             FILTER (WHERE activity.active_date = t.today) AS dau,
           COUNT(DISTINCT activity.analytics_user_key)
             FILTER (WHERE activity.active_date >= t.today - 6) AS wau,
           COUNT(DISTINCT activity.analytics_user_key)
             FILTER (WHERE activity.active_date >= t.today - 29) AS mau
         FROM canonical_activity activity
         CROSS JOIN t`,
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
        `WITH
         ${CANONICAL_ACTIVITY_CTES},
         ranked AS (
           SELECT
             COALESCE(
               'account:' || ia.account_id::text,
               'installation:' || e.user_id
             ) AS analytics_user_key,
             COALESCE(
               e.metadata->>'analyticsAccessTier',
               'legacy_unknown'
             ) AS tier,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(
                 'account:' || ia.account_id::text,
                 'installation:' || e.user_id
               )
               ORDER BY e.created_at DESC
             ) AS rn
           FROM user_events e
           LEFT JOIN installation_accounts ia
             ON ia.installation_id = e.user_id
           WHERE (e.created_at AT TIME ZONE $1)::date =
                 (now() AT TIME ZONE $1)::date
             AND NOT EXISTS (
               SELECT 1
               FROM excluded_analytics_users x
               WHERE x.user_id = e.user_id
             )
             AND (
               ia.account_id IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM excluded_accounts ea
                 WHERE ea.account_id = ia.account_id
               )
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

      const platformUsersQ = pool.query(
        `WITH t AS (
           SELECT (now() AT TIME ZONE $1)::date AS today
         ),
         installation_accounts AS (
           SELECT DISTINCT ON (installation_id)
             installation_id,
             account_id
           FROM account_installations
           ORDER BY
             installation_id,
             (unlinked_at IS NULL) DESC,
             updated_at DESC,
             linked_at DESC
         ),
         excluded_accounts AS (
           SELECT DISTINCT ia.account_id
           FROM excluded_analytics_users excluded
           JOIN installation_accounts ia
             ON ia.installation_id = excluded.user_id
           WHERE ia.account_id IS NOT NULL
         ),
         platform_activity AS (
           SELECT DISTINCT
             COALESCE(
               'account:' || ia.account_id::text,
               'installation:' || e.user_id
             ) AS analytics_user_key,
             e.metadata->>'clientPlatform' AS platform,
             (e.created_at AT TIME ZONE $1)::date AS active_date
           FROM user_events e
           LEFT JOIN installation_accounts ia
             ON ia.installation_id = e.user_id
           WHERE e.metadata->>'clientPlatform' IN ('ios', 'android')
             AND NOT EXISTS (
               SELECT 1
               FROM excluded_analytics_users x
               WHERE x.user_id = e.user_id
             )
             AND (
               ia.account_id IS NULL
               OR NOT EXISTS (
                 SELECT 1
                 FROM excluded_accounts ea
                 WHERE ea.account_id = ia.account_id
               )
             )
         )
         SELECT
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'ios'
                 AND active_date = t.today
             ) AS ios_dau,
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'ios'
                 AND active_date >= t.today - 6
             ) AS ios_wau,
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'ios'
                 AND active_date >= t.today - 29
             ) AS ios_mau,
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'android'
                 AND active_date = t.today
             ) AS android_dau,
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'android'
                 AND active_date >= t.today - 6
             ) AS android_wau,
           COUNT(DISTINCT analytics_user_key)
             FILTER (
               WHERE platform = 'android'
                 AND active_date >= t.today - 29
             ) AS android_mau
         FROM platform_activity
         CROSS JOIN t`,
        [tz]
      );

      const todayByPlatformQ = pool.query(
        `SELECT
           COALESCE(
             NULLIF(metadata->>'clientPlatform', ''),
             'unknown'
           ) AS platform,
           COUNT(*) FILTER (
             WHERE event_name = 'app_opened'
           ) AS app_opens,
           COUNT(DISTINCT COALESCE(
             NULLIF(metadata->>'debateId', ''),
             id::text
           )) FILTER (
             WHERE event_name = 'debate_started'
           ) AS debate_starts,
           COUNT(DISTINCT COALESCE(
             NULLIF(metadata->>'debateId', ''),
             id::text
           )) FILTER (
             WHERE event_name = 'debate_completed'
           ) AS debate_completions,
           COUNT(*) FILTER (
             WHERE event_name = 'daily_challenge_completed'
           ) AS daily_challenge_completions,
           COUNT(*) FILTER (
             WHERE event_name = 'paywall_viewed'
           ) AS paywall_views,
           COUNT(*) FILTER (
             WHERE event_name = 'purchase_completed'
           ) AS purchases_completed
         FROM user_events e
         WHERE (e.created_at AT TIME ZONE $1)::date =
               (now() AT TIME ZONE $1)::date
           AND NOT EXISTS (
             SELECT 1
             FROM excluded_analytics_users x
             WHERE x.user_id = e.user_id
           )
         GROUP BY 1
         ORDER BY 1`,
        [tz]
      );

      const subscriptionsQ = pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status IN ('trial', 'grace_period')
               AND is_trial = true
               AND is_recurring_pro = true
               AND (
                 (status = 'trial' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_trials,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND is_recurring_pro = true
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_paid_subscribers,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND is_lifetime_pro = true
               AND status = 'active'
               AND revocation_date IS NULL
           ) AS active_lifetime_pro,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND (
                 (
                   is_lifetime_pro = true
                   AND status = 'active'
                   AND revocation_date IS NULL
                 ) OR (
                   is_recurring_pro = true
                   AND status IN ('trial', 'active', 'grace_period')
                   AND (
                     (status IN ('trial', 'active') AND expires_date > NOW()) OR
                     (status = 'grace_period' AND grace_period_expires_date > NOW())
                   )
                 )
               )
           ) AS active_pro_access,
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
               AND COALESCE(pricing_cohort, 'unknown') = 'founding_2026'
               AND status IN ('trial', 'grace_period')
               AND is_trial = true
               AND is_recurring_pro = true
               AND (
                 (status = 'trial' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_founding_trials,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'founding_2026'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND is_recurring_pro = true
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_founding_paid_subscribers,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'founding_2026'
               AND product_id = 'agora_pro_monthly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS founding_paid_monthly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'founding_2026'
               AND product_id = 'agora_pro_yearly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS founding_paid_yearly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'standard'
               AND status IN ('trial', 'grace_period')
               AND is_trial = true
               AND is_recurring_pro = true
               AND (
                 (status = 'trial' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_standard_trials,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'standard'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND is_recurring_pro = true
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_standard_paid_subscribers,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'standard'
               AND product_id = 'agora_pro_monthly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS standard_paid_monthly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'standard'
               AND product_id = 'agora_pro_yearly'
               AND status IN ('active', 'grace_period')
               AND is_trial = false
               AND (
                 (status = 'active' AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS standard_paid_yearly,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND COALESCE(pricing_cohort, 'unknown') = 'unknown'
               AND is_recurring_pro = true
               AND status IN ('active', 'trial', 'grace_period')
               AND (
                 (status IN ('trial', 'active') AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_unknown_cohort,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND is_recurring_pro = true
               AND status IN ('active', 'trial', 'grace_period')
               AND auto_renew_enabled = false
               AND (
                 (status IN ('trial', 'active') AND expires_date > NOW()) OR
                 (status = 'grace_period' AND grace_period_expires_date > NOW())
               )
           ) AS active_auto_renew_off,
           COUNT(*) FILTER (
             WHERE environment = 'Production'
               AND is_recurring_pro = true
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

      const googlePlaySubscriptionsQ = pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND is_trial = true
               AND normalized_status IN (
                 'trial',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_trials,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND is_trial = false
               AND normalized_status IN (
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_paid_subscribers,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND normalized_status IN (
                 'trial',
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_pro_access,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND product_id = 'agora_pro_monthly'
               AND is_trial = false
               AND normalized_status IN (
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS paid_monthly,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND product_id = 'agora_pro_yearly'
               AND is_trial = false
               AND normalized_status IN (
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS paid_yearly,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND COALESCE(pricing_cohort, 'unknown') =
                   'founding_2026'
               AND is_trial = true
               AND normalized_status IN (
                 'trial',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_founding_trials,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND COALESCE(pricing_cohort, 'unknown') =
                   'founding_2026'
               AND is_trial = false
               AND normalized_status IN (
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_founding_paid_subscribers,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND COALESCE(pricing_cohort, 'unknown') =
                   'standard'
               AND is_trial = true
               AND normalized_status IN (
                 'trial',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_standard_trials,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND COALESCE(pricing_cohort, 'unknown') =
                   'standard'
               AND is_trial = false
               AND normalized_status IN (
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_standard_paid_subscribers,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND COALESCE(pricing_cohort, 'unknown') =
                   'unknown'
               AND normalized_status IN (
                 'trial',
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_unknown_cohort,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND normalized_status IN (
                 'trial',
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
               AND auto_renew_enabled = false
           ) AS active_auto_renew_off,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND normalized_status = 'on_hold'
           ) AS on_hold_subscriptions,
           COUNT(*) FILTER (
             WHERE test_purchase = false
               AND normalized_status = 'paused'
           ) AS paused_subscriptions,
           COUNT(*) FILTER (
             WHERE test_purchase = true
               AND normalized_status IN (
                 'trial',
                 'active',
                 'grace_period'
               )
               AND expires_date > NOW()
           ) AS active_test_purchases
         FROM google_play_subscription_entitlements gp
         WHERE NOT EXISTS (
           SELECT 1
           FROM account_installations ai
           INNER JOIN excluded_analytics_users x
             ON x.user_id = ai.installation_id
           WHERE ai.account_id = gp.account_id
         )`
      );

      const retentionQ = pool.query(
        `WITH
         ${CANONICAL_ACTIVITY_CTES},
         first_seen AS (
           SELECT
             analytics_user_key,
             MIN(active_date) AS cohort_date
           FROM canonical_activity
           GROUP BY analytics_user_key
         ),
         spans AS (
           SELECT
             fs.analytics_user_key,
             (activity.active_date - fs.cohort_date) AS day_n
           FROM first_seen fs
           JOIN canonical_activity activity
             ON activity.analytics_user_key = fs.analytics_user_key
         )
         SELECT
           COUNT(DISTINCT analytics_user_key) AS cohort_size,
           ROUND(
             COUNT(DISTINCT analytics_user_key)
               FILTER (WHERE day_n >= 1)::numeric
             / NULLIF(COUNT(DISTINCT analytics_user_key), 0),
             3
           ) AS d1_plus,
           ROUND(
             COUNT(DISTINCT analytics_user_key)
               FILTER (WHERE day_n >= 7)::numeric
             / NULLIF(COUNT(DISTINCT analytics_user_key), 0),
             3
           ) AS d7_plus,
           ROUND(
             COUNT(DISTINCT analytics_user_key)
               FILTER (WHERE day_n >= 30)::numeric
             / NULLIF(COUNT(DISTINCT analytics_user_key), 0),
             3
           ) AS d30_plus
         FROM spans`
      );

      const [
        users,
        today,
        tier,
        platformUsers,
        todayByPlatform,
        subscriptions,
        googlePlaySubscriptions,
        retention,
      ] = await Promise.all([
        usersQ,
        todayQ,
        tierQ,
        platformUsersQ,
        todayByPlatformQ,
        subscriptionsQ,
        googlePlaySubscriptionsQ,
        retentionQ,
      ]);

      const platformRows = Object.fromEntries(
        todayByPlatform.rows.map((row) => [
          row.platform,
          row,
        ])
      );

      return res.json({
        success: true,
        timezone: tz,
        users: users.rows[0],
        platformUsers: platformUsers.rows[0],
        today: today.rows[0],
        todayByPlatform: platformRows,
        todayByTier: tier.rows[0],
        subscriptions: subscriptions.rows[0],
        subscriptionsByStore: {
          appStore: subscriptions.rows[0],
          googlePlay: googlePlaySubscriptions.rows[0],
        },
        retention: retention.rows[0],
      });
    } catch (err) {
      console.error('[analytics] summary:', err.message);
      return res.status(500).json({ success: false });
    }
  });

  return router;
}
