import cron from 'node-cron';
import pg from 'pg';
import {
  AppStoreServerAPIClient,
  Environment,
} from '@apple/app-store-server-library';

import {
  APP_STORE_BUNDLE_ID,
  verifyAppStoreRenewalInfoJWS,
  verifyAppStoreTransactionJWS,
} from './appStoreSubscriptionVerifier.js';
import {
  createAppleSubscriptionStatusReconciliationService,
} from './lib/appleSubscriptionStatusReconciliationService.js';

const { Pool } = pg;
const TIME_ZONE = 'America/Chicago';

function cleanText(value, maxLength = 100000) {
  if (value == null) return '';
  return String(value).trim().slice(0, maxLength);
}

function readPrivateKey(value) {
  const text = cleanText(value);
  return text.includes('-----BEGIN') ? text.replace(/\\n/g, '\n') : text;
}

function booleanEnvironment(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function integerEnvironment(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

const enabled = booleanEnvironment(
  'APPLE_SUBSCRIPTION_STATUS_RECONCILIATION_ENABLED',
  true
);

if (enabled) {
  const connectionString = cleanText(process.env.DATABASE_URL);
  const issuerId = cleanText(
    process.env.APP_STORE_SERVER_ISSUER_ID ||
    process.env.APP_STORE_IAP_ISSUER_ID
  );
  const keyId = cleanText(
    process.env.APP_STORE_SERVER_KEY_ID ||
    process.env.APP_STORE_IAP_KEY_ID
  );
  const privateKey = readPrivateKey(
    process.env.APP_STORE_SERVER_PRIVATE_KEY ||
    process.env.APP_STORE_IAP_PRIVATE_KEY
  );
  const limit = integerEnvironment(
    'APPLE_SUBSCRIPTION_STATUS_RECONCILE_LIMIT',
    250,
    1,
    1000
  );

  if (!connectionString) {
    console.warn(
      '[AppleSubscriptionStatusReconcile] Disabled: DATABASE_URL is missing.'
    );
  } else if (!issuerId || !keyId || !privateKey) {
    console.warn(
      '[AppleSubscriptionStatusReconcile] Disabled: add an App Store Connect In-App Purchase key using APP_STORE_SERVER_ISSUER_ID, APP_STORE_SERVER_KEY_ID, and APP_STORE_SERVER_PRIVATE_KEY.'
    );
  } else {
    const productionClient = new AppStoreServerAPIClient(
      privateKey,
      keyId,
      issuerId,
      APP_STORE_BUNDLE_ID,
      Environment.PRODUCTION
    );
    const pool = new Pool({
      connectionString,
      ssl: connectionString.includes('railway')
        ? { rejectUnauthorized: false }
        : false,
      max: 2,
    });
    const service = createAppleSubscriptionStatusReconciliationService({
      pool,
      productionClient,
      verifyTransactionJWS: verifyAppStoreTransactionJWS,
      verifyRenewalInfoJWS: verifyAppStoreRenewalInfoJWS,
    });
    let running = false;

    pool.on('error', (error) => {
      console.error(
        '[AppleSubscriptionStatusReconcile] Postgres pool error:',
        error?.message || error
      );
    });

    async function run(reason = 'scheduled') {
      if (running) {
        console.log(
          '[AppleSubscriptionStatusReconcile] Skipping overlapping run.'
        );
        return;
      }

      running = true;
      try {
        const summary = await service.reconcileActiveSubscriptions({ limit });
        console.log('[AppleSubscriptionStatusReconcile] Completed.', {
          reason,
          checked: summary.checked,
          updated: summary.updated,
          autoRenewChanges: summary.autoRenewChanges,
          failed: summary.failed,
        });
      } catch (error) {
        console.error(
          '[AppleSubscriptionStatusReconcile] Run failed:',
          error?.message || error
        );
      } finally {
        running = false;
      }
    }

    // Apple Server Notifications remain the immediate real-time source. This
    // hourly server-to-server status check is a safety net for missed delivery.
    cron.schedule('20 * * * *', () => run('hourly'), {
      timezone: TIME_ZONE,
    });

    setTimeout(() => {
      run('startup');
    }, 75_000).unref?.();

    console.log('[AppleSubscriptionStatusReconcile] Enabled.', {
      schedule: 'hourly at :20 America/Chicago',
      limitPerRun: limit,
      bundleId: APP_STORE_BUNDLE_ID,
    });
  }
}
