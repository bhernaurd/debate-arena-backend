import assert from 'node:assert/strict';
import test from 'node:test';

import { getAppleFiscalPayoutCalendar } from '../lib/appleFiscalCalendar.js';

test('Apple payout calendar identifies the Aug 2026 fiscal period and next expected payout', () => {
  const calendar = getAppleFiscalPayoutCalendar({
    asOf: new Date('2026-08-24T17:00:00Z'),
    limit: 7,
  });

  assert.equal(calendar.current?.fiscalMonth, '2026-08');
  assert.equal(calendar.current?.periodStart, '2026-08-02');
  assert.equal(calendar.current?.periodEnd, '2026-08-29');
  assert.equal(calendar.current?.estimatedPaymentDate, '2026-10-01');
  assert.equal(calendar.nextPayout?.fiscalMonth, '2026-07');
  assert.equal(calendar.nextPayout?.estimatedPaymentDate, '2026-09-03');
  assert.equal(calendar.isEstimated, true);
});
