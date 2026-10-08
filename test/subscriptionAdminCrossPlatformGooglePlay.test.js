import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(
  new URL('../migrations/053_subscription_admin_cross_platform.sql', import.meta.url),
  'utf8'
);
const routes = fs.readFileSync(
  new URL('../subscriptionAdminRoutes.js', import.meta.url),
  'utf8'
);
const dashboardRoutes = fs.readFileSync(
  new URL('../subscriptionAdminDashboardRoutes.js', import.meta.url),
  'utf8'
);
const history = fs.readFileSync(
  new URL('../lib/subscriptionAdminHistoryService.js', import.meta.url),
  'utf8'
);
const subscribersUi = fs.readFileSync(
  new URL('../lib/subscriptionAdminSubscribersUi.js', import.meta.url),
  'utf8'
);

test('cross-platform migration records Google Play state history', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS google_play_subscription_state_events/);
  assert.match(migration, /record_google_play_subscription_state_event/);
  assert.match(migration, /AFTER INSERT OR UPDATE/);
  assert.match(migration, /previous_auto_renew_enabled/);
  assert.match(migration, /previous_latest_order_id/);
});

test('owner subscription projections combine App Store and Google Play', () => {
  assert.match(migration, /subscription_admin_cross_platform_customers_v1/);
  assert.match(migration, /subscription_admin_cross_platform_current_customers_v1/);
  assert.match(migration, /subscription_admin_cross_platform_business_metrics_v1/);
  assert.match(migration, /subscription_admin_cross_platform_transaction_timeline_v1/);
  assert.match(migration, /subscription_admin_cross_platform_events_v1/);
  assert.match(migration, /FROM google_play_subscription_entitlements entitlement/);
  assert.match(migration, /affiliate_google_play_subscription_attributions/);
  assert.match(migration, /'google_play'::text AS store_platform/);
});

test('Google Play current state maps into subscriber trial paid churn and affiliate fields', () => {
  assert.match(migration, /google\.normalized_status = 'on_hold'/);
  assert.match(migration, /google\.normalized_status IN \('paused', 'expired', 'replaced'\)/);
  assert.match(migration, /google\.is_trial = FALSE[\s\S]*google\.has_pro_access[\s\S]*recurring_revenue_active/);
  assert.match(migration, /google\.is_trial = TRUE[\s\S]*google\.has_pro_access[\s\S]*trial_active/);
  assert.match(migration, /google\.auto_renew_enabled = FALSE[\s\S]*google\.has_pro_access[\s\S]*canceling/);
  assert.match(migration, /attribution\.normalized_creator_code/);
  assert.match(migration, /affiliate_attribution_source/);
});

test('owner APIs read cross-platform customer metrics timelines and events', () => {
  assert.match(routes, /subscription_admin_cross_platform_business_metrics_v1/);
  assert.match(routes, /subscription_admin_cross_platform_current_customers_v1/);
  assert.match(routes, /subscription_admin_cross_platform_customers_v1/);
  assert.match(routes, /subscription_admin_cross_platform_transaction_timeline_v1/);
  assert.match(routes, /subscription_admin_cross_platform_events_v1/);
  assert.match(dashboardRoutes, /subscription_admin_cross_platform_current_customers_v1/);
});

test('subscriber history and UI expose Google Play alongside App Store', () => {
  assert.match(history, /subscription_admin_cross_platform_transaction_timeline_v1/);
  assert.match(history, /subscription_admin_cross_platform_events_v1/);
  assert.match(history, /subscription_admin_cross_platform_customers_v1/);
  assert.match(subscribersUi, /Google Play/);
  assert.match(subscribersUi, /App Store/);
  assert.match(subscribersUi, /store_platform/);
});
