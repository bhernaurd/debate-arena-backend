import pg from "pg";
import { sendAnalyticsEmail } from "./emailReporter.js";
import { buildMonthlyBusinessAnalytics } from "./businessAnalyticsReport.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Optional manual testing override.
// Example:
// REPORT_MONTH=2026-06 npm run monthly-analytics-report
const REPORT_MONTH = process.env.REPORT_MONTH || null;

function toNumber(value) {
  return Number(value || 0);
}

function percent(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);

  if (d === 0) return "—";

  return `${((n / d) * 100).toFixed(1)}%`;
}

function formatNetChange(value) {
  const n = Number(value || 0);

  if (n > 0) return `+${n}`;
  return `${n}`;
}

function formatGrowthRate(currentMonthActiveUsers, previousMonthActiveUsers) {
  const current = Number(currentMonthActiveUsers || 0);
  const previous = Number(previousMonthActiveUsers || 0);

  if (previous === 0) return "—";

  return `${(((current - previous) / previous) * 100).toFixed(1)}%`;
}

function formatSeconds(value) {
  if (value === null || value === undefined) return "—";

  const numberValue = Number(value);

  if (Number.isNaN(numberValue)) return "—";

  return `${numberValue.toFixed(2)}s`;
}

function stripTelegramHtml(value = "") {
  return String(value)
    .replaceAll("<b>", "")
    .replaceAll("</b>", "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'");
}

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count || 0) === 1 ? singular : plural;
}

function chooseBiggestDropOff(data) {
  const candidates = [];

  function addCandidate({
    key,
    label,
    from,
    to,
    fromLabel,
    toLabel,
    action,
  }) {
    const start = Number(from || 0);
    const end = Number(to || 0);

    if (start <= 0) return;

    const boundedEnd = Math.min(end, start);
    const dropRate = (start - boundedEnd) / start;

    candidates.push({
      key,
      label,
      from: start,
      to: boundedEnd,
      fromLabel,
      toLabel,
      dropRate,
      action,
    });
  }

  addCandidate({
    key: "daily_challenge_start",
    label: "Daily Challenge viewer-days → same-day starter-days",
    from: data.dailyChallengeViewerDays,
    to: data.dailyChallengeViewerStarterDays,
    fromLabel: "viewer-days",
    toLabel: "matched starter-days",
    action:
      "Improve the Daily Challenge intro and CTA. Make the prompt feel more urgent and make Enter the Agora the obvious next step.",
  });

  addCandidate({
    key: "daily_challenge_completion",
    label: "Daily Challenge starter-days → same-day completion-days",
    from: data.dailyChallengeStarterDays,
    to: data.dailyChallengeStarterCompletionDays,
    fromLabel: "starter-days",
    toLabel: "matched completion-days",
    action:
      "Improve Daily Challenge completion. Make the Finish Debate button more obvious and make the report payoff feel immediate.",
  });

  addCandidate({
    key: "philosopher_to_topic",
    label: "Philosopher selector-days → same-day topic selector-days",
    from: data.philosopherSelectorDays,
    to: data.philosopherTopicOverlapDays,
    fromLabel: "selector-days",
    toLabel: "matched topic-days",
    action:
      "Improve the topic selection step. Make the questions more immediately compelling after a user selects a philosopher, and make generated topics more prominent.",
  });

  addCandidate({
    key: "topic_to_difficulty",
    label: "Topic selector-days → same-day difficulty selector-days",
    from: data.topicSelectorDays,
    to: data.topicDifficultyOverlapDays,
    fromLabel: "selector-days",
    toLabel: "matched difficulty-days",
    action:
      "Review the difficulty selection screen. Make Guided, Balanced, and Relentless instantly clear and reduce hesitation before starting.",
  });

  addCandidate({
    key: "difficulty_to_normal_start",
    label: "Difficulty selector-days → same-day normal debate starter-days",
    from: data.difficultySelectorDays,
    to: data.difficultyStartOverlapDays,
    fromLabel: "selector-days",
    toLabel: "matched starter-days",
    action:
      "Check the handoff from difficulty selection into the debate screen. Make sure the debate starts quickly and the loading state feels intentional.",
  });

  addCandidate({
    key: "normal_start_to_completion",
    label: "Tracked normal debate starts → matched completions",
    from: data.trackedNormalDebateStarts,
    to: data.matchedNormalDebateCompletions,
    fromLabel: "tracked starts",
    toLabel: "matched completions",
    action:
      "Review normal debate completion. Make the Finish Debate button visible after a real exchange and make the report feel like the reward for finishing.",
  });

  addCandidate({
    key: "report_to_share",
    label: "Tracked report views → reports shared",
    from: data.trackedReportViews,
    to: data.matchedReportShares,
    fromLabel: "viewed reports",
    toLabel: "shared reports",
    action:
      "Improve the share-card CTA. Show it immediately after the report score and make the card feel worth saving or posting.",
  });

  if (candidates.length === 0) {
    return {
      biggestDropOff: "No usable matched monthly funnel data yet.",
      recommendedAction:
        "No action needed yet. Keep collecting data and review the next monthly report.",
    };
  }

  const biggest = candidates.sort((a, b) => b.dropRate - a.dropRate)[0];

  return {
    biggestDropOff: `${biggest.label} dropped from ${biggest.from} ${biggest.fromLabel} to ${biggest.to} ${biggest.toLabel}.`,
    recommendedAction: biggest.action,
  };
}

function chooseStrongestArea(data) {
  const dailyChallengeCompletions = toNumber(data.dailyChallengeCompletions);
  const normalDebateCompletions = toNumber(data.normalDebateCompletions);
  const reportViews = toNumber(data.reportViews);
  const shareCardsCreated = toNumber(data.shareCardsCreated);

  if (dailyChallengeCompletions > 0 && dailyChallengeCompletions >= normalDebateCompletions) {
    return `Daily Challenge usage is the strongest signal. Users completed ${dailyChallengeCompletions} Daily Challenges this month.`;
  }

  if (normalDebateCompletions > 0) {
    return `Normal debate usage is the strongest signal. Users completed ${normalDebateCompletions} normal debates this month.`;
  }

  if (reportViews > 0) {
    return `Users are reaching reports. There were ${reportViews} total report views this month.`;
  }

  if (shareCardsCreated > 0) {
    return `Sharing showed activity. Users created ${shareCardsCreated} share cards this month.`;
  }

  return "No clear strongest area yet. The month needs more user activity.";
}

function chooseReportGenerationNote({
  reportsGeneratedWithTiming,
  averageGenerationSeconds,
  slowestGenerationSeconds,
}) {
  const timed = toNumber(reportsGeneratedWithTiming);

  if (timed === 0) {
    return "No completed report-generation timing recorded this month.";
  }

  const average = Number(averageGenerationSeconds || 0);
  const slowest = Number(slowestGenerationSeconds || 0);

  if (average >= 10) {
    return "Average report generation time is high. Prioritize reducing report generation latency.";
  }

  if (slowest >= 20) {
    return "One or more reports generated very slowly. Check slowest report cases and backend latency.";
  }

  return "Report generation timing looks healthy based on completed report generations.";
}

function chooseTrackingNote({
  reportMonth,
  reportsGeneratedWithTiming,
  normalDebateStarts,
  trackedNormalDebateStarts,
  reportViews,
  trackedReportViews,
}) {
  const notes = [
    "Monthly funnel percentages use matched Central-time user-days or matching debateId values; raw activity totals are shown separately.",
  ];

  const timed = toNumber(reportsGeneratedWithTiming);
  const rawStarts = toNumber(normalDebateStarts);
  const trackedStarts = toNumber(trackedNormalDebateStarts);
  const rawReportViews = toNumber(reportViews);
  const trackedViews = toNumber(trackedReportViews);

  if (rawStarts > trackedStarts) {
    notes.push(
      `${rawStarts - trackedStarts} normal debate start event(s) lacked a usable debateId and were excluded from the matched completion rate.`
    );
  }

  if (rawReportViews > trackedViews) {
    notes.push(
      `${rawReportViews - trackedViews} report view event(s) lacked a usable debateId and were excluded from the matched report-to-share rate.`
    );
  }

  if (timed === 0) {
    notes.push(
      "No completed report-generation timing was recorded; this can mean no new reports were generated or users were on older app versions."
    );
  }

  if (String(reportMonth || "").includes("June 2026")) {
    notes.push(
      "June should be treated as a transition month because analytics tracking was actively improved during the month."
    );
  }

  if (String(reportMonth || "").includes("July 2026")) {
    notes.push(
      "Free/Trial/Paid Pro and subscription lifecycle analytics begin with the July 31 release, so July is only a partial rollout month. August is the first full comparable month."
    );
  }

  return notes.join(" ");
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  if (!TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_CHAT_ID");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }
}

function validateReportMonth(value) {
  if (!value) return null;

  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error("REPORT_MONTH must use YYYY-MM format, for example 2026-06.");
  }

  return value;
}

async function main() {
  const client = await pool.connect();

  try {
    const reportMonthOverride = validateReportMonth(REPORT_MONTH);

    const result = await client.query(
      `
      WITH runtime AS (
        SELECT
          CASE
            WHEN $1::text IS NOT NULL
              THEN ($1::text || '-01')::date
            ELSE
              (
                date_trunc('month', NOW() AT TIME ZONE 'America/Chicago')::date
                - INTERVAL '1 month'
              )::date
          END AS report_month_start
      ),
      bounds AS (
        SELECT
          report_month_start,
          (report_month_start + INTERVAL '1 month')::date AS report_month_end,
          (report_month_start - INTERVAL '1 month')::date AS previous_month_start,
          report_month_start AS previous_month_end,
          report_month_start::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
          (report_month_start + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
        FROM runtime
      ),
      eligible_events AS (
        SELECT
          e.*,
          (e.created_at AT TIME ZONE 'America/Chicago')::date AS central_date,
          NULLIF(BTRIM(e.metadata->>'debateId'), '') AS analytics_debate_id
        FROM user_events e
        CROSS JOIN bounds b
        WHERE e.created_at >= b.start_time
          AND e.created_at < b.end_time
          AND NOT EXISTS (
            SELECT 1
            FROM excluded_analytics_users x
            WHERE x.user_id = e.user_id
          )
      ),
      first_seen AS (
        SELECT
          user_id,
          MIN(active_date) AS first_active_date
        FROM user_activity_days
        WHERE NOT EXISTS (
          SELECT 1
          FROM excluded_analytics_users x
          WHERE x.user_id = user_activity_days.user_id
        )
        GROUP BY user_id
      ),
      current_month_users AS (
        SELECT DISTINCT uad.user_id
        FROM user_activity_days uad
        CROSS JOIN bounds b
        WHERE uad.active_date >= b.report_month_start
          AND uad.active_date < b.report_month_end
          AND NOT EXISTS (
            SELECT 1
            FROM excluded_analytics_users x
            WHERE x.user_id = uad.user_id
          )
      ),
      current_month_user_days AS (
        SELECT DISTINCT uad.user_id, uad.active_date
        FROM user_activity_days uad
        CROSS JOIN bounds b
        WHERE uad.active_date >= b.report_month_start
          AND uad.active_date < b.report_month_end
          AND NOT EXISTS (
            SELECT 1
            FROM excluded_analytics_users x
            WHERE x.user_id = uad.user_id
          )
      ),
      previous_month_users AS (
        SELECT DISTINCT uad.user_id
        FROM user_activity_days uad
        CROSS JOIN bounds b
        WHERE uad.active_date >= b.previous_month_start
          AND uad.active_date < b.previous_month_end
          AND NOT EXISTS (
            SELECT 1
            FROM excluded_analytics_users x
            WHERE x.user_id = uad.user_id
          )
      ),
      activity_summary AS (
        SELECT
          b.report_month_start,
          b.report_month_end,
          COUNT(DISTINCT cmu.user_id) AS monthly_active_users,
          (
            SELECT COUNT(DISTINCT pmu.user_id)
            FROM previous_month_users pmu
          ) AS previous_month_active_users,
          COUNT(DISTINCT cmu.user_id)
          - (
            SELECT COUNT(DISTINCT pmu.user_id)
            FROM previous_month_users pmu
          ) AS net_user_change,
          COUNT(DISTINCT cmu.user_id) FILTER (
            WHERE fs.first_active_date >= b.report_month_start
              AND fs.first_active_date < b.report_month_end
          ) AS new_users_this_month,
          COUNT(DISTINCT cmu.user_id) FILTER (
            WHERE fs.first_active_date < b.report_month_start
          ) AS returning_users_this_month,
          COUNT(DISTINCT cmu.user_id) FILTER (
            WHERE cmu.user_id IN (
              SELECT user_id FROM previous_month_users
            )
          ) AS retained_users_from_last_month,
          (
            SELECT COUNT(DISTINCT pmu.user_id)
            FROM previous_month_users pmu
            WHERE NOT EXISTS (
              SELECT 1
              FROM current_month_users current_user
              WHERE current_user.user_id = pmu.user_id
            )
          ) AS lost_users_from_last_month
        FROM bounds b
        LEFT JOIN current_month_users cmu ON true
        LEFT JOIN first_seen fs ON cmu.user_id = fs.user_id
        GROUP BY b.report_month_start, b.report_month_end
      ),
      event_summary AS (
        SELECT
          b.report_month_start,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_viewers,
          COUNT(*) FILTER (
            WHERE e.event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_views,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'daily_challenge_started'
          ) AS daily_challenge_starters,
          COUNT(*) FILTER (
            WHERE e.event_name = 'daily_challenge_started'
          ) AS daily_challenge_starts,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'daily_challenge_completed'
          ) AS daily_challenge_completers,
          COUNT(*) FILTER (
            WHERE e.event_name = 'daily_challenge_completed'
          ) AS daily_challenge_completions,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'philosopher_selected'
          ) AS philosopher_selectors,
          COUNT(*) FILTER (
            WHERE e.event_name = 'philosopher_selected'
          ) AS philosopher_selections,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'topic_selected'
          ) AS topic_selectors,
          COUNT(*) FILTER (
            WHERE e.event_name = 'topic_selected'
          ) AS topic_selections,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'difficulty_selected'
          ) AS difficulty_selectors,
          COUNT(*) FILTER (
            WHERE e.event_name = 'difficulty_selected'
          ) AS difficulty_selections,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'debate_started'
              AND e.metadata->>'isDailyChallenge' = 'false'
          ) AS unique_normal_debate_starters,
          COUNT(DISTINCT COALESCE(e.analytics_debate_id, e.id::text)) FILTER (
            WHERE e.event_name = 'debate_started'
              AND e.metadata->>'isDailyChallenge' = 'false'
          ) AS normal_debate_starts,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'debate_completed'
              AND e.metadata->>'isDailyChallenge' = 'false'
          ) AS unique_normal_debate_completers,
          COUNT(DISTINCT COALESCE(e.analytics_debate_id, e.id::text)) FILTER (
            WHERE e.event_name = 'debate_completed'
              AND e.metadata->>'isDailyChallenge' = 'false'
          ) AS normal_debate_completions,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'report_viewed'
          ) AS unique_report_viewers,
          COUNT(*) FILTER (
            WHERE e.event_name = 'report_viewed'
          ) AS report_views,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'share_card_created'
          ) AS unique_share_card_creators,
          COUNT(*) FILTER (
            WHERE e.event_name = 'share_card_created'
          ) AS share_cards_created
        FROM bounds b
        LEFT JOIN eligible_events e ON true
        GROUP BY b.report_month_start
      ),
      stage_user_days AS (
        SELECT DISTINCT e.user_id, e.central_date, e.event_name
        FROM eligible_events e
        WHERE e.event_name IN (
          'daily_challenge_viewed',
          'daily_challenge_started',
          'daily_challenge_completed',
          'philosopher_selected',
          'topic_selected',
          'difficulty_selected'
        )
      ),
      normal_start_user_days AS (
        SELECT DISTINCT e.user_id, e.central_date
        FROM eligible_events e
        WHERE e.event_name = 'debate_started'
          AND e.metadata->>'isDailyChallenge' = 'false'
      ),
      funnel_overlap AS (
        SELECT
          (
            SELECT COUNT(*)
            FROM stage_user_days v
            WHERE v.event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_viewer_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days s
            WHERE s.event_name = 'daily_challenge_started'
          ) AS daily_challenge_starter_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days v
            WHERE v.event_name = 'daily_challenge_viewed'
              AND EXISTS (
                SELECT 1
                FROM current_month_user_days aud
                WHERE aud.user_id = v.user_id
                  AND aud.active_date = v.central_date
              )
          ) AS daily_challenge_active_viewer_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days s
            WHERE s.event_name = 'daily_challenge_started'
              AND EXISTS (
                SELECT 1
                FROM stage_user_days v
                WHERE v.user_id = s.user_id
                  AND v.central_date = s.central_date
                  AND v.event_name = 'daily_challenge_viewed'
              )
          ) AS daily_challenge_viewer_starter_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days c
            WHERE c.event_name = 'daily_challenge_completed'
              AND EXISTS (
                SELECT 1
                FROM stage_user_days s
                WHERE s.user_id = c.user_id
                  AND s.central_date = c.central_date
                  AND s.event_name = 'daily_challenge_started'
              )
          ) AS daily_challenge_starter_completion_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days c
            WHERE c.event_name = 'daily_challenge_completed'
              AND EXISTS (
                SELECT 1
                FROM stage_user_days v
                WHERE v.user_id = c.user_id
                  AND v.central_date = c.central_date
                  AND v.event_name = 'daily_challenge_viewed'
              )
          ) AS daily_challenge_viewer_completion_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days p
            WHERE p.event_name = 'philosopher_selected'
          ) AS philosopher_selector_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days t
            WHERE t.event_name = 'topic_selected'
          ) AS topic_selector_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days d
            WHERE d.event_name = 'difficulty_selected'
          ) AS difficulty_selector_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days t
            WHERE t.event_name = 'topic_selected'
              AND EXISTS (
                SELECT 1
                FROM stage_user_days p
                WHERE p.user_id = t.user_id
                  AND p.central_date = t.central_date
                  AND p.event_name = 'philosopher_selected'
              )
          ) AS philosopher_topic_overlap_days,
          (
            SELECT COUNT(*)
            FROM stage_user_days d
            WHERE d.event_name = 'difficulty_selected'
              AND EXISTS (
                SELECT 1
                FROM stage_user_days t
                WHERE t.user_id = d.user_id
                  AND t.central_date = d.central_date
                  AND t.event_name = 'topic_selected'
              )
          ) AS topic_difficulty_overlap_days,
          (
            SELECT COUNT(*)
            FROM normal_start_user_days n
            WHERE EXISTS (
              SELECT 1
              FROM stage_user_days d
              WHERE d.user_id = n.user_id
                AND d.central_date = n.central_date
                AND d.event_name = 'difficulty_selected'
            )
          ) AS difficulty_start_overlap_days
      ),
      normal_started_debates AS (
        SELECT
          e.user_id,
          e.analytics_debate_id AS debate_id,
          MIN(e.created_at) AS started_at
        FROM eligible_events e
        WHERE e.event_name = 'debate_started'
          AND e.metadata->>'isDailyChallenge' = 'false'
          AND e.analytics_debate_id IS NOT NULL
        GROUP BY e.user_id, e.analytics_debate_id
      ),
      normal_completed_debates AS (
        SELECT
          e.user_id,
          e.analytics_debate_id AS debate_id,
          MIN(e.created_at) AS completed_at
        FROM eligible_events e
        WHERE e.event_name = 'debate_completed'
          AND e.metadata->>'isDailyChallenge' = 'false'
          AND e.analytics_debate_id IS NOT NULL
        GROUP BY e.user_id, e.analytics_debate_id
      ),
      normal_debate_conversion AS (
        SELECT
          COUNT(*) AS tracked_normal_debate_starts,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM normal_completed_debates c
              WHERE c.user_id = s.user_id
                AND c.debate_id = s.debate_id
                AND c.completed_at >= s.started_at
            )
          ) AS matched_normal_debate_completions
        FROM normal_started_debates s
      ),
      viewed_report_debates AS (
        SELECT DISTINCT e.user_id, e.analytics_debate_id AS debate_id
        FROM eligible_events e
        WHERE e.event_name = 'report_viewed'
          AND e.analytics_debate_id IS NOT NULL
      ),
      shared_report_debates AS (
        SELECT DISTINCT e.user_id, e.analytics_debate_id AS debate_id
        FROM eligible_events e
        WHERE e.event_name = 'share_card_created'
          AND e.analytics_debate_id IS NOT NULL
      ),
      report_share_conversion AS (
        SELECT
          COUNT(*) AS tracked_report_views,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1
              FROM shared_report_debates s
              WHERE s.user_id = v.user_id
                AND s.debate_id = v.debate_id
            )
          ) AS matched_report_shares
        FROM viewed_report_debates v
      ),
      ranked_timing_events AS (
        SELECT
          e.user_id,
          COALESCE(e.analytics_debate_id, e.id::text) AS report_key,
          CASE
            WHEN e.metadata->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (e.metadata->>'durationMs')::numeric / 1000.0
            ELSE NULL
          END AS generation_seconds,
          ROW_NUMBER() OVER (
            PARTITION BY e.user_id, COALESCE(e.analytics_debate_id, e.id::text)
            ORDER BY e.created_at DESC, e.id DESC
          ) AS rn
        FROM eligible_events e
        WHERE e.event_name = 'report_generation_completed'
      ),
      report_generation_timing_events AS (
        SELECT generation_seconds
        FROM ranked_timing_events
        WHERE rn = 1
      ),
      report_generation_timing_summary AS (
        SELECT
          b.report_month_start,
          COUNT(t.generation_seconds) AS reports_generated_with_timing,
          ROUND(AVG(t.generation_seconds), 2) AS average_generation_seconds,
          ROUND(MIN(t.generation_seconds), 2) AS fastest_generation_seconds,
          ROUND(MAX(t.generation_seconds), 2) AS slowest_generation_seconds
        FROM bounds b
        LEFT JOIN report_generation_timing_events t ON true
        GROUP BY b.report_month_start
      )
      SELECT
        TO_CHAR(a.report_month_start, 'FMMonth YYYY') AS report_month,
        TO_CHAR(a.report_month_start, 'YYYY-MM-DD') AS report_month_start,
        TO_CHAR(a.report_month_end - INTERVAL '1 day', 'YYYY-MM-DD') AS report_month_end,
        a.monthly_active_users,
        a.previous_month_active_users,
        a.net_user_change,
        a.new_users_this_month,
        a.returning_users_this_month,
        a.retained_users_from_last_month,
        a.lost_users_from_last_month,
        es.daily_challenge_viewers,
        es.daily_challenge_views,
        es.daily_challenge_starters,
        es.daily_challenge_starts,
        es.daily_challenge_completers,
        es.daily_challenge_completions,
        es.philosopher_selectors,
        es.philosopher_selections,
        es.topic_selectors,
        es.topic_selections,
        es.difficulty_selectors,
        es.difficulty_selections,
        es.unique_normal_debate_starters,
        es.normal_debate_starts,
        es.unique_normal_debate_completers,
        es.normal_debate_completions,
        es.unique_report_viewers,
        es.report_views,
        es.unique_share_card_creators,
        es.share_cards_created,
        fo.*,
        ndc.*,
        rsc.*,
        rgt.reports_generated_with_timing,
        rgt.average_generation_seconds,
        rgt.fastest_generation_seconds,
        rgt.slowest_generation_seconds
      FROM activity_summary a
      JOIN event_summary es
        ON a.report_month_start = es.report_month_start
      CROSS JOIN funnel_overlap fo
      CROSS JOIN normal_debate_conversion ndc
      CROSS JOIN report_share_conversion rsc
      JOIN report_generation_timing_summary rgt
        ON a.report_month_start = rgt.report_month_start;
      `,
      [reportMonthOverride]
    );

    const row = result.rows[0];

    if (!row) {
      throw new Error("No monthly analytics data returned.");
    }

    const monthlyActiveUsers = toNumber(row.monthly_active_users);
    const previousMonthActiveUsers = toNumber(row.previous_month_active_users);
    const netUserChange = toNumber(row.net_user_change);
    const newUsersThisMonth = toNumber(row.new_users_this_month);
    const returningUsersThisMonth = toNumber(row.returning_users_this_month);
    const retainedUsersFromLastMonth = toNumber(row.retained_users_from_last_month);
    const lostUsersFromLastMonth = toNumber(row.lost_users_from_last_month);

    const dailyChallengeViewers = toNumber(row.daily_challenge_viewers);
    const dailyChallengeViews = toNumber(row.daily_challenge_views);
    const dailyChallengeStarters = toNumber(row.daily_challenge_starters);
    const dailyChallengeStarts = toNumber(row.daily_challenge_starts);
    const dailyChallengeCompleters = toNumber(row.daily_challenge_completers);
    const dailyChallengeCompletions = toNumber(row.daily_challenge_completions);
    const dailyChallengeViewerDays = toNumber(row.daily_challenge_viewer_days);
    const dailyChallengeStarterDays = toNumber(row.daily_challenge_starter_days);
    const dailyChallengeActiveViewerDays = toNumber(row.daily_challenge_active_viewer_days);
    const dailyChallengeViewerStarterDays = toNumber(row.daily_challenge_viewer_starter_days);
    const dailyChallengeStarterCompletionDays = toNumber(row.daily_challenge_starter_completion_days);
    const dailyChallengeViewerCompletionDays = toNumber(row.daily_challenge_viewer_completion_days);

    const philosopherSelectors = toNumber(row.philosopher_selectors);
    const philosopherSelections = toNumber(row.philosopher_selections);
    const topicSelectors = toNumber(row.topic_selectors);
    const topicSelections = toNumber(row.topic_selections);
    const difficultySelectors = toNumber(row.difficulty_selectors);
    const difficultySelections = toNumber(row.difficulty_selections);
    const philosopherSelectorDays = toNumber(row.philosopher_selector_days);
    const topicSelectorDays = toNumber(row.topic_selector_days);
    const difficultySelectorDays = toNumber(row.difficulty_selector_days);
    const philosopherTopicOverlapDays = toNumber(row.philosopher_topic_overlap_days);
    const topicDifficultyOverlapDays = toNumber(row.topic_difficulty_overlap_days);
    const difficultyStartOverlapDays = toNumber(row.difficulty_start_overlap_days);

    const uniqueNormalDebateStarters = toNumber(row.unique_normal_debate_starters);
    const normalDebateStarts = toNumber(row.normal_debate_starts);
    const uniqueNormalDebateCompleters = toNumber(row.unique_normal_debate_completers);
    const normalDebateCompletions = toNumber(row.normal_debate_completions);
    const trackedNormalDebateStarts = toNumber(row.tracked_normal_debate_starts);
    const matchedNormalDebateCompletions = toNumber(row.matched_normal_debate_completions);

    const uniqueReportViewers = toNumber(row.unique_report_viewers);
    const reportViews = toNumber(row.report_views);
    const uniqueShareCardCreators = toNumber(row.unique_share_card_creators);
    const shareCardsCreated = toNumber(row.share_cards_created);
    const trackedReportViews = toNumber(row.tracked_report_views);
    const matchedReportShares = toNumber(row.matched_report_shares);

    const reportsGeneratedWithTiming = toNumber(row.reports_generated_with_timing);
    const averageGenerationSeconds = row.average_generation_seconds;
    const fastestGenerationSeconds = row.fastest_generation_seconds;
    const slowestGenerationSeconds = row.slowest_generation_seconds;

    const monthlyGrowthRate = formatGrowthRate(
      monthlyActiveUsers,
      previousMonthActiveUsers
    );

    const monthlyViewToStartRate = percent(
      dailyChallengeViewerStarterDays,
      dailyChallengeViewerDays
    );

    const monthlyStartToCompletionRate = percent(
      dailyChallengeStarterCompletionDays,
      dailyChallengeStarterDays
    );

    const monthlyViewToCompletionRate = percent(
      dailyChallengeViewerCompletionDays,
      dailyChallengeViewerDays
    );

    const monthlyPhilosopherToTopicRate = percent(
      philosopherTopicOverlapDays,
      philosopherSelectorDays
    );

    const monthlyTopicToDifficultyRate = percent(
      topicDifficultyOverlapDays,
      topicSelectorDays
    );

    const monthlyDifficultyToNormalStartRate = percent(
      difficultyStartOverlapDays,
      difficultySelectorDays
    );

    const monthlyNormalDebateCompletionRate = percent(
      matchedNormalDebateCompletions,
      trackedNormalDebateStarts
    );

    const reportToShareRate = percent(
      matchedReportShares,
      trackedReportViews
    );

    const strongestArea = chooseStrongestArea({
      dailyChallengeCompletions,
      normalDebateCompletions,
      reportViews,
      shareCardsCreated,
    });

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      dailyChallengeViewerDays,
      dailyChallengeViewerStarterDays,
      dailyChallengeStarterDays,
      dailyChallengeStarterCompletionDays,
      philosopherSelectorDays,
      philosopherTopicOverlapDays,
      topicSelectorDays,
      topicDifficultyOverlapDays,
      difficultySelectorDays,
      difficultyStartOverlapDays,
      trackedNormalDebateStarts,
      matchedNormalDebateCompletions,
      trackedReportViews,
      matchedReportShares,
    });

    const reportGenerationNote = chooseReportGenerationNote({
      reportsGeneratedWithTiming,
      averageGenerationSeconds,
      slowestGenerationSeconds,
    });

    const trackingNote = chooseTrackingNote({
      reportMonth: row.report_month,
      reportsGeneratedWithTiming,
      normalDebateStarts,
      trackedNormalDebateStarts,
      reportViews,
      trackedReportViews,
    });

    const message = [
      `🏛️ <b>The Oracle Monthly Report</b>`,
      ``,
      `For: <b>${row.report_month}</b>`,
      `<b>Period:</b> ${row.report_month_start} to ${row.report_month_end}`,
      ``,
      `<b>Monthly User Activity / Growth</b>`,
      `<b>Monthly Active Users:</b> ${monthlyActiveUsers}`,
      `<b>Previous Month Active Users:</b> ${previousMonthActiveUsers}`,
      `<b>Net User Change:</b> ${formatNetChange(netUserChange)}`,
      `<b>Monthly Growth Rate:</b> ${monthlyGrowthRate}`,
      ``,
      `<b>New users this month:</b> ${newUsersThisMonth}`,
      `<b>Returning users this month:</b> ${returningUsersThisMonth}`,
      `<b>Retained users from last month:</b> ${retainedUsersFromLastMonth}`,
      `<b>Lost users from last month:</b> ${lostUsersFromLastMonth}`,
      ``,
      `<b>Daily Challenge Monthly Activity</b>`,
      `<b>Daily Challenge viewers:</b> ${dailyChallengeViewers} ${pluralize(dailyChallengeViewers, "user")}`,
      `<b>Daily Challenge views:</b> ${dailyChallengeViews} total`,
      `<b>Daily Challenge starters:</b> ${dailyChallengeStarters} ${pluralize(dailyChallengeStarters, "user")}`,
      `<b>Daily Challenge starts:</b> ${dailyChallengeStarts} total`,
      `<b>Daily Challenge completers:</b> ${dailyChallengeCompleters} ${pluralize(dailyChallengeCompleters, "user")}`,
      `<b>Daily Challenge completions:</b> ${dailyChallengeCompletions} total`,
      ``,
      `<b>Daily Challenge Matched User-Day Funnel</b>`,
      `<b>Viewer-days:</b> ${dailyChallengeViewerDays}`,
      `<b>Starter-days:</b> ${dailyChallengeStarterDays}`,
      `<b>Viewer-days recorded as active:</b> ${dailyChallengeActiveViewerDays}`,
      `<b>Same-day viewer → starter overlap:</b> ${dailyChallengeViewerStarterDays} of ${dailyChallengeViewerDays} viewer-days (${monthlyViewToStartRate})`,
      `<b>Same-day starter → completion overlap:</b> ${dailyChallengeStarterCompletionDays} of ${dailyChallengeStarterDays} starter-days (${monthlyStartToCompletionRate})`,
      `<b>Same-day viewer → completion overlap:</b> ${dailyChallengeViewerCompletionDays} of ${dailyChallengeViewerDays} viewer-days (${monthlyViewToCompletionRate})`,
      ``,
      `<b>Normal Debate Monthly Activity</b>`,
      `<b>Philosopher selectors:</b> ${philosopherSelectors} ${pluralize(philosopherSelectors, "user")}`,
      `<b>Philosopher selections:</b> ${philosopherSelections} total`,
      `<b>Topic selectors:</b> ${topicSelectors} ${pluralize(topicSelectors, "user")}`,
      `<b>Topic selections:</b> ${topicSelections} total`,
      `<b>Difficulty selectors:</b> ${difficultySelectors} ${pluralize(difficultySelectors, "user")}`,
      `<b>Difficulty selections:</b> ${difficultySelections} total`,
      ``,
      `<b>Normal debate starts:</b> ${normalDebateStarts} total`,
      `<b>Unique normal debate starters:</b> ${uniqueNormalDebateStarters} ${pluralize(uniqueNormalDebateStarters, "user")}`,
      `<b>Normal debate completions:</b> ${normalDebateCompletions} total`,
      `<b>Unique normal debate completers:</b> ${uniqueNormalDebateCompleters} ${pluralize(uniqueNormalDebateCompleters, "user")}`,
      ``,
      `<b>Normal Debate Matched User-Day Funnel</b>`,
      `<b>Same-day philosopher → topic overlap:</b> ${philosopherTopicOverlapDays} of ${philosopherSelectorDays} selector-days (${monthlyPhilosopherToTopicRate})`,
      `<b>Same-day topic → difficulty overlap:</b> ${topicDifficultyOverlapDays} of ${topicSelectorDays} selector-days (${monthlyTopicToDifficultyRate})`,
      `<b>Same-day difficulty → normal start overlap:</b> ${difficultyStartOverlapDays} of ${difficultySelectorDays} selector-days (${monthlyDifficultyToNormalStartRate})`,
      `<b>Tracked normal starts with debateId:</b> ${trackedNormalDebateStarts}`,
      `<b>Tracked starts completed during the month:</b> ${matchedNormalDebateCompletions} of ${trackedNormalDebateStarts} (${monthlyNormalDebateCompletionRate})`,
      ``,
      `<b>Reports / Sharing</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Unique report viewers:</b> ${uniqueReportViewers} ${pluralize(uniqueReportViewers, "user")}`,
      `<b>Share cards created:</b> ${shareCardsCreated} total`,
      `<b>Unique share-card creators:</b> ${uniqueShareCardCreators} ${pluralize(uniqueShareCardCreators, "user")}`,
      `<b>Viewed reports with debateId:</b> ${trackedReportViews}`,
      `<b>Viewed reports with at least one share:</b> ${matchedReportShares} of ${trackedReportViews} (${reportToShareRate})`,
      ``,
      `<b>Report Generation Time</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Deduplicated reports with generation timing:</b> ${reportsGeneratedWithTiming}`,
      `<b>Average generation time:</b> ${formatSeconds(averageGenerationSeconds)}`,
      `<b>Fastest / slowest generation:</b> ${formatSeconds(fastestGenerationSeconds)} / ${formatSeconds(slowestGenerationSeconds)}`,
      `<b>Generation timing note:</b> ${reportGenerationNote}`,
      ``,
      `<b>Monthly Summary</b>`,
      `<b>Strongest area:</b> ${strongestArea}`,
      `<b>Biggest matched funnel drop-off:</b> ${biggestDropOff}`,
      `<b>Recommended focus next month:</b> ${recommendedAction}`,
      ``,
      `<b>Tracking note:</b> ${trackingNote}`,
    ].join("\n");

    const businessMessage = await buildMonthlyBusinessAnalytics(
      client,
      reportMonthOverride
    );

    const emailReport = [
      stripTelegramHtml(message),
      "",
      "────────────────────────",
      "",
      stripTelegramHtml(businessMessage),
    ].join("\n");

    const subject = `The Agora Monthly Report — ${row.report_month}`;

    const deliveryResults = await Promise.allSettled([
      sendTelegramMessage(message),
      sendTelegramMessage(businessMessage),
      sendAnalyticsEmail({
        subject,
        reportText: emailReport,
      }),
    ]);

    console.log("[monthlyAnalyticsReport] Delivery results:", deliveryResults);

    const failedDeliveries = deliveryResults.filter((result) => {
      if (result.status === "rejected") {
        return true;
      }

      return (
        result.value?.success === false ||
        result.value?.skipped === true
      );
    });

    if (failedDeliveries.length > 0) {
      console.error(
        "[monthlyAnalyticsReport] One or more deliveries failed:",
        failedDeliveries
      );
      process.exitCode = 1;
      return;
    }

    console.log("Monthly analytics report sent successfully.");
  } catch (error) {
    console.error("Monthly analytics report failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
