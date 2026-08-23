// subscriptionAdminEventScanner.js
// Converts newly committed Apple subscription_events into owner/admin alerts.
//
// App Store webhook handling stays completely independent. This scanner only
// examines events after they are safely persisted, so an APNs/Telegram outage
// can never make Apple's webhook fail or duplicate subscription state changes.

const DEFAULT_SCAN_MS = 30_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 5;

function boundedInteger(value, defaultValue, minimum, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(minimum, Math.min(maximum, parsed));
}

export function createSubscriptionAdminEventScanner({
    pool,
    notificationService,
    logger = console,
    environment = process.env,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error(
            'A PostgreSQL pool is required for the subscription admin event scanner.'
        );
    }

    if (
        !notificationService ||
        typeof notificationService.enqueueAppleNotification !== 'function' ||
        typeof notificationService.kick !== 'function'
    ) {
        throw new Error(
            'A valid subscription admin notification service is required.'
        );
    }

    const scanMs = boundedInteger(
        environment.SUBSCRIPTION_ADMIN_SCAN_MS,
        DEFAULT_SCAN_MS,
        5_000,
        300_000
    );
    const batchSize = boundedInteger(
        environment.SUBSCRIPTION_ADMIN_SCAN_BATCH_SIZE,
        DEFAULT_BATCH_SIZE,
        1,
        500
    );
    const maxBatches = boundedInteger(
        environment.SUBSCRIPTION_ADMIN_SCAN_MAX_BATCHES,
        DEFAULT_MAX_BATCHES,
        1,
        20
    );

    let timer = null;
    let scanPromise = null;

    async function scanOnce() {
        if (!notificationService.config?.enabled) {
            return { scanned: 0, queued: 0 };
        }

        let scanned = 0;
        let queued = 0;

        for (let batch = 0; batch < maxBatches; batch += 1) {
            const result = await pool.query(
                `
                SELECT
                    event.event_key,
                    event.notification_uuid,
                    event.event_type,
                    event.subtype,
                    event.environment,
                    event.original_transaction_id,
                    event.transaction_id,
                    event.product_id,
                    event.status_after,
                    event.is_trial,
                    event.auto_renew_enabled,
                    event.expires_date,
                    event.event_at,
                    transaction.app_account_token,
                    transaction.price_milliunits,
                    transaction.currency,
                    COALESCE(
                        attribution.normalized_creator_code,
                        affiliate.normalized_code
                    ) AS affiliate_code
                FROM subscription_admin_notification_state state
                JOIN subscription_events event
                  ON event.source = 'apple_notification'
                 AND (
                        event.event_at > state.last_scanned_event_at
                        OR (
                            event.event_at = state.last_scanned_event_at
                            AND event.event_key > state.last_scanned_event_key
                        )
                    )
                LEFT JOIN app_store_transactions transaction
                  ON transaction.transaction_id = event.transaction_id
                 AND transaction.environment = event.environment
                LEFT JOIN affiliate_subscription_attributions attribution
                  ON attribution.original_transaction_id =
                        event.original_transaction_id
                 AND attribution.environment = event.environment
                LEFT JOIN affiliates affiliate
                  ON affiliate.id = attribution.affiliate_id
                WHERE state.id = 1
                ORDER BY event.event_at ASC, event.event_key ASC
                LIMIT $1
                `,
                [batchSize]
            );

            if (result.rows.length === 0) {
                break;
            }

            for (const row of result.rows) {
                const outcome =
                    await notificationService.enqueueAppleNotification({
                        notificationUUID: row.notification_uuid,
                        notificationType: row.event_type,
                        subtype: row.subtype,
                        environment: row.environment,
                        transaction: {
                            transactionId: row.transaction_id,
                            originalTransactionId:
                                row.original_transaction_id,
                            productId: row.product_id,
                            appAccountToken: row.app_account_token,
                            price: row.price_milliunits,
                            currency: row.currency,
                        },
                        entitlement: {
                            originalTransactionId:
                                row.original_transaction_id,
                            productId: row.product_id,
                            status: row.status_after,
                            isTrial: row.is_trial === true,
                            autoRenewEnabled:
                                row.auto_renew_enabled ?? null,
                            expiresDate: row.expires_date || null,
                        },
                        affiliateAttribution: row.affiliate_code
                            ? {
                                normalizedCode:
                                    row.affiliate_code,
                            }
                            : null,
                    });

                scanned += 1;
                if (outcome?.queued === true) {
                    queued += 1;
                }

                // Advance only after this event was successfully examined. If
                // an outbox insert throws, this update never happens and the
                // same event is retried on the next scan. The outbox's unique
                // dedupe key makes a crash between insert and cursor update safe.
                await pool.query(
                    `
                    UPDATE subscription_admin_notification_state
                    SET
                        last_scanned_event_at = $1,
                        last_scanned_event_key = $2,
                        updated_at = NOW()
                    WHERE id = 1
                    `,
                    [row.event_at, row.event_key]
                );
            }

            if (result.rows.length < batchSize) {
                break;
            }
        }

        if (queued > 0) {
            await notificationService.kick();
        }

        return { scanned, queued };
    }

    function kick() {
        if (!notificationService.config?.enabled) {
            return Promise.resolve({ scanned: 0, queued: 0 });
        }

        if (scanPromise) {
            return scanPromise;
        }

        scanPromise = scanOnce()
            .catch((error) => {
                logger.error(
                    '[SubscriptionAdminAlerts] Apple event scan failed:',
                    error?.message || error
                );
                return { scanned: 0, queued: 0, error };
            })
            .finally(() => {
                scanPromise = null;
            });

        return scanPromise;
    }

    function start() {
        if (!notificationService.config?.enabled) {
            return;
        }

        if (timer) return;

        timer = setInterval(() => {
            void kick();
        }, scanMs);
        timer.unref?.();

        logger.log(
            '[SubscriptionAdminAlerts] Apple event scanner started.',
            { scanMs, batchSize, maxBatches }
        );

        void kick();
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    return Object.freeze({
        start,
        stop,
        kick,
        scanOnce,
    });
}

export default createSubscriptionAdminEventScanner;
