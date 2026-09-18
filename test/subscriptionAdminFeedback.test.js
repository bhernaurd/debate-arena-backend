import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboardSource = await readFile(
  new URL('../subscriptionAdminDashboardRoutes.js', import.meta.url),
  'utf8'
);
const feedbackUiSource = await readFile(
  new URL('../lib/subscriptionAdminFeedbackUi.js', import.meta.url),
  'utf8'
);
const migrationSource = await readFile(
  new URL('../migrations/042_founder_feedback_review_status.sql', import.meta.url),
  'utf8'
);

test('admin dashboard exposes a protected feedback inbox', () => {
  assert.match(
    dashboardSource,
    /router\.get\('\/data\/feedback'/
  );
  assert.match(
    dashboardSource,
    /router\.post\('\/data\/feedback\/:feedbackId\/reviewed'/
  );
  assert.match(
    dashboardSource,
    /FROM founder_feedback f/
  );
});

test('feedback inbox supports status, type, search, and account context', () => {
  assert.match(dashboardSource, /feature_idea/);
  assert.match(dashboardSource, /f\.reviewed_at IS NULL/);
  assert.match(dashboardSource, /f\.reviewed_at IS NOT NULL/);
  assert.match(dashboardSource, /f\.message ILIKE/);
  assert.match(dashboardSource, /COALESCE\(ai\.email, gi\.email\) AS email/);
});

test('feedback review state is persisted', () => {
  assert.match(
    migrationSource,
    /ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ/
  );
  assert.match(
    dashboardSource,
    /SET reviewed_at = CASE/
  );
  assert.match(
    dashboardSource,
    /THEN COALESCE\(reviewed_at, NOW\(\)\)/
  );
});

test('feedback dashboard UI adds a nav item and direct community inbox', () => {
  assert.match(feedbackUiSource, /id="feedbackNav"/);
  assert.match(feedbackUiSource, /id="view-feedback"/);
  assert.match(feedbackUiSource, /Community feedback/);
  assert.match(feedbackUiSource, /Mark as reviewed/);
  assert.match(feedbackUiSource, /Copy feedback/);
});

test('feedback dashboard shows an unread badge and summary metrics', () => {
  assert.match(feedbackUiSource, /feedbackNavBadge/);
  assert.match(feedbackUiSource, /Total feedback/);
  assert.match(feedbackUiSource, /Feature ideas/);
  assert.match(feedbackUiSource, /Bugs/);
});


test('feedback can be permanently deleted from the private dashboard', () => {
  assert.match(
    dashboardSource,
    /router\.delete\('\/data\/feedback\/:feedbackId'/
  );
  assert.match(
    dashboardSource,
    /DELETE FROM founder_feedback/
  );
  assert.match(
    feedbackUiSource,
    /Delete feedback/
  );
  assert.match(
    feedbackUiSource,
    /Delete this feedback permanently\? This cannot be undone\./
  );
});


test('feedback table exposes an inline trash action beside review controls', () => {
  assert.match(feedbackUiSource, /feedback-row-actions/);
  assert.match(feedbackUiSource, /data-feedback-delete/);
  assert.match(feedbackUiSource, /aria-label="Delete feedback"/);
  assert.match(
    feedbackUiSource,
    /Delete this feedback permanently\? This cannot be undone\./
  );
});
