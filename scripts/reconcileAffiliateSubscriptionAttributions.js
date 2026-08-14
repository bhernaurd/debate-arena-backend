import '../env.js';

import pg from 'pg';

import {
  createAffiliateSubscriptionAttributionService,
} from '../lib/affiliateSubscriptionAttributionService.js';

const { Pool } = pg;

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_BATCHES = 20;

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function loadCandidates(client, batchSize) {
  const result = await client.query(
    `
    SELECT DISTINCT ON (
      tx.original_transaction_id,
      CASE
        WHEN LOWER(tx.environment) = 'production' THEN 'Production'
        WHEN LOWER(tx.environment) = 'sandbox' THEN 'Sandbox'
      END
    )
      tx.transaction_id,
      tx.original_transaction_id,
      CASE
        WHEN LOWER(tx.environment) = 'production' THEN 'Production'
        WHEN LOWER(tx.environment) = 'sandbox' THEN 'Sandbox'
      END AS environment,
      tx.product_id,
      tx.offer_type,
      tx.offer_identifier,
      tx.purchase_date,
      tx.signed_date,
      tx.price_milliunits,
      tx.currency
    FROM app_store_transactions tx
    JOIN affiliates affiliate
      ON affiliate.normalized_apple_offer_identifier =
         UPPER(BTRIM(tx.offer_identifier))
     AND affiliate.status = 'active'
     AND affiliate.code_status = 'active'
    WHERE UPPER(REPLACE(REPLACE(BTRIM(tx.offer_type), '-', '_'), ' ', '_')) IN ('3', 'OFFER_CODE')
      AND tx.offer_identifier IS NOT NULL
      AND BTRIM(tx.offer_identifier) <> ''
      AND LOWER(tx.environment) IN ('production', 'sandbox')
      AND NOT EXISTS (
        SELECT 1
        FROM affiliate_subscription_attributions attribution
        WHERE attribution.original_transaction_id =
              tx.original_transaction_id
          AND attribution.environment = CASE
            WHEN LOWER(tx.environment) = 'production' THEN 'Production'
            WHEN LOWER(tx.environment) = 'sandbox' THEN 'Sandbox'
          END
      )
    ORDER BY
      tx.original_transaction_id,
      CASE
        WHEN LOWER(tx.environment) = 'production' THEN 'Production'
        WHEN LOWER(tx.environment) = 'sandbox' THEN 'Sandbox'
      END,
      COALESCE(
        tx.purchase_date,
        tx.signed_date,
        tx.updated_at
      ) ASC,
      tx.transaction_id ASC
    LIMIT $1
    `,
    [batchSize]
  );

  return result.rows;
}

async function reconcileCandidate(service, pool, row) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await service.observeVerifiedTransaction({
      client,
      source: 'stored_transaction_reconciliation',
      environment: row.environment,
      transaction: {
        transactionId: row.transaction_id,
        originalTransactionId: row.original_transaction_id,
        productId: row.product_id,
        offerType: row.offer_type,
        offerIdentifier: row.offer_identifier,
        purchaseDate: row.purchase_date,
        signedDate: row.signed_date,
        price: row.price_milliunits,
        currency: row.currency,
      },
    });

    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original reconciliation error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }

  const batchSize = parsePositiveInt(
    process.env.AFFILIATE_ATTRIBUTION_RECONCILE_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    2_000
  );
  const maxBatches = parsePositiveInt(
    process.env.AFFILIATE_ATTRIBUTION_RECONCILE_MAX_BATCHES,
    DEFAULT_MAX_BATCHES,
    200
  );

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
    max: 4,
  });

  const service = createAffiliateSubscriptionAttributionService({ pool });

  let attributed = 0;
  let alreadyOwned = 0;
  let reviewRequired = 0;
  let failures = 0;

  try {
    for (let batch = 1; batch <= maxBatches; batch += 1) {
      const client = await pool.connect();
      let candidates;

      try {
        candidates = await loadCandidates(client, batchSize);
      } finally {
        client.release();
      }

      if (candidates.length === 0) {
        break;
      }

      for (const row of candidates) {
        try {
          const result = await reconcileCandidate(service, pool, row);

          if (result?.status === 'attributed_new') {
            attributed += 1;
          } else if (
            result?.status === 'inherited_existing' ||
            result?.status === 'conflict_preserved_existing'
          ) {
            alreadyOwned += 1;
          } else {
            reviewRequired += 1;
          }
        } catch (error) {
          failures += 1;
          console.error(
            '[AffiliateAttributionReconcile] Candidate failed.',
            {
              errorCode:
                error?.code ||
                'affiliate_attribution_reconcile_failed',
              environment: row.environment,
            }
          );
        }
      }

      if (candidates.length < batchSize) {
        break;
      }
    }
  } finally {
    await pool.end();
  }

  console.log(
    '[AffiliateAttributionReconcile] Complete.',
    {
      attributed,
      alreadyOwned,
      reviewRequired,
      failures,
    }
  );

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(
    '[AffiliateAttributionReconcile] Fatal error:',
    error?.message || error
  );
  process.exitCode = 1;
});
