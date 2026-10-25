import cron from 'node-cron';
import pg from 'pg';
import { createGooglePlaySubscriptionService } from './lib/googlePlaySubscriptionService.js';
import { createGooglePlayTokenVault } from './lib/googlePlayTokenVault.js';

const enabled = /^(1|true|yes|on)$/i.test(
  process.env.GOOGLE_PLAY_RECONCILIATION_ENABLED ?? 'true'
);
const connectionString = process.env.DATABASE_URL;
const limit = Math.min(500, Math.max(1, Number.parseInt(
  process.env.GOOGLE_PLAY_RECONCILIATION_LIMIT || '150', 10
) || 150));

if (enabled && connectionString) {
  const { Pool } = pg;
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('railway') ? { rejectUnauthorized: false } : false,
    max: 2,
  });
  const vault = createGooglePlayTokenVault({ pool });
  if (!vault.enabled) {
    console.warn('[GooglePlayReconcile] Disabled: GOOGLE_PLAY_RECONCILIATION_KEY must be 64 hex characters.');
    await pool.end();
  } else {
    const subscriptionService = createGooglePlaySubscriptionService({ pool });
    let running = false;
    async function reconcile(reason) {
      if (running) return;
      running = true;
      const summary = { reason, checked: 0, refreshed: 0, failed: 0 };
      try {
        const candidates = await vault.candidates(limit);
        for (const row of candidates) {
          summary.checked++;
          try {
            await subscriptionService.syncVerifiedPurchase({
              authorization: { accountId: row.account_id },
              requestedPackageName: row.package_name,
              purchaseToken: row.purchaseToken,
              productId: row.product_id,
              pricingCohortHint: row.pricing_cohort || 'unknown',
              paywallSessionId: row.pricing_cohort_paywall_session_id || null,
            });
            summary.refreshed++;
          } catch (error) {
            summary.failed++;
            console.warn('[GooglePlayReconcile] Subscription refresh failed.', {
              code: error?.code || 'refresh_failed',
            });
          }
        }
        console.log('[GooglePlayReconcile] Completed.', summary);
      } catch (error) {
        console.error('[GooglePlayReconcile] Run failed.', {
          code: error?.code || 'reconciliation_failed',
        });
      } finally {
        running = false;
      }
    }
    cron.schedule('35 * * * *', () => reconcile('hourly'), {
      timezone: 'America/Chicago',
    });
    setTimeout(() => { void reconcile('startup'); }, 90_000).unref?.();
    console.log('[GooglePlayReconcile] Enabled.', { schedule: 'hourly at :35 America/Chicago', limit });
  }
}
