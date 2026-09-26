import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CANONICAL_ACTIVITY_CTES,
  canonicalAnalyticsUserKey,
} from '../lib/analyticsIdentity.js';
import {
  ANALYTICS_ALLOWED_EVENTS,
} from '../analytics.js';

test('canonical analytics identity prefers account over installation', () => {
  assert.equal(
    canonicalAnalyticsUserKey({
      accountId: '11111111-1111-4111-8111-111111111111',
      installationId: 'installation-123',
    }),
    'account:11111111-1111-4111-8111-111111111111'
  );
});

test('canonical analytics identity preserves anonymous installations', () => {
  assert.equal(
    canonicalAnalyticsUserKey({
      installationId: 'installation-123',
    }),
    'installation:installation-123'
  );
  assert.equal(
    canonicalAnalyticsUserKey({}),
    null
  );
});

test('canonical activity SQL counts linked accounts once and anonymous installs separately', () => {
  assert.match(
    CANONICAL_ACTIVITY_CTES,
    /COALESCE\(\s*'account:' \|\| ia\.account_id::text,\s*'installation:' \|\| activity\.user_id\s*\) AS analytics_user_key/s
  );
  assert.match(
    CANONICAL_ACTIVITY_CTES,
    /LEFT JOIN account_installations/
  );
  assert.match(
    CANONICAL_ACTIVITY_CTES,
    /excluded_analytics_users/
  );
});

test('daily and monthly reports share the canonical activity identity contract', () => {
  const daily = fs.readFileSync(
    new URL('../scripts/dailyAnalyticsReportV2.js', import.meta.url),
    'utf8'
  );
  const monthly = fs.readFileSync(
    new URL('../scripts/monthlyAnalyticsReportV2.js', import.meta.url),
    'utf8'
  );

  assert.match(daily, /CANONICAL_ACTIVITY_CTES/);
  assert.match(monthly, /CANONICAL_ACTIVITY_CTES/);
  assert.match(daily, /COUNT\(DISTINCT analytics_user_key\)/);
  assert.match(monthly, /analytics_user_key/);
});

test('new Learn and Mirror analytics events are accepted by the backend', () => {
  const expected = [
    'learn_hub_viewed',
    'learn_card_opened',
    'learn_item_started',
    'learn_item_completed',
    'learn_course_completed',
    'mirror_questionnaire_started',
    'mirror_questionnaire_completed',
    'mirror_analysis_generation_started',
    'mirror_analysis_generated',
    'mirror_analysis_failed',
    'mirror_analysis_read_depth',
    'mirror_detail_expanded',
    'mirror_evidence_opened',
    'mirror_recommendation_tapped',
    'mirror_next_eligible_seen',
    'mirror_completed',
  ];

  for (const eventName of expected) {
    assert.equal(
      ANALYTICS_ALLOWED_EVENTS.has(eventName),
      true,
      `${eventName} should be accepted by analytics.js`
    );
  }
});
