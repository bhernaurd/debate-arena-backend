from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    if text.count(old) != 1:
        raise SystemExit(f'{label} anchor not unique: {text.count(old)}')
    return text.replace(old, new, 1)

analytics = Path('analytics.js')
a = analytics.read_text()
store_fn = '''  async function recordStorefrontCountry(userId, countryCode) {
    if (!countryCode) return;
    await pool.query(
      `UPDATE account_installations
       SET app_store_country_code = $2,
           app_store_country_observed_at = NOW(),
           updated_at = NOW()
       WHERE installation_id = $1
         AND unlinked_at IS NULL`,
      [userId, countryCode]
    );
  }

'''
a = replace_once(a, store_fn, '', 'storefront database writer')
a = replace_once(
    a,
    '''      await recordStorefrontCountry(userId, storefrontCountryCode);
      await recordActiveDay(userId);''',
    '''      // Storefront country is retained in the app_opened event metadata. This keeps
      // collection additive and lets a future account inherit pre-sign-in observations
      // through its linked installation without requiring a schema migration first.
      await recordActiveDay(userId);''',
    'storefront database call',
)
analytics.write_text(a)

routes = Path('subscriptionAdminDashboardRoutes.js')
r = routes.read_text()
activity_observed = '''        LEFT JOIN LATERAL (
          SELECT country_code, country_source
          FROM (
            SELECT
              install_country.app_store_country_code AS country_code,
              'observed_storefront'::text AS country_source,
              install_country.app_store_country_observed_at AS observed_at,
              0 AS source_priority
            FROM account_installations install_country
            WHERE install_country.account_id = a.id
              AND install_country.app_store_country_code ~ '^[A-Z]{3}$'

            UNION ALL

            SELECT
              UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code,
              'analytics_storefront'::text AS country_source,
              event_country.created_at AS observed_at,
              1 AS source_priority
            FROM user_events event_country
            WHERE event_country.user_id IN (
              SELECT DISTINCT installation_id
              FROM account_installations linked_install
              WHERE linked_install.account_id = a.id
            )
              AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'
            ORDER BY observed_at DESC NULLS LAST
            LIMIT 1
          ) observed_country
          ORDER BY source_priority ASC, observed_at DESC NULLS LAST
          LIMIT 1
        ) observed_country ON TRUE'''
activity_replacement = '''        LEFT JOIN LATERAL (
          SELECT
            UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code,
            'analytics_storefront'::text AS country_source
          FROM user_events event_country
          WHERE event_country.user_id IN (
            SELECT DISTINCT installation_id
            FROM account_installations linked_install
            WHERE linked_install.account_id = a.id
          )
            AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'
          ORDER BY event_country.created_at DESC
          LIMIT 1
        ) observed_country ON TRUE'''
r = replace_once(r, activity_observed, activity_replacement, 'activity observed country join')

geo_observed = '''          LEFT JOIN LATERAL (
            SELECT country_code
            FROM (
              SELECT
                install_country.app_store_country_code AS country_code,
                install_country.app_store_country_observed_at AS observed_at,
                0 AS source_priority
              FROM account_installations install_country
              WHERE install_country.account_id = a.id
                AND install_country.app_store_country_code ~ '^[A-Z]{3}$'

              UNION ALL

              SELECT
                UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code,
                event_country.created_at AS observed_at,
                1 AS source_priority
              FROM user_events event_country
              WHERE event_country.user_id IN (
                SELECT DISTINCT installation_id
                FROM account_installations linked_install
                WHERE linked_install.account_id = a.id
              )
                AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'
              ORDER BY observed_at DESC NULLS LAST
              LIMIT 1
            ) observed
            ORDER BY source_priority ASC, observed_at DESC NULLS LAST
            LIMIT 1
          ) observed_country ON TRUE'''
geo_replacement = '''          LEFT JOIN LATERAL (
            SELECT
              UPPER(event_country.metadata->>'storefrontCountryCode') AS country_code
            FROM user_events event_country
            WHERE event_country.user_id IN (
              SELECT DISTINCT installation_id
              FROM account_installations linked_install
              WHERE linked_install.account_id = a.id
            )
              AND UPPER(COALESCE(event_country.metadata->>'storefrontCountryCode', '')) ~ '^[A-Z]{3}$'
            ORDER BY event_country.created_at DESC
            LIMIT 1
          ) observed_country ON TRUE'''
r = replace_once(r, geo_observed, geo_replacement, 'geography observed country join')
routes.write_text(r)

test = Path('test/subscriptionAdminAccountUsageGeography.test.js')
t = test.read_text()
t = t.replace("  assert.match(source, /app_store_country_code/);\n", "  assert.match(source, /storefrontCountryCode/);\n")
t = t.replace("  assert.match(source, /UPDATE account_installations/);\n  assert.match(source, /app_store_country_observed_at = NOW\\(\\)/);\n", "  assert.doesNotMatch(source, /UPDATE account_installations/);\n  assert.match(source, /storefrontCountryCode \\? \{ storefrontCountryCode \} : null/);\n")
test.write_text(t)

print('Geography no longer depends on migration 038 being applied before deployment.')
