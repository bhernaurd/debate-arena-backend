import pg from "pg";

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

function pluralize(count, singular, plural = `${singular}s`) {
  return Number(count || 0) === 1 ? singular : plural;
}

function normalDebateCompletionRateLabel({
  normalDebateStarts,
  normalDebateCompletions,
}) {
  const starts = toNumber(normalDebateStarts);
  const completions = toNumber(normalDebateCompletions);

  if (completions > 0 && starts === 0) {
    return "tracking rollout in progress";
  }

  if (starts > 0 && completions > starts * 2) {
    return "tracking rollout in progress";
  }

  return percent(completions, starts);
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
    key: "daily_challenge_start",
    label: "Daily Challenge views → starts",
    from: data.dailyChallengeViews,
    to: data.dailyChallengeStarts,
    fromLabel: "views",
    toLabel: "starts",
    action:
      "Improve the Daily Challenge intro and CTA. Make the prompt feel more urgent and make Enter the Agora the obvious next step.",
  });

  addCandidate({
    key: "daily_challenge_completion",
    label: "Daily Challenge starts → completions",
    from: data.dailyChallengeStarts,
    to: data.dailyChallengeCompletions,
    fromLabel: "starts",
    toLabel: "completions",
    action:
      "Improve Daily Challenge completion. Make the Finish Debate button more obvious and make the report payoff feel immediate.",
  });

  addCandidate({
    key: "philosopher_to_topic",
    label: "Philosopher selectors → topic selectors",
    from: data.philosopherSelectors,
    to: data.topicSelectors,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Improve the topic selection step. Make the questions more immediately compelling after a user selects a philosopher, and make generated topics more prominent.",
  });

  addCandidate({
    key: "topic_to_difficulty",
    label: "Topic selectors → difficulty selectors",
    from: data.topicSelectors,
    to: data.difficultySelectors,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Review the difficulty selection screen. Make Guided, Balanced, and Relentless instantly clear and reduce hesitation before starting.",
  });

  addCandidate({
    key: "difficulty_to_normal_start",
    label: "Difficulty selectors → normal debate starters",
    from: data.difficultySelectors,
    to: data.uniqueNormalDebateStarters,
    fromLabel: "users",
    toLabel: "users",
    action:
      "Check the handoff from difficulty selection into the debate screen. Make sure the debate starts quickly and the loading state feels intentional.",
  });

  addCandidate({
    key: "normal_start_to_completion",
    label: "Normal debate starts → normal debate completions",
    from: data.normalDebateStarts,
    to: data.normalDebateCompletions,
    fromLabel: "starts",
    toLabel: "completions",
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
      "Improve the share-card CTA. Show it immediately after the report score and make the card feel worth saving or posting.",
  });

  if (candidates.length === 0) {
    return {
      biggestDropOff: "No usable monthly funnel data yet.",
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
  normalDebateStarts,
  normalDebateCompletions,
  reportsGeneratedWithTiming,
}) {
  const notes = [];

  const starts = toNumber(normalDebateStarts);
  const completions = toNumber(normalDebateCompletions);
  const timed = toNumber(reportsGeneratedWithTiming);

  if (completions > 0 && starts === 0) {
    notes.push(
      "Normal debate starts may be undercounted because debate-start tracking was improved near the end of the month."
    );
  } else if (starts > 0 && completions > starts * 2) {
    notes.push(
      "Normal debate completion rate may be inflated because older app versions undercounted debate starts."
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

  if (notes.length === 0) {
    return "No major tracking caveats for this month.";
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
      current_month_users AS (
        SELECT DISTINCT
          user_activity_days.user_id
        FROM user_activity_days
        CROSS JOIN bounds
        WHERE user_activity_days.active_date >= bounds.report_month_start
          AND user_activity_days.active_date < bounds.report_month_end
          AND NOT EXISTS (
            SELECT 1 FROM excluded_analytics_users x
            WHERE x.user_id = user_activity_days.user_id
          )
      ),
      previous_month_users AS (
        SELECT DISTINCT
          user_activity_days.user_id
        FROM user_activity_days
        CROSS JOIN bounds
        WHERE user_activity_days.active_date >= bounds.previous_month_start
          AND user_activity_days.active_date < bounds.previous_month_end
          AND NOT EXISTS (
            SELECT 1 FROM excluded_analytics_users x
            WHERE x.user_id = user_activity_days.user_id
          )
      ),
      activity_summary AS (
        SELECT
          bounds.report_month_start,
          bounds.report_month_end,

          COUNT(DISTINCT current_month_users.user_id) AS monthly_active_users,

          (
            SELECT COUNT(DISTINCT previous_month_users.user_id)
            FROM previous_month_users
          ) AS previous_month_active_users,

          COUNT(DISTINCT current_month_users.user_id)
          -
          (
            SELECT COUNT(DISTINCT previous_month_users.user_id)
            FROM previous_month_users
          ) AS net_user_change,

          COUNT(DISTINCT current_month_users.user_id) FILTER (
            WHERE first_seen.first_active_date >= bounds.report_month_start
              AND first_seen.first_active_date < bounds.report_month_end
          ) AS new_users_this_month,

          COUNT(DISTINCT current_month_users.user_id) FILTER (
            WHERE first_seen.first_active_date < bounds.report_month_start
          ) AS returning_users_this_month,

          COUNT(DISTINCT current_month_users.user_id) FILTER (
            WHERE current_month_users.user_id IN (
              SELECT user_id FROM previous_month_users
            )
          ) AS retained_users_from_last_month,

          (
            SELECT COUNT(DISTINCT previous_month_users.user_id)
            FROM previous_month_users
            WHERE NOT EXISTS (
              SELECT 1 FROM current_month_users cmu
              WHERE cmu.user_id = previous_month_users.user_id
            )
          ) AS lost_users_from_last_month

        FROM bounds
        LEFT JOIN current_month_users
          ON true
        LEFT JOIN first_seen
          ON current_month_users.user_id = first_seen.user_id
        GROUP BY
          bounds.report_month_start,
          bounds.report_month_end
      ),
      event_summary AS (
        SELECT
          bounds.report_month_start,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_viewers,

          COUNT(*) FILTER (
            WHERE event_name = 'daily_challenge_viewed'
          ) AS daily_challenge_views,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_started'
          ) AS daily_challenge_starters,

          COUNT(*) FILTER (
            WHERE event_name = 'daily_challenge_started'
          ) AS daily_challenge_starts,

          COUNT(DISTINCT user_events.user_id) FILTER (
            WHERE event_name = 'daily_challenge_completed'
          ) AS daily_challenge_completers,

          COUNT(*) FILTER (
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
        GROUP BY bounds.report_month_start
      ),
      report_generation_timing_events AS (
        SELECT
          bounds.report_month_start,
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
          bounds.report_month_start,
          COUNT(report_generation_timing_events.generation_seconds) AS reports_generated_with_timing,
          ROUND(AVG(report_generation_timing_events.generation_seconds), 2) AS average_generation_seconds,
          ROUND(MIN(report_generation_timing_events.generation_seconds), 2) AS fastest_generation_seconds,
          ROUND(MAX(report_generation_timing_events.generation_seconds), 2) AS slowest_generation_seconds
        FROM bounds
        LEFT JOIN report_generation_timing_events
          ON bounds.report_month_start = report_generation_timing_events.report_month_start
        GROUP BY bounds.report_month_start
      )
      SELECT
        TO_CHAR(activity_summary.report_month_start, 'FMMonth YYYY') AS report_month,
        TO_CHAR(activity_summary.report_month_start, 'YYYY-MM-DD') AS report_month_start,
        TO_CHAR(activity_summary.report_month_end - INTERVAL '1 day', 'YYYY-MM-DD') AS report_month_end,

        activity_summary.monthly_active_users,
        activity_summary.previous_month_active_users,
        activity_summary.net_user_change,
        activity_summary.new_users_this_month,
        activity_summary.returning_users_this_month,
        activity_summary.retained_users_from_last_month,
        activity_summary.lost_users_from_last_month,

        event_summary.daily_challenge_viewers,
        event_summary.daily_challenge_views,
        event_summary.daily_challenge_starters,
        event_summary.daily_challenge_starts,
        event_summary.daily_challenge_completers,
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
        ON activity_summary.report_month_start = event_summary.report_month_start
      JOIN report_generation_timing_summary
        ON activity_summary.report_month_start = report_generation_timing_summary.report_month_start;
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

    const monthlyGrowthRate = formatGrowthRate(
      monthlyActiveUsers,
      previousMonthActiveUsers
    );

    const monthlyViewToStartRate = percent(
      dailyChallengeStarts,
      dailyChallengeViews
    );

    const monthlyStartToCompletionRate = percent(
      dailyChallengeCompletions,
      dailyChallengeStarts
    );

    const monthlyViewToCompletionRate = percent(
      dailyChallengeCompletions,
      dailyChallengeViews
    );

    const monthlyPhilosopherToTopicRate = percent(
      topicSelectors,
      philosopherSelectors
    );

    const monthlyTopicToDifficultyRate = percent(
      difficultySelectors,
      topicSelectors
    );

    const monthlyDifficultyToNormalStartRate = percent(
      uniqueNormalDebateStarters,
      difficultySelectors
    );

    const monthlyNormalDebateCompletionRate = normalDebateCompletionRateLabel({
      normalDebateStarts,
      normalDebateCompletions,
    });

    const totalReportToShareRate = percent(
      shareCardsCreated,
      reportViews
    );

    const uniqueReportToShareRate = percent(
      uniqueShareCardCreators,
      uniqueReportViewers
    );

    const strongestArea = chooseStrongestArea({
      dailyChallengeCompletions,
      normalDebateCompletions,
      reportViews,
      shareCardsCreated,
    });

    const { biggestDropOff, recommendedAction } = chooseBiggestDropOff({
      dailyChallengeViews,
      dailyChallengeStarts,
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

    const trackingNote = chooseTrackingNote({
      reportMonth: row.report_month,
      normalDebateStarts,
      normalDebateCompletions,
      reportsGeneratedWithTiming,
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
      `<b>Daily Challenge Monthly Funnel</b>`,
      `<b>Daily Challenge viewers:</b> ${dailyChallengeViewers} ${pluralize(dailyChallengeViewers, "user")}`,
      `<b>Daily Challenge views:</b> ${dailyChallengeViews} total`,
      `<b>Daily Challenge starters:</b> ${dailyChallengeStarters} ${pluralize(dailyChallengeStarters, "user")}`,
      `<b>Daily Challenge starts:</b> ${dailyChallengeStarts} total`,
      `<b>Daily Challenge completers:</b> ${dailyChallengeCompleters} ${pluralize(dailyChallengeCompleters, "user")}`,
      `<b>Daily Challenge completions:</b> ${dailyChallengeCompletions} total`,
      `<b>View → start rate:</b> ${monthlyViewToStartRate}`,
      `<b>Start → completion rate:</b> ${monthlyStartToCompletionRate}`,
      `<b>View → completion rate:</b> ${monthlyViewToCompletionRate}`,
      ``,
      `<b>Normal Debate Monthly Funnel</b>`,
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
      `<b>Philosopher → topic rate:</b> ${monthlyPhilosopherToTopicRate}`,
      `<b>Topic → difficulty rate:</b> ${monthlyTopicToDifficultyRate}`,
      `<b>Difficulty → normal debate start rate:</b> ${monthlyDifficultyToNormalStartRate}`,
      `<b>Normal debate completion rate:</b> ${monthlyNormalDebateCompletionRate}`,
      ``,
      `<b>Reports / Sharing</b>`,
      `<b>Reports viewed:</b> ${reportViews} total`,
      `<b>Unique report viewers:</b> ${uniqueReportViewers} ${pluralize(uniqueReportViewers, "user")}`,
      `<b>Share cards created:</b> ${shareCardsCreated} total`,
      `<b>Unique share-card creators:</b> ${uniqueShareCardCreators} ${pluralize(uniqueShareCardCreators, "user")}`,
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
      `<b>Monthly Summary</b>`,
      `<b>Strongest area:</b> ${strongestArea}`,
      `<b>Biggest funnel drop-off:</b> ${biggestDropOff}`,
      `<b>Recommended focus next month:</b> ${recommendedAction}`,
      ``,
      `<b>Tracking note:</b> ${trackingNote}`,
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
