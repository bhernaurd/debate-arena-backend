function toNumber(value) {
  return Number(value || 0);
}

function formatSeconds(value) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}s` : '—';
}

function formatMoney(value) {
  const number = Number(value || 0);
  return `$${number.toFixed(2)}`;
}

function percent(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—';
}

function tierLabel(tier) {
  switch (tier) {
    case 'free': return 'Free';
    case 'trial': return 'Trial';
    case 'paid_pro': return 'Paid Pro';
    case 'legacy_pro': return 'Legacy client-reported Pro';
    default: return 'Unknown/legacy';
  }
}

function performanceLine(row) {
  return `<b>${tierLabel(row.tier)}:</b> n=${toNumber(row.completed_count)}, avg ${formatSeconds(row.avg_seconds)}, p50 ${formatSeconds(row.p50_seconds)}, p95 ${formatSeconds(row.p95_seconds)}, fastest/slowest ${formatSeconds(row.fastest_seconds)} / ${formatSeconds(row.slowest_seconds)}, failed ${toNumber(row.failed_count)}`;
}

export async function buildDailyBusinessAnalytics(client) {
  const tierResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    ),
    ranked AS (
      SELECT
        e.user_id,
        CASE
          WHEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        ROW_NUMBER() OVER (PARTITION BY e.user_id ORDER BY e.created_at DESC) AS rn
      FROM user_events e
      CROSS JOIN bounds
      WHERE e.created_at >= bounds.start_time
        AND e.created_at < bounds.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    ),
    active_counts AS (
      SELECT tier, COUNT(*) AS active_users
      FROM ranked
      WHERE rn = 1
      GROUP BY tier
    ),
    event_counts AS (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        COUNT(DISTINCT COALESCE(NULLIF(e.metadata->>'debateId', ''), e.id::text)) FILTER (
          WHERE e.event_name = 'debate_completed'
        ) AS debate_completions,
        COUNT(*) FILTER (WHERE e.event_name = 'report_generation_completed') AS reports_completed,
        COUNT(*) FILTER (WHERE e.event_name = 'report_generation_failed') AS reports_failed
      FROM user_events e
      CROSS JOIN bounds
      WHERE e.created_at >= bounds.start_time
        AND e.created_at < bounds.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
      GROUP BY 1
    )
    SELECT
      COALESCE(a.tier, ec.tier) AS tier,
      COALESCE(a.active_users, 0) AS active_users,
      COALESCE(ec.debate_completions, 0) AS debate_completions,
      COALESCE(ec.reports_completed, 0) AS reports_completed,
      COALESCE(ec.reports_failed, 0) AS reports_failed
    FROM active_counts a
    FULL OUTER JOIN event_counts ec ON ec.tier = a.tier
    ORDER BY tier;
  `);

  const paywallResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    ),
    events AS (
      SELECT e.*
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    ),
    started_sessions AS (
      SELECT DISTINCT NULLIF(BTRIM(metadata->>'paywallSessionId'), '') AS session_id
      FROM events
      WHERE event_name = 'purchase_started'
        AND NULLIF(BTRIM(metadata->>'paywallSessionId'), '') IS NOT NULL
    ),
    completed_sessions AS (
      SELECT DISTINCT NULLIF(BTRIM(metadata->>'paywallSessionId'), '') AS session_id
      FROM events
      WHERE event_name = 'purchase_completed'
        AND NULLIF(BTRIM(metadata->>'paywallSessionId'), '') IS NOT NULL
    )
    SELECT
      COUNT(*) FILTER (WHERE event_name = 'paywall_viewed') AS paywall_views,
      COUNT(DISTINCT user_id) FILTER (WHERE event_name = 'paywall_viewed') AS unique_paywall_viewers,
      COUNT(*) FILTER (WHERE event_name = 'paywall_plan_selected') AS plan_selections,
      COUNT(*) FILTER (WHERE event_name = 'purchase_started') AS purchase_starts,
      COUNT(*) FILTER (WHERE event_name = 'purchase_completed') AS purchase_completions,
      COUNT(*) FILTER (WHERE event_name = 'purchase_cancelled') AS purchase_cancellations,
      COUNT(*) FILTER (WHERE event_name = 'purchase_pending') AS purchase_pending,
      COUNT(*) FILTER (WHERE event_name = 'purchase_failed') AS purchase_failures,
      COUNT(*) FILTER (WHERE event_name = 'restore_started') AS restore_starts,
      COUNT(*) FILTER (
        WHERE event_name = 'restore_completed'
          AND metadata->>'activeSubscriptionFound' = 'true'
      ) AS successful_restores,
      (SELECT COUNT(*) FROM started_sessions) AS purchase_start_sessions,
      (SELECT COUNT(*) FROM completed_sessions) AS purchase_completed_sessions,
      (
        SELECT COUNT(*)
        FROM started_sessions s
        WHERE EXISTS (
          SELECT 1
          FROM completed_sessions c
          WHERE c.session_id = s.session_id
        )
      ) AS completed_started_sessions
    FROM events;
  `);

  const subscriptionResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    ),
    current_snapshot AS (
      SELECT
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
        ) AS active_paid,
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
            AND status IN ('trial', 'active', 'grace_period')
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
      )
    ),
    first_paid AS (
      SELECT t.original_transaction_id, MIN(t.purchase_date) AS first_paid_date
      FROM app_store_transactions t
      WHERE t.environment = 'Production'
        AND t.is_trial = false
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
        )
      GROUP BY t.original_transaction_id
    ),
    period AS (
      SELECT
        (
          SELECT COUNT(DISTINCT t.original_transaction_id)
          FROM app_store_transactions t
          CROSS JOIN bounds b
          WHERE t.environment = 'Production'
            AND t.is_trial = true
            AND t.purchase_date >= b.start_time
            AND t.purchase_date < b.end_time
            AND NOT EXISTS (
              SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
            )
        ) AS trial_starts,
        (
          SELECT COUNT(DISTINCT fp.original_transaction_id)
          FROM first_paid fp
          CROSS JOIN bounds b
          WHERE fp.first_paid_date >= b.start_time
            AND fp.first_paid_date < b.end_time
        ) AS first_paid_starts,
        (
          SELECT COUNT(DISTINCT fp.original_transaction_id)
          FROM first_paid fp
          CROSS JOIN bounds b
          WHERE fp.first_paid_date >= b.start_time
            AND fp.first_paid_date < b.end_time
            AND EXISTS (
              SELECT 1 FROM app_store_transactions prior
              WHERE prior.original_transaction_id = fp.original_transaction_id
                AND prior.environment = 'Production'
                AND prior.is_trial = true
                AND prior.purchase_date < fp.first_paid_date
            )
        ) AS trial_conversions
    ),
    event_period AS (
      SELECT
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_CHANGE_RENEWAL_STATUS'
            AND subtype = 'AUTO_RENEW_DISABLED'
        ) AS cancellations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND status_after = 'expired'
        ) AS expirations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND status_after = 'revoked'
        ) AS refunds_or_revocations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_RENEW'
        ) AS renewals,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND status_after = 'billing_retry'
        ) AS billing_retry_entries,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_RENEW'
            AND subtype = 'BILLING_RECOVERY'
        ) AS billing_recoveries
      FROM subscription_events e
      CROSS JOIN bounds b
      WHERE e.event_at >= b.start_time
        AND e.event_at < b.end_time
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = e.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = e.original_transaction_id
                 AND link.environment = e.environment
                 AND link.user_id = x.user_id
             )
        )
    )
    SELECT
      cs.*,
      p.trial_starts,
      p.first_paid_starts,
      p.trial_conversions,
      ep.cancellations,
      ep.expirations,
      ep.refunds_or_revocations,
      ep.renewals,
      ep.billing_retry_entries,
      ep.billing_recoveries,
      ROUND((cs.paid_monthly * 7.99 + cs.paid_yearly * (49.99 / 12.0))::numeric, 2) AS estimated_gross_mrr
    FROM current_snapshot cs
    CROSS JOIN period p
    CROSS JOIN event_period ep;
  `);

  const reportPerformanceResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    ),
    jobs AS (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        status,
        EXTRACT(EPOCH FROM (completed_at - processing_started_at)) AS seconds
      FROM ai_generation_jobs j
      CROSS JOIN bounds b
      WHERE j.job_type = 'debate_report'
        AND COALESCE(j.completed_at, j.failed_at, j.created_at) >= b.start_time
        AND COALESCE(j.completed_at, j.failed_at, j.created_at) < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = j.user_id
        )
    )
    SELECT
      tier,
      COUNT(*) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL) AS completed_count,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      ROUND((AVG(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS avg_seconds,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS p50_seconds,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS p95_seconds,
      ROUND((MIN(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS fastest_seconds,
      ROUND((MAX(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS slowest_seconds
    FROM jobs
    GROUP BY tier
    ORDER BY tier;
  `);

  const clientReportPerformanceResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    ),
    ranked_events AS (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        e.event_name,
        CASE
          WHEN e.metadata->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (e.metadata->>'durationMs')::numeric / 1000.0
          ELSE NULL
        END AS seconds,
        ROW_NUMBER() OVER (
          PARTITION BY
            e.user_id,
            COALESCE(NULLIF(BTRIM(e.metadata->>'debateId'), ''), e.id::text),
            e.event_name
          ORDER BY e.created_at DESC, e.id DESC
        ) AS rn
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND e.event_name IN (
          'report_generation_completed',
          'report_generation_failed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    ),
    events AS (
      SELECT tier, event_name, seconds
      FROM ranked_events
      WHERE rn = 1
    )
    SELECT
      tier,
      COUNT(*) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ) AS completed_count,
      COUNT(*) FILTER (
        WHERE event_name = 'report_generation_failed'
      ) AS failed_count,
      ROUND((AVG(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS avg_seconds,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS p50_seconds,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS p95_seconds,
      ROUND((MIN(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS fastest_seconds,
      ROUND((MAX(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS slowest_seconds
    FROM events
    GROUP BY tier
    ORDER BY tier;
  `);

  const insightResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    )
    SELECT
      COUNT(*) AS created,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS still_pending
    FROM ai_generation_jobs j
    CROSS JOIN bounds b
    WHERE j.job_type = 'debate_report_insight'
      AND j.created_at >= b.start_time
      AND j.created_at < b.end_time
      AND NOT EXISTS (
        SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = j.user_id
      );
  `);

  const progressiveResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    )
    SELECT
      COUNT(*) FILTER (WHERE event_name = 'report_progressive_started') AS progressive_started,
      COUNT(*) FILTER (WHERE event_name = 'report_progressive_insight_visible') AS insight_visible,
      COUNT(*) FILTER (WHERE event_name = 'report_full_content_visible') AS full_content_visible,
      ROUND(AVG((metadata->>'elapsedMs')::numeric / 1000.0) FILTER (
        WHERE event_name = 'report_progressive_started'
          AND metadata->>'elapsedMs' ~ '^[0-9]+(\\.[0-9]+)?$'
      ), 2) AS avg_seconds_to_progressive,
      ROUND(AVG((metadata->>'elapsedMs')::numeric / 1000.0) FILTER (
        WHERE event_name = 'report_full_content_visible'
          AND metadata->>'elapsedMs' ~ '^[0-9]+(\\.[0-9]+)?$'
          AND metadata->>'source' = 'generated_report'
      ), 2) AS avg_seconds_to_full
    FROM user_events e
    CROSS JOIN bounds b
    WHERE e.created_at >= b.start_time
      AND e.created_at < b.end_time
      AND NOT EXISTS (
        SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
      );
  `);

  const qualityResult = await client.query(`
    WITH bounds AS (
      SELECT
        (((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS start_time,
        (((NOW() AT TIME ZONE 'America/Chicago')::date)::timestamp AT TIME ZONE 'America/Chicago') AS end_time
    )
    SELECT
      COUNT(*) AS total_events,
      COUNT(*) FILTER (WHERE metadata ? 'analyticsAccessTier') AS tier_stamped_events,
      COUNT(*) FILTER (
        WHERE event_name IN (
          'debate_started',
          'debate_completed',
          'report_generation_started',
          'report_generation_completed',
          'report_generation_failed'
        )
          AND NULLIF(BTRIM(metadata->>'debateId'), '') IS NULL
      ) AS critical_lifecycle_events_missing_debate_id,
      COUNT(*) FILTER (
        WHERE event_name IN ('report_viewed', 'share_card_created')
          AND NULLIF(BTRIM(metadata->>'debateId'), '') IS NULL
      ) AS legacy_report_actions_missing_debate_id,
      COUNT(*) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND COALESCE(metadata->>'durationMs', '') !~ '^[0-9]+(\\.[0-9]+)?$'
      ) AS completed_reports_missing_duration
    FROM user_events e
    CROSS JOIN bounds b
    WHERE e.created_at >= b.start_time
      AND e.created_at < b.end_time
      AND NOT EXISTS (
        SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
      );
  `);

  const tiers = new Map(tierResult.rows.map((row) => [row.tier, row]));
  const paywall = paywallResult.rows[0] || {};
  const subscriptions = subscriptionResult.rows[0] || {};
  const insights = insightResult.rows[0] || {};
  const progressive = progressiveResult.rows[0] || {};
  const quality = qualityResult.rows[0] || {};

  const tierLines = ['free', 'trial', 'paid_pro', 'legacy_pro', 'legacy_unknown']
    .filter((tier) => tiers.has(tier))
    .map((tier) => {
      const row = tiers.get(tier);
      return `<b>${tierLabel(tier)}:</b> ${toNumber(row.active_users)} active, ${toNumber(row.debate_completions)} debate completions, ${toNumber(row.reports_completed)} reports completed, ${toNumber(row.reports_failed)} report failures`;
    });

  const performanceLines = reportPerformanceResult.rows.length > 0
    ? reportPerformanceResult.rows.map(performanceLine)
    : ['No backend report jobs completed in this period.'];

  const clientPerformanceLines = clientReportPerformanceResult.rows.length > 0
    ? clientReportPerformanceResult.rows.map(performanceLine)
    : ['No end-to-end client report timing was recorded in this period.'];

  return [
    `💼 <b>The Agora Business & Pro Analytics</b>`,
    ``,
    `<b>Free vs Pro Activity</b>`,
    ...(tierLines.length > 0 ? tierLines : ['No tier-stamped activity yet.']),
    ``,
    `<b>Subscription Snapshot — Production only</b>`,
    `<b>Active paid subscribers:</b> ${toNumber(subscriptions.active_paid)} (${toNumber(subscriptions.paid_monthly)} monthly / ${toNumber(subscriptions.paid_yearly)} yearly)`,
    `<b>Active 7-day trials:</b> ${toNumber(subscriptions.active_trials)}`,
    `<b>Active but auto-renew off:</b> ${toNumber(subscriptions.active_auto_renew_off)}`,
    `<b>Currently in billing retry:</b> ${toNumber(subscriptions.billing_retry_subscriptions)}`,
    `<b>Estimated gross MRR:</b> ${formatMoney(subscriptions.estimated_gross_mrr)} before Apple fees, taxes, refunds, and FX`,
    `<b>Yesterday:</b> ${toNumber(subscriptions.trial_starts)} trial starts, ${toNumber(subscriptions.first_paid_starts)} first paid starts, ${toNumber(subscriptions.trial_conversions)} trial conversions`,
    `<b>Renewals / billing retry / recoveries:</b> ${toNumber(subscriptions.renewals)} / ${toNumber(subscriptions.billing_retry_entries)} / ${toNumber(subscriptions.billing_recoveries)}`,
    `<b>Cancellations / expirations / refunds:</b> ${toNumber(subscriptions.cancellations)} / ${toNumber(subscriptions.expirations)} / ${toNumber(subscriptions.refunds_or_revocations)}`,
    ``,
    `<b>Paywall Funnel</b>`,
    `<b>Views:</b> ${toNumber(paywall.paywall_views)} (${toNumber(paywall.unique_paywall_viewers)} users)`,
    `<b>Plan selections:</b> ${toNumber(paywall.plan_selections)}`,
    `<b>Raw purchase start/completion events:</b> ${toNumber(paywall.purchase_starts)} / ${toNumber(paywall.purchase_completions)}`,
    `<b>Session-linked purchase completion:</b> ${toNumber(paywall.completed_started_sessions)} of ${toNumber(paywall.purchase_start_sessions)} started sessions (${percent(paywall.completed_started_sessions, paywall.purchase_start_sessions)})`,
    `<b>Completed sessions observed:</b> ${toNumber(paywall.purchase_completed_sessions)}`,
    `<b>Cancelled / pending / failed:</b> ${toNumber(paywall.purchase_cancellations)} / ${toNumber(paywall.purchase_pending)} / ${toNumber(paywall.purchase_failures)}`,
    `<b>Successful restores:</b> ${toNumber(paywall.successful_restores)} of ${toNumber(paywall.restore_starts)} attempts`,
    ``,
    `<b>End-to-End Report Wait by Tier</b>`,
    ...clientPerformanceLines,
    ``,
    `<b>Backend Report Generation by Tier</b>`,
    ...performanceLines,
    ``,
    `<b>Progressive Pro Report UX</b>`,
    `<b>Progressive screens:</b> ${toNumber(progressive.progressive_started)}`,
    `<b>Insight packets visibly available:</b> ${toNumber(progressive.insight_visible)}`,
    `<b>Full reports visibly loaded:</b> ${toNumber(progressive.full_content_visible)}`,
    `<b>Average time to progressive / full:</b> ${formatSeconds(progressive.avg_seconds_to_progressive)} / ${formatSeconds(progressive.avg_seconds_to_full)}`,
    `<b>Insight jobs created/completed/failed/pending:</b> ${toNumber(insights.created)} / ${toNumber(insights.completed)} / ${toNumber(insights.failed)} / ${toNumber(insights.still_pending)}`,
    ``,
    `<b>Analytics Data Quality</b>`,
    `<b>Tier-stamped events:</b> ${toNumber(quality.tier_stamped_events)} / ${toNumber(quality.total_events)}`,
    `<b>Critical lifecycle events missing debateId:</b> ${toNumber(quality.critical_lifecycle_events_missing_debate_id)}`,
    `<b>Legacy report views/shares missing debateId:</b> ${toNumber(quality.legacy_report_actions_missing_debate_id)}`,
    `<b>Completed reports missing duration:</b> ${toNumber(quality.completed_reports_missing_duration)}`,
  ].join('\n');
}

export async function buildMonthlyBusinessAnalytics(client, reportMonthOverride = null) {
  const result = await client.query(`
    WITH runtime AS (
      SELECT CASE
        WHEN $1::text IS NOT NULL THEN ($1::text || '-01')::date
        ELSE (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 month')::date
      END AS month_start
    ),
    bounds AS (
      SELECT
        month_start,
        (month_start + INTERVAL '1 month')::date AS month_end,
        month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
        (month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
      FROM runtime
    ),
    latest_tier AS (
      SELECT DISTINCT ON (e.user_id)
        e.user_id,
        CASE
          WHEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
      ORDER BY e.user_id, e.created_at DESC
    ),
    tier_summary AS (
      SELECT
        COUNT(*) FILTER (WHERE tier = 'free') AS free_mau,
        COUNT(*) FILTER (WHERE tier = 'trial') AS trial_mau,
        COUNT(*) FILTER (WHERE tier = 'paid_pro') AS paid_pro_mau,
        COUNT(*) FILTER (WHERE tier IN ('legacy_pro', 'legacy_unknown')) AS legacy_unknown_mau
      FROM latest_tier
    ),
    paywall_events AS (
      SELECT e.*
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    ),
    paywall_started_sessions AS (
      SELECT DISTINCT NULLIF(BTRIM(metadata->>'paywallSessionId'), '') AS session_id
      FROM paywall_events
      WHERE event_name = 'purchase_started'
        AND NULLIF(BTRIM(metadata->>'paywallSessionId'), '') IS NOT NULL
    ),
    paywall_completed_sessions AS (
      SELECT DISTINCT NULLIF(BTRIM(metadata->>'paywallSessionId'), '') AS session_id
      FROM paywall_events
      WHERE event_name = 'purchase_completed'
        AND NULLIF(BTRIM(metadata->>'paywallSessionId'), '') IS NOT NULL
    ),
    paywall AS (
      SELECT
        COUNT(*) FILTER (WHERE event_name = 'paywall_viewed') AS paywall_views,
        COUNT(DISTINCT user_id) FILTER (WHERE event_name = 'paywall_viewed') AS unique_viewers,
        COUNT(*) FILTER (WHERE event_name = 'purchase_started') AS purchase_starts,
        COUNT(*) FILTER (WHERE event_name = 'purchase_completed') AS purchase_completions,
        COUNT(*) FILTER (WHERE event_name = 'purchase_cancelled') AS purchase_cancellations,
        COUNT(*) FILTER (WHERE event_name = 'purchase_failed') AS purchase_failures,
        (SELECT COUNT(*) FROM paywall_started_sessions) AS purchase_start_sessions,
        (SELECT COUNT(*) FROM paywall_completed_sessions) AS purchase_completed_sessions,
        (
          SELECT COUNT(*)
          FROM paywall_started_sessions s
          WHERE EXISTS (
            SELECT 1
            FROM paywall_completed_sessions c
            WHERE c.session_id = s.session_id
          )
        ) AS completed_started_sessions
      FROM paywall_events
    ),
    first_paid AS (
      SELECT t.original_transaction_id, MIN(t.purchase_date) AS first_paid_date
      FROM app_store_transactions t
      WHERE t.environment = 'Production'
        AND t.is_trial = false
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
        )
      GROUP BY t.original_transaction_id
    ),
    first_trial AS (
      SELECT t.original_transaction_id, MIN(t.purchase_date) AS first_trial_date
      FROM app_store_transactions t
      WHERE t.environment = 'Production'
        AND t.is_trial = true
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
        )
      GROUP BY t.original_transaction_id
    ),
    latest_at_end AS (
      SELECT DISTINCT ON (t.original_transaction_id)
        t.*
      FROM app_store_transactions t
      CROSS JOIN bounds b
      WHERE t.environment = 'Production'
        AND t.purchase_date < b.end_time
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
        )
      ORDER BY t.original_transaction_id, t.purchase_date DESC NULLS LAST, t.signed_date DESC NULLS LAST, t.updated_at DESC
    ),
    latest_at_start AS (
      SELECT DISTINCT ON (t.original_transaction_id)
        t.*
      FROM app_store_transactions t
      CROSS JOIN bounds b
      WHERE t.environment = 'Production'
        AND t.purchase_date < b.start_time
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
        )
      ORDER BY t.original_transaction_id, t.purchase_date DESC NULLS LAST, t.signed_date DESC NULLS LAST, t.updated_at DESC
    ),
    paid_start_ids AS (
      SELECT las.original_transaction_id
      FROM latest_at_start las
      CROSS JOIN bounds b
      WHERE las.is_trial = false
        AND (
          las.revocation_date IS NULL OR
          las.revocation_date >= b.start_time
        )
        AND las.expires_date > b.start_time
    ),
    paid_end_ids AS (
      SELECT lae.original_transaction_id
      FROM latest_at_end lae
      CROSS JOIN bounds b
      WHERE lae.is_trial = false
        AND (
          lae.revocation_date IS NULL OR
          lae.revocation_date >= b.end_time
        )
        AND lae.expires_date > b.end_time
    ),
    subscription_summary AS (
      SELECT
        COUNT(*) FILTER (
          WHERE lae.is_trial = true
            AND (
              lae.revocation_date IS NULL OR
              lae.revocation_date >= b.end_time
            )
            AND lae.expires_date > b.end_time
        ) AS trials_at_month_end,
        COUNT(*) FILTER (
          WHERE lae.is_trial = false
            AND (
              lae.revocation_date IS NULL OR
              lae.revocation_date >= b.end_time
            )
            AND lae.expires_date > b.end_time
        ) AS paid_at_month_end,
        COUNT(*) FILTER (
          WHERE lae.product_id = 'agora_pro_monthly'
            AND lae.is_trial = false
            AND (
              lae.revocation_date IS NULL OR
              lae.revocation_date >= b.end_time
            )
            AND lae.expires_date > b.end_time
        ) AS paid_monthly_at_end,
        COUNT(*) FILTER (
          WHERE lae.product_id = 'agora_pro_yearly'
            AND lae.is_trial = false
            AND (
              lae.revocation_date IS NULL OR
              lae.revocation_date >= b.end_time
            )
            AND lae.expires_date > b.end_time
        ) AS paid_yearly_at_end,
        (SELECT COUNT(*) FROM paid_start_ids) AS paid_at_month_start
      FROM bounds b
      LEFT JOIN latest_at_end lae ON true
      GROUP BY b.start_time, b.end_time
    ),
    period_subscription AS (
      SELECT
        (
          SELECT COUNT(DISTINCT t.original_transaction_id)
          FROM app_store_transactions t
          CROSS JOIN bounds b
          WHERE t.environment = 'Production'
            AND t.is_trial = true
            AND t.purchase_date >= b.start_time
            AND t.purchase_date < b.end_time
            AND NOT EXISTS (
              SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = t.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = t.original_transaction_id
                 AND link.environment = t.environment
                 AND link.user_id = x.user_id
             )
            )
        ) AS trial_starts,
        (
          SELECT COUNT(DISTINCT fp.original_transaction_id)
          FROM first_paid fp
          CROSS JOIN bounds b
          WHERE fp.first_paid_date >= b.start_time
            AND fp.first_paid_date < b.end_time
        ) AS first_paid_starts,
        (
          SELECT COUNT(DISTINCT fp.original_transaction_id)
          FROM first_paid fp
          CROSS JOIN bounds b
          WHERE fp.first_paid_date >= b.start_time
            AND fp.first_paid_date < b.end_time
            AND EXISTS (
              SELECT 1 FROM first_trial ft
              WHERE ft.original_transaction_id = fp.original_transaction_id
                AND ft.first_trial_date < fp.first_paid_date
            )
        ) AS trial_conversions,
        (
          SELECT COUNT(*)
          FROM first_trial ft
          CROSS JOIN bounds b
          WHERE ft.first_trial_date >= b.start_time
            AND ft.first_trial_date < b.end_time
            AND ft.first_trial_date <= LEAST(
              NOW(),
              b.end_time + INTERVAL '14 days'
            ) - INTERVAL '14 days'
        ) AS matured_trial_cohort,
        (
          SELECT COUNT(*)
          FROM first_trial ft
          CROSS JOIN bounds b
          WHERE ft.first_trial_date >= b.start_time
            AND ft.first_trial_date < b.end_time
            AND ft.first_trial_date <= LEAST(
              NOW(),
              b.end_time + INTERVAL '14 days'
            ) - INTERVAL '14 days'
            AND EXISTS (
              SELECT 1
              FROM first_paid fp
              WHERE fp.original_transaction_id = ft.original_transaction_id
                AND fp.first_paid_date >= ft.first_trial_date
                AND fp.first_paid_date <= ft.first_trial_date + INTERVAL '14 days'
            )
        ) AS matured_trial_conversions
    ),
    losses AS (
      SELECT
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_CHANGE_RENEWAL_STATUS'
            AND subtype = 'AUTO_RENEW_DISABLED'
        ) AS cancellations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production' AND status_after = 'expired'
        ) AS expirations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production' AND status_after = 'revoked'
        ) AS refunds_or_revocations,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_RENEW'
        ) AS renewals,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND status_after = 'billing_retry'
        ) AS billing_retry_entries,
        COUNT(DISTINCT original_transaction_id) FILTER (
          WHERE environment = 'Production'
            AND event_type = 'DID_RENEW'
            AND subtype = 'BILLING_RECOVERY'
        ) AS billing_recoveries,
        (
          SELECT COUNT(*)
          FROM paid_start_ids psi
          WHERE NOT EXISTS (
            SELECT 1
            FROM paid_end_ids pei
            WHERE pei.original_transaction_id = psi.original_transaction_id
          )
        ) AS paid_losses
      FROM subscription_events e
      CROSS JOIN bounds b
      WHERE e.event_at >= b.start_time AND e.event_at < b.end_time
        AND NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = e.user_id
             OR EXISTS (
               SELECT 1
               FROM subscription_installation_links link
               WHERE link.original_transaction_id = e.original_transaction_id
                 AND link.environment = e.environment
                 AND link.user_id = x.user_id
             )
        )
    ),
    quality AS (
      SELECT
        COUNT(*) AS total_events,
        COUNT(*) FILTER (WHERE metadata ? 'analyticsAccessTier') AS tier_stamped,
        COUNT(*) FILTER (
          WHERE event_name IN (
            'debate_started',
            'debate_completed',
            'report_generation_started',
            'report_generation_completed',
            'report_generation_failed'
          )
            AND NULLIF(BTRIM(metadata->>'debateId'), '') IS NULL
        ) AS critical_lifecycle_events_missing_debate_id,
        COUNT(*) FILTER (
          WHERE event_name IN ('report_viewed', 'share_card_created')
            AND NULLIF(BTRIM(metadata->>'debateId'), '') IS NULL
        ) AS legacy_report_actions_missing_debate_id,
        COUNT(*) FILTER (
          WHERE event_name = 'report_generation_completed'
            AND COALESCE(metadata->>'durationMs', '') !~ '^[0-9]+(\\.[0-9]+)?$'
        ) AS completed_reports_missing_duration
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    )
    SELECT
      TO_CHAR(b.month_start, 'FMMonth YYYY') AS report_month,
      ts.*,
      p.*,
      ss.*,
      ps.*,
      l.*,
      q.*,
      ROUND((ss.paid_monthly_at_end * 7.99 + ss.paid_yearly_at_end * (49.99 / 12.0))::numeric, 2) AS estimated_gross_mrr,
      ROUND((l.paid_losses::numeric / NULLIF(ss.paid_at_month_start, 0)) * 100, 1) AS estimated_churn_percent
    FROM bounds b
    CROSS JOIN tier_summary ts
    CROSS JOIN paywall p
    CROSS JOIN subscription_summary ss
    CROSS JOIN period_subscription ps
    CROSS JOIN losses l
    CROSS JOIN quality q;
  `, [reportMonthOverride]);

  const reportPerformanceResult = await client.query(`
    WITH runtime AS (
      SELECT CASE
        WHEN $1::text IS NOT NULL THEN ($1::text || '-01')::date
        ELSE (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 month')::date
      END AS month_start
    ),
    bounds AS (
      SELECT
        month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
        (month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
      FROM runtime
    ),
    jobs AS (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        status,
        EXTRACT(EPOCH FROM (completed_at - processing_started_at)) AS seconds
      FROM ai_generation_jobs j
      CROSS JOIN bounds b
      WHERE j.job_type = 'debate_report'
        AND COALESCE(j.completed_at, j.failed_at, j.created_at) >= b.start_time
        AND COALESCE(j.completed_at, j.failed_at, j.created_at) < b.end_time
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = j.user_id
        )
    )
    SELECT
      tier,
      COUNT(*) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL) AS completed_count,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      ROUND((AVG(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS avg_seconds,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS p50_seconds,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS p95_seconds,
      ROUND((MIN(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS fastest_seconds,
      ROUND((MAX(seconds) FILTER (WHERE status = 'completed' AND seconds IS NOT NULL))::numeric, 2) AS slowest_seconds
    FROM jobs
    GROUP BY tier
    ORDER BY tier;
  `, [reportMonthOverride]);

  const clientReportPerformanceResult = await client.query(`
    WITH runtime AS (
      SELECT CASE
        WHEN $1::text IS NOT NULL THEN ($1::text || '-01')::date
        ELSE (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 month')::date
      END AS month_start
    ),
    bounds AS (
      SELECT
        month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
        (month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
      FROM runtime
    ),
    ranked_events AS (
      SELECT
        CASE
          WHEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '') IN (
            'free', 'trial', 'paid_pro', 'legacy_pro'
          )
            THEN NULLIF(BTRIM(e.metadata->>'analyticsAccessTier'), '')
          ELSE 'legacy_unknown'
        END AS tier,
        e.event_name,
        CASE
          WHEN e.metadata->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
            THEN (e.metadata->>'durationMs')::numeric / 1000.0
          ELSE NULL
        END AS seconds,
        ROW_NUMBER() OVER (
          PARTITION BY
            e.user_id,
            COALESCE(NULLIF(BTRIM(e.metadata->>'debateId'), ''), e.id::text),
            e.event_name
          ORDER BY e.created_at DESC, e.id DESC
        ) AS rn
      FROM user_events e
      CROSS JOIN bounds b
      WHERE e.created_at >= b.start_time
        AND e.created_at < b.end_time
        AND e.event_name IN (
          'report_generation_completed',
          'report_generation_failed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
        )
    ),
    events AS (
      SELECT tier, event_name, seconds
      FROM ranked_events
      WHERE rn = 1
    )
    SELECT
      tier,
      COUNT(*) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ) AS completed_count,
      COUNT(*) FILTER (
        WHERE event_name = 'report_generation_failed'
      ) AS failed_count,
      ROUND((AVG(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS avg_seconds,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS p50_seconds,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS p95_seconds,
      ROUND((MIN(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS fastest_seconds,
      ROUND((MAX(seconds) FILTER (
        WHERE event_name = 'report_generation_completed'
          AND seconds IS NOT NULL
      ))::numeric, 2) AS slowest_seconds
    FROM events
    GROUP BY tier
    ORDER BY tier;
  `, [reportMonthOverride]);

  const row = result.rows[0] || {};
  const performanceLines = reportPerformanceResult.rows.length > 0
    ? reportPerformanceResult.rows.map(performanceLine)
    : ['No backend report jobs completed in this month.'];

  const clientPerformanceLines = clientReportPerformanceResult.rows.length > 0
    ? clientReportPerformanceResult.rows.map(performanceLine)
    : ['No end-to-end client report timing was recorded in this month.'];

  return [
    `💼 <b>The Agora Monthly Business & Pro Report</b>`,
    `For: <b>${row.report_month || 'Unknown month'}</b>`,
    ``,
    `<b>Free vs Pro Monthly Activity</b>`,
    `<b>Free MAU:</b> ${toNumber(row.free_mau)}`,
    `<b>Trial MAU:</b> ${toNumber(row.trial_mau)}`,
    `<b>Paid Pro MAU:</b> ${toNumber(row.paid_pro_mau)}`,
    `<b>Legacy/unknown MAU:</b> ${toNumber(row.legacy_unknown_mau)}`,
    ``,
    `<b>Subscriber Growth — Production only</b>`,
    `<b>Paid subscribers at month end:</b> ${toNumber(row.paid_at_month_end)} (${toNumber(row.paid_monthly_at_end)} monthly / ${toNumber(row.paid_yearly_at_end)} yearly)`,
    `<b>Trials at month end:</b> ${toNumber(row.trials_at_month_end)}`,
    `<b>Trial starts / first paid starts / conversions occurring:</b> ${toNumber(row.trial_starts)} / ${toNumber(row.first_paid_starts)} / ${toNumber(row.trial_conversions)}`,
    `<b>Matured 14-day trial cohort:</b> ${toNumber(row.matured_trial_conversions)} converted / ${toNumber(row.matured_trial_cohort)} eligible (${percent(row.matured_trial_conversions, row.matured_trial_cohort)})`,
    `<b>Renewals / billing retry / recoveries:</b> ${toNumber(row.renewals)} / ${toNumber(row.billing_retry_entries)} / ${toNumber(row.billing_recoveries)}`,
    `<b>Cancellations / expirations / refunds:</b> ${toNumber(row.cancellations)} / ${toNumber(row.expirations)} / ${toNumber(row.refunds_or_revocations)}`,
    `<b>Estimated churn:</b> ${row.estimated_churn_percent === null ? '—' : `${Number(row.estimated_churn_percent).toFixed(1)}%`} (${toNumber(row.paid_losses)} losses / ${toNumber(row.paid_at_month_start)} paid at start)`,
    `<b>Estimated gross MRR:</b> ${formatMoney(row.estimated_gross_mrr)} before Apple fees, taxes, refunds, and FX`,
    ``,
    `<b>Monthly Paywall Funnel</b>`,
    `<b>Views:</b> ${toNumber(row.paywall_views)} (${toNumber(row.unique_viewers)} users)`,
    `<b>Raw purchase start/completion events:</b> ${toNumber(row.purchase_starts)} / ${toNumber(row.purchase_completions)}`,
    `<b>Session-linked purchase completion:</b> ${toNumber(row.completed_started_sessions)} of ${toNumber(row.purchase_start_sessions)} started sessions (${percent(row.completed_started_sessions, row.purchase_start_sessions)})`,
    `<b>Completed sessions observed:</b> ${toNumber(row.purchase_completed_sessions)}`,
    `<b>Cancelled / failed:</b> ${toNumber(row.purchase_cancellations)} / ${toNumber(row.purchase_failures)}`,
    ``,
    `<b>End-to-End Report Wait by Tier</b>`,
    ...clientPerformanceLines,
    ``,
    `<b>Backend Report Generation by Tier</b>`,
    ...performanceLines,
    ``,
    `<b>Analytics Data Quality</b>`,
    `<b>Tier-stamped events:</b> ${toNumber(row.tier_stamped)} / ${toNumber(row.total_events)}`,
    `<b>Critical lifecycle events missing debateId:</b> ${toNumber(row.critical_lifecycle_events_missing_debate_id)}`,
    `<b>Legacy report views/shares missing debateId:</b> ${toNumber(row.legacy_report_actions_missing_debate_id)}`,
    `<b>Completed reports missing duration:</b> ${toNumber(row.completed_reports_missing_duration)}`,
    ...(String(row.report_month || '').includes('July 2026')
      ? [
          `<b>Coverage note:</b> Subscription and Free/Trial/Paid Pro analytics begin with the July 31 release. August is the first full comparable month.`,
        ]
      : []),
  ].join('\n');
}
