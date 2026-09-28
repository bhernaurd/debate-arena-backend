import pg from 'pg';
import { sendAnalyticsEmail } from './emailReporter.js';
import { CANONICAL_ACTIVITY_CTES } from '../lib/analyticsIdentity.js';
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
${CANONICAL_ACTIVITY_CTES},
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
      'account:' || ia.account_id::text,
      'installation:' || e.user_id
    ) AS analytics_user_key,
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
  WHERE re.account_id IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM excluded_accounts ea
       WHERE ea.account_id = re.account_id
     )
),
first_seen AS (
  SELECT analytics_user_key, MIN(active_date) AS first_active_date
  FROM canonical_activity
  GROUP BY analytics_user_key
),
activity_users AS (
  SELECT DISTINCT ca.analytics_user_key
  FROM canonical_activity ca
  CROSS JOIN params p
  WHERE ca.active_date = p.report_date
),
activity AS (
  SELECT
    COUNT(*) AS daily_active_users,
    COUNT(*) FILTER (
      WHERE fs.first_active_date = p.report_date
    ) AS new_users
  FROM activity_users au
  JOIN first_seen fs USING (analytics_user_key)
  CROSS JOIN params p
),
philosopher_flows AS (
  SELECT DISTINCT analytics_user_key, platform, flow_id FROM events
  WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL
),
started_flows AS (
  SELECT DISTINCT analytics_user_key, platform, flow_id FROM events
  WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false' AND flow_id IS NOT NULL
),
matched_flows AS (
  SELECT pf.analytics_user_key, pf.platform, pf.flow_id FROM philosopher_flows pf
  WHERE EXISTS (
    SELECT 1 FROM started_flows sf
    WHERE sf.analytics_user_key = pf.analytics_user_key AND sf.flow_id = pf.flow_id
  )
),
summary AS (
  SELECT
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'daily_challenge_viewed') AS dc_viewers,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'daily_challenge_started') AS dc_starters,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'daily_challenge_completed') AS dc_completers,
    COUNT(DISTINCT flow_id) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL) AS philosopher_times,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL) AS philosopher_users,
    COUNT(*) FILTER (WHERE event_name = 'topic_selected' AND flow_id IS NOT NULL) AS topic_times,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'topic_selected' AND flow_id IS NOT NULL) AS topic_users,
    COUNT(DISTINCT flow_id) FILTER (WHERE event_name = 'difficulty_selected' AND flow_id IS NOT NULL) AS mode_times,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'difficulty_selected' AND flow_id IS NOT NULL) AS mode_users,
    COUNT(DISTINCT COALESCE(debate_id, id::text)) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false') AS debate_starts,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'debate_started' AND metadata->>'isDailyChallenge' = 'false') AS debate_start_users,
    COUNT(DISTINCT COALESCE(debate_id, id::text)) FILTER (WHERE event_name = 'debate_completed' AND metadata->>'isDailyChallenge' = 'false') AS debate_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'debate_completed' AND metadata->>'isDailyChallenge' = 'false') AS debate_completion_users,
    COUNT(*) FILTER (WHERE event_name = 'report_viewed') AS report_views,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'report_viewed') AS report_users,
    COUNT(*) FILTER (WHERE event_name = 'share_card_created') AS share_cards,
    COUNT(DISTINCT analytics_user_key) FILTER (WHERE event_name = 'share_card_created') AS share_users,
    COUNT(*) FILTER (WHERE event_name = 'report_generation_failed') AS report_generation_failures
  FROM events
),
learn_summary AS (
  SELECT
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_hub_viewed'
    ) AS learn_hub_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_started_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_completed_users,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_item_completions,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_started_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_completed_users,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_item_completions,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_started_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_completed_users,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_item_completions,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_started_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_completed_users,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_item_completions,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'mirror'
    ) AS mirror_opened_users,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_questionnaire_started'
    ) AS mirror_questionnaire_started_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_questionnaire_completed'
    ) AS mirror_questionnaire_completed_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_generation_started'
    ) AS mirror_generation_attempts,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_generated'
    ) AS mirror_analysis_generated_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_failed'
    ) AS mirror_analysis_failures,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'mirror_analysis_read_depth'
        AND CASE
          WHEN COALESCE(metadata->>'depth', '') ~ '^[0-9]+$'
            THEN (metadata->>'depth')::integer
          ELSE 0
        END >= 50
    ) AS mirror_readers_50_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'mirror_analysis_read_depth'
        AND COALESCE(metadata->>'depth', '') = '100'
    ) AS mirror_readers_100_users,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_detail_expanded'
    ) AS mirror_detail_expansion_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_evidence_opened'
    ) AS mirror_evidence_open_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_recommendation_tapped'
    ) AS mirror_recommendation_tap_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_next_eligible_seen'
    ) AS mirror_next_eligible_seen_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_completed'
    ) AS mirror_completed_events,

    COUNT(*) FILTER (
      WHERE event_name IN (
        'learn_card_opened',
        'learn_item_started',
        'learn_item_completed',
        'learn_course_completed'
      )
        AND NULLIF(BTRIM(metadata->>'feature'), '') IS NULL
    ) AS learn_events_missing_feature,
    COUNT(*) FILTER (
      WHERE event_name IN (
        'learn_card_opened',
        'learn_item_started',
        'learn_item_completed',
        'learn_course_completed'
      )
        AND COALESCE(metadata->>'feature', '') NOT IN (
          'learn_philosophy',
          'thought_lab',
          'modern_cases',
          'where_do_you_stand',
          'mirror'
        )
    ) AS learn_events_unknown_feature,
    COUNT(*) FILTER (
      WHERE event_name IN ('learn_item_started', 'learn_item_completed')
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NULL
    ) AS learn_item_events_missing_id,
    COUNT(*) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND NULLIF(BTRIM(metadata->>'courseId'), '') IS NULL
    ) AS learn_course_events_missing_id,
    COUNT(*) FILTER (
      WHERE event_name LIKE 'mirror_%'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NULL
    ) AS mirror_events_missing_cycle,
    COUNT(*) FILTER (
      WHERE event_name LIKE 'mirror_%'
        AND COALESCE(metadata->>'mirrorNumber', '') !~ '^[1-9][0-9]*$'
    ) AS mirror_events_invalid_number
  FROM events
),
mirror_completion_summary AS (
  SELECT
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 1) AS mirror_1_completed,
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 2) AS mirror_2_completed,
    COUNT(DISTINCT s.account_id) FILTER (WHERE s.cycle_number = 3) AS mirror_3_completed
  FROM account_mirror_snapshots s
  CROSS JOIN bounds b
  WHERE s.generated_at >= b.start_time
    AND s.generated_at < b.end_time
    AND NOT EXISTS (
      SELECT 1
      FROM excluded_accounts ea
      WHERE ea.account_id = s.account_id
    )
),
mirror_second_eligible AS (
  SELECT DISTINCT c.account_id
  FROM account_mirror_cycles c
  CROSS JOIN bounds b
  WHERE c.cycle_number = 2
    AND c.questionnaire_eligible_at < b.end_time
    AND NOT EXISTS (
      SELECT 1
      FROM excluded_accounts ea
      WHERE ea.account_id = c.account_id
    )
),
mirror_second_completed AS (
  SELECT DISTINCT s.account_id
  FROM account_mirror_snapshots s
  CROSS JOIN bounds b
  WHERE s.cycle_number = 2
    AND s.generated_at < b.end_time
    AND NOT EXISTS (
      SELECT 1
      FROM excluded_accounts ea
      WHERE ea.account_id = s.account_id
    )
),
mirror_return_summary AS (
  SELECT
    COUNT(*) AS mirror_2_eligible,
    COUNT(completed.account_id) AS mirror_2_returned
  FROM mirror_second_eligible eligible
  LEFT JOIN mirror_second_completed completed
    USING (account_id)
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
  SELECT DISTINCT ca.active_date, ca.analytics_user_key
  FROM canonical_activity ca
  CROSS JOIN params p
  WHERE ca.active_date >= p.report_date - 13
    AND ca.active_date <= p.report_date
),
daily_counts AS (
  SELECT active_date, COUNT(DISTINCT analytics_user_key) AS users
  FROM activity_14
  GROUP BY active_date
),
seven_day AS (
  SELECT
    (SELECT COUNT(DISTINCT analytics_user_key) FROM activity_14 a CROSS JOIN params p WHERE a.active_date >= p.report_date - 6) AS active_7d,
    (SELECT COUNT(DISTINCT analytics_user_key) FROM activity_14 a CROSS JOIN params p WHERE a.active_date BETWEEN p.report_date - 13 AND p.report_date - 7) AS previous_active_7d,
    COALESCE((SELECT AVG(users::numeric) FROM daily_counts d CROSS JOIN params p WHERE d.active_date >= p.report_date - 6), 0) AS avg_dau_7d
),
report_label AS (SELECT TO_CHAR(report_date, 'FMDay, FMMonth DD, YYYY') AS label FROM params)
SELECT rl.label AS report_date_label,
  a.daily_active_users, a.new_users, (a.daily_active_users - a.new_users) AS returning_users,
  s.*, ls.*, mcs.*, mrs.*, fc.philosopher_flows, fc.matched_flows, r.ranked_debates, r.ranked_users,
  ps.paid_pro, ps.trial_pro, t.raw_events, t.account_linked_events,
  t.philosopher_missing_flow, t.normal_starts_missing_flow,
  sd.active_7d, sd.previous_active_7d, ROUND(sd.avg_dau_7d, 1) AS avg_dau_7d
FROM report_label rl CROSS JOIN activity a CROSS JOIN summary s CROSS JOIN learn_summary ls
CROSS JOIN mirror_completion_summary mcs CROSS JOIN mirror_return_summary mrs CROSS JOIN flow_conversion fc
CROSS JOIN ranked r CROSS JOIN pro_summary ps CROSS JOIN tracking t CROSS JOIN seven_day sd;
`;

const PLATFORM_SQL = `
WITH params AS (
  SELECT ((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::date AS report_date
),
bounds AS (
  SELECT
    report_date::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
    (report_date + 1)::timestamp AT TIME ZONE 'America/Chicago' AS end_time
  FROM params
),
${CANONICAL_ACTIVITY_CTES},
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
activity_event_platforms AS (
  SELECT DISTINCT ON (e.user_id)
    e.user_id AS installation_id,
    LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) AS platform
  FROM user_events e
  CROSS JOIN bounds b
  WHERE e.created_at >= b.start_time
    AND e.created_at < b.end_time
    AND LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) IN ('ios','android')
  ORDER BY e.user_id, e.created_at DESC
),
platform_activity AS (
  SELECT DISTINCT
    ca.analytics_user_key,
    COALESCE(aep.platform, ap.account_platform, 'unknown') AS platform
  FROM canonical_activity ca
  CROSS JOIN params p
  LEFT JOIN activity_event_platforms aep
    ON aep.installation_id = ca.installation_id
  LEFT JOIN account_platforms ap
    ON ap.account_id = ca.account_id
  WHERE ca.active_date = p.report_date
),
events AS (
  SELECT
    e.*,
    ia.account_id,
    COALESCE(
      'account:' || ia.account_id::text,
      'installation:' || e.user_id
    ) AS analytics_user_key,
    COALESCE(
      CASE
        WHEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), '')) IN ('ios','android')
          THEN LOWER(NULLIF(BTRIM(e.metadata->>'clientPlatform'), ''))
      END,
      ap.account_platform,
      'unknown'
    ) AS platform,
    NULLIF(BTRIM(e.metadata->>'flowId'), '') AS flow_id,
    NULLIF(BTRIM(e.metadata->>'debateId'), '') AS debate_id
  FROM user_events e
  CROSS JOIN bounds b
  LEFT JOIN installation_accounts ia
    ON ia.installation_id = e.user_id
  LEFT JOIN account_platforms ap
    ON ap.account_id = ia.account_id
  WHERE e.created_at >= b.start_time
    AND e.created_at < b.end_time
    AND NOT EXISTS (
      SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
    )
    AND (
      ia.account_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id
      )
    )
),
philosopher_flows AS (
  SELECT DISTINCT analytics_user_key, platform, flow_id
  FROM events
  WHERE event_name = 'philosopher_selected'
    AND flow_id IS NOT NULL
),
matched AS (
  SELECT pf.*
  FROM philosopher_flows pf
  WHERE EXISTS (
    SELECT 1
    FROM events e
    WHERE e.analytics_user_key = pf.analytics_user_key
      AND e.flow_id = pf.flow_id
      AND e.event_name = 'debate_started'
      AND e.metadata->>'isDailyChallenge' = 'false'
  )
)
SELECT
  p.platform,
  (
    SELECT COUNT(DISTINCT pa.analytics_user_key)
    FROM platform_activity pa
    WHERE pa.platform = p.platform
  ) AS active_users,
  COUNT(DISTINCT COALESCE(e.debate_id, e.id::text))
    FILTER (
      WHERE e.event_name = 'debate_started'
        AND e.metadata->>'isDailyChallenge' = 'false'
    ) AS debate_starts,
  (SELECT COUNT(*) FROM philosopher_flows pf WHERE pf.platform = p.platform) AS philosopher_flows,
  (SELECT COUNT(*) FROM matched m WHERE m.platform = p.platform) AS matched_flows
FROM (VALUES ('ios'::text), ('android'::text)) p(platform)
LEFT JOIN events e
  ON e.platform = p.platform
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
  SELECT generate_series(
    params.start_date,
    params.end_date,
    INTERVAL '1 day'
  )::date AS active_date
  FROM params
),
${CANONICAL_ACTIVITY_CTES},
first_seen AS (
  SELECT analytics_user_key, MIN(active_date) AS first_active_date
  FROM canonical_activity
  GROUP BY analytics_user_key
),
daily_active AS (
  SELECT active_date, COUNT(DISTINCT analytics_user_key) AS daily_active_users
  FROM canonical_activity
  GROUP BY active_date
),
daily_new AS (
  SELECT first_active_date AS active_date, COUNT(*) AS new_users
  FROM first_seen
  GROUP BY first_active_date
)
SELECT
  TO_CHAR(days.active_date, 'MM-DD-YYYY Dy') AS report_date,
  COALESCE(daily_active.daily_active_users, 0) AS daily_active_users,
  COALESCE(daily_new.new_users, 0) AS new_users,
  COALESCE(daily_active.daily_active_users, 0)
    - COALESCE(daily_new.new_users, 0) AS returning_users
FROM days
LEFT JOIN daily_active
  ON days.active_date = daily_active.active_date
LEFT JOIN daily_new
  ON days.active_date = daily_new.active_date
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
  const mirrorFailures = toNumber(row.mirror_analysis_failures);
  if (mirrorFailures > 0) warnings.push(`${mirrorFailures} Mirror analysis failure${mirrorFailures === 1 ? '' : 's'} recorded.`);

  const learnMissingFeature = toNumber(row.learn_events_missing_feature);
  const learnUnknownFeature = toNumber(row.learn_events_unknown_feature);
  const learnMissingItem = toNumber(row.learn_item_events_missing_id);
  const learnMissingCourse = toNumber(row.learn_course_events_missing_id);
  const mirrorMissingCycle = toNumber(row.mirror_events_missing_cycle);
  const mirrorInvalidNumber = toNumber(row.mirror_events_invalid_number);

  if (learnMissingFeature > 0) warnings.push(`${learnMissingFeature} Learn event${learnMissingFeature === 1 ? '' : 's'} missing feature metadata.`);
  if (learnUnknownFeature > 0) warnings.push(`${learnUnknownFeature} Learn event${learnUnknownFeature === 1 ? '' : 's'} used an unknown feature value.`);
  if (learnMissingItem > 0) warnings.push(`${learnMissingItem} Learn item event${learnMissingItem === 1 ? '' : 's'} missing itemId.`);
  if (learnMissingCourse > 0) warnings.push(`${learnMissingCourse} Learn course completion${learnMissingCourse === 1 ? '' : 's'} missing courseId.`);
  if (mirrorMissingCycle > 0) warnings.push(`${mirrorMissingCycle} Mirror event${mirrorMissingCycle === 1 ? '' : 's'} missing cycleId.`);
  if (mirrorInvalidNumber > 0) warnings.push(`${mirrorInvalidNumber} Mirror event${mirrorInvalidNumber === 1 ? '' : 's'} missing a valid mirrorNumber.`);

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
      `<b>LEARN</b>`,
      `Learn Hub: ${toNumber(row.learn_hub_users)} ${toNumber(row.learn_hub_users) === 1 ? 'user' : 'users'}`,
      `Learn Philosophy: ${toNumber(row.learn_philosophy_opened_users)} opened • ${toNumber(row.learn_philosophy_started_users)} started • ${toNumber(row.learn_philosophy_completed_users)} completed`,
      `↳ ${toNumber(row.learn_philosophy_item_completions)} items completed • ${toNumber(row.learn_philosophy_course_completions)} courses finished`,
      `Thought Experiment Lab: ${toNumber(row.thought_lab_opened_users)} opened • ${toNumber(row.thought_lab_started_users)} started • ${toNumber(row.thought_lab_completed_users)} completed`,
      `↳ ${toNumber(row.thought_lab_item_completions)} experiments completed • ${toNumber(row.thought_lab_course_completions)} full-lab finishes`,
      `Modern Cases: ${toNumber(row.modern_cases_opened_users)} opened • ${toNumber(row.modern_cases_started_users)} started • ${toNumber(row.modern_cases_completed_users)} completed`,
      `↳ ${toNumber(row.modern_cases_item_completions)} cases completed • ${toNumber(row.modern_cases_course_completions)} full-set finishes`,
      `Where Do You Stand?: ${toNumber(row.stance_opened_users)} opened • ${toNumber(row.stance_started_users)} started • ${toNumber(row.stance_completed_users)} completed`,
      `↳ ${toNumber(row.stance_item_completions)} positions completed • ${toNumber(row.stance_course_completions)} full-set finishes`, ``,
      `<b>THE MIRROR</b>`,
      `${toNumber(row.mirror_opened_users)} opened`,
      `Questionnaire: ${toNumber(row.mirror_questionnaire_started_events)} started • ${toNumber(row.mirror_questionnaire_completed_events)} submitted`,
      `Generation: ${toNumber(row.mirror_generation_attempts)} attempts • ${toNumber(row.mirror_analysis_generated_events)} generated • ${toNumber(row.mirror_analysis_failures)} failed`,
      `Reading: ${toNumber(row.mirror_readers_50_users)} reached 50% • ${toNumber(row.mirror_readers_100_users)} reached 100%`,
      `Engagement: ${toNumber(row.mirror_detail_expansion_events)} detail expands • ${toNumber(row.mirror_evidence_open_events)} evidence opens • ${toNumber(row.mirror_recommendation_tap_events)} recommendation taps`,
      `Next Mirror eligible seen: ${toNumber(row.mirror_next_eligible_seen_events)} • client completion events: ${toNumber(row.mirror_completed_events)}`,
      `Server completions: #1 ${toNumber(row.mirror_1_completed)} • #2 ${toNumber(row.mirror_2_completed)} • #3 ${toNumber(row.mirror_3_completed)}`,
      `Starting Mirror → Mirror #2: ${toNumber(row.mirror_2_returned)}/${toNumber(row.mirror_2_eligible)} (${percent(row.mirror_2_returned, row.mirror_2_eligible)})`, ``,
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