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

function formatNetChange(value) {
  const number = toNumber(value);

  if (number > 0) return `+${number}`;
  return `${number}`;
}

function formatGrowthRate(value) {
  if (value === null || value === undefined) return "N/A";
  return `${Number(value).toFixed(1)}%`;
}

function chooseMonthlySummary(data) {
  const monthlyActiveUsers = toNumber(data.monthly_active_users);
  const previousMonthActiveUsers = toNumber(data.previous_month_active_users);
  const netUserChange = toNumber(data.net_user_change);
  const newUsersThisMonth = toNumber(data.new_users_this_month);
  const returningUsersThisMonth = toNumber(data.returning_users_this_month);
  const retainedUsersFromLastMonth = toNumber(data.retained_users_from_last_month);
  const lostUsersFromLastMonth = toNumber(data.lost_users_from_last_month);
  const debatesStarted = toNumber(data.debates_started);
  const debatesCompleted = toNumber(data.debates_completed);
  const shareCardsCreated = toNumber(data.share_cards_created);

  if (monthlyActiveUsers === 0) {
    return {
      monthlySummary: "No user activity was recorded for the month.",
      recommendedFocus: "No action needed yet. Keep watching after launch or after marketing begins.",
    };
  }

  if (previousMonthActiveUsers === 0 && monthlyActiveUsers > 0) {
    return {
      monthlySummary: `The Agora had ${monthlyActiveUsers} active users this month. Since last month had no active users, this is a fresh baseline month.`,
      recommendedFocus: "Focus on getting users to complete debates and return the next day.",
    };
  }

  if (netUserChange > 0) {
    return {
      monthlySummary: `The Agora grew by ${netUserChange} active users compared to last month.`,
      recommendedFocus: "Double down on the channels, posts, and features that brought users back.",
    };
  }

  if (netUserChange < 0) {
    return {
      monthlySummary: `The Agora lost ${Math.abs(netUserChange)} active users compared to last month.`,
      recommendedFocus: "Investigate retention, Daily Challenge completion, and whether users are reaching the debate report.",
    };
  }

  if (lostUsersFromLastMonth > retainedUsersFromLastMonth) {
    return {
      monthlySummary: "User activity was flat overall, but more last-month users were lost than retained.",
      recommendedFocus: "Focus on retention: stronger Daily Challenge hooks, better notifications, and faster path to debate completion.",
    };
  }

  if (newUsersThisMonth > returningUsersThisMonth) {
    return {
      monthlySummary: "This month was driven more by new users than returning users.",
      recommendedFocus: "Watch next month closely to see whether these new users come back.",
    };
  }

  if (debatesStarted > 0 && debatesCompleted === 0) {
    return {
      monthlySummary: "Users started debates, but completions were weak.",
      recommendedFocus: "Review debate length, difficulty, finish-button placement, and report loading speed.",
    };
  }

  if (debatesCompleted > 0 && shareCardsCreated === 0) {
    return {
      monthlySummary: "Users completed debates, but share-card creation was weak.",
      recommendedFocus: "Improve the share-card CTA and make the final report feel more worth sharing.",
    };
  }

  return {
    monthlySummary: "The month looks stable with no obvious major issue.",
    recommendedFocus: "Keep monitoring growth, retention, debate completion, and share-card creation.",
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
          date_trunc('month', (NOW() AT TIME ZONE 'America/Chicago'))::date AS current_month_start
      ),
      month_bounds AS (
        SELECT
          (current_month_start - INTERVAL '1 month')::date AS report_month_start,
          current_month_start::date AS report_month_end,
          (current_month_start - INTERVAL '2 months')::date AS previous_month_start,
          (current_month_start - INTERVAL '1 month')::date AS previous_month_end
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
      report_month_users AS (
        SELECT DISTINCT
          user_activity_days.user_id
        FROM user_activity_days
        CROSS JOIN month_bounds
        WHERE user_activity_days.active_date >= month_bounds.report_month_start
          AND user_activity_days.active_date < month_bounds.report_month_end
          AND user_activity_days.user_id NOT IN (
            SELECT user_id FROM excluded_analytics_users
          )
      ),
      previous_month_users AS (
        SELECT DISTINCT
          user_activity_days.user_id
        FROM user_activity_days
        CROSS JOIN month_bounds
        WHERE user_activity_days.active_date >= month_bounds.previous_month_start
          AND user_activity_days.active_date < month_bounds.previous_month_end
          AND user_activity_days.user_id NOT IN (
            SELECT user_id FROM excluded_analytics_users
          )
      ),
      event_summary AS (
        SELECT
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
            WHERE event_name = 'debate_started'
          ) AS debates_started,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'debate_completed'
          ) AS debates_completed,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'report_viewed'
          ) AS reports_viewed,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'share_card_created'
          ) AS share_cards_created

        FROM user_events
        CROSS JOIN month_bounds
        WHERE user_events.created_at >= month_bounds.report_month_start::timestamp AT TIME ZONE 'America/Chicago'
          AND user_events.created_at < month_bounds.report_month_end::timestamp AT TIME ZONE 'America/Chicago'
          AND user_events.user_id NOT IN (
            SELECT user_id FROM excluded_analytics_users
          )
      )
      SELECT
        TRIM(TO_CHAR(month_bounds.report_month_start, 'Month YYYY')) AS report_month,

        COUNT(DISTINCT report_month_users.user_id) AS monthly_active_users,

        (
          SELECT COUNT(DISTINCT user_id)
          FROM previous_month_users
        ) AS previous_month_active_users,

        COUNT(DISTINCT report_month_users.user_id)
        -
        (
          SELECT COUNT(DISTINCT user_id)
          FROM previous_month_users
        ) AS net_user_change,

        ROUND(
          (
            COUNT(DISTINCT report_month_users.user_id)::numeric
            -
            (
              SELECT COUNT(DISTINCT user_id)::numeric
              FROM previous_month_users
            )
          )
          / NULLIF(
            (
              SELECT COUNT(DISTINCT user_id)::numeric
              FROM previous_month_users
            ),
            0
          ) * 100,
          1
        ) AS monthly_growth_percent,

        COUNT(DISTINCT report_month_users.user_id) FILTER (
          WHERE first_seen.first_active_date >= month_bounds.report_month_start
            AND first_seen.first_active_date < month_bounds.report_month_end
        ) AS new_users_this_month,

        COUNT(DISTINCT report_month_users.user_id) FILTER (
          WHERE first_seen.first_active_date < month_bounds.report_month_start
        ) AS returning_users_this_month,

        (
          SELECT COUNT(*)
          FROM report_month_users r
          INNER JOIN previous_month_users p
            ON r.user_id = p.user_id
        ) AS retained_users_from_last_month,

        (
          SELECT COUNT(*)
          FROM previous_month_users p
          LEFT JOIN report_month_users r
            ON p.user_id = r.user_id
          WHERE r.user_id IS NULL
        ) AS lost_users_from_last_month,

        event_summary.daily_challenge_viewed,
        event_summary.daily_challenge_started,
        event_summary.daily_challenge_completed,

        ROUND(
          event_summary.daily_challenge_started::numeric
          / NULLIF(event_summary.daily_challenge_viewed, 0) * 100,
          1
        ) AS daily_challenge_start_percent,

        ROUND(
          event_summary.daily_challenge_completed::numeric
          / NULLIF(event_summary.daily_challenge_started, 0) * 100,
          1
        ) AS daily_challenge_completion_percent,

        event_summary.debates_started,
        event_summary.debates_completed,

        ROUND(
          event_summary.debates_completed::numeric
          / NULLIF(event_summary.debates_started, 0) * 100,
          1
        ) AS debate_completion_percent,

        event_summary.reports_viewed,
        event_summary.share_cards_created,

        ROUND(
          event_summary.share_cards_created::numeric
          / NULLIF(event_summary.reports_viewed, 0) * 100,
          1
        ) AS report_to_share_percent

      FROM month_bounds
      LEFT JOIN report_month_users
        ON true
      LEFT JOIN first_seen
        ON report_month_users.user_id = first_seen.user_id
      CROSS JOIN event_summary
      GROUP BY
        month_bounds.report_month_start,
        event_summary.daily_challenge_viewed,
        event_summary.daily_challenge_started,
        event_summary.daily_challenge_completed,
        event_summary.debates_started,
        event_summary.debates_completed,
        event_summary.reports_viewed,
        event_summary.share_cards_created;
    `);

    const row = result.rows[0];

    if (!row) {
      throw new Error("No monthly analytics data returned.");
    }

    const monthlyActiveUsers = toNumber(row.monthly_active_users);
    const previousMonthActiveUsers = toNumber(row.previous_month_active_users);
    const netUserChange = toNumber(row.net_user_change);
    const monthlyGrowthRate = formatGrowthRate(row.monthly_growth_percent);

    const newUsersThisMonth = toNumber(row.new_users_this_month);
    const returningUsersThisMonth = toNumber(row.returning_users_this_month);
    const retainedUsersFromLastMonth = toNumber(row.retained_users_from_last_month);
    const lostUsersFromLastMonth = toNumber(row.lost_users_from_last_month);

    const dailyChallengeViewed = toNumber(row.daily_challenge_viewed);
    const dailyChallengeStarted = toNumber(row.daily_challenge_started);
    const dailyChallengeCompleted = toNumber(row.daily_challenge_completed);
    const dailyChallengeStartRate = percent(
      dailyChallengeStarted,
      dailyChallengeViewed
    );
    const dailyChallengeCompletionRate = percent(
      dailyChallengeCompleted,
      dailyChallengeStarted
    );

    const debatesStarted = toNumber(row.debates_started);
    const debatesCompleted = toNumber(row.debates_completed);
    const debateCompletionRate = percent(debatesCompleted, debatesStarted);

    const reportsViewed = toNumber(row.reports_viewed);
    const shareCardsCreated = toNumber(row.share_cards_created);
    const reportToShareRate = percent(shareCardsCreated, reportsViewed);

    const { monthlySummary, recommendedFocus } = chooseMonthlySummary({
      monthly_active_users: monthlyActiveUsers,
      previous_month_active_users: previousMonthActiveUsers,
      net_user_change: netUserChange,
      new_users_this_month: newUsersThisMonth,
      returning_users_this_month: returningUsersThisMonth,
      retained_users_from_last_month: retainedUsersFromLastMonth,
      lost_users_from_last_month: lostUsersFromLastMonth,
      debates_started: debatesStarted,
      debates_completed: debatesCompleted,
      share_cards_created: shareCardsCreated,
    });

    const message = [
      `🏛️ <b>The Oracle Monthly Report</b>`,
      ``,
      `For: <b>${row.report_month}</b>`,
      ``,
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
      `<b>Daily Challenge viewed:</b> ${dailyChallengeViewed}`,
      `<b>Daily Challenge started:</b> ${dailyChallengeStarted}`,
      `<b>Daily Challenge completed:</b> ${dailyChallengeCompleted}`,
      `<b>Daily Challenge start rate:</b> ${dailyChallengeStartRate}`,
      `<b>Daily Challenge completion rate:</b> ${dailyChallengeCompletionRate}`,
      ``,
      `<b>Debates started:</b> ${debatesStarted}`,
      `<b>Debates completed:</b> ${debatesCompleted}`,
      `<b>Debate completion rate:</b> ${debateCompletionRate}`,
      ``,
      `<b>Reports viewed:</b> ${reportsViewed}`,
      `<b>Share cards created:</b> ${shareCardsCreated}`,
      `<b>Report-to-share rate:</b> ${reportToShareRate}`,
      ``,
      `<b>Monthly summary:</b> ${monthlySummary}`,
      `<b>Recommended focus:</b> ${recommendedFocus}`,
    ].join("\n");

    await sendTelegramMessage(message);

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
