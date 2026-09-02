const PRODUCTION_ENVIRONMENT = 'Production';
const RECURRING_PRODUCT_IDS = Object.freeze([
  'agora_pro_monthly',
  'agora_pro_yearly',
]);

function normalizeAutoRenewStatus(renewal) {
  const raw = renewal?.autoRenewStatus;
  if (raw === undefined || raw === null) return null;
  if (raw === true || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 0 || raw === '0') return false;

  const normalized = String(raw).trim().toUpperCase();
  if (normalized.includes('ENABLED') || normalized === 'ON') return true;
  if (normalized.includes('DISABLED') || normalized === 'OFF') return false;
  return null;
}

function isFreeTrial(transaction) {
  const discountType = String(transaction?.offerDiscountType || '')
    .trim()
    .toUpperCase();
  if (discountType === 'FREE_TRIAL') return true;

  const offerType = transaction?.offerType;
  const normalizedOfferType = String(offerType ?? '')
    .trim()
    .toUpperCase();
  return (
    offerType === 1 ||
    normalizedOfferType === '1' ||
    normalizedOfferType.includes('INTRODUCTORY')
  );
}

function localStatusFromApple(status, trial) {
  switch (Number(status)) {
    case 1:
      return trial ? 'trial' : 'active';
    case 2:
      return 'expired';
    case 3:
      return 'billing_retry';
    case 4:
      return 'grace_period';
    case 5:
      return 'revoked';
    default:
      return null;
  }
}

function dateFromAppleTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return new Date(numeric);
}

function latestSignedDate(transaction, renewal) {
  const values = [transaction?.signedDate, renewal?.signedDate]
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return new Date(Math.max(...values));
}

function flattenLastTransactions(response) {
  const groups = Array.isArray(response?.data) ? response.data : [];
  return groups.flatMap((group) =>
    Array.isArray(group?.lastTransactions) ? group.lastTransactions : []
  );
}

function numberLimit(value, fallback = 250) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(1000, parsed));
}

export function createAppleSubscriptionStatusReconciliationService({
  pool,
  productionClient,
  verifyTransactionJWS,
  verifyRenewalInfoJWS,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('A PostgreSQL pool is required.');
  }
  if (!productionClient || typeof productionClient.getAllSubscriptionStatuses !== 'function') {
    throw new Error('An App Store Server API production client is required.');
  }
  if (typeof verifyTransactionJWS !== 'function' || typeof verifyRenewalInfoJWS !== 'function') {
    throw new Error('Apple signed transaction and renewal verifiers are required.');
  }

  async function loadChains(limit) {
    const result = await pool.query(
      `
      SELECT
        original_transaction_id,
        environment,
        product_id,
        status,
        is_trial,
        auto_renew_enabled,
        expires_date,
        last_signed_date,
        updated_at
      FROM subscription_entitlements
      WHERE environment = 'Production'
        AND product_id = ANY($1::text[])
        AND status IN ('trial', 'active', 'grace_period', 'billing_retry')
      ORDER BY updated_at ASC, original_transaction_id ASC
      LIMIT $2
      `,
      [RECURRING_PRODUCT_IDS, numberLimit(limit)]
    );
    return result.rows;
  }

  async function readCurrentAppleState(originalTransactionId) {
    const response = await productionClient.getAllSubscriptionStatuses(
      originalTransactionId
    );
    const item = flattenLastTransactions(response).find(
      (candidate) =>
        String(candidate?.originalTransactionId || '') ===
        String(originalTransactionId)
    );

    if (!item) {
      const error = new Error(
        `Apple returned no current subscription status for ${originalTransactionId}.`
      );
      error.code = 'apple_subscription_status_missing';
      throw error;
    }
    if (!item.signedTransactionInfo || !item.signedRenewalInfo) {
      const error = new Error(
        `Apple current status is missing signed transaction or renewal information for ${originalTransactionId}.`
      );
      error.code = 'apple_subscription_status_incomplete';
      throw error;
    }

    const [verifiedTransaction, verifiedRenewal] = await Promise.all([
      verifyTransactionJWS(item.signedTransactionInfo),
      verifyRenewalInfoJWS(item.signedRenewalInfo),
    ]);

    if (
      verifiedTransaction?.environment !== PRODUCTION_ENVIRONMENT ||
      verifiedRenewal?.environment !== PRODUCTION_ENVIRONMENT
    ) {
      const error = new Error('Apple reconciliation returned a non-production signed payload.');
      error.code = 'apple_subscription_environment_mismatch';
      throw error;
    }

    const transaction = verifiedTransaction.decoded || {};
    const renewal = verifiedRenewal.decoded || {};
    if (
      String(transaction.originalTransactionId || '') !==
      String(originalTransactionId)
    ) {
      const error = new Error('Apple signed transaction does not match the requested subscription chain.');
      error.code = 'apple_subscription_chain_mismatch';
      throw error;
    }

    const autoRenewEnabled = normalizeAutoRenewStatus(renewal);
    if (autoRenewEnabled === null) {
      const error = new Error('Apple signed renewal information did not contain a recognized auto-renew state.');
      error.code = 'apple_auto_renew_status_missing';
      throw error;
    }

    const trial = isFreeTrial(transaction);
    return {
      autoRenewEnabled,
      status: localStatusFromApple(item.status, trial),
      trial,
      productId:
        typeof transaction.productId === 'string' && transaction.productId.trim()
          ? transaction.productId.trim()
          : null,
      transactionId:
        typeof transaction.transactionId === 'string' && transaction.transactionId.trim()
          ? transaction.transactionId.trim()
          : null,
      expiresDate: dateFromAppleTimestamp(transaction.expiresDate),
      gracePeriodExpiresDate: dateFromAppleTimestamp(renewal.gracePeriodExpiresDate),
      expirationIntent: Number.isFinite(Number(renewal.expirationIntent))
        ? Number(renewal.expirationIntent)
        : null,
      signedDate: latestSignedDate(transaction, renewal),
    };
  }

  async function persistCurrentAppleState(chain, appleState) {
    const result = await pool.query(
      `
      UPDATE subscription_entitlements
      SET
        product_id = COALESCE($3, product_id),
        status = COALESCE($4, status),
        is_trial = $5,
        auto_renew_enabled = $6,
        expires_date = COALESCE($7, expires_date),
        grace_period_expires_date = $8,
        expiration_intent = $9,
        last_transaction_id = COALESCE($10, last_transaction_id),
        last_signed_date = CASE
          WHEN $11::timestamptz IS NULL THEN last_signed_date
          ELSE GREATEST(COALESCE(last_signed_date, $11::timestamptz), $11::timestamptz)
        END,
        updated_at = NOW()
      WHERE original_transaction_id = $1
        AND environment = $2
        AND (
          $11::timestamptz IS NULL
          OR last_signed_date IS NULL
          OR $11::timestamptz >= last_signed_date
        )
      RETURNING
        original_transaction_id,
        status,
        is_trial,
        auto_renew_enabled,
        expires_date,
        last_signed_date
      `,
      [
        chain.original_transaction_id,
        PRODUCTION_ENVIRONMENT,
        appleState.productId,
        appleState.status,
        appleState.trial,
        appleState.autoRenewEnabled,
        appleState.expiresDate,
        appleState.gracePeriodExpiresDate,
        appleState.expirationIntent,
        appleState.transactionId,
        appleState.signedDate,
      ]
    );

    return result.rows[0] || null;
  }

  async function reconcileChain(chain) {
    const appleState = await readCurrentAppleState(chain.original_transaction_id);
    const changedAutoRenew =
      chain.auto_renew_enabled !== appleState.autoRenewEnabled;
    const updated = await persistCurrentAppleState(chain, appleState);

    return {
      originalTransactionId: chain.original_transaction_id,
      changedAutoRenew: Boolean(updated && changedAutoRenew),
      previousAutoRenew: chain.auto_renew_enabled,
      autoRenewEnabled: updated?.auto_renew_enabled ?? chain.auto_renew_enabled,
      updated: Boolean(updated),
      status: updated?.status ?? chain.status,
    };
  }

  async function reconcileActiveSubscriptions({ limit = 250 } = {}) {
    const chains = await loadChains(limit);
    const summary = {
      checked: 0,
      updated: 0,
      autoRenewChanges: 0,
      failed: 0,
      failures: [],
    };

    for (const chain of chains) {
      summary.checked += 1;
      try {
        const result = await reconcileChain(chain);
        if (result.updated) summary.updated += 1;
        if (result.changedAutoRenew) summary.autoRenewChanges += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          originalTransactionId: chain.original_transaction_id,
          code: error?.code || null,
          message: error?.message || String(error),
        });
        logger.warn?.('[AppleSubscriptionStatusReconcile] Chain failed.', {
          originalTransactionId: chain.original_transaction_id,
          code: error?.code || null,
          error: error?.message || error,
        });
      }
    }

    return summary;
  }

  return Object.freeze({
    reconcileChain,
    reconcileActiveSubscriptions,
  });
}

export default createAppleSubscriptionStatusReconciliationService;
