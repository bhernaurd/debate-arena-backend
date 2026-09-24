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

const REPORT_MONTH = process.env.REPORT_MONTH || null;

function validateReportMonth(value) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('REPORT_MONTH must use YYYY-MM format.');
  return value;
}

const SQL = `
WITH runtime AS (
  SELECT CASE
    WHEN $1::text IS NOT NULL THEN ($1 || '-01')::date
    ELSE (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 month')::date
  END AS month_start
),
bounds AS (
  SELECT month_start, (month_start + INTERVAL '1 month')::date AS month_end,
    (month_start - INTERVAL '1 month')::date AS previous_start, month_start AS previous_end,
    month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
    (month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
  FROM runtime
),
installation_accounts AS (
  SELECT DISTINCT ON (installation_id) installation_id, account_id FROM account_installations
  ORDER BY installation_id, (unlinked_at IS NULL) DESC, updated_at DESC, linked_at DESC
),
excluded_accounts AS (
  SELECT DISTINCT ia.account_id FROM excluded_analytics_users x JOIN installation_accounts ia ON ia.installation_id = x.user_id
),
account_platforms AS (
  SELECT a.id AS account_id,
    CASE
      WHEN EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id) AND NOT EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id) THEN 'android'
      WHEN EXISTS (SELECT 1 FROM account_apple_identities ap WHERE ap.account_id = a.id) AND NOT EXISTS (SELECT 1 FROM account_google_identities g WHERE g.account_id = a.id) THEN 'ios'
      ELSE 'unknown' END AS account_platform
  FROM accounts a
),
raw_events AS (
  SELECT e.*, ia.account_id,
    COALESCE(CASE WHEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) IN ('ios','android') THEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) END, ap.account_platform, 'unknown') AS platform,
    NULLIF(BTRIM(e.metadata->>'flowId'), '') AS flow_id,
    NULLIF(BTRIM(e.metadata->>'debateId'), '') AS debate_id
  FROM user_events e CROSS JOIN bounds b
  LEFT JOIN installation_accounts ia ON ia.installation_id = e.user_id
  LEFT JOIN account_platforms ap ON ap.account_id = ia.account_id
  WHERE e.created_at >= b.start_time AND e.created_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id)
),
events AS (
  SELECT re.* FROM raw_events re WHERE re.account_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = re.account_id)
),
current_activity AS (
  SELECT DISTINCT ia.account_id
  FROM user_activity_days uad JOIN installation_accounts ia ON ia.installation_id = uad.user_id CROSS JOIN bounds b
  WHERE uad.active_date >= b.month_start AND uad.active_date < b.month_end
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = uad.user_id)
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id)
),
previous_activity AS (
  SELECT DISTINCT ia.account_id
  FROM user_activity_days uad JOIN installation_accounts ia ON ia.installation_id = uad.user_id CROSS JOIN bounds b
  WHERE uad.active_date >= b.previous_start AND uad.active_date < b.previous_end
    AND NOT EXISTS (SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = uad.user_id)
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id)
),
activity AS (
  SELECT
    (SELECT COUNT(*) FROM current_activity) AS monthly_active_users,
    (SELECT COUNT(*) FROM previous_activity) AS previous_month_active_users,
    (SELECT COUNT(*) FROM current_activity ca JOIN previous_activity pa USING (account_id)) AS retained_users,
    (SELECT COUNT(*) FROM current_activity ca JOIN accounts a ON a.id = ca.account_id CROSS JOIN bounds b
      WHERE (a.created_at AT TIME ZONE 'America/Chicago')::date >= b.month_start AND (a.created_at AT TIME ZONE 'America/Chicago')::date < b.month_end) AS new_users
),
philosopher_flows AS (
  SELECT DISTINCT account_id, platform, flow_id FROM events WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL
),
matched_flows AS (
  SELECT pf.* FROM philosopher_flows pf WHERE EXISTS (
    SELECT 1 FROM events e WHERE e.account_id = pf.account_id AND e.flow_id = pf.flow_id
      AND e.event_name = 'debate_started' AND e.metadata->>'isDailyChallenge' = 'false'
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
    COUNT(*) FILTER (WHERE event_name = 'report_generation_failed') AS report_generation_failures,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_hub_viewed') AS learn_hub_users,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_card_opened' AND metadata->>'feature' = 'learn_philosophy') AS learn_philosophy_users,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_item_completed' AND metadata->>'feature' = 'learn_philosophy') AS learn_philosophy_completers,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_card_opened' AND metadata->>'feature' = 'thought_lab') AS thought_lab_users,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_item_completed' AND metadata->>'feature' = 'thought_lab') AS thought_lab_completers,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_card_opened' AND metadata->>'feature' = 'modern_cases') AS modern_cases_users,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_item_completed' AND metadata->>'feature' = 'modern_cases') AS modern_cases_completers,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_card_opened' AND metadata->>'feature' = 'where_do_you_stand') AS stance_users,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_item_completed' AND metadata->>'feature' = 'where_do_you_stand') AS stance_completers,
    COUNT(DISTINCT account_id) FILTER (WHERE event_name = 'learn_card_opened' AND metadata->>'feature' = 'mirror') AS mirror_users,
    COUNT(DISTINCT account_id) FILTER (
      WHERE event_name = 'mirror_analysis_read_depth'
        AND metadata->>'depth' IN ('50', '75', '100')
    ) AS mirror_readers_50
  FROM events
),
mirror_lifecycle AS (
  SELECT
    COUNT(DISTINCT c.account_id) FILTER (
      WHERE c.questionnaire_started_at >= b.start_time
        AND c.questionnaire_started_at < b.end_time
    ) AS mirror_questionnaire_starters,
    COUNT(DISTINCT c.account_id) FILTER (
      WHERE c.questionnaire_completed_at >= b.start_time
        AND c.questionnaire_completed_at < b.end_time
    ) AS mirror_questionnaire_completers
  FROM account_mirror_cycles c
  CROSS JOIN bounds b
  WHERE NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = c.account_id)
),
mirror_snapshot_activity AS (
  SELECT
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 1) AS mirror_1_completers,
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 2) AS mirror_2_completers,
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 3) AS mirror_3_completers
  FROM account_mirror_snapshots s
  CROSS JOIN bounds b
  WHERE s.generated_at >= b.start_time
    AND s.generated_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = s.account_id)
),
mirror_failures AS (
  SELECT COUNT(*) AS mirror_analysis_failures
  FROM api_usage_logs l
  CROSS JOIN bounds b
  WHERE l.occurred_at >= b.start_time
    AND l.occurred_at < b.end_time
    AND l.feature IN ('mirror_starting_analysis', 'mirror_recurring_analysis')
    AND l.success = FALSE
    AND (
      l.account_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = l.account_id)
    )
),
mirror_2_eligible_accounts AS (
  SELECT DISTINCT c.account_id
  FROM account_mirror_cycles c
  CROSS JOIN bounds b
  WHERE c.cycle_number = 2
    AND c.questionnaire_eligible_at < b.end_time
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = c.account_id)
),
mirror_retention AS (
  SELECT
    COUNT(*) AS mirror_2_eligible_accounts,
    COUNT(*) FILTER (
      WHERE EXISTS (
        SELECT 1
        FROM account_mirror_snapshots snapshot
        CROSS JOIN bounds b
        WHERE snapshot.account_id = eligible.account_id
          AND snapshot.cycle_number = 2
          AND snapshot.generated_at < b.end_time
      )
    ) AS mirror_2_completed_accounts
  FROM mirror_2_eligible_accounts eligible
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
    AND ((se.is_lifetime_pro = true AND se.status = 'active' AND se.revocation_date IS NULL)
      OR (se.is_recurring_pro = true AND se.status IN ('trial','active','grace_period')
        AND ((se.status IN ('trial','active') AND se.expires_date > NOW()) OR (se.status = 'grace_period' AND se.grace_period_expires_date > NOW()))))
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = o.account_id)
),
android_pro AS (
  SELECT DISTINCT g.account_id, CASE WHEN g.is_trial = true THEN 'trial' ELSE 'paid' END AS tier
  FROM google_play_subscription_entitlements g
  WHERE g.test_purchase = false AND g.normalized_status IN ('trial','active','grace_period')
    AND (g.expires_date IS NULL OR g.expires_date > NOW())
    AND NOT EXISTS (SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = g.account_id)
),
pro AS (SELECT account_id, tier FROM apple_pro UNION SELECT account_id, tier FROM android_pro),
pro_summary AS (
  SELECT COUNT(DISTINCT account_id) FILTER (WHERE tier = 'paid') AS paid_pro,
         COUNT(DISTINCT account_id) FILTER (WHERE tier = 'trial') AS trial_pro FROM pro
),
tracking AS (
  SELECT COUNT(*) AS raw_events,
    COUNT(*) FILTER (WHERE account_id IS NOT NULL) AS account_linked_events,
    COUNT(*) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NULL) AS philosopher_missing_flow,
    COUNT(*) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false' AND flow_id IS NULL) AS normal_starts_missing_flow
  FROM raw_events
),
label AS (SELECT TO_CHAR(month_start, 'FMMonth YYYY') AS report_month FROM bounds)
SELECT l.report_month, a.*, (a.monthly_active_users - a.new_users) AS returning_users, s.*,
  (SELECT COUNT(*) FROM philosopher_flows) AS philosopher_flows,
  (SELECT COUNT(*) FROM matched_flows) AS matched_flows,
  r.ranked_debates, r.ranked_users, ps.paid_pro, ps.trial_pro, t.*,
  ml.mirror_questionnaire_starters, ml.mirror_questionnaire_completers,
  msa.mirror_1_completers, msa.mirror_2_completers, msa.mirror_3_completers,
  mf.mirror_analysis_failures,
  mr.mirror_2_eligible_accounts, mr.mirror_2_completed_accounts
FROM label l CROSS JOIN activity a CROSS JOIN summary s CROSS JOIN ranked r CROSS JOIN pro_summary ps CROSS JOIN tracking t
CROSS JOIN mirror_lifecycle ml CROSS JOIN mirror_snapshot_activity msa CROSS JOIN mirror_failures mf
CROSS JOIN mirror_retention mr;
`;

const PLATFORM_SQL = `
WITH runtime AS (
  SELECT CASE WHEN $1::text IS NOT NULL THEN ($1 || '-01')::date
    ELSE (date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 month')::date END AS month_start
),
bounds AS (SELECT month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
  (month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time FROM runtime),
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
  FROM user_events e CROSS JOIN bounds b JOIN installation_accounts ia ON ia.installation_id = e.user_id
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
GROUP BY p.platform ORDER BY CASE p.platform WHEN 'ios' THEN 1 ELSE 2 END;
`;

function trackingWarnings(row) {
  const warnings = [];
  const raw = toNumber(row.raw_events);
  const linked = toNumber(row.account_linked_events);
  if (raw > linked) warnings.push(`${raw - linked} events could not be linked to an Agora account.`);
  if (toNumber(row.philosopher_missing_flow) > 0) warnings.push(`${toNumber(row.philosopher_missing_flow)} philosopher selections were missing flowId.`);
  if (toNumber(row.normal_starts_missing_flow) > 0) warnings.push(`${toNumber(row.normal_starts_missing_flow)} normal debate starts were missing flowId.`);
  if (toNumber(row.report_generation_failures) > 0) warnings.push(`${toNumber(row.report_generation_failures)} debate report generation failures were recorded.`);
  if (toNumber(row.mirror_analysis_failures) > 0) warnings.push(`${toNumber(row.mirror_analysis_failures)} Mirror analysis failures were recorded.`);
  return warnings;
}

async function main() {
  const client = await pool.connect();
  try {
    const override = validateReportMonth(REPORT_MONTH);
    const [result, platformResult] = await Promise.all([client.query(SQL, [override]), client.query(PLATFORM_SQL, [override])]);
    const row = result.rows[0];
    if (!row) throw new Error('Monthly analytics query returned no row.');

    const platformLines = platformResult.rows
      .filter((p) => toNumber(p.active_users) > 0 || toNumber(p.debate_starts) > 0 || toNumber(p.philosopher_flows) > 0)
      .map((p) => platformLine({ platform: p.platform, activeUsers: p.active_users, debateStarts: p.debate_starts, philosopherFlows: p.philosopher_flows, matchedFlows: p.matched_flows }));
    const warnings = trackingWarnings(row);
    const lines = [
      `🏛️ <b>The Oracle Monthly Report</b>`, `<b>${row.report_month}</b>`, ``,
      `<b>USERS</b>`, `${toNumber(row.monthly_active_users)} active • ${toNumber(row.new_users)} new • ${toNumber(row.returning_users)} returning`,
      `Retention: ${percent(row.retained_users, row.previous_month_active_users)} • vs prior month ${growth(row.monthly_active_users, row.previous_month_active_users)}`, ``,
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
      `<b>LEARN</b>`, `${toNumber(row.learn_hub_users)} hub users`,
      `Learn Philosophy: ${toNumber(row.learn_philosophy_users)} opened • ${toNumber(row.learn_philosophy_completers)} completed an item`,
      `Thought Lab: ${toNumber(row.thought_lab_users)} opened • ${toNumber(row.thought_lab_completers)} completed an item`,
      `Modern Cases: ${toNumber(row.modern_cases_users)} opened • ${toNumber(row.modern_cases_completers)} completed a case`,
      `Where Do You Stand?: ${toNumber(row.stance_users)} opened • ${toNumber(row.stance_completers)} answered a statement`,
      `Mirror: ${toNumber(row.mirror_users)} opened • ${toNumber(row.mirror_questionnaire_starters)} questionnaire starts • ${toNumber(row.mirror_questionnaire_completers)} submits`,
      `Mirror completions this month: #1 ${toNumber(row.mirror_1_completers)} • #2 ${toNumber(row.mirror_2_completers)} • #3 ${toNumber(row.mirror_3_completers)} • ${toNumber(row.mirror_readers_50)} read 50%+`,
      `Starting Mirror → Mirror #2: ${toNumber(row.mirror_2_completed_accounts)}/${toNumber(row.mirror_2_eligible_accounts)} (${percent(row.mirror_2_completed_accounts, row.mirror_2_eligible_accounts)})`, ``,
      `<b>AGORA PRO</b>`, `${toNumber(row.paid_pro)} paid • ${toNumber(row.trial_pro)} trial`,
    ];
    if (platformLines.length > 0) lines.push('', '<b>PLATFORM</b>', ...platformLines);
    if (warnings.length > 0) lines.push('', '<b>⚠️ TRACKING</b>', ...warnings);

    const message = lines.join('\n');
    const subject = `The Agora Monthly Report — ${row.report_month}`;
    const deliveries = await Promise.allSettled([
      sendTelegramMessage(message),
      sendAnalyticsEmail({ subject, reportText: plainText(message) }),
    ]);
    const failed = deliveries.filter((d) => d.status === 'rejected');
    if (failed.length === deliveries.length) throw failed[0].reason;
    console.log('[monthlyAnalyticsReportV2] Delivery results:', deliveries);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[monthlyAnalyticsReportV2] Failed:', error);
  process.exitCode = 1;
});
