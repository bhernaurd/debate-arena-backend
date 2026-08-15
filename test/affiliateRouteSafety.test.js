import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(
  fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(testDirectory, '..');
const source = fs.readFileSync(
  path.join(repositoryRoot, 'affiliateRoutes.js'),
  'utf8'
);

test('admin affiliate creation keeps creator codes unique while allowing a shared Apple offer reference', () => {
  assert.match(
    source,
    /affiliates_normalized_code_unique[\s\S]*?affiliate_code_already_exists/
  );
  assert.doesNotMatch(
    source,
    /affiliate_offer_identifier_already_exists/
  );
});


test('partner dashboard stays read-only and presents anonymous subscriber activity', () => {
  assert.match(source, /Anonymous Subscriber Activity/);
  assert.match(source, /Subscriber<\/th>/);
  assert.match(source, /Current Subscribers/);
  assert.match(source, /Promo Active/);
  assert.match(source, /Paid \+ Renewing/);
  assert.match(source, /Paid \+ Canceling/);
  assert.match(source, /Current State<\/th>/);
  assert.match(source, /Eligible Revenue Generated/);
  assert.doesNotMatch(source, /Commission-Earning Subscribers/);
  assert.doesNotMatch(source, /Search creators/i);
  assert.doesNotMatch(source, /document\.cookie/);
});


test('performance breakdown stays cohort-focused and does not repeat lifetime financial totals', () => {
  const start = source.indexOf("document.getElementById('performanceBreakdown').innerHTML");
  const end = source.indexOf("document.getElementById('subscriberActivity')", start);

  assert.ok(start >= 0, 'performance breakdown render block should exist');
  assert.ok(end > start, 'performance breakdown render block should have an end marker');

  const block = source.slice(start, end);
  assert.match(block, /Promo Renewal Rate/);
  assert.match(block, /Promo Non-Renewals/);
  assert.match(block, /Paid Conversion Rate/);
  assert.match(block, /Active Retention/);
  assert.match(block, /Cancellation Rate/);
  assert.doesNotMatch(block, /Eligible Revenue Generated/);
  assert.doesNotMatch(block, /Lifetime Commission Earned/);
  assert.doesNotMatch(block, /Lifetime Paid/);
});

test('conversion and retention copy distinguishes historical conversion from current access', () => {
  assert.match(source, /ever reached a commission-earning paid subscription/);
  assert.match(source, /still counts as converted even if they later cancel or expire/);
  assert.match(source, /still have subscription access right now/);
  assert.match(source, /previously converted but later expired are not counted as active/);
});


test('breakdown uses explicit calendar-month navigation with YTD and Lifetime shortcuts', () => {
  assert.match(source, /id="selectedMonthLabel"/);
  assert.match(source, /id="monthPicker" type="month"/);
  assert.match(source, /id="previousMonth"/);
  assert.match(source, /id="nextMonth"/);
  assert.match(source, /data-range="ytd"/);
  assert.match(source, /data-range="lifetime"/);
  assert.match(source, /month:/);
  assert.match(source, /In Progress/);
  assert.match(source, /Awaiting Finalization/);
  assert.doesNotMatch(source, /data-range="last_month"/);
  assert.doesNotMatch(source, /data-range="last_3_months"/);
});

test('owner affiliate admin dashboard is a locked shell backed by admin-only APIs', () => {
  assert.match(source, /\/admin\/affiliates/);
  assert.match(source, /AFFILIATE_ADMIN_KEY/);
  assert.match(source, /sessionStorage\.getItem\('agoraAffiliateAdminKey'\)/);
  assert.match(source, /Overview/);
  assert.match(source, /Monthly Payouts/);
  assert.match(source, /Affiliate Alerts/);
  assert.match(source, /Production only/);
  assert.match(source, /\/api\/admin\/affiliates\/:id\/operational-status', adminOnly/);
  assert.match(source, /\/api\/admin\/affiliate-alerts', adminOnly/);
  assert.match(source, /\/api\/admin\/affiliate-payouts', adminOnly/);
  assert.doesNotMatch(source, /const\s+adminKey\s*=\s*['"][A-Za-z0-9+/=_-]{32,}['"]/);
});

test('admin payout UI can build a month before payout rows already exist', () => {
  assert.match(source, /id="refreshMonth"/);
  assert.match(source, /\/api\/admin\/affiliate-payouts\/refresh-period/);
  assert.match(source, /Refresh Month after Apple data is available/);
});

test('admin dashboard exposes App Store Connect imports and sync controls', () => {
  assert.match(source, /App Store Connect Imports/);
  assert.match(source, /Sync App Store Connect/);
  assert.match(source, /\/api\/admin\/app-store-connect\/imports', adminOnly/);
  assert.match(source, /Complete Apple Import/);
  assert.match(source, /Needs Setup/);
  assert.match(source, /APP_STORE_CONNECT_ISSUER_ID/);
  assert.match(source, /AFFILIATE_APPLE_SUBSCRIPTION_ID/);
});

test('App Store Connect imports collapse duplicate creator-code resources and persist owner choices', () => {
  assert.match(source, /Choose Current Apple Configuration/);
  assert.match(source, /configurationCount/);
  assert.match(source, /data-apple-import-choose/);
  assert.match(source, /data-apple-import-ignore/);
  assert.match(source, /data-apple-import-restore/);
  assert.match(source, /\/api\/admin\/app-store-connect\/imports\/:code\/canonical', adminOnly/);
  assert.match(source, /\/api\/admin\/app-store-connect\/imports\/:code\/ignore', adminOnly/);
  assert.match(source, /\/api\/admin\/app-store-connect\/imports\/:code\/restore', adminOnly/);
  assert.match(source, /Show Ignored/);
});

test('shared Apple offers are explicitly supported and never shown as attribution blockers', () => {
  assert.match(source, /Shared affiliate offer/);
  assert.match(source, /historical configuration/);
  assert.doesNotMatch(source, /Exact Attribution Blocked/);
  assert.doesNotMatch(source, /Fix Apple Setup/);
  assert.doesNotMatch(source, /each affiliate must have its own Apple offer reference/);
  assert.doesNotMatch(source, /data-apple-import-blocked/);
});

test('authenticated account creator-code claim routes exist and reconcile safely', () => {
  assert.match(source, /\/api\/account\/affiliate\/claim/);
  assert.match(source, /readBearerToken\(req\)/);
  assert.match(source, /readAccountInstallationId\(req\)/);
  assert.match(source, /claimCreatorCode/);
  assert.match(source, /reconcileAccount/);
  assert.match(source, /creator-code claim saved; reconciliation deferred/);
});
