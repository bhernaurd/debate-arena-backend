import pg from "pg";

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

  if (d === 0) return "0.0%";

  return `${((n / d) * 100).toFixed(1)}%`;
}

function formatSeconds(value) {
  if (value === null || value === undefined) {
    return "—";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "—";
  }

  return `${number.toFixed(1)}s`;
}

function chooseBiggestDropOff(data) {
  const dailyActiveUsers = toNumber(data.daily_active_users);
  const dailyChallengeViewed = toNumber(data.daily_challenge_viewed);
  const dailyChallengeStarted = toNumber(data.daily_challenge_started);
  const dailyChallengeCompleted = toNumber(data.daily_challenge_completed);
  const normalPhilosopherSelected = toNumber(data.normal_philosopher_selected);
  const normalTopicSelected = toNumber(data.normal_topic_selected);
  const normalDifficultySelected = toNumber(data.normal_difficulty_selected);
  const normalDebateStarted = toNumber(data.normal_debate_started);
  const normalDebateCompleted = toNumber(data.normal_debate_completed);
  const reportViewers = toNumber(data.report_viewers);
  const shareCardUsers = toNumber(data.share_card_users);

  if (dailyActiveUsers === 0) {
    return {
      biggestDropOff: "No user activity for this day.",
      recommendedAction: "No action needed yet. Keep watching tomorrow's report.",
    };
  }

  if (dailyChallengeViewed === 0) {
    return {
      biggestDropOff: "Users opened the app but did not view the Daily Challenge.",
      recommendedAction: "Check Daily Challenge display logic and first-open behavior.",
    };
  }

  if (dailyChallengeViewed > 0 && dailyChallengeStarted === 0) {
    return {
      biggestDropOff: "Users viewed the Daily Challenge but did not start it.",
      recommendedAction: "Review the Daily Challenge topic, CTA, and first-screen motivation.",
    };
  }

  if (dailyChallengeStarted > 0 && dailyChallengeCompleted === 0) {
    return {
      biggestDropOff: "Users started the Daily Challenge but did not complete it.",
      recommendedAction: "Review debate length, difficulty, and visibility of the Finish button.",
    };
  }

  if (normalPhilosopherSelected > 0 && normalTopicSelected === 0) {
    return {
      biggestDropOff: "Users selected a philosopher but did not select a topic.",
      recommendedAction: "Review the topic picker clarity, topic choices, and generated-question CTA.",
    };
  }

  if (normalTopicSelected > 0 && normalDifficultySelected === 0) {
    return {
      biggestDropOff: "Users selected a topic but did not choose a difficulty.",
      recommendedAction: "Review the difficulty-mode screen and make the choice feel easier.",
    };
  }

  if (normalDifficultySelected > 0 && normalDebateStarted === 0) {
    return {
      biggestDropOff: "Users chose a difficulty but did not start a normal debate.",
      recommendedAction: "Check navigation from Difficulty Mode into DebateView.",
    };
  }

  if (normalDebateStarted > 0 && normalDebateCompleted === 0) {
    return {
      biggestDropOff: "Users started normal debates but did not complete them.",
      recommendedAction: "Review debate length, difficulty, finish-button placement, and loading states.",
    };
  }

  if (
    (dailyChallengeCompleted > 0 || normalDebateCompleted > 0) &&
    reportViewers === 0
  ) {
    return {
      biggestDropOff: "Users completed debates but did not view reports.",
      recommendedAction: "Check report generation, report navigation, and loading states.",
    };
  }

  if (reportViewers > 0 && shareCardUsers === 0) {
    return {
      biggestDropOff: "Users viewed reports but did not create share cards.",
      recommendedAction: "Improve the share-card CTA, quote, or visual payoff.",
    };
  }

  return {
    biggestDropOff: "No obvious funnel issue from yesterday's data.",
    recommendedAction: "Keep monitoring. Wait for a larger sample before changing the product.",
  };
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
          ) AS daily_challenge_viewed,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_started'
          ) AS daily_challenge_started,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_completed'
          ) AS daily_challenge_completed,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'philosopher_selected'
          ) AS normal_philosopher_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'topic_selected'
          ) AS normal_topic_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'difficulty_selected'
          ) AS normal_difficulty_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_started'
              AND COALESCE(user_events.metadata->>'isDailyChallenge', 'false') <> 'true'
          ) AS normal_debate_started,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_completed'
              AND COALESCE(user_events.metadata->>'isDailyChallenge', 'false') <> 'true'
          ) AS normal_debate_completed,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'report_viewed'
          ) AS reports_viewed_all_paths,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'share_card_created'
          ) AS share_cards_created_all_paths,

          COUNT(*) FILTER (
            WHERE event_name = 'report_generation_completed'
          ) AS report_generation_completed,

          ROUND(
            AVG((user_events.metadata->>'durationMs')::numeric) FILTER (
              WHERE event_name = 'report_generation_completed'
                AND user_events.metadata ? 'durationMs'
            ) / 1000,
            1
          ) AS avg_report_load_seconds,

          ROUND(
            MIN((user_events.metadata->>'durationMs')::numeric) FILTER (
              WHERE event_name = 'report_generation_completed'
                AND user_events.metadata ? 'durationMs'
            ) / 1000,
            1
          ) AS fastest_report_seconds,

          ROUND(
            MAX((user_events.metadata->>'durationMs')::numeric) FILTER (
              WHERE event_name = 'report_generation_completed'
                AND user_events.metadata ? 'durationMs'
            ) / 1000,
            1
          ) AS slowest_report_seconds

        FROM bounds
        LEFT JOIN user_events
          ON user_events.created_at >= bounds.start_time
         AND user_events.created_at < bounds.end_time
         AND user_events.user_id NOT IN (
           SELECT user_id FROM excluded_analytics_users
         )
        GROUP BY bounds.report_date
      ),
      first_seen AS (
        SELECT
          user_id,
          MIN(active_date) AS first_active_date
        FROM user_activity_days
        WHERE user_id NOT IN (
          SELECT user_id FROM excluded_analytics_users
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
          AND user_activity_days.user_id NOT IN (
            SELECT user_id FROM excluded_analytics_users
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
        LEFT JOIN report_day_users ON true
        LEFT JOIN first_seen ON report_day_users.user_id = first_seen.user_id
        GROUP BY params.report_date
      )
      SELECT
        TO_CHAR(activity_summary.report_date, 'YYYY-MM-DD') AS report_date,
        activity_summary.daily_active_users,
        activity_summary.new_users,
        activity_summary.returning_users,
        event_summary.daily_challenge_viewed,
        event_summary.daily_challenge_started,
        event_summary.daily_challenge_completed,
        event_summary.normal_philosopher_selected,
        event_summary.normal_topic_selected,
        event_summary.normal_difficulty_selected,
        event_summary.normal_debate_started,
        event_summary.normal_debate_completed,
        event_summary.reports_viewed_all_paths,
        event_summary.share_cards_created_all_paths,
        event_summary.report_generation_completed,
        event_summary.avg_report_load_seconds,
        event_summary.fastest_report_seconds,
        event_summary.slowest_report_seconds
      FROM activity_summary
      JOIN event_summary
        ON activity_summary.report_date = event_summary.report_date;
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
        WHERE user_id NOT IN (
          SELECT user_id FROM excluded_analytics_users
        )
        GROUP BY user_id
      ),
      daily_active AS (
        SELECT
          active_date,
          COUNT(DISTINCT user_id) AS daily_active_users
        FROM user_activity_days
        WHERE user_id NOT IN (
          SELECT user_id FROM excluded_analytics_users
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

    const dailyChallengeViewed = toNumber(row.daily_challenge_viewed);
    const dailyChallengeStarted = toNumber(row.daily_challenge_started);
    const dailyChallengeCompleted = toNumber(row.daily_challenge_completed);

    const normalPhilosopherSelected = toNumber(row.normal_philosopher_selected);
    const normalTopicSelected = toNumber(row.normal_topic_selected);
    const normalDifficultySelected = toNumber(row.normal_difficulty_selected);
    const normalDebateStarted = toNumber(row.normal_debate_started);
    const normalDebateCompleted = toNumber(row.normal_debate_completed);

    const reportsViewedAllPaths = toNumber(row.reports_viewed_all_paths);
    const shareCardsCreatedAllPaths = toNumber(row.share_cards_created_all_paths);

    const reportGenerationCompleted = toNumber(row.report_generation_completed);
    const avgReportLoadTime =
      reportGenerationCompleted > 0 ? formatSeconds(row.avg_report_load_seconds) : "—";
    const fastestReportLoadTime =
      reportGenerationCompleted > 0 ? formatSeconds(row.fastest_report_seconds) : "—";
    const slowestReportLoadTime =
      reportGenerationCompleted > 0 ? formatSeconds(row.slowest_report_seconds) : "—";

    const dailyChallengeStartRate = percent(
      dailyChallengeStarted,
      dailyChallengeViewed
    );

    const dailyChallengeCompletionRate = percent(
      dailyChallengeCompleted,
      dailyChallengeStarted
    );

    const openedToPhilosopherRate = percent(
      normalPhilosopherSelected,
      dailyActiveUsers
    );

    const philosopherToTopicRate = percent(
      normalTopicSelected,
      normalPhilosopherSelected
    );

    const topicToDifficultyRate = percent(
      normalDifficultySelected,
      normalTopicSelected
    );

    const difficultyToNormalDebateRate = percent(
      normalDebateStarted,
      normalDifficultySelected
    );

    const normalDebateCompletionRate = percent(
      normalDebateCompleted,
      normalDebateStarted
    );

    const reportToShareRate = percent(
      shareCardsCreatedAllPaths,
      reportsViewedAllPaths
    );

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      daily_active_users: dailyActiveUsers,
      daily_challenge_viewed: dailyChallengeViewed,
      daily_challenge_started: dailyChallengeStarted,
      daily_challenge_completed: dailyChallengeCompleted,
      normal_philosopher_selected: normalPhilosopherSelected,
      normal_topic_selected: normalTopicSelected,
      normal_difficulty_selected: normalDifficultySelected,
      normal_debate_started: normalDebateStarted,
      normal_debate_completed: normalDebateCompleted,
      report_viewers: reportsViewedAllPaths,
      share_card_users: shareCardsCreatedAllPaths,
    });

    const message = [
      `🔮 The Oracle has spoken.`,
      ``,
      `The Agora Daily Report`,
      `For: ${row.report_date}`,
      ``,
      `Daily Active Users: ${dailyActiveUsers}`,
      `New users: ${newUsers}`,
      `Returning users: ${returningUsers}`,
      ``,
      `Daily Challenge Funnel`,
      `Daily Challenge viewed: ${dailyChallengeViewed}`,
      `Daily Challenge started: ${dailyChallengeStarted}`,
      `Daily Challenge completed: ${dailyChallengeCompleted}`,
      `Daily Challenge start rate: ${dailyChallengeStartRate}`,
      `Daily Challenge completion rate: ${dailyChallengeCompletionRate}`,
      ``,
      `Normal Debate Funnel`,
      `Philosopher selected: ${normalPhilosopherSelected}`,
      `Topic selected: ${normalTopicSelected}`,
      `Difficulty selected: ${normalDifficultySelected}`,
      `Normal debate started: ${normalDebateStarted}`,
      `Normal debate completed: ${normalDebateCompleted}`,
      ``,
      `Opened → philosopher rate: ${openedToPhilosopherRate}`,
      `Philosopher → topic rate: ${philosopherToTopicRate}`,
      `Topic → difficulty rate: ${topicToDifficultyRate}`,
      `Difficulty → normal debate rate: ${difficultyToNormalDebateRate}`,
      `Normal debate completion rate: ${normalDebateCompletionRate}`,
      ``,
      `Reports / Sharing`,
      `Reports viewed, all paths: ${reportsViewedAllPaths}`,
      `Debate reports completed: ${reportGenerationCompleted}`,
      `Avg report load time: ${avgReportLoadTime}`,
      `Fastest / slowest report: ${fastestReportLoadTime} / ${slowestReportLoadTime}`,
      `Share cards created, all paths: ${shareCardsCreatedAllPaths}`,
      `Report-to-share rate: ${reportToShareRate}`,
      ``,
      `Biggest funnel drop-off: ${biggestDropOff}`,
      `One recommended action: ${recommendedAction}`,
    ].join("\n");

    const sevenDayLines = sevenDayResult.rows.map((day) => {
      return [
        `${day.report_date}`,
        `Daily Active Users: ${toNumber(day.daily_active_users)}`,
        `New users: ${toNumber(day.new_users)}`,
        `Returning users: ${toNumber(day.returning_users)}`,
      ].join("\n");
    });

    const sevenDayMessage = [
      `📊 7-Day User Activity Report`,
      ``,
      `Last 7 completed Central-time days`,
      ``,
      sevenDayLines.join("\n\n"),
    ].join("\n");

    await sendTelegramMessage(message);
    await sendTelegramMessage(sevenDayMessage);

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
