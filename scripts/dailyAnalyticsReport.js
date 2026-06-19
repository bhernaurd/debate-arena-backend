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

function chooseBiggestDropOff(data) {
  const dailyActiveUsers = toNumber(data.daily_active_users);
  const dailyChallengeViewed = toNumber(data.daily_challenge_viewed);
  const dailyChallengeStarted = toNumber(data.daily_challenge_started);
  const dailyChallengeCompleted = toNumber(data.daily_challenge_completed);
  const debateStarters = toNumber(data.debate_starters);
  const debateCompleters = toNumber(data.debate_completers);
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

  if (debateStarters > 0 && debateCompleters === 0) {
    return {
      biggestDropOff: "Users started debates but did not complete them.",
      recommendedAction: "Check whether the debate flow feels too long, unclear, or difficult.",
    };
  }

  if (debateCompleters > 0 && reportViewers === 0) {
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
            WHERE event_name = 'app_opened'
          ) AS daily_active_users_from_events,

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
          ) AS philosopher_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'topic_selected'
          ) AS topic_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'difficulty_selected'
          ) AS difficulty_selected,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_started'
          ) AS debate_starters,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_completed'
          ) AS debate_completers,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'report_viewed'
          ) AS report_viewers,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'share_card_created'
          ) AS share_card_users

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

        event_summary.daily_challenge_viewed,
        event_summary.daily_challenge_started,
        event_summary.daily_challenge_completed,

        event_summary.philosopher_selected,
        event_summary.topic_selected,
        event_summary.difficulty_selected,

        event_summary.debate_starters,
        event_summary.debate_completers,

        event_summary.report_viewers,
        event_summary.share_card_users

      FROM activity_summary
      JOIN event_summary
        ON activity_summary.report_date = event_summary.report_date;
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

    const philosopherSelected = toNumber(row.philosopher_selected);
    const topicSelected = toNumber(row.topic_selected);
    const difficultySelected = toNumber(row.difficulty_selected);

    const debateStarters = toNumber(row.debate_starters);
    const debateCompleters = toNumber(row.debate_completers);

    const reportViewers = toNumber(row.report_viewers);
    const shareCardUsers = toNumber(row.share_card_users);

    const dailyChallengeStartRate = percent(
      dailyChallengeStarted,
      dailyChallengeViewed
    );

    const dailyChallengeCompletionRate = percent(
      dailyChallengeCompleted,
      dailyChallengeStarted
    );

    const openedToPhilosopherRate = percent(
      philosopherSelected,
      dailyActiveUsers
    );

    const philosopherToTopicRate = percent(
      topicSelected,
      philosopherSelected
    );

    const topicToDifficultyRate = percent(
      difficultySelected,
      topicSelected
    );

    const difficultyToDebateRate = percent(
      debateStarters,
      difficultySelected
    );

    const debateCompletionRate = percent(debateCompleters, debateStarters);
    const reportToShareRate = percent(shareCardUsers, reportViewers);

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      daily_active_users: dailyActiveUsers,
      daily_challenge_viewed: dailyChallengeViewed,
      daily_challenge_started: dailyChallengeStarted,
      daily_challenge_completed: dailyChallengeCompleted,
      debate_starters: debateStarters,
      debate_completers: debateCompleters,
      report_viewers: reportViewers,
      share_card_users: shareCardUsers,
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
      `<b>Daily Challenge viewed:</b> ${dailyChallengeViewed}`,
      `<b>Daily Challenge started:</b> ${dailyChallengeStarted}`,
      `<b>Daily Challenge completed:</b> ${dailyChallengeCompleted}`,
      `<b>Daily Challenge start rate:</b> ${dailyChallengeStartRate}`,
      `<b>Daily Challenge completion rate:</b> ${dailyChallengeCompletionRate}`,
      ``,
      `<b>Debate funnel:</b>`,
      `<b>Philosopher selected:</b> ${philosopherSelected}`,
      `<b>Topic selected:</b> ${topicSelected}`,
      `<b>Difficulty selected:</b> ${difficultySelected}`,
      `<b>Debate starters:</b> ${debateStarters}`,
      `<b>Debate completers:</b> ${debateCompleters}`,
      ``,
      `<b>Opened → philosopher rate:</b> ${openedToPhilosopherRate}`,
      `<b>Philosopher → topic rate:</b> ${philosopherToTopicRate}`,
      `<b>Topic → difficulty rate:</b> ${topicToDifficultyRate}`,
      `<b>Difficulty → debate rate:</b> ${difficultyToDebateRate}`,
      `<b>Debate completion rate:</b> ${debateCompletionRate}`,
      ``,
      `<b>Reports viewed:</b> ${reportViewers}`,
      `<b>Share cards created:</b> ${shareCardUsers}`,
      `<b>Report-to-share rate:</b> ${reportToShareRate}`,
      ``,
      `<b>Biggest funnel drop-off:</b> ${biggestDropOff}`,
      `<b>One recommended action:</b> ${recommendedAction}`,
    ].join("\n");

    await sendTelegramMessage(message);

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
