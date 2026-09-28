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
${CANONICAL_ACTIVITY_CTES},
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
    COALESCE(
      'account:' || ia.account_id::text,
      'installation:' || e.user_id
    ) AS analytics_user_key,
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
current_activity AS (
  SELECT DISTINCT ca.analytics_user_key
  FROM canonical_activity ca
  CROSS JOIN bounds b
  WHERE ca.active_date >= b.month_start
    AND ca.active_date < b.month_end
),
previous_activity AS (
  SELECT DISTINCT ca.analytics_user_key
  FROM canonical_activity ca
  CROSS JOIN bounds b
  WHERE ca.active_date >= b.previous_start
    AND ca.active_date < b.previous_end
),
activity AS (
  SELECT
    (SELECT COUNT(*) FROM current_activity) AS monthly_active_users,
    (SELECT COUNT(*) FROM previous_activity) AS previous_month_active_users,
    (
      SELECT COUNT(*)
      FROM current_activity ca
      JOIN previous_activity pa USING (analytics_user_key)
    ) AS retained_users,
    (
      SELECT COUNT(*)
      FROM current_activity ca
      JOIN first_seen fs USING (analytics_user_key)
      CROSS JOIN bounds b
      WHERE fs.first_active_date >= b.month_start
        AND fs.first_active_date < b.month_end
    ) AS new_users
),
philosopher_flows AS (
  SELECT DISTINCT analytics_user_key, platform, flow_id FROM events WHERE event_name = 'philosopher_selected' AND flow_id IS NOT NULL
),
matched_flows AS (
  SELECT pf.* FROM philosopher_flows pf WHERE EXISTS (
    SELECT 1 FROM events e WHERE e.analytics_user_key = pf.analytics_user_key AND e.flow_id = pf.flow_id
      AND e.event_name = 'debate_started' AND e.metadata->>'isDailyChallenge' = 'false'
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
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
    ) AS learn_philosophy_started_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'learn_philosophy'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS learn_philosophy_item_starts,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'learn_philosophy'
    ) AS learn_philosophy_completed_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'learn_philosophy'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS learn_philosophy_item_completions,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'courseId'), '')
    )) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'learn_philosophy'
        AND NULLIF(BTRIM(metadata->>'courseId'), '') IS NOT NULL
    ) AS learn_philosophy_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'thought_lab'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
    ) AS thought_lab_started_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'thought_lab'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS thought_lab_item_starts,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'thought_lab'
    ) AS thought_lab_completed_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'thought_lab'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS thought_lab_item_completions,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'courseId'), '')
    )) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'thought_lab'
        AND NULLIF(BTRIM(metadata->>'courseId'), '') IS NOT NULL
    ) AS thought_lab_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'modern_cases'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
    ) AS modern_cases_started_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'modern_cases'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS modern_cases_item_starts,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'modern_cases'
    ) AS modern_cases_completed_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'modern_cases'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS modern_cases_item_completions,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'courseId'), '')
    )) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'modern_cases'
        AND NULLIF(BTRIM(metadata->>'courseId'), '') IS NOT NULL
    ) AS modern_cases_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_opened_users,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'where_do_you_stand'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
    ) AS stance_started_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_started'
        AND metadata->>'feature' = 'where_do_you_stand'
        AND COALESCE(metadata->>'wasCompletedBeforeOpen', 'false') <> 'true'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS stance_item_starts,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
    ) AS stance_completed_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'itemId'), '')
    )) FILTER (
      WHERE event_name = 'learn_item_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
        AND NULLIF(BTRIM(metadata->>'itemId'), '') IS NOT NULL
    ) AS stance_item_completions,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'courseId'), '')
    )) FILTER (
      WHERE event_name = 'learn_course_completed'
        AND metadata->>'feature' = 'where_do_you_stand'
        AND NULLIF(BTRIM(metadata->>'courseId'), '') IS NOT NULL
    ) AS stance_course_completions,
    COUNT(DISTINCT analytics_user_key) FILTER (
      WHERE event_name = 'learn_card_opened'
        AND metadata->>'feature' = 'mirror'
    ) AS mirror_opened_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_questionnaire_started'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
    ) AS mirror_questionnaire_started_events,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_questionnaire_completed'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
    ) AS mirror_questionnaire_completed_events,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_generation_started'
    ) AS mirror_generation_attempts,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_generation_started'
        AND COALESCE(metadata->>'source', 'questionnaire_submit') = 'questionnaire_submit'
    ) AS mirror_initial_generation_attempts,
    COUNT(*) FILTER (
      WHERE event_name = 'mirror_analysis_generation_started'
        AND metadata->>'source' = 'retry'
    ) AS mirror_retry_generation_attempts,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_analysis_generated'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
    ) AS mirror_analysis_generated_events,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), ''),
      COALESCE(
        NULLIF(BTRIM(metadata->>'failureToken'), ''),
        NULLIF(BTRIM(metadata->>'clientEventId'), ''),
        id::text
      )
    )) FILTER (
      WHERE event_name = 'mirror_analysis_failed'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
    ) AS mirror_analysis_failures,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_analysis_read_depth'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
        AND CASE
          WHEN COALESCE(metadata->>'depth', '') ~ '^[0-9]+$'
            THEN (metadata->>'depth')::integer
          ELSE 0
        END >= 50
    ) AS mirror_readers_50_users,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_analysis_read_depth'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
        AND COALESCE(metadata->>'depth', '') = '100'
    ) AS mirror_readers_100_users,
    COUNT(*) FILTER (WHERE event_name = 'mirror_detail_expanded') AS mirror_detail_expansion_events,
    COUNT(*) FILTER (WHERE event_name = 'mirror_evidence_opened') AS mirror_evidence_open_events,
    COUNT(*) FILTER (WHERE event_name = 'mirror_recommendation_tapped') AS mirror_recommendation_tap_events,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_next_eligible_seen'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
    ) AS mirror_next_eligible_seen_events,
    COUNT(DISTINCT (
      analytics_user_key,
      NULLIF(BTRIM(metadata->>'cycleId'), '')
    )) FILTER (
      WHERE event_name = 'mirror_completed'
        AND NULLIF(BTRIM(metadata->>'cycleId'), '') IS NOT NULL
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
    COUNT(*) AS mirror_server_completed_total,
    COUNT(*) FILTER (WHERE s.cycle_number = 1) AS mirror_1_completed,
    COUNT(*) FILTER (WHERE s.cycle_number = 2) AS mirror_2_completed,
    COUNT(*) FILTER (WHERE s.cycle_number = 3) AS mirror_3_completed,
    COUNT(*) FILTER (WHERE s.cycle_number >= 4) AS mirror_4_plus_completed
  FROM account_mirror_snapshots s
  CROSS JOIN bounds b
  WHERE s.generated_at >= b.start_time
    AND s.generated_at < b.end_time
    AND NOT EXISTS (
      SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = s.account_id
    )
),
mirror_cycle_summary AS (
  SELECT
    COUNT(*) FILTER (
      WHERE c.questionnaire_started_at >= b.start_time
        AND c.questionnaire_started_at < b.end_time
    ) AS mirror_server_questionnaire_starts,
    COUNT(*) FILTER (
      WHERE c.questionnaire_completed_at >= b.start_time
        AND c.questionnaire_completed_at < b.end_time
    ) AS mirror_server_questionnaire_submissions,
    COUNT(*) FILTER (
      WHERE c.failed_at >= b.start_time
        AND c.failed_at < b.end_time
    ) AS mirror_server_failures
  FROM account_mirror_cycles c
  CROSS JOIN bounds b
  WHERE NOT EXISTS (
    SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = c.account_id
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
SELECT l.report_month, a.*, (a.monthly_active_users - a.new_users) AS returning_users, s.*, ls.*, mcs.*, mcys.*, mrs.*,
  (SELECT COUNT(*) FROM philosopher_flows) AS philosopher_flows,
  (SELECT COUNT(*) FROM matched_flows) AS matched_flows,
  r.ranked_debates, r.ranked_users, ps.paid_pro, ps.trial_pro, t.*
FROM label l CROSS JOIN activity a CROSS JOIN summary s CROSS JOIN learn_summary ls
CROSS JOIN mirror_completion_summary mcs CROSS JOIN mirror_cycle_summary mcys CROSS JOIN mirror_return_summary mrs
CROSS JOIN ranked r CROSS JOIN pro_summary ps CROSS JOIN tracking t;
`;

const PLATFORM_SQL = `
WITH runtime AS (
  SELECT CASE
    WHEN $1::text IS NOT NULL THEN ($1 || '-01')::date
    ELSE (
      date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date
      - INTERVAL '1 month'
    )::date
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
  CROSS JOIN bounds b
  LEFT JOIN activity_event_platforms aep
    ON aep.installation_id = ca.installation_id
  LEFT JOIN account_platforms ap
    ON ap.account_id = ca.account_id
  WHERE ca.active_date >= b.month_start
    AND ca.active_date < b.month_end
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

function trackingWarnings(row) {
  const warnings = [];
  const raw = toNumber(row.raw_events);
  const linked = toNumber(row.account_linked_events);
  if (raw > linked) warnings.push(`${raw - linked} events could not be linked to an Agora account.`);
  if (toNumber(row.philosopher_missing_flow) > 0) warnings.push(`${toNumber(row.philosopher_missing_flow)} philosopher selections were missing flowId.`);
  if (toNumber(row.normal_starts_missing_flow) > 0) warnings.push(`${toNumber(row.normal_starts_missing_flow)} normal debate starts were missing flowId.`);
  if (toNumber(row.report_generation_failures) > 0) warnings.push(`${toNumber(row.report_generation_failures)} debate report generation failures were recorded.`);
  const mirrorFailures = toNumber(row.mirror_server_failures);
  if (mirrorFailures > 0) warnings.push(`${mirrorFailures} server-confirmed Mirror analysis failure${mirrorFailures === 1 ? '' : 's'} recorded.`);

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
      `<b>LEARN</b>`,
      `Learn Hub: ${toNumber(row.learn_hub_users)} ${toNumber(row.learn_hub_users) === 1 ? 'user' : 'users'}`,
      `Learn Philosophy: ${toNumber(row.learn_philosophy_opened_users)} users opened • ${toNumber(row.learn_philosophy_started_users)} started • ${toNumber(row.learn_philosophy_completed_users)} completed`,
      `↳ ${toNumber(row.learn_philosophy_item_starts)} new item starts • ${toNumber(row.learn_philosophy_item_completions)} items completed • ${toNumber(row.learn_philosophy_course_completions)} courses finished`,
      `Thought Experiment Lab: ${toNumber(row.thought_lab_opened_users)} users opened • ${toNumber(row.thought_lab_started_users)} started • ${toNumber(row.thought_lab_completed_users)} completed`,
      `↳ ${toNumber(row.thought_lab_item_starts)} new experiment starts • ${toNumber(row.thought_lab_item_completions)} experiments completed • ${toNumber(row.thought_lab_course_completions)} full-lab finishes`,
      `Modern Cases: ${toNumber(row.modern_cases_opened_users)} users opened • ${toNumber(row.modern_cases_started_users)} started • ${toNumber(row.modern_cases_completed_users)} completed`,
      `↳ ${toNumber(row.modern_cases_item_starts)} new case starts • ${toNumber(row.modern_cases_item_completions)} cases completed • ${toNumber(row.modern_cases_course_completions)} full-set finishes`,
      `Where Do You Stand?: ${toNumber(row.stance_opened_users)} users opened • ${toNumber(row.stance_started_users)} started • ${toNumber(row.stance_completed_users)} completed`,
      `↳ ${toNumber(row.stance_item_starts)} new position starts • ${toNumber(row.stance_item_completions)} positions completed • ${toNumber(row.stance_course_completions)} full-set finishes`, ``,
      `<b>THE MIRROR</b>`,
      `${toNumber(row.mirror_opened_users)} users opened`,
      `Questionnaire (server): ${toNumber(row.mirror_server_questionnaire_starts)} started • ${toNumber(row.mirror_server_questionnaire_submissions)} submitted`,
      `Questionnaire events (client): ${toNumber(row.mirror_questionnaire_started_events)} started • ${toNumber(row.mirror_questionnaire_completed_events)} submitted`,
      `Generation attempts (client): ${toNumber(row.mirror_initial_generation_attempts)} initial • ${toNumber(row.mirror_retry_generation_attempts)} retries`,
      `Analysis (server): ${toNumber(row.mirror_server_completed_total)} completed • ${toNumber(row.mirror_server_failures)} failed`,
      `Client observations: ${toNumber(row.mirror_analysis_generated_events)} generated • ${toNumber(row.mirror_analysis_failures)} failed • ${toNumber(row.mirror_completed_events)} completed`,
      `Reading: ${toNumber(row.mirror_readers_50_users)} Mirror reports reached 50% • ${toNumber(row.mirror_readers_100_users)} reached 100%`,
      `Engagement: ${toNumber(row.mirror_detail_expansion_events)} detail expands • ${toNumber(row.mirror_evidence_open_events)} evidence opens • ${toNumber(row.mirror_recommendation_tap_events)} recommendation taps`,
      `Next Mirror eligible seen: ${toNumber(row.mirror_next_eligible_seen_events)}`,
      `Server completions: #1 ${toNumber(row.mirror_1_completed)} • #2 ${toNumber(row.mirror_2_completed)} • #3 ${toNumber(row.mirror_3_completed)} • #4+ ${toNumber(row.mirror_4_plus_completed)}`,
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
