import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaywallConfiguration,
} from './paywallConfigurationRoutes.js';

test('returns the expected Chicago campaign boundaries', () => {
  const cases = [
    {
      iso: '2026-07-22T04:59:59Z',
      variant: 'standard',
      phase: 'none',
      days: null,
      localDate: '2026-07-21',
    },
    {
      iso: '2026-07-22T05:00:00Z',
      variant: 'founding_2026',
      phase: 'regular',
      days: 41,
      localDate: '2026-07-22',
    },
    {
      iso: '2026-08-18T05:00:00Z',
      variant: 'founding_2026',
      phase: 'final_two_weeks',
      days: 14,
      localDate: '2026-08-18',
    },
    {
      iso: '2026-08-25T05:00:00Z',
      variant: 'founding_2026',
      phase: 'final_week',
      days: 7,
      localDate: '2026-08-25',
    },
    {
      iso: '2026-08-31T05:00:00Z',
      variant: 'founding_2026',
      phase: 'final_day',
      days: 1,
      localDate: '2026-08-31',
    },
    {
      iso: '2026-09-01T05:00:00Z',
      variant: 'standard',
      phase: 'none',
      days: null,
      localDate: '2026-09-01',
    },
  ];

  for (const expected of cases) {
    const result = buildPaywallConfiguration({
      now: new Date(expected.iso),
      timeZone: 'America/Chicago',
    });

    assert.equal(result.paywallVariant, expected.variant);
    assert.equal(result.urgencyPhase, expected.phase);
    assert.equal(result.daysRemaining, expected.days);
    assert.equal(result.localDate, expected.localDate);
  }
});

test('respects the first and last worldwide local-date boundaries', () => {
  const firstZone = buildPaywallConfiguration({
    now: new Date('2026-07-21T10:00:00Z'),
    timeZone: 'Pacific/Kiritimati',
  });

  assert.equal(firstZone.localDate, '2026-07-22');
  assert.equal(firstZone.paywallVariant, 'founding_2026');

  const lastZoneExpired = buildPaywallConfiguration({
    now: new Date('2026-09-01T12:00:00Z'),
    timeZone: 'Etc/GMT+12',
  });

  assert.equal(lastZoneExpired.localDate, '2026-09-01');
  assert.equal(lastZoneExpired.paywallVariant, 'standard');
});

test('rejects an invalid IANA time zone', () => {
  assert.throws(
    () => buildPaywallConfiguration({
      now: new Date(),
      timeZone: 'Invalid/Zone',
    }),
    (error) => error.statusCode === 400
  );
});
