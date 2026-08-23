import { sendPush } from '../apnsService.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN_RE = /^[A-Za-z0-9:_-]{32,512}$/;

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 60_000;

function cleanText(value, maxLength = 500) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLength);
}

function cleanUuid(value) {
    const text = cleanText(value, 64);
    return text && UUID_RE.test(text)
        ? text.toLowerCase()
        : null;
}

function readBoolean(value, defaultValue) {
    if (value == null || String(value).trim() === '') {
        return defaultValue;
    }

    switch (String(value).trim().toLowerCase()) {
        case '1':
        case 'true':
        case 'yes':
        case 'on':
            return true;
        case '0':
        case 'false':
        case 'no':
        case 'off':
            return false;
        default:
            return defaultValue;
    }
}

function boundedInteger(value, defaultValue, minimum, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeEnvironment(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'sandbox' || text === 'development') {
        return 'Sandbox';
    }
    return 'Production';
}

function normalizeApnsEnvironment(value) {
    return normalizeEnvironment(value) === 'Sandbox'
        ? 'development'
        : 'production';
}

function shortId(value) {
    const text = cleanText(value, 256);
    if (!text) return null;
    return text.length <= 12
        ? text
        : `${text.slice(0, 8)}…${text.slice(-4)}`;
}

function productLabel(productId) {
    switch (cleanText(productId, 200)) {
        case 'agora_pro_monthly':
            return 'Monthly';
        case 'agora_pro_yearly':
            return 'Yearly';
        default:
            return cleanText(productId, 200) || 'Unknown';
    }
}

export function formatAppleMilliunitPrice(price, currency) {
    if (price == null || price === '') return null;

    const numeric = Number(price);
    const currencyCode = cleanText(currency, 16)?.toUpperCase();

    if (
        !Number.isSafeInteger(numeric) ||
        numeric < 0 ||
        !currencyCode ||
        !/^[A-Z]{3}$/.test(currencyCode)
    ) {
        return null;
    }

    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyCode,
        }).format(numeric / 1000);
    } catch {
        return `${(numeric / 1000).toFixed(2)} ${currencyCode}`;
    }
}

export function classifyAppleSubscriptionAlert({
    notificationType,
    subtype,
    notifyRenewals = false,
} = {}) {
    const type = String(notificationType || '')
        .trim()
        .toUpperCase();
    const sub = String(subtype || '')
        .trim()
        .toUpperCase();

    if (type === 'SUBSCRIBED' && sub === 'INITIAL_BUY') {
        return Object.freeze({
            eventKind: 'new_subscription',
            emoji: '🎉',
            title: 'New Agora Pro subscriber',
        });
    }

    if (type === 'SUBSCRIBED' && sub === 'RESUBSCRIBE') {
        return Object.freeze({
            eventKind: 'resubscription',
            emoji: '🔁',
            title: 'Agora Pro subscriber returned',
        });
    }

    if (
        type === 'DID_CHANGE_RENEWAL_STATUS' &&
        sub === 'AUTO_RENEW_DISABLED'
    ) {
        return Object.freeze({
            eventKind: 'auto_renew_disabled',
            emoji: '⚠️',
            title: 'Agora Pro auto-renew turned off',
        });
    }

    if (
        type === 'DID_CHANGE_RENEWAL_STATUS' &&
        sub === 'AUTO_RENEW_ENABLED'
    ) {
        return Object.freeze({
            eventKind: 'auto_renew_enabled',
            emoji: '✅',
            title: 'Agora Pro auto-renew turned back on',
        });
    }

    if (type === 'DID_FAIL_TO_RENEW') {
        return Object.freeze({
            eventKind: 'billing_issue',
            emoji: '💳',
            title: 'Agora Pro billing issue',
        });
    }

    if (type === 'GRACE_PERIOD_EXPIRED') {
        return Object.freeze({
            eventKind: 'grace_period_expired',
            emoji: '⏳',
            title: 'Agora Pro grace period expired',
        });
    }

    if (type === 'DID_RECOVER') {
        return Object.freeze({
            eventKind: 'billing_recovered',
            emoji: '✅',
            title: 'Agora Pro billing recovered',
        });
    }

    if (type === 'EXPIRED') {
        return Object.freeze({
            eventKind: 'expired',
            emoji: '⌛️',
            title: 'Agora Pro subscription expired',
        });
    }

    if (type === 'REFUND') {
        return Object.freeze({
            eventKind: 'refund',
            emoji: '💸',
            title: 'Agora Pro refund issued',
        });
    }

    if (type === 'REVOKE') {
        return Object.freeze({
            eventKind: 'revoked',
            emoji: '🚫',
            title: 'Agora Pro access revoked',
        });
    }

    if (type === 'DID_RENEW' && notifyRenewals) {
        return Object.freeze({
            eventKind: 'renewal',
            emoji: '♻️',
            title: 'Agora Pro renewed',
        });
    }

    return null;
}

function buildAlertText({
    classification,
    transaction,
    renewal,
    entitlement,
    affiliateAttribution,
    environment,
}) {
    const productId =
        cleanText(transaction?.productId, 200) ||
        cleanText(entitlement?.productId, 200);
    const priceText = formatAppleMilliunitPrice(
        transaction?.price,
        transaction?.currency
    );
    const accountId =
        cleanUuid(transaction?.appAccountToken) ||
        cleanUuid(renewal?.appAccountToken);
    const originalTransactionId = cleanText(
        transaction?.originalTransactionId ||
        entitlement?.originalTransactionId,
        128
    );
    const affiliateCode = cleanText(
        affiliateAttribution?.normalizedCode ||
        affiliateAttribution?.creatorCode,
        64
    );

    const expiresDate = entitlement?.expiresDate
        ? new Date(entitlement.expiresDate)
        : null;
    const validExpiresDate =
        expiresDate && !Number.isNaN(expiresDate.getTime())
            ? expiresDate
            : null;

    const lines = [
        `${classification.emoji} ${classification.title}`,
        '',
        `Plan: ${productLabel(productId)}`,
    ];

    if (priceText) {
        lines.push(`Apple transaction price: ${priceText}`);
    }

    lines.push(`Environment: ${normalizeEnvironment(environment)}`);

    if (entitlement?.isTrial === true) {
        lines.push('Trial: Yes');
    }

    if (typeof entitlement?.autoRenewEnabled === 'boolean') {
        lines.push(
            `Auto-renew: ${entitlement.autoRenewEnabled ? 'On' : 'Off'}`
        );
    }

    if (validExpiresDate) {
        lines.push(`Access until: ${validExpiresDate.toISOString()}`);
    }

    if (affiliateCode) {
        lines.push(`Affiliate: ${affiliateCode}`);
    }

    if (accountId) {
        lines.push(`Account: ${shortId(accountId)}`);
    }

    if (originalTransactionId) {
        lines.push(
            `Original transaction: ${shortId(originalTransactionId)}`
        );
    }

    return {
        title: `${classification.emoji} ${classification.title}`,
        body: lines.slice(2).join(' • ').slice(0, 900),
        telegramText: lines.join('\n').slice(0, 3500),
        accountId,
        originalTransactionId,
        productId,
        priceText,
        affiliateCode,
    };
}

export function buildAppleSubscriptionAdminAlert({
    notificationUUID,
    notificationType,
    subtype,
    environment,
    transaction,
    renewal,
    entitlement,
    affiliateAttribution,
    notifyRenewals = false,
} = {}) {
    const classification = classifyAppleSubscriptionAlert({
        notificationType,
        subtype,
        notifyRenewals,
    });

    if (!classification) return null;

    const normalizedEnvironment = normalizeEnvironment(environment);
    const text = buildAlertText({
        classification,
        transaction,
        renewal,
        entitlement,
        affiliateAttribution,
        environment: normalizedEnvironment,
    });
    const transactionId = cleanText(
        transaction?.transactionId,
        128
    );
    const dedupeBase =
        cleanText(notificationUUID, 128) ||
        transactionId ||
        text.originalTransactionId ||
        'unknown';

    return Object.freeze({
        dedupeKey:
            `apple_admin:${normalizedEnvironment}:` +
            `${dedupeBase}:${classification.eventKind}`,
        notificationUUID: cleanText(notificationUUID, 128),
        notificationType:
            cleanText(notificationType, 100) || 'UNKNOWN',
        subtype: cleanText(subtype, 100),
        environment: normalizedEnvironment,
        eventKind: classification.eventKind,
        title: text.title,
        body: text.body,
        telegramText: text.telegramText,
        accountId: text.accountId,
        originalTransactionId: text.originalTransactionId,
        transactionId,
        productId: text.productId,
        payload: {
            eventKind: classification.eventKind,
            productId: text.productId,
            accountId: text.accountId,
            originalTransactionId: text.originalTransactionId,
            transactionId,
            affiliateCode: text.affiliateCode,
            appleTransactionPrice: text.priceText,
            entitlementStatus: cleanText(entitlement?.status, 64),
            isTrial: entitlement?.isTrial === true,
            autoRenewEnabled:
                typeof entitlement?.autoRenewEnabled === 'boolean'
                    ? entitlement.autoRenewEnabled
                    : null,
            expiresDate: entitlement?.expiresDate || null,
        },
    });
}

async function sendTelegram({
    botToken,
    chatId,
    text,
    fetchImpl,
}) {
    if (!botToken || !chatId) {
        return {
            ok: false,
            reason: 'Telegram is not configured.',
        };
    }

    try {
        const response = await fetchImpl(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    disable_web_page_preview: true,
                }),
            }
        );

        if (!response.ok) {
            const responseText = await response.text().catch(() => '');
            return {
                ok: false,
                reason:
                    `Telegram HTTP ${response.status}` +
                    (responseText
                        ? `: ${responseText.slice(0, 300)}`
                        : ''),
            };
        }

        return { ok: true, reason: null };
    } catch (error) {
        return {
            ok: false,
            reason: error?.message || 'Telegram request failed.',
        };
    }
}

export function createSubscriptionAdminNotificationService({
    pool,
    sendPushImpl = sendPush,
    fetchImpl = globalThis.fetch,
    logger = console,
    environment = process.env,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error(
            'A PostgreSQL pool is required for subscription admin notifications.'
        );
    }

    const config = Object.freeze({
        enabled: readBoolean(
            environment.SUBSCRIPTION_ADMIN_ALERTS_ENABLED,
            false
        ),
        notifySandbox: readBoolean(
            environment.SUBSCRIPTION_ADMIN_NOTIFY_SANDBOX,
            false
        ),
        notifyRenewals: readBoolean(
            environment.SUBSCRIPTION_ADMIN_NOTIFY_RENEWALS,
            false
        ),
        telegramFallbackEnabled: readBoolean(
            environment.SUBSCRIPTION_ADMIN_TELEGRAM_FALLBACK_ENABLED,
            true
        ),
        telegramAlways: readBoolean(
            environment.SUBSCRIPTION_ADMIN_TELEGRAM_ALWAYS,
            false
        ),
        adminPushUserId: cleanUuid(
            environment.SUBSCRIPTION_ADMIN_PUSH_USER_ID
        ),
        directApnsToken: DEVICE_TOKEN_RE.test(
            String(
                environment.SUBSCRIPTION_ADMIN_APNS_DEVICE_TOKEN || ''
            ).trim()
        )
            ? String(
                environment.SUBSCRIPTION_ADMIN_APNS_DEVICE_TOKEN
            ).trim()
            : null,
        apnsEnvironment: normalizeApnsEnvironment(
            environment.SUBSCRIPTION_ADMIN_APNS_ENVIRONMENT ||
            'production'
        ),
        telegramBotToken: cleanText(
            environment.TELEGRAM_BOT_TOKEN,
            512
        ),
        telegramChatId: cleanText(
            environment.TELEGRAM_ADMIN_CHAT_ID,
            128
        ),
        pollMs: boundedInteger(
            environment.SUBSCRIPTION_ADMIN_POLL_MS,
            DEFAULT_POLL_MS,
            5_000,
            300_000
        ),
        maxAttempts: boundedInteger(
            environment.SUBSCRIPTION_ADMIN_MAX_ATTEMPTS,
            DEFAULT_MAX_ATTEMPTS,
            1,
            20
        ),
    });

    let timer = null;
    let dispatchPromise = null;

    function hasTelegram() {
        return Boolean(
            config.telegramBotToken &&
            config.telegramChatId
        );
    }

    function hasApnsSelector() {
        return Boolean(
            config.directApnsToken ||
            config.adminPushUserId
        );
    }

    async function resolveApnsToken() {
        if (config.directApnsToken) {
            return config.directApnsToken;
        }

        if (!config.adminPushUserId) {
            return null;
        }

        // PushTokenService currently registers identifierForVendor-style
        // user IDs in push_tokens.user_id. This is intentionally separate
        // from the authenticated Agora account UUID.
        const result = await pool.query(
            `
            SELECT device_token
            FROM push_tokens
            WHERE user_id = $1
              AND notifications_enabled = true
              AND LOWER(COALESCE(platform, 'ios')) = 'ios'
              AND apns_environment = $2
            ORDER BY
                last_registered_at DESC NULLS LAST,
                updated_at DESC NULLS LAST
            LIMIT 1
            `,
            [
                config.adminPushUserId,
                config.apnsEnvironment,
            ]
        );

        return cleanText(result.rows[0]?.device_token, 512);
    }

    async function enqueueAppleNotification({
        client,
        notificationUUID,
        notificationType,
        subtype,
        environment: verifiedEnvironment,
        transaction,
        renewal,
        entitlement,
        affiliateAttribution,
    } = {}) {
        if (!config.enabled) {
            return { queued: false, reason: 'disabled' };
        }

        const alert = buildAppleSubscriptionAdminAlert({
            notificationUUID,
            notificationType,
            subtype,
            environment: verifiedEnvironment,
            transaction,
            renewal,
            entitlement,
            affiliateAttribution,
            notifyRenewals: config.notifyRenewals,
        });

        if (!alert) {
            return { queued: false, reason: 'event_not_enabled' };
        }

        if (
            alert.environment === 'Sandbox' &&
            !config.notifySandbox
        ) {
            return { queued: false, reason: 'sandbox_disabled' };
        }

        const db = client || pool;

        // Older builds may have used a UUID-shaped installation identifier in
        // appAccountToken. Only write account_id when that UUID is a real Agora
        // account so the admin alert can never violate the account FK.
        let verifiedAccountId = null;

        if (alert.accountId) {
            const accountResult = await db.query(
                `
                SELECT id
                FROM accounts
                WHERE id = $1::uuid
                LIMIT 1
                `,
                [alert.accountId]
            );

            verifiedAccountId = accountResult.rows[0]?.id || null;
        }

        const result = await db.query(
            `
            INSERT INTO subscription_admin_notifications (
                dedupe_key,
                source,
                notification_uuid,
                notification_type,
                subtype,
                environment,
                account_id,
                original_transaction_id,
                transaction_id,
                product_id,
                event_kind,
                title,
                body,
                telegram_text,
                payload
            )
            VALUES (
                $1, 'app_store_notification', $2, $3, $4, $5,
                $6::uuid, $7, $8, $9, $10, $11, $12, $13,
                $14::jsonb
            )
            ON CONFLICT (dedupe_key) DO NOTHING
            RETURNING id
            `,
            [
                alert.dedupeKey,
                alert.notificationUUID,
                alert.notificationType,
                alert.subtype,
                alert.environment,
                verifiedAccountId,
                alert.originalTransactionId,
                alert.transactionId,
                alert.productId,
                alert.eventKind,
                alert.title,
                alert.body,
                alert.telegramText,
                JSON.stringify(alert.payload),
            ]
        );

        return {
            queued: result.rowCount > 0,
            duplicate: result.rowCount === 0,
            id: result.rows[0]?.id || null,
            eventKind: alert.eventKind,
        };
    }

    async function claimNext() {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                WITH candidate AS (
                    SELECT id
                    FROM subscription_admin_notifications
                    WHERE
                        (
                            status = 'pending'
                            OR (
                                status = 'sending'
                                AND last_attempt_at <
                                    NOW() - INTERVAL '5 minutes'
                            )
                        )
                        AND attempt_count < $1
                        AND next_attempt_at <= NOW()
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE subscription_admin_notifications notification
                SET
                    status = 'sending',
                    attempt_count = notification.attempt_count + 1,
                    last_attempt_at = NOW(),
                    updated_at = NOW()
                FROM candidate
                WHERE notification.id = candidate.id
                RETURNING notification.*
                `,
                [config.maxAttempts]
            );

            await client.query('COMMIT');
            return result.rows[0] || null;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {}
            throw error;
        } finally {
            client.release();
        }
    }

    async function completeDelivery(
        row,
        {
            apnsStatus,
            apnsError,
            telegramStatus,
            telegramError,
            deliveredVia,
        }
    ) {
        const delivered = Boolean(deliveredVia);
        const retryDelayMs = Math.min(
            30 * 60_000,
            DEFAULT_RETRY_BASE_MS *
            (2 ** Math.max(0, Number(row.attempt_count || 1) - 1))
        );
        const exhausted =
            Number(row.attempt_count || 0) >=
            config.maxAttempts;

        await pool.query(
            `
            UPDATE subscription_admin_notifications
            SET
                status = $2,
                apns_status = $3,
                apns_error = $4,
                telegram_status = $5,
                telegram_error = $6,
                delivered_via = $7::text,
                delivered_at = CASE
                    WHEN $7::text IS NOT NULL
                        THEN COALESCE(delivered_at, NOW())
                    ELSE delivered_at
                END,
                next_attempt_at = CASE
                    WHEN $7::text IS NOT NULL THEN next_attempt_at
                    WHEN $8::boolean THEN next_attempt_at
                    ELSE NOW() + ($9::bigint * INTERVAL '1 millisecond')
                END,
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                row.id,
                delivered
                    ? 'delivered'
                    : exhausted
                        ? 'failed'
                        : 'pending',
                apnsStatus,
                cleanText(apnsError, 1000),
                telegramStatus,
                cleanText(telegramError, 1000),
                deliveredVia,
                exhausted,
                retryDelayMs,
            ]
        );
    }

    async function deliverRow(row) {
        let apnsStatus = 'not_configured';
        let apnsError = null;
        let telegramStatus = 'not_attempted';
        let telegramError = null;
        let deliveredVia = null;

        if (hasApnsSelector()) {
            try {
                const deviceToken = await resolveApnsToken();

                if (deviceToken) {
                    const outcome = await sendPushImpl(
                        deviceToken,
                        row.title,
                        row.body,
                        {
                            source: 'subscription_admin',
                            adminEvent: row.event_kind,
                            notificationId: row.id,
                            productId: row.product_id || '',
                        }
                    );

                    const ok =
                        outcome === true ||
                        outcome?.ok === true;

                    if (ok) {
                        apnsStatus = 'sent';
                        deliveredVia = 'apns';
                    } else {
                        apnsStatus = 'failed';
                        apnsError =
                            outcome?.reason ||
                            'APNs send failed.';
                    }
                } else {
                    apnsStatus = 'no_target';
                    apnsError =
                        'No active APNs token was found for the configured admin push user.';
                }
            } catch (error) {
                apnsStatus = 'failed';
                apnsError =
                    error?.message ||
                    'APNs delivery failed.';
            }
        }

        const shouldSendTelegram =
            hasTelegram() &&
            (
                config.telegramAlways ||
                (
                    config.telegramFallbackEnabled &&
                    deliveredVia !== 'apns'
                )
            );

        if (shouldSendTelegram) {
            const telegram = await sendTelegram({
                botToken: config.telegramBotToken,
                chatId: config.telegramChatId,
                text: row.telegram_text,
                fetchImpl,
            });

            telegramStatus = telegram.ok ? 'sent' : 'failed';
            telegramError = telegram.reason;

            if (telegram.ok && !deliveredVia) {
                deliveredVia = 'telegram';
            } else if (telegram.ok && deliveredVia === 'apns') {
                deliveredVia = 'apns+telegram';
            }
        } else if (!hasTelegram()) {
            telegramStatus = 'not_configured';
        } else {
            telegramStatus = 'not_needed';
        }

        await completeDelivery(row, {
            apnsStatus,
            apnsError,
            telegramStatus,
            telegramError,
            deliveredVia,
        });

        if (deliveredVia) {
            logger.log(
                '[SubscriptionAdminAlerts] Delivered',
                {
                    id: row.id,
                    eventKind: row.event_kind,
                    via: deliveredVia,
                }
            );
        } else {
            logger.warn(
                '[SubscriptionAdminAlerts] Delivery failed',
                {
                    id: row.id,
                    eventKind: row.event_kind,
                    apnsError,
                    telegramError,
                }
            );
        }
    }

    async function dispatchPending() {
        if (!config.enabled) return;

        for (let index = 0; index < 20; index += 1) {
            const row = await claimNext();
            if (!row) break;
            await deliverRow(row);
        }
    }

    function kick() {
        if (!config.enabled) return Promise.resolve();
        if (dispatchPromise) return dispatchPromise;

        dispatchPromise = dispatchPending()
            .catch((error) => {
                logger.error(
                    '[SubscriptionAdminAlerts] Dispatcher failed:',
                    error?.message || error
                );
            })
            .finally(() => {
                dispatchPromise = null;
            });

        return dispatchPromise;
    }

    function start() {
        if (!config.enabled) {
            logger.log('[SubscriptionAdminAlerts] Disabled.');
            return;
        }

        if (!hasApnsSelector() && !hasTelegram()) {
            logger.warn(
                '[SubscriptionAdminAlerts] Enabled but no APNs admin target or Telegram fallback is configured.'
            );
        }

        if (timer) return;

        timer = setInterval(() => {
            void kick();
        }, config.pollMs);
        timer.unref?.();

        logger.log(
            '[SubscriptionAdminAlerts] Worker started.',
            {
                apnsConfigured: hasApnsSelector(),
                telegramConfigured: hasTelegram(),
                notifySandbox: config.notifySandbox,
                notifyRenewals: config.notifyRenewals,
            }
        );

        void kick();
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    }

    async function enqueueTestNotification({
        eventKind = 'test',
        title = 'Agora subscription alerts are connected',
        body = 'APNs is primary. Telegram is ready as fallback.',
    } = {}) {
        const dedupeKey =
            `manual_test:${Date.now()}:${Math.random()
                .toString(16)
                .slice(2)}`;

        const result = await pool.query(
            `
            INSERT INTO subscription_admin_notifications (
                dedupe_key,
                source,
                notification_type,
                environment,
                event_kind,
                title,
                body,
                telegram_text,
                payload
            )
            VALUES (
                $1, 'manual_test', 'TEST', 'Production',
                $2, $3, $4, $5, $6::jsonb
            )
            RETURNING id
            `,
            [
                dedupeKey,
                cleanText(eventKind, 100) || 'test',
                cleanText(title, 250) ||
                    'Agora subscription alerts are connected',
                cleanText(body, 1000) ||
                    'APNs is primary. Telegram is ready as fallback.',
                `${title}\n\n${body}`,
                JSON.stringify({ source: 'manual_test' }),
            ]
        );

        void kick();

        return { id: result.rows[0]?.id || null };
    }

    return Object.freeze({
        config,
        start,
        stop,
        kick,
        enqueueAppleNotification,
        enqueueTestNotification,
    });
}

export default createSubscriptionAdminNotificationService;
