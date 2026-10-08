import assert from 'node:assert/strict';
import test from 'node:test';

import { ANALYTICS_ALLOWED_EVENTS } from '../analytics.js';

test('production analytics accepts the Android release event contract', () => {
  const expected = [
    'restore_no_active_subscription',
    'ranked_placement_started',
    'ranked_placement_completed',
    'ranked_ladder_started',
    'ranked_ladder_completed',
    'ranked_forfeited',
  ];

  for (const eventName of expected) {
    assert.equal(
      ANALYTICS_ALLOWED_EVENTS.has(eventName),
      true,
      `${eventName} must be accepted before the Android release`
    );
  }
});
