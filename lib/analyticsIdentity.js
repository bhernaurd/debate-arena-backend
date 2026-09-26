// Shared analytics identity contract.
//
// One real user should count once across devices after sign-in, while anonymous
// installations still count until they are linked to an Agora account.
//
// Every DAU/WAU/MAU report should build from this CTE so Telegram, the analytics
// endpoint, email reports, and direct Postgres queries use the same definition.
export const CANONICAL_ACTIVITY_CTES = `
installation_accounts AS (
  SELECT DISTINCT ON (installation_id)
    installation_id,
    account_id
  FROM account_installations
  ORDER BY
    installation_id,
    (unlinked_at IS NULL) DESC,
    updated_at DESC,
    linked_at DESC
),
excluded_accounts AS (
  SELECT DISTINCT ia.account_id
  FROM excluded_analytics_users excluded
  JOIN installation_accounts ia
    ON ia.installation_id = excluded.user_id
  WHERE ia.account_id IS NOT NULL
),
canonical_activity AS (
  SELECT
    activity.active_date,
    activity.user_id AS installation_id,
    ia.account_id,
    COALESCE(
      'account:' || ia.account_id::text,
      'installation:' || activity.user_id
    ) AS analytics_user_key
  FROM user_activity_days activity
  LEFT JOIN installation_accounts ia
    ON ia.installation_id = activity.user_id
  WHERE NOT EXISTS (
      SELECT 1
      FROM excluded_analytics_users excluded
      WHERE excluded.user_id = activity.user_id
    )
    AND (
      ia.account_id IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM excluded_accounts excluded_account
        WHERE excluded_account.account_id = ia.account_id
      )
    )
)
`;

export function canonicalAnalyticsUserKey({
  accountId = null,
  installationId,
} = {}) {
  const cleanAccountId =
    typeof accountId === 'string'
      ? accountId.trim()
      : '';
  const cleanInstallationId =
    typeof installationId === 'string'
      ? installationId.trim()
      : '';

  if (cleanAccountId) {
    return `account:${cleanAccountId}`;
  }

  if (cleanInstallationId) {
    return `installation:${cleanInstallationId}`;
  }

  return null;
}
