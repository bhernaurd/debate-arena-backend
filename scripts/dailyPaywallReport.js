import '../env.js';
import pg from 'pg';
import { sendTelegramMessage, toNumber } from './analyticsReportV2Shared.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

const PAYWALL_SQL = `
WITH params AS (
  SELECT ((NOW() AT TIME ZONE 'America/Chicago')::date - 1)::date AS report_date
),
bounds AS (
  SELECT
    report_date,
    report_date::timestamp AT TIME ZONE 'America/Chicago' AS start_time,
    (report_date + 1)::timestamp AT TIME ZONE 'America/Chicago' AS end_time
  FROM params
),
installation_accounts AS (
  SELECT DISTINCT ON (installation_id)
    installation_id,
    account_id
  FROM account_installations
  ORDER BY installation_id, (unlinked_at IS NULL) DESC, updated_at DESC, linked_at DESC
),
excluded_accounts AS (
  SELECT DISTINCT ia.account_id
  FROM excluded_analytics_users x
  JOIN installation_accounts ia ON ia.installation_id = x.user_id
),
paywall_events AS (
  SELECT e.id, ia.account_id
  FROM user_events e
  CROSS JOIN bounds b
  LEFT JOIN installation_accounts ia ON ia.installation_id = e.user_id
  WHERE e.event_name = 'paywall_viewed'
    AND e.created_at >= b.start_time
    AND e.created_at < b.end_time
    AND NOT EXISTS (
      SELECT 1 FROM excluded_analytics_users x WHERE x.user_id = e.user_id
    )
    AND ia.account_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM excluded_accounts ea WHERE ea.account_id = ia.account_id
    )
)
SELECT
  TO_CHAR(p.report_date, 'Mon FMDD') AS report_date_label,
  COUNT(pe.id) AS paywall_views,
  COUNT(DISTINCT pe.account_id) AS paywall_users
FROM params p
LEFT JOIN paywall_events pe ON TRUE
GROUP BY p.report_date;
`;

async function main() {
  try {
    const result = await pool.query(PAYWALL_SQL);
    const row = result.rows[0];
    if (!row) throw new Error('Daily paywall query returned no row.');

    const views = toNumber(row.paywall_views);
    const users = toNumber(row.paywall_users);
    const viewLabel = views === 1 ? 'time' : 'times';
    const userLabel = users === 1 ? 'user' : 'users';

    await sendTelegramMessage([
      `💳 <b>PAYWALL — ${row.report_date_label}</b>`,
      ``,
      `Paywall viewed: ${views} ${viewLabel} • ${users} ${userLabel}`,
    ].join('\n'));

    console.log('[dailyPaywallReport] Sent:', { views, users });
  } catch (error) {
    console.error('[dailyPaywallReport] Failed:', error?.message || error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
