import pg from "pg";
import { sendAnalyticsEmail } from "./emailReporter.js";
import { buildDailyBusinessAnalytics } from "./businessAnalyticsReport.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function toNumber(value) {
  return Number(value || 0);
}

function percent(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);

  if (d === 0) return "—";

  return `${((n / d) * 100).toFixed(1)}%`;
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

    const dropRate = (start - Math.min(end, start)) / start;

    candidates.push({
      key,
      label,
      from: start,
      to: Math.min(end, start),
      fromLabel,
      toLabel,
      dropRate,
      action,
    });
  }

  addCandidate({
    key: "daily_challenge_visibility",
    label: "Daily Active Users → Daily Challenge viewers",
    from: data.dailyActiveUsers,
    to: data.dailyChallengeActiveViewers,
    fromLabel: "active users",
    toLabel: "matched viewers",
    action:
      "Review Daily Challenge presentation logic and onboarding eligibility. Make sure every eligible active user sees the Daily Challenge when they reach the app.",
  });

  addCandidate({
    key: "daily_challenge_start",
    label: "Daily Challenge viewers → same-day starters",
    from: data.dailyChallengeViewers,
    to: data.dailyChallengeViewerStarters,
    fromLabel: "viewers",
    toLabel: "matched starters",
    action:
      "Improve the Daily Challenge intro. Make the prompt more compelling and make the Enter the Agora button feel like the obvious next step.",
  });

  addCandidate({
    key: "daily_challenge_completion",
    label: "Daily Challenge starters → same-day completions",
    from: data.dailyChallengeStarters,
    to: data.dailyChallengeStarterCompletions,
    fromLabel: "starters",
    toLabel: "matched completions",
    action:
      "Review the Daily Challenge debate flow. Make the Finish Debate button more obvious once the user has exchanged at least one round, and make the report payoff feel immediate.",
  });

  addCandidate({
    key: "philosopher_to_topic",
    label: "Philosopher selectors → same-day topic selectors",
    from: data.philosopherSelectors,
    to: data.philosopherTopicOverlap,
    fromLabel: "users",
    toLabel: "matched users",
    action:
      "Improve the topic selection step. Make the questions more immediately compelling after a user selects a philosopher, and consider making generated topics more prominent.",
  });

  addCandidate({
    key: "topic_to_difficulty",
    label: "Topic selectors → same-day difficulty selectors",
    from: data.topicSelectors,
    to: data.topicDifficultyOverlap,
    fromLabel: "users",
    toLabel: "matched users",
    action:
      "Review the difficulty selection screen. Make the difference between Guided, Balanced, and Relentless instantly clear and reduce hesitation before starting.",
  });

  addCandidate({
    key: "difficulty_to_normal_start",
    label: "Difficulty selectors → same-day normal debate starters",
    from: data.difficultySelectors,
    to: data.difficultyStartOverlap,
    fromLabel: "users",
    toLabel: "matched users",
    action:
      "Check the handoff from difficulty selection into the debate screen. Make sure the debate starts quickly and the opening loading state feels intentional.",
  });

  addCandidate({
    key: "normal_start_to_completion",
    label: "Tracked normal debate starts → same-day matched completions",
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
      "Improve the share-card CTA. Show it immediately after the report score and make the generated card feel worth saving or posting.",
  });

  if (candidates.length === 0) {
    return {
      biggestDropOff: "No usable matched funnel data for this day.",
      recommendedAction:
        "No action needed yet. Keep collecting data and check tomorrow's report.",
    };
  }

  const biggest = candidates.sort((a, b) => b.dropRate - a.dropRate)[0];

  return {
    biggestDropOff: `${biggest.label} dropped from ${biggest.from} ${biggest.fromLabel} to ${biggest.to} ${biggest.toLabel}.`,
    recommendedAction: biggest.action,
  };
}

function chooseReportGenerationNote({
  reportsGeneratedWithTiming,
  averageGenerationSeconds,
  slowestGenerationSeconds,
}) {
  const timed = toNumber(reportsGeneratedWithTiming);

  if (timed === 0) {
    return "No completed report-generation timing recorded for this day.";
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

  return data;
}

async function main() {
  const client = await pool.connect();

  try {
    const result = await client.query(`
      WITH params AS (
        SELECT
          ((NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 day')::date AS report_date
      ),
      bounds AS (
        SELECT
          report_date,
          report_date::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
          (report_date + INTERVAL '1 day')::timestamp AT TIME ZONE 'America/Chicago' AS end_time
        FROM params
      ),
      eligible_events AS (
        SELECT
          e.*,
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
      report_day_users AS (
        SELECT DISTINCT
          uad.user_id,
          uad.active_date
        FROM user_activity_days uad
        CROSS JOIN params p
        WHERE uad.active_date = p.report_date
          AND NOT EXISTS (
            SELECT 1
            FROM excluded_analytics_users x
            WHERE x.user_id = uad.user_id
          )
      ),
      activity_summary AS (
        SELECT
          p.report_date,
          COUNT(rdu.user_id) AS daily_active_users,
          COUNT(rdu.user_id) FILTER (
            WHERE fs.first_active_date = p.report_date
          ) AS new_users,
          COUNT(rdu.user_id) FILTER (
            WHERE fs.first_active_date < p.report_date
          ) AS returning_users
        FROM params p
        LEFT JOIN report_day_users rdu ON true
        LEFT JOIN first_seen fs ON rdu.user_id = fs.user_id
        GROUP BY p.report_date
      ),
      event_summary AS (
        SELECT
          b.report_date,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_viewers,
          COUNT(DISTINCT e.user_id) FILTER (
            WHERE e.event_name = 'daily_challenge_started'
          ) AS daily_challenge_starters,
          COUNT(DISTINCT e.user_id) FILTER (
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
        GROUP BY b.report_date
      ),
      stage_users AS (
        SELECT DISTINCT e.user_id, e.event_name
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
      normal_start_users AS (
        SELECT DISTINCT e.user_id
        FROM eligible_events e
        WHERE e.event_name = 'debate_started'
          AND e.metadata->>'isDailyChallenge' = 'false'
      ),
      funnel_overlap AS (
        SELECT
          (
            SELECT COUNT(*)
            FROM stage_users v
            WHERE v.event_name = 'daily_challenge_viewed'
              AND EXISTS (
                SELECT 1
                FROM report_day_users rdu
                WHERE rdu.user_id = v.user_id
              )
          ) AS daily_challenge_active_viewers,
          (
            SELECT COUNT(*)
            FROM stage_users s
            WHERE s.event_name = 'daily_challenge_started'
              AND EXISTS (
                SELECT 1
                FROM stage_users v
                WHERE v.user_id = s.user_id
                  AND v.event_name = 'daily_challenge_viewed'
              )
          ) AS daily_challenge_viewer_starters,
          (
            SELECT COUNT(*)
            FROM stage_users c
            WHERE c.event_name = 'daily_challenge_completed'
              AND EXISTS (
                SELECT 1
                FROM stage_users s
                WHERE s.user_id = c.user_id
                  AND s.event_name = 'daily_challenge_started'
              )
          ) AS daily_challenge_starter_completions,
          (
            SELECT COUNT(*)
            FROM stage_users c
            WHERE c.event_name = 'daily_challenge_completed'
              AND EXISTS (
                SELECT 1
                FROM stage_users v
                WHERE v.user_id = c.user_id
                  AND v.event_name = 'daily_challenge_viewed'
              )
          ) AS daily_challenge_viewer_completions,
          (
            SELECT COUNT(*)
            FROM stage_users t
            WHERE t.event_name = 'topic_selected'
              AND EXISTS (
                SELECT 1
                FROM stage_users p
                WHERE p.user_id = t.user_id
                  AND p.event_name = 'philosopher_selected'
              )
          ) AS philosopher_topic_overlap,
          (
            SELECT COUNT(*)
            FROM stage_users d
            WHERE d.event_name = 'difficulty_selected'
              AND EXISTS (
                SELECT 1
                FROM stage_users t
                WHERE t.user_id = d.user_id
                  AND t.event_name = 'topic_selected'
              )
          ) AS topic_difficulty_overlap,
          (
            SELECT COUNT(*)
            FROM normal_start_users n
            WHERE EXISTS (
              SELECT 1
              FROM stage_users d
              WHERE d.user_id = n.user_id
                AND d.event_name = 'difficulty_selected'
            )
          ) AS difficulty_start_overlap
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
          b.report_date,
          COUNT(t.generation_seconds) AS reports_generated_with_timing,
          ROUND(AVG(t.generation_seconds), 2) AS average_generation_seconds,
          ROUND(MIN(t.generation_seconds), 2) AS fastest_generation_seconds,
          ROUND(MAX(t.generation_seconds), 2) AS slowest_generation_seconds
        FROM bounds b
        LEFT JOIN report_generation_timing_events t ON true
        GROUP BY b.report_date
      )
      SELECT
        TO_CHAR(a.report_date, 'YYYY-MM-DD') AS report_date,
        TO_CHAR(
          a.report_date,
          'FMDay, FMMonth FMDD, YYYY'
        ) AS report_date_label,
        a.daily_active_users,
        a.new_users,
        a.returning_users,
        es.*,
        fo.*,
        ndc.*,
        rsc.*,
        rgt.reports_generated_with_timing,
        rgt.average_generation_seconds,
        rgt.fastest_generation_seconds,
        rgt.slowest_generation_seconds
      FROM activity_summary a
      JOIN event_summary es ON a.report_date = es.report_date
      CROSS JOIN funnel_overlap fo
      CROSS JOIN normal_debate_conversion ndc
      CROSS JOIN report_share_conversion rsc
      JOIN report_generation_timing_summary rgt ON a.report_date = rgt.report_date;
    `);

    const sevenDayResult = await client.query(`
      WITH params AS (
        SELECT 
          ((NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '1 day')::date AS end_date,
          ((NOW() AT TIME ZONE 'America/Chicago')::date - INTERVAL '7 days')::date AS start_date
      ),
      days AS (
        SELECT 
          generate_series(
            params.start_date,
            params.end_date,
            INTERVAL '1 day'
          )::date AS active_date
        FROM params
      ),
      first_seen AS (
        SELECT
          user_id,
          MIN(active_date) AS first_active_date
        FROM user_activity_days
        WHERE NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x
          WHERE x.user_id = user_activity_days.user_id
        )
        GROUP BY user_id
      ),
      daily_active AS (
        SELECT 
          active_date,
          COUNT(DISTINCT user_id) AS daily_active_users
        FROM user_activity_days
        WHERE NOT EXISTS (
          SELECT 1 FROM excluded_analytics_users x
          WHERE x.user_id = user_activity_days.user_id
        )
        GROUP BY active_date
      ),
      daily_new AS (
        SELECT 
          first_active_date AS active_date,
          COUNT(DISTINCT user_id) AS new_users
        FROM first_seen
        GROUP BY first_active_date
      )
      SELECT 
        TO_CHAR(days.active_date, 'MM-DD-YYYY Dy') AS report_date,
        COALESCE(daily_active.daily_active_users, 0) AS daily_active_users,
        COALESCE(daily_new.new_users, 0) AS new_users,
        COALESCE(daily_active.daily_active_users, 0) - COALESCE(daily_new.new_users, 0) AS returning_users
      FROM days
      LEFT JOIN daily_active
        ON days.active_date = daily_active.active_date
      LEFT JOIN daily_new
        ON days.active_date = daily_new.active_date
      ORDER BY days.active_date DESC;
    `);

    const row = result.rows[0];

    if (!row) {
      throw new Error("No analytics data returned.");
    }

    const dailyActiveUsers = toNumber(row.daily_active_users);
    const newUsers = toNumber(row.new_users);
    const returningUsers = toNumber(row.returning_users);

    const dailyChallengeViewers = toNumber(row.daily_challenge_viewers);
    const dailyChallengeStarters = toNumber(row.daily_challenge_starters);
    const dailyChallengeCompletions = toNumber(row.daily_challenge_completions);
    const dailyChallengeActiveViewers = toNumber(row.daily_challenge_active_viewers);
    const dailyChallengeViewerStarters = toNumber(row.daily_challenge_viewer_starters);
    const dailyChallengeStarterCompletions = toNumber(row.daily_challenge_starter_completions);
    const dailyChallengeViewerCompletions = toNumber(row.daily_challenge_viewer_completions);

    const philosopherSelectors = toNumber(row.philosopher_selectors);
    const philosopherSelections = toNumber(row.philosopher_selections);
    const topicSelectors = toNumber(row.topic_selectors);
    const topicSelections = toNumber(row.topic_selections);
    const difficultySelectors = toNumber(row.difficulty_selectors);
    const difficultySelections = toNumber(row.difficulty_selections);
    const philosopherTopicOverlap = toNumber(row.philosopher_topic_overlap);
    const topicDifficultyOverlap = toNumber(row.topic_difficulty_overlap);
    const difficultyStartOverlap = toNumber(row.difficulty_start_overlap);

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

    const dailyChallengeVisibilityRate = percent(
      dailyChallengeActiveViewers,
      dailyActiveUsers
    );

    const dailyChallengeViewerToStarterRate = percent(
      dailyChallengeViewerStarters,
      dailyChallengeViewers
    );

    const dailyChallengeStarterToCompletionRate = percent(
      dailyChallengeStarterCompletions,
      dailyChallengeStarters
    );

    const dailyChallengeViewerToCompletionRate = percent(
      dailyChallengeViewerCompletions,
      dailyChallengeViewers
    );

    const philosopherToTopicRate = percent(
      philosopherTopicOverlap,
      philosopherSelectors
    );

    const topicToDifficultyRate = percent(
      topicDifficultyOverlap,
      topicSelectors
    );

    const difficultyToNormalDebateStartRate = percent(
      difficultyStartOverlap,
      difficultySelectors
    );

    const normalDebateCompletionRate = percent(
      matchedNormalDebateCompletions,
      trackedNormalDebateStarts
    );

    const reportToShareRate = percent(
      matchedReportShares,
      trackedReportViews
    );

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      dailyActiveUsers,
      dailyChallengeActiveViewers,
      dailyChallengeViewers,
      dailyChallengeViewerStarters,
      dailyChallengeStarters,
      dailyChallengeStarterCompletions,
      philosopherSelectors,
      philosopherTopicOverlap,
      topicSelectors,
      topicDifficultyOverlap,
      difficultySelectors,
      difficultyStartOverlap,
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

    const message = [
      `🏛️ <b>The Oracle has spoken.</b>`,
      ``,
      `<b>The Agora Daily Report</b>`,
      `For: <b>${row.report_date_label}</b>`,
      ``,
      `<b>Daily Active Users:</b> ${dailyActiveUsers}`,
      `<b>New users:</b> ${newUsers}`,
      `<b>Returning users:</b> ${returningUsers}`,
      ``,
      `<b>Daily Challenge Funnel</b>`,
      `<b>Daily Challenge viewers:</b> ${dailyChallengeViewers} users`,
      `<b>Daily Challenge starters:</b> ${dailyChallengeStarters} users`,
      `<b>Daily Challenge completions:</b> ${dailyChallengeCompletions} users`,
      `<b>Active-user visibility overlap:</b> ${dailyChallengeActiveViewers} of ${dailyActiveUsers} active users (${dailyChallengeVisibilityRate})`,
      `<b>Same-day viewer → starter overlap:</b> ${dailyChallengeViewerStarters} of ${dailyChallengeViewers} viewers (${dailyChallengeViewerToStarterRate})`,
      `<b>Same-day starter → completion overlap:</b> ${dailyChallengeStarterCompletions} of ${dailyChallengeStarters} starters (${dailyChallengeStarterToCompletionRate})`,
      `<b>Same-day viewer → completion overlap:</b> ${dailyChallengeViewerCompletions} of ${dailyChallengeViewers} viewers (${dailyChallengeViewerToCompletionRate})`,
      ``,
      `<b>Normal Debate Funnel</b>`,
      `<b>Philosopher selectors:</b> ${philosopherSelectors} users`,
      `<b>Philosopher selections:</b> ${philosopherSelections} total`,
      `<b>Topic selectors:</b> ${topicSelectors} users`,
      `<b>Topic selections:</b> ${topicSelections} total`,
      `<b>Difficulty selectors:</b> ${difficultySelectors} users`,
      `<b>Difficulty selections:</b> ${difficultySelections} total`,
      ``,
      `<b>Normal debate starts:</b> ${normalDebateStarts} debates`,
      `<b>Unique normal debate starters:</b> ${uniqueNormalDebateStarters} users`,
      `<b>Normal debate completions:</b> ${normalDebateCompletions} debates`,
      `<b>Unique normal debate completers:</b> ${uniqueNormalDebateCompleters} users`,
      ``,
      `<b>Same-day philosopher → topic overlap:</b> ${philosopherTopicOverlap} of ${philosopherSelectors} users (${philosopherToTopicRate})`,
      `<b>Same-day topic → difficulty overlap:</b> ${topicDifficultyOverlap} of ${topicSelectors} users (${topicToDifficultyRate})`,
      `<b>Same-day difficulty → normal start overlap:</b> ${difficultyStartOverlap} of ${difficultySelectors} users (${difficultyToNormalDebateStartRate})`,
      `<b>Tracked normal starts with debateId:</b> ${trackedNormalDebateStarts}`,
      `<b>Tracked starts completed the same day:</b> ${matchedNormalDebateCompletions} of ${trackedNormalDebateStarts} (${normalDebateCompletionRate})`,
      ``,
      `<b>Reports / Sharing</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Unique report viewers:</b> ${uniqueReportViewers} users`,
      `<b>Share cards created:</b> ${shareCardsCreated} total`,
      `<b>Unique share-card creators:</b> ${uniqueShareCardCreators} users`,
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
      `<b>Biggest matched funnel drop-off:</b> ${biggestDropOff}`,
      `<b>One recommended action:</b> ${recommendedAction}`,
      ``,
      `<b>Measurement note:</b> Funnel percentages use same-day matched users or matching debateId values. Raw activity totals remain listed separately.`,
    ].join("\n");

    const sevenDayLines = sevenDayResult.rows.map((day) => {
      return [
        `<b>${day.report_date}</b>`,
        `Daily Active Users: ${toNumber(day.daily_active_users)}`,
        `New users: ${toNumber(day.new_users)}`,
        `Returning users: ${toNumber(day.returning_users)}`,
      ].join("\n");
    });

    const sevenDayMessage = [
      `📊 <b>7-Day User Activity Report</b>`,
      ``,
      `<b>Last 7 completed Central-time days</b>`,
      ``,
      sevenDayLines.join("\n\n"),
    ].join("\n");

    const businessMessage = await buildDailyBusinessAnalytics(client);

    const emailReport = [
      stripTelegramHtml(message),
      "",
      "────────────────────────",
      "",
      stripTelegramHtml(businessMessage),
      "",
      "────────────────────────",
      "",
      stripTelegramHtml(sevenDayMessage),
    ].join("\n");

    const subject = `The Agora Daily Report — ${row.report_date_label}`;

    const deliveryResults = await Promise.allSettled([
      sendTelegramMessage(message),
      sendTelegramMessage(businessMessage),
      sendTelegramMessage(sevenDayMessage),
      sendAnalyticsEmail({
        subject,
        reportText: emailReport,
      }),
    ]);

    console.log("[dailyAnalyticsReport] Delivery results:", deliveryResults);

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
      console.error("[dailyAnalyticsReport] One or more deliveries failed:", failedDeliveries);
      process.exitCode = 1;
      return;
    }

    console.log("Daily analytics report sent successfully.");
  } catch (error) {
    console.error("Daily analytics report failed:", error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
