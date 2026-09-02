import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAppleSubscriptionStatusReconciliationService,
} from '../lib/appleSubscriptionStatusReconciliationService.js';

test('reconciliation replaces stale auto-renew state with verified Apple current status', async () => {
  const queries = [];
  const pool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql.includes('FROM subscription_entitlements') && sql.includes('ORDER BY updated_at')) {
        return {
          rows: [
            {
              original_transaction_id: 'orig-1',
              environment: 'Production',
              product_id: 'agora_pro_monthly',
              status: 'active',
              is_trial: false,
              auto_renew_enabled: true,
              expires_date: new Date('2026-10-02T00:00:00Z'),
              last_signed_date: new Date('2026-09-01T00:00:00Z'),
            },
          ],
        };
      }
      if (sql.includes('UPDATE subscription_entitlements')) {
        assert.equal(values[0], 'orig-1');
        assert.equal(values[1], 'Production');
        assert.equal(values[5], false);
        assert.equal(values[3], 'active');
        assert.ok(values[10] instanceof Date);
        return {
          rows: [
            {
              original_transaction_id: 'orig-1',
              status: 'active',
              is_trial: false,
              auto_renew_enabled: false,
              expires_date: values[6],
              last_signed_date: values[10],
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const productionClient = {
    async getAllSubscriptionStatuses(transactionId) {
      assert.equal(transactionId, 'orig-1');
      return {
        data: [
          {
            subscriptionGroupIdentifier: 'group-1',
            lastTransactions: [
              {
                status: 1,
                originalTransactionId: 'orig-1',
                signedTransactionInfo: 'signed-transaction',
                signedRenewalInfo: 'signed-renewal',
              },
            ],
          },
        ],
      };
    },
  };

  const service = createAppleSubscriptionStatusReconciliationService({
    pool,
    productionClient,
    verifyTransactionJWS: async (jws) => {
      assert.equal(jws, 'signed-transaction');
      return {
        environment: 'Production',
        decoded: {
          originalTransactionId: 'orig-1',
          transactionId: 'tx-2',
          productId: 'agora_pro_monthly',
          expiresDate: Date.parse('2026-10-02T00:00:00Z'),
          signedDate: Date.parse('2026-09-02T12:00:00Z'),
        },
      };
    },
    verifyRenewalInfoJWS: async (jws) => {
      assert.equal(jws, 'signed-renewal');
      return {
        environment: 'Production',
        decoded: {
          autoRenewStatus: 0,
          signedDate: Date.parse('2026-09-02T12:01:00Z'),
        },
      };
    },
    logger: { warn() {} },
  });

  const summary = await service.reconcileActiveSubscriptions();
  assert.deepEqual(
    {
      checked: summary.checked,
      updated: summary.updated,
      autoRenewChanges: summary.autoRenewChanges,
      failed: summary.failed,
    },
    { checked: 1, updated: 1, autoRenewChanges: 1, failed: 0 }
  );
  assert.equal(queries.length, 2);
});

test('reconciliation verifies the exact original transaction chain Apple returns', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM subscription_entitlements')) {
        return {
          rows: [
            {
              original_transaction_id: 'orig-expected',
              environment: 'Production',
              product_id: 'agora_pro_yearly',
              status: 'active',
              is_trial: false,
              auto_renew_enabled: true,
            },
          ],
        };
      }
      throw new Error('The entitlement must not be updated when Apple has no matching chain.');
    },
  };

  const service = createAppleSubscriptionStatusReconciliationService({
    pool,
    productionClient: {
      async getAllSubscriptionStatuses() {
        return {
          data: [
            {
              lastTransactions: [
                {
                  status: 1,
                  originalTransactionId: 'different-chain',
                  signedTransactionInfo: 'tx',
                  signedRenewalInfo: 'renewal',
                },
              ],
            },
          ],
        };
      },
    },
    verifyTransactionJWS: async () => {
      throw new Error('Verifier should not be called for a different chain.');
    },
    verifyRenewalInfoJWS: async () => {
      throw new Error('Verifier should not be called for a different chain.');
    },
    logger: { warn() {} },
  });

  const summary = await service.reconcileActiveSubscriptions();
  assert.equal(summary.checked, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.failures[0].code, 'apple_subscription_status_missing');
});
