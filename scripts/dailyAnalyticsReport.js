import pg from "pg";
import { sendAnalyticsEmail } from "./emailReporter.js";

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

    const dropRate = Math.max(0, (start - end) / start);

    candidates.push({
      key,
      label,
      from: start,
      to: end,
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
    to: data.dailyChallengeViewers,
    fromLabel: "active users",
    toLabel: "viewers",
    action:
      "Review Daily Challenge presentation logic and onboarding eligibility. Make sure every eligible user sees the Daily Challenge when they reach the app.",
  });

  addCandidate({
    key: "daily_challenge_start",
    label: "Daily Challenge viewers → starters",
    from: data.dailyChallengeViewers,
    to: data.dailyChallengeStarters,
    fromLabel: "viewers",
    toLabel: "starters",
    action:
      "Improve the Daily Challenge intro. Make the prompt more compelling and make the Enter the Agora button feel like the obvious next step.",
  });

  addCandidate({
    key: "daily_challenge_completion",
    label: "Daily Challenge starters → completions",
    from: data.dailyChallengeStarters,
    to: data.dailyChallengeCompletions,
    fromLabel: "starters",
    toLabel: "completions",
    action:
      "Review the Daily Challenge debate flow. Make the Finish Debate button more obvious once the user has exchanged at least one round, and make the report payoff feel immediate.",
  });

  addCandidate({
    key: "philosopher_to_topic",
    label: "Philosopher selectors → topic selectors",
    from: data.philosopherSelectors,
    to: data.topicSelectors,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Improve the topic selection step. Make the questions more immediately compelling after a user selects a philosopher, and consider making generated topics more prominent.",
  });

  addCandidate({
    key: "topic_to_difficulty",
    label: "Topic selectors → difficulty selectors",
    from: data.topicSelectors,
    to: data.difficultySelectors,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Review the difficulty selection screen. Make the difference between Guided, Balanced, and Relentless instantly clear and reduce hesitation before starting.",
  });

  addCandidate({
    key: "difficulty_to_normal_start",
    label: "Difficulty selectors → normal debate starters",
    from: data.difficultySelectors,
    to: data.uniqueNormalDebateStarters,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Check the handoff from difficulty selection into the debate screen. Make sure the debate starts quickly and the opening loading state feels intentional.",
  });

  addCandidate({
    key: "normal_start_to_completion",
    label: "Normal debate starts → normal debate completions",
    from: data.normalDebateStarts,
    to: data.normalDebateCompletions,
    fromLabel: "debates",
    toLabel: "debates",
    action:
      "Review normal debate completion. Make the Finish Debate button visible after a real exchange and make the report feel like the reward for finishing.",
  });

  addCandidate({
    key: "report_to_share",
    label: "Report views → share cards created",
    from: data.reportViews,
    to: data.shareCardsCreated,
    fromLabel: "report views",
    toLabel: "share cards",
    action:
      "Improve the share-card CTA. Show it immediately after the report score and make the generated card feel worth saving or posting.",
  });

  if (candidates.length === 0) {
    return {
      biggestDropOff: "No usable funnel data for this day.",
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
      event_summary AS (
        SELECT
          bounds.report_date,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_viewers,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_started'
          ) AS daily_challenge_starters,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_completed'
          ) AS daily_challenge_completions,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'philosopher_selected'
          ) AS philosopher_selectors,

          COUNT(*) FILTER (
            WHERE event_name = 'philosopher_selected'
          ) AS philosopher_selections,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'topic_selected'
          ) AS topic_selectors,

          COUNT(*) FILTER (
            WHERE event_name = 'topic_selected'
          ) AS topic_selections,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'difficulty_selected'
          ) AS difficulty_selectors,

          COUNT(*) FILTER (
            WHERE event_name = 'difficulty_selected'
          ) AS difficulty_selections,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_started'
              AND user_events.metadata->>'isDailyChallenge' = 'false'
          ) AS unique_normal_debate_starters,

          COUNT(DISTINCT COALESCE(NULLIF(user_events.metadata->>'debateId', ''), user_events.id::text)) FILTER (
            WHERE event_name = 'debate_started'
              AND user_events.metadata->>'isDailyChallenge' = 'false'
          ) AS normal_debate_starts,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_completed'
              AND user_events.metadata->>'isDailyChallenge' = 'false'
          ) AS unique_normal_debate_completers,

          COUNT(DISTINCT COALESCE(NULLIF(user_events.metadata->>'debateId', ''), user_events.id::text)) FILTER (
            WHERE event_name = 'debate_completed'
              AND user_events.metadata->>'isDailyChallenge' = 'false'
          ) AS normal_debate_completions,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'report_viewed'
          ) AS unique_report_viewers,

          COUNT(*) FILTER (
            WHERE event_name = 'report_viewed'
          ) AS report_views,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'share_card_created'
          ) AS unique_share_card_creators,

          COUNT(*) FILTER (
            WHERE event_name = 'share_card_created'
          ) AS share_cards_created

        FROM bounds
        LEFT JOIN user_events
          ON user_events.created_at >= bounds.start_time
          AND user_events.created_at < bounds.end_time
          AND NOT EXISTS (
            SELECT 1 FROM excluded_analytics_users x
            WHERE x.user_id = user_events.user_id
          )
        GROUP BY bounds.report_date
      ),
      report_generation_timing_events AS (
        SELECT
          bounds.report_date,
          user_events.user_id,
          CASE
            WHEN user_events.metadata->>'durationMs' ~ '^[0-9]+(\\.[0-9]+)?$'
              THEN (user_events.metadata->>'durationMs')::numeric / 1000.0
            ELSE NULL
          END AS generation_seconds
        FROM bounds
        JOIN user_events
          ON user_events.created_at >= bounds.start_time
          AND user_events.created_at < bounds.end_time
          AND user_events.event_name = 'report_generation_completed'
          AND NOT EXISTS (
            SELECT 1 FROM excluded_analytics_users x
            WHERE x.user_id = user_events.user_id
          )
      ),
      report_generation_timing_summary AS (
        SELECT
          bounds.report_date,
          COUNT(report_generation_timing_events.generation_seconds) AS reports_generated_with_timing,
          ROUND(AVG(report_generation_timing_events.generation_seconds), 2) AS average_generation_seconds,
          ROUND(MIN(report_generation_timing_events.generation_seconds), 2) AS fastest_generation_seconds,
          ROUND(MAX(report_generation_timing_events.generation_seconds), 2) AS slowest_generation_seconds
        FROM bounds
        LEFT JOIN report_generation_timing_events
          ON bounds.report_date = report_generation_timing_events.report_date
        GROUP BY bounds.report_date
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
      report_day_users AS (
        SELECT DISTINCT
          user_activity_days.user_id,
          user_activity_days.active_date
        FROM user_activity_days
        CROSS JOIN params
        WHERE user_activity_days.active_date = params.report_date
          AND NOT EXISTS (
            SELECT 1 FROM excluded_analytics_users x
            WHERE x.user_id = user_activity_days.user_id
          )
      ),
      activity_summary AS (
        SELECT
          params.report_date,

          COUNT(report_day_users.user_id) AS daily_active_users,

          COUNT(report_day_users.user_id) FILTER (
            WHERE first_seen.first_active_date = params.report_date
          ) AS new_users,

          COUNT(report_day_users.user_id) FILTER (
            WHERE first_seen.first_active_date < params.report_date
          ) AS returning_users

        FROM params
        LEFT JOIN report_day_users
          ON true
        LEFT JOIN first_seen
          ON report_day_users.user_id = first_seen.user_id
        GROUP BY params.report_date
      )
      SELECT
        TO_CHAR(activity_summary.report_date, 'YYYY-MM-DD') AS report_date,

        activity_summary.daily_active_users,
        activity_summary.new_users,
        activity_summary.returning_users,

        event_summary.daily_challenge_viewers,
        event_summary.daily_challenge_starters,
        event_summary.daily_challenge_completions,

        event_summary.philosopher_selectors,
        event_summary.philosopher_selections,
        event_summary.topic_selectors,
        event_summary.topic_selections,
        event_summary.difficulty_selectors,
        event_summary.difficulty_selections,

        event_summary.unique_normal_debate_starters,
        event_summary.normal_debate_starts,
        event_summary.unique_normal_debate_completers,
        event_summary.normal_debate_completions,

        event_summary.unique_report_viewers,
        event_summary.report_views,
        event_summary.unique_share_card_creators,
        event_summary.share_cards_created,

        report_generation_timing_summary.reports_generated_with_timing,
        report_generation_timing_summary.average_generation_seconds,
        report_generation_timing_summary.fastest_generation_seconds,
        report_generation_timing_summary.slowest_generation_seconds

      FROM activity_summary
      JOIN event_summary
        ON activity_summary.report_date = event_summary.report_date
      JOIN report_generation_timing_summary
        ON activity_summary.report_date = report_generation_timing_summary.report_date;
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

    const philosopherSelectors = toNumber(row.philosopher_selectors);
    const philosopherSelections = toNumber(row.philosopher_selections);
    const topicSelectors = toNumber(row.topic_selectors);
    const topicSelections = toNumber(row.topic_selections);
    const difficultySelectors = toNumber(row.difficulty_selectors);
    const difficultySelections = toNumber(row.difficulty_selections);

    const uniqueNormalDebateStarters = toNumber(row.unique_normal_debate_starters);
    const normalDebateStarts = toNumber(row.normal_debate_starts);
    const uniqueNormalDebateCompleters = toNumber(row.unique_normal_debate_completers);
    const normalDebateCompletions = toNumber(row.normal_debate_completions);

    const uniqueReportViewers = toNumber(row.unique_report_viewers);
    const reportViews = toNumber(row.report_views);
    const uniqueShareCardCreators = toNumber(row.unique_share_card_creators);
    const shareCardsCreated = toNumber(row.share_cards_created);

    const reportsGeneratedWithTiming = toNumber(row.reports_generated_with_timing);
    const averageGenerationSeconds = row.average_generation_seconds;
    const fastestGenerationSeconds = row.fastest_generation_seconds;
    const slowestGenerationSeconds = row.slowest_generation_seconds;

    const dailyChallengeVisibilityRate = percent(
      dailyChallengeViewers,
      dailyActiveUsers
    );

    const dailyChallengeViewerToStarterRate = percent(
      dailyChallengeStarters,
      dailyChallengeViewers
    );

    const dailyChallengeStarterToCompletionRate = percent(
      dailyChallengeCompletions,
      dailyChallengeStarters
    );

    const dailyChallengeViewerToCompletionRate = percent(
      dailyChallengeCompletions,
      dailyChallengeViewers
    );

    const philosopherToTopicRate = percent(
      topicSelectors,
      philosopherSelectors
    );

    const topicToDifficultyRate = percent(
      difficultySelectors,
      topicSelectors
    );

    const difficultyToNormalDebateStartRate = percent(
      uniqueNormalDebateStarters,
      difficultySelectors
    );

    const normalDebateCompletionRate = percent(
      normalDebateCompletions,
      normalDebateStarts
    );

    const totalReportToShareRate = percent(
      shareCardsCreated,
      reportViews
    );

    const uniqueReportToShareRate = percent(
      uniqueShareCardCreators,
      uniqueReportViewers
    );

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      dailyActiveUsers,
      dailyChallengeViewers,
      dailyChallengeStarters,
      dailyChallengeCompletions,
      philosopherSelectors,
      topicSelectors,
      difficultySelectors,
      uniqueNormalDebateStarters,
      normalDebateStarts,
      normalDebateCompletions,
      reportViews,
      shareCardsCreated,
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
      `For: <b>${row.report_date}</b>`,
      ``,
      `<b>Daily Active Users:</b> ${dailyActiveUsers}`,
      `<b>New users:</b> ${newUsers}`,
      `<b>Returning users:</b> ${returningUsers}`,
      ``,
      `<b>Daily Challenge Funnel</b>`,
      `<b>Daily Challenge viewers:</b> ${dailyChallengeViewers} / ${dailyActiveUsers} active users`,
      `<b>Daily Challenge visibility rate:</b> ${dailyChallengeVisibilityRate}`,
      `<b>Daily Challenge starters:</b> ${dailyChallengeStarters}`,
      `<b>Daily Challenge completions:</b> ${dailyChallengeCompletions}`,
      `<b>Viewer → starter rate:</b> ${dailyChallengeViewerToStarterRate}`,
      `<b>Starter → completion rate:</b> ${dailyChallengeStarterToCompletionRate}`,
      `<b>Viewer → completion rate:</b> ${dailyChallengeViewerToCompletionRate}`,
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
      `<b>Philosopher → topic rate:</b> ${philosopherToTopicRate}`,
      `<b>Topic → difficulty rate:</b> ${topicToDifficultyRate}`,
      `<b>Difficulty → normal debate start rate:</b> ${difficultyToNormalDebateStartRate}`,
      `<b>Normal debate completion rate:</b> ${normalDebateCompletionRate}`,
      ``,
      `<b>Reports / Sharing</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Unique report viewers:</b> ${uniqueReportViewers} users`,
      `<b>Share cards created:</b> ${shareCardsCreated} total`,
      `<b>Unique share-card creators:</b> ${uniqueShareCardCreators} users`,
      `<b>Total report-to-share rate:</b> ${totalReportToShareRate}`,
      `<b>Unique report-to-share rate:</b> ${uniqueReportToShareRate}`,
      ``,
      `<b>Report Generation Time</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Reports with generation timing:</b> ${reportsGeneratedWithTiming}`,
      `<b>Average generation time:</b> ${formatSeconds(averageGenerationSeconds)}`,
      `<b>Fastest / slowest generation:</b> ${formatSeconds(fastestGenerationSeconds)} / ${formatSeconds(slowestGenerationSeconds)}`,
      `<b>Generation timing note:</b> ${reportGenerationNote}`,
      ``,
      `<b>Biggest funnel drop-off:</b> ${biggestDropOff}`,
      `<b>One recommended action:</b> ${recommendedAction}`,
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

    const emailReport = [
      stripTelegramHtml(message),
      "",
      "────────────────────────",
      "",
      stripTelegramHtml(sevenDayMessage),
    ].join("\n");

    const subject = `The Agora Daily Report — ${row.report_date}`;

    const deliveryResults = await Promise.allSettled([
      sendTelegramMessage(message),
      sendTelegramMessage(sevenDayMessage),
      sendAnalyticsEmail({
        subject,
        reportText: emailReport,
      }),
    ]);

    console.log("[dailyAnalyticsReport] Delivery results:", deliveryResults);

    const failedDeliveries = deliveryResults.filter(
      (result) => result.status === "rejected"
    );

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
