import pg from 'pg';
import { sendAnalyticsEmail } from './emailReporter.js';
import {
  growth,
  percent,
  plainText,
  platformLine,
  sendTelegramMessage,
  stageLine,
  toNumber,
} from './analyticsReportV2Shared.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

const SQL = `
WITH params AS (
  SELECT ((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::date AS report_date
),
bounds AS (
  SELECT report_date,
    report_date::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
    (report_date + 1)::timestamp AT TIME ZONE 'America/Chicago' AS end_time
  FROM params
),
installation_accounts AS (
  SELECT DISTINCT ON (installation_id) installation_id, account_id
  FROM account_installations
  ORDER BY installation_id, (unlinked_at IS NULL) DESC, updated_at DESC, linked_at DESC
),
excluded_accounts AS (
  SELECT DISTINCT ia.account_id
  FROM excluded_analytics_users x
  JOIN installation_accounts ia ON ia.installation_id = x.user_id
),
account_platforms AS (
  SELECT a.id AS account_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id) THEN 'android'
      WHEN EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id) THEN 'ios'
      ELSE 'unknown'
    END AS account_platform
  FROM accounts a
),
raw_events AS (
  SELECT e.*, ia.account_id,
    COALESCE(
      CASE WHEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) IN ('ios','android')
        THEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) END,
      ap.account_platform, 'unknown'
    ) AS platform,
    NULLIF(BTRIM(e.metadata->>'flowId'), '') AS flow_id,
    NULLIF(BTRIM(e.metadata->>'debateId'), '') AS debate_id
  FROM user_events e
  CROSS JOIN bounds b
  LEFT JOIN installation_accounts ia ON ia.installation_id = e.user_id
  LEFT JOIN account_platforms ap ON ap.account_id = ia.account_id
  WHERE e.created_at >= b.start_time AND e.created_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id)
),
events AS (
  SELECT re.* FROM raw_events re
  WHERE re.account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = re.account_id)
),
activity_accounts AS (
  SELECT DISTINCT ia.account_id
  FROM user_activity_days uad
  JOIN installation_accounts ia ON ia.installation_id = uad.user_id
  CROSS JOIN params p
  WHERE uad.active_date = p.report_date
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = uad.user_id)
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id)
),
activity AS (
  SELECT COUNT(*) AS daily_active_users,
    COUNT(*) FILTER (WHERE (a.created_at AT TIME ZONE 'America/Chicago')::date = p.report_date) AS new_users
  FROM activity_accounts aa
  JOIN accounts a ON a.id = aa.account_id
  CROSS JOIN params p
),
philosopher_flows AS (
  SELECT DISTINCT account_id, platform, flow_id FROM events
  WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL
),
started_flows AS (
  SELECT DISTINCT account_id, platform, flow_id FROM events
  WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false' AND flow_id IS NOT NULL
),
matched_flows AS (
  SELECT pf.account_id, pf.platform, pf.flow_id FROM philosopher_flows pf
  WHERE EXISTS (
    SELECT 1 FROM started_flows sf
    WHERE sf.account_id = pf.account_id AND sf.flow_id = pf.flow_id
  )
),
summary AS (
  SELECT
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'daily_challenge_viewed') AS dc_viewers,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'daily_challenge_started') AS dc_starters,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'daily_challenge_completed') AS dc_completers,
    COUNT(DISTINCT flow_id) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL) AS philosopher_times,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL) AS philosopher_users,
    COUNT(*) FILTER (WHERE event_name = 'topic_selected' AND flow_id IS NOT NULL) AS topic_times,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'topic_selected' AND flow_id IS NOT NULL) AS topic_users,
    COUNT(DISTINCT flow_id) FILTER (WHERE event_name = 'difficulty_selected' AND flow_id IS NOT NULL) AS mode_times,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'difficulty_selected' AND flow_id IS NOT NULL) AS mode_users,
    COUNT(DISTINCT COALESCE(debate_id, id::text)) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false') AS debate_starts,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false') AS debate_start_users,
    COUNT(DISTINCT COALESCE(debate_id, id::text)) FILTER (WHERE event_name = 'debate_completed' AND metadata->>'isDailyChallenge' = 'false') AS debate_completions,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'debate_completed' AND metadata->>'isDailyChallenge' = 'false') AS debate_completion_users,
    COUNT(*) FILTER (WHERE event_name = 'report_viewed') AS report_views,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'report_viewed') AS report_users,
    COUNT(*) FILTER (WHERE event_name = 'share_card_created') AS share_cards,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'share_card_created') AS share_users,
    COUNT(*) FILTER (WHERE event_name = 'report_generation_failed') AS report_generation_failures
  FROM events
),
flow_conversion AS (
  SELECT (SELECT COUNT(*) FROM philosopher_flows) AS philosopher_flows,
         (SELECT COUNT(*) FROM matched_flows) AS matched_flows
),
ranked AS (
  SELECT COUNT(DISTINCT d.id) AS ranked_debates, COUNT(DISTINCT d.account_id) AS ranked_users
  FROM account_ranked_debates d CROSS JOIN bounds b
  WHERE d.started_at >= b.start_time AND d.started_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = d.account_id)
),
apple_pro AS (
  SELECT DISTINCT o.account_id, CASE WHEN se.is_trial = true THEN 'trial' ELSE 'paid' END AS tier
  FROM account_subscription_ownership o
  JOIN subscription_entitlements se ON se.original_transaction_id = o.original_transaction_id AND se.environment = o.environment
  WHERE o.ownership_status = 'active' AND se.environment = 'Production'
    AND (
      (se.is_lifetime_pro = true AND se.status = 'active' AND se.revocation_date IS NULL)
      OR (se.is_recurring_pro = true AND se.status IN ('trial','active','grace_period')
        AND ((se.status IN ('trial','active') AND se.expires_date > NOW()) OR (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())))
    )
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = o.account_id)
),
android_pro AS (
  SELECT DISTINCT g.account_id, CASE WHEN g.is_trial = true THEN 'trial' ELSE 'paid' END AS tier
  FROM google_play_subscription_entitlements g
  WHERE g.test_purchase = false AND g.normalized_status IN ('trial','active','grace_period')
    AND (g.expires_date IS NULL OR g.expires_date > NOW())
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = g.account_id)
),
pro AS (
  SELECT account_id, tier FROM apple_pro UNION SELECT account_id, tier FROM android_pro
),
pro_summary AS (
  SELECT COUNT(DISTINCT account_id) FILTER (WHERE tier = 'paid') AS paid_pro,
         COUNT(DISTINCT account_id) FILTER (WHERE tier = 'trial') AS trial_pro
  FROM pro
),
tracking AS (
  SELECT COUNT(*) AS raw_events,
    COUNT(*) FILTER (WHERE account_id IS NOT NULL) AS account_linked_events,
    COUNT(*) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NULL) AS philosopher_missing_flow,
    COUNT(*) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false' AND flow_id IS NULL) AS normal_starts_missing_flow
  FROM raw_events
),
activity_14 AS (
  SELECT DISTINCT uad.active_date, ia.account_id
  FROM user_activity_days uad
  JOIN installation_accounts ia ON ia.installation_id = uad.user_id
  CROSS JOIN params p
  WHERE uad.active_date >= p.report_date - 13 AND uad.active_date <= p.report_date
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = uad.user_id)
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id)
),
daily_counts AS (
  SELECT active_date, COUNT(DISTINCT account_id) AS users FROM activity_14 GROUP BY active_date
),
seven_day AS (
  SELECT
    (SELECT COUNT(DISTINCT account_id) FROM activity_14 a CROSS JOIN params p WHERE a.active_date >= p.report_date - 6) AS active_7d,
    (SELECT COUNT(DISTINCT account_id) FROM activity_14 a CROSS JOIN params p WHERE a.active_date BETWEEN p.report_date - 13 AND p.report_date - 7) AS previous_active_7d,
    COALESCE((SELECT AVG(users::numeric) FROM daily_counts d CROSS JOIN params p WHERE d.active_date >= p.report_date - 6), 0) AS avg_dau_7d
),
report_label AS (SELECT TO_CHAR(report_date, 'FMDay, FMMonth DD, YYYY') AS label FROM params)
SELECT rl.label AS report_date_label,
  a.daily_active_users, a.new_users, (a.daily_active_users - a.new_users) AS returning_users,
  s.*, fc.philosopher_flows, fc.matched_flows, r.ranked_debates, r.ranked_users,
  ps.paid_pro, ps.trial_pro, t.raw_events, t.account_linked_events,
  t.philosopher_missing_flow, t.normal_starts_missing_flow,
  sd.active_7d, sd.previous_active_7d, ROUND(sd.avg_dau_7d, 1) AS avg_dau_7d
FROM report_label rl CROSS JOIN activity a CROSS JOIN summary s CROSS JOIN flow_conversion fc
CROSS JOIN ranked r CROSS JOIN pro_summary ps CROSS JOIN tracking t CROSS JOIN seven_day sd;
`;

const PLATFORM_SQL = `
WITH params AS (SELECT ((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::date AS report_date),
bounds AS (SELECT report_date::timestamp AT TIME ZONE 'America/Chicago' AS start_time, (report_date + 1)::timestamp AT TIME ZONE 'America/Chicago' AS end_time FROM params),
installation_accounts AS (
  SELECT DISTINCT ON (installation_id) installation_id, account_id FROM account_installations
  ORDER BY installation_id, (unlinked_at IS NULL) DESC, updated_at DESC, linked_at DESC
),
account_platforms AS (
  SELECT a.id AS account_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id) AND NOT EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id) THEN 'android'
      WHEN EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id) AND NOT EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id) THEN 'ios'
      ELSE 'unknown' END AS account_platform
  FROM accounts a
),
events AS (
  SELECT e.*, ia.account_id,
    COALESCE(CASE WHEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) IN ('ios','android') THEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) END, ap.account_platform, 'unknown') AS platform,
    NULLIF(BTRIM(e.metadata->>'flowId'), '') AS flow_id,
    NULLIF(BTRIM(e.metadata->>'debateId'), '') AS debate_id
  FROM user_events e CROSS JOIN bounds b
  JOIN installation_accounts ia ON ia.installation_id = e.user_id
  LEFT JOIN account_platforms ap ON ap.account_id = ia.account_id
  WHERE e.created_at >= b.start_time AND e.created_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id)
),
philosopher_flows AS (
  SELECT DISTINCT account_id, platform, flow_id FROM events WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL
),
matched AS (
  SELECT pf.* FROM philosopher_flows pf WHERE EXISTS (
    SELECT 1 FROM events e WHERE e.account_id = pf.account_id AND e.flow_id = pf.flow_id
      AND e.event_name = 'debate_started' AND e.metadata->>'isDailyChallenge' = 'false'
  )
)
SELECT p.platform,
  COUNT(DISTINCT e.account_id) FILTER (WHERE e.event_name = 'app_opened') AS active_users,
  COUNT(DISTINCT COALESCE(e.debate_id, e.id::text)) FILTER (WHERE e.event_name = 'debate_started' AND e.metadata->>'isDailyChallenge' = 'false') AS debate_starts,
  (SELECT COUNT(*) FROM philosopher_flows pf WHERE pf.platform = p.platform) AS philosopher_flows,
  (SELECT COUNT(*) FROM matched m WHERE m.platform = p.platform) AS matched_flows
FROM (VALUES ('ios'::text), ('android'::text)) p(platform)
LEFT JOIN events e ON e.platform = p.platform
GROUP BY p.platform
ORDER BY CASE p.platform WHEN 'ios' THEN 1 ELSE 2 END;
`;

const SEVEN_DAY_DETAIL_SQL = `
WITH params AS (
  SELECT
    ((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::date AS end_date,
    ((NOW() AT TIME ZONE 'America/Chicago')::date - 7)::date AS start_date
),
days AS (
  SELECT generate_series(params.start_date, params.end_date, INTERVAL '1 day')::date AS active_date
  FROM params
),
installation_accounts AS (
  SELECT DISTINCT ON (installation_id) installation_id, account_id
  FROM account_installations
  ORDER BY installation_id, (unlinked_at IS NULL) DESC, updated_at DESC, linked_at DESC
),
excluded_accounts AS (
  SELECT DISTINCT ia.account_id
  FROM excluded_analytics_users x
  JOIN installation_accounts ia ON ia.installation_id = x.user_id
),
account_activity AS (
  SELECT DISTINCT uad.active_date, ia.account_id
  FROM user_activity_days uad
  JOIN installation_accounts ia ON ia.installation_id = uad.user_id
  WHERE NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = uad.user_id)
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id)
),
first_seen AS (
  SELECT account_id, MIN(active_date) AS first_active_date
  FROM account_activity
  GROUP BY account_id
),
daily_active AS (
  SELECT active_date, COUNT(DISTINCT account_id) AS daily_active_users
  FROM account_activity
  GROUP BY active_date
),
daily_new AS (
  SELECT first_active_date AS active_date, COUNT(DISTINCT account_id) AS new_users
  FROM first_seen
  GROUP BY first_active_date
)
SELECT
  TO_CHAR(days.active_date, 'MM-DD-YYYY Dy') AS report_date,
  COALESCE(daily_active.daily_active_users, 0) AS daily_active_users,
  COALESCE(daily_new.new_users, 0) AS new_users,
  COALESCE(daily_active.daily_active_users, 0) - COALESCE(daily_new.new_users, 0) AS returning_users
FROM days
LEFT JOIN daily_active ON days.active_date = daily_active.active_date
LEFT JOIN daily_new ON days.active_date = daily_new.active_date
ORDER BY days.active_date DESC;
`;

function trackingWarnings(row) {
  const warnings = [];
  const raw = toNumber(row.raw_events);
  const linked = toNumber(row.account_linked_events);
  if (raw > linked) warnings.push(`${raw - linked} event${raw - linked === 1 ? '' : 's'} could not be linked to an Agora account.`);
  const missingPhilosopher = toNumber(row.philosopher_missing_flow);
  if (missingPhilosopher > 0) warnings.push(`${missingPhilosopher} philosopher selection${missingPhilosopher === 1 ? '' : 's'} missing flowId.`);
  const missingStart = toNumber(row.normal_starts_missing_flow);
  if (missingStart > 0) warnings.push(`${missingStart} normal debate start${missingStart === 1 ? '' : 's'} missing flowId.`);
  const reportFailures = toNumber(row.report_generation_failures);
  if (reportFailures > 0) warnings.push(`${reportFailures} debate report generation failure${reportFailures === 1 ? '' : 's'} recorded.`);
  return warnings;
}

function buildSevenDayMessage(rows) {
  const sevenDayLines = rows.map((day) => [
    `<b>${day.report_date}</b>`,
    `Daily Active Users: ${toNumber(day.daily_active_users)}`,
    `New users: ${toNumber(day.new_users)}`,
    `Returning users: ${toNumber(day.returning_users)}`,
  ].join('\n'));

  return [
    `📊 <b>7-Day User Activity Report</b>`,
    ``,
    `<b>Last 7 completed Central-time days</b>`,
    ``,
    sevenDayLines.join('\n\n'),
  ].join('\n');
}

async function main() {
  try {
    const [summaryResult, platformResult, sevenDayResult] = await Promise.all([
      pool.query(SQL),
      pool.query(PLATFORM_SQL),
      pool.query(SEVEN_DAY_DETAIL_SQL),
    ]);
    const row = summaryResult.rows[0];
    if (!row) throw new Error('Daily analytics query returned no row.');

    const platformLines = platformResult.rows
      .filter((p) => toNumber(p.active_users) > 0 || toNumber(p.debate_starts) > 0 || toNumber(p.philosopher_flows) > 0)
      .map((p) => platformLine({ platform: p.platform, activeUsers: p.active_users, debateStarts: p.debate_starts, philosopherFlows: p.philosopher_flows, matchedFlows: p.matched_flows }));
    const warnings = trackingWarnings(row);

    const lines = [
      `🏛️ <b>The Agora Daily Report</b>`, `<b>${row.report_date_label}</b>`, ``,
      `<b>USERS</b>`, `${toNumber(row.daily_active_users)} active • ${toNumber(row.new_users)} new • ${toNumber(row.returning_users)} returning`, ``,
      `<b>DAILY CHALLENGE</b>`, `${toNumber(row.dc_viewers)} viewed • ${toNumber(row.dc_starters)} started • ${toNumber(row.dc_completers)} completed`, ``,
      `<b>NORMAL DEBATES</b>`,
      stageLine('Philosopher selected', row.philosopher_times, row.philosopher_users),
      stageLine('Topic selected', row.topic_times, row.topic_users),
      stageLine('Mode confirmed', row.mode_times, row.mode_users),
      stageLine('Debate started', row.debate_starts, row.debate_start_users, 'debates'),
      stageLine('Debate completed', row.debate_completions, row.debate_completion_users, 'debates'),
      `Philosopher → Debate: ${percent(row.matched_flows, row.philosopher_flows)}`, ``,
      `<b>RANKED</b>`, `${toNumber(row.ranked_debates)} debates • ${toNumber(row.ranked_users)} ${toNumber(row.ranked_users) === 1 ? 'user' : 'users'}`, ``,
      `<b>REPORTS</b>`, `${toNumber(row.report_views)} viewed • ${toNumber(row.report_users)} ${toNumber(row.report_users) === 1 ? 'user' : 'users'}`,
      `${toNumber(row.share_cards)} share cards • ${toNumber(row.share_users)} ${toNumber(row.share_users) === 1 ? 'user' : 'users'}`, ``,
      `<b>AGORA PRO</b>`, `${toNumber(row.paid_pro)} paid • ${toNumber(row.trial_pro)} trial`,
    ];
    if (platformLines.length > 0) lines.push('', '<b>PLATFORM</b>', ...platformLines);
    lines.push('', '<b>7-DAY</b>', `${toNumber(row.active_7d)} active • ${Number(row.avg_dau_7d || 0).toFixed(1)} avg DAU • ${growth(row.active_7d, row.previous_active_7d)} vs prior 7d`);
    if (warnings.length > 0) lines.push('', '<b>⚠️ TRACKING</b>', ...warnings);

    const message = lines.join('\n');
    const sevenDayMessage = buildSevenDayMessage(sevenDayResult.rows);
    const subject = `The Agora Daily Report — ${row.report_date_label}`;
    const telegramDelivery = (async () => {
      await sendTelegramMessage(message);
      await sendTelegramMessage(sevenDayMessage);
      return { success: true };
    })();
    const deliveries = await Promise.allSettled([
      telegramDelivery,
      sendAnalyticsEmail({
        subject,
        reportText: [
          plainText(message),
          '',
          '────────────────────────',
          '',
          plainText(sevenDayMessage),
        ].join('\n'),
      }),
    ]);
    const [telegramResult, emailResult] = deliveries;
    if (telegramResult.status === 'rejected') {
      throw telegramResult.reason;
    }
    if (emailResult.status === 'rejected') {
      console.error('[dailyAnalyticsReportV2] Email delivery failed:', emailResult.reason);
    }
    console.log('[dailyAnalyticsReportV2] Delivery results:', deliveries);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[dailyAnalyticsReportV2] Failed:', error);
  process.exitCode = 1;
});