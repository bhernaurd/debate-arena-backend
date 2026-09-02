import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAppleSubscriptionVerificationState,
  recordAppleAutoRenewVerification,
  recordAppleSubscriptionReconciliationRun,
  resetAppleSubscriptionVerificationStateForTests,
  setAppleSubscriptionVerificationConfiguration,
} from '../lib/appleSubscriptionVerificationState.js';

test('verification state keeps the newest live Apple check per subscription chain', () => {
  resetAppleSubscriptionVerificationStateForTests();
  setAppleSubscriptionVerificationConfiguration({ enabled: true, schedule: 'hourly' });
  recordAppleAutoRenewVerification({
    originalTransactionId: 'orig-1',
    verifiedAt: '2026-09-02T21:00:00.000Z',
    source: 'apple_notification',
    autoRenewEnabled: false,
  });
  recordAppleSubscriptionReconciliationRun({
    reason: 'hourly',
    startedAt: '2026-09-02T21:20:00.000Z',
    completedAt: '2026-09-02T21:20:02.000Z',
    summary: {
      checked: 1,
      updated: 1,
      autoRenewChanges: 0,
      failed: 0,
      verified: [{
        originalTransactionId: 'orig-1',
        verifiedAt: '2026-09-02T21:20:01.000Z',
        autoRenewEnabled: false,
        status: 'active',
      }],
    },
  });
  const state = getAppleSubscriptionVerificationState();
  assert.equal(state.configuration.enabled, true);
  assert.equal(state.lastRun.checked, 1);
  assert.equal(state.lastRun.failed, 0);
  assert.equal(state.chains['orig-1'].source, 'apple_status_reconcile');
  assert.equal(state.chains['orig-1'].verifiedAt, '2026-09-02T21:20:01.000Z');
  assert.equal(state.chains['orig-1'].autoRenewEnabled, false);
});
