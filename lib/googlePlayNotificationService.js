import crypto from 'node:crypto';

import {
    createGooglePlayPublisherService,
} from './googlePlayPublisherService.js';

const GOOGLE_PLAY_PRO_PRODUCT_IDS = new Set([
    'agora_pro_monthly',
    'agora_pro_yearly',
]);

export class GooglePlayNotificationError extends Error {
    constructor(code, message, {
        status = 500,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlayNotificationError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlayNotificationError(code, message, options);
}

function clean(value, maximum = 4096) {
    if (typeof value !== 'string') return '';
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return '';
    return cleaned;
}

function optionalClean(value, maximum = 255) {
    if (value == null || value === '') return null;
    return clean(value, maximum) || null;
}

function sha256(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function parseDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeState(value) {
    return clean(value, 100).toUpperCase() ||
        'SUBSCRIPTION_STATE_UNSPECIFIED';
}

function normalizeAcknowledgementState(value) {
    return optionalClean(value, 100)?.toUpperCase() || null;
}

function stateToStatus(subscriptionState, expiryTime, nowMs) {
    const expiryMs = expiryTime?.getTime() ?? 0;
    const hasFutureAccess = expiryMs > nowMs;

    switch (subscriptionState) {
        case 'SUBSCRIPTION_STATE_ACTIVE':
        case 'SUBSCRIPTION_STATE_CANCELED':
            return hasFutureAccess ? 'active' : 'expired';
        case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
            return hasFutureAccess ? 'grace_period' : 'expired';
        case 'SUBSCRIPTION_STATE_PENDING':
            return 'pending';
        case 'SUBSCRIPTION_STATE_PAUSED':
            return 'paused';
        case 'SUBSCRIPTION_STATE_ON_HOLD':
            return 'on_hold';
        case 'SUBSCRIPTION_STATE_EXPIRED':
        case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
            return 'expired';
        default:
            return 'unknown';
    }
}

function isEntitledStatus(status, expiryTime, nowMs) {
    return (
        ['trial', 'active', 'grace_period'].includes(status) &&
        Boolean(expiryTime && expiryTime.getTime() > nowMs)
    );
}

function lineItemForNotification(subscription, subscriptionId) {
    const lineItems = Array.isArray(subscription?.lineItems)
        ? subscription.lineItems
        : [];
    const requested = clean(subscriptionId, 200);

    if (requested && GOOGLE_PLAY_PRO_PRODUCT_IDS.has(requested)) {
        return lineItems.find(
            (item) => clean(item?.productId, 200) === requested
        ) || null;
    }

    return lineItems.find((item) =>
        GOOGLE_PLAY_PRO_PRODUCT_IDS.has(
            clean(item?.productId, 200)
        )
    ) || null;
}

function verifiedOfferDetails(lineItem) {
    const details = lineItem?.offerDetails;
    if (!details || typeof details !== 'object') {
        return { basePlanId: null, offerId: null };
    }
    return {
        basePlanId: optionalClean(details.basePlanId, 200),
        offerId: optionalClean(details.offerId, 200),
    };
}

function verifiedAutoRenewEnabled(lineItem) {
    const value = lineItem?.autoRenewingPlan?.autoRenewEnabled;
    return typeof value === 'boolean' ? value : null;
}

function verifiedLatestOrderId(subscription, lineItem) {
    return optionalClean(
        lineItem?.latestSuccessfulOrderId ??
        lineItem?.latestOrderId ??
        subscription?.latestOrderId,
        255
    );
}

function normalizeExternalAccountId(subscription) {
    return optionalClean(
        subscription?.externalAccountIdentifiers?.obfuscatedExternalAccountId,
        255
    );
}

async function withTransaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original failure.
        }
        throw error;
    } finally {
        client.release();
    }
}

function normalizeOwnershipRow(row) {
    if (!row) return null;
    const accountId = clean(row.account_id?.toString(), 64).toLowerCase();
    if (!accountId) return null;
    return {
        accountId,
        pricingCohort:
            optionalClean(row.pricing_cohort, 40) || 'unknown',
        paywallSessionId:
            optionalClean(row.paywall_session_id, 255),
        obfuscatedExternalAccountId:
            optionalClean(row.obfuscated_external_account_id, 255),
        isTrial: row.is_trial === true,
    };
}

async function findOwnershipRow(client, purchaseTokenHash) {
    if (!purchaseTokenHash) return null;
    const result = await client.query(
        `
        SELECT
            account_id,
            pricing_cohort,
            paywall_session_id,
            obfuscated_external_account_id,
            is_trial
        FROM google_play_subscription_entitlements
        WHERE purchase_token_hash = $1
        FOR UPDATE
        `,
        [purchaseTokenHash]
    );
    return normalizeOwnershipRow(result.rows[0]);
}

/**
 * Reconciles Google Play Real-time Developer Notifications against previously
 * authenticated ownership. The RTDN payload is only a wake-up signal: current
 * subscription state is always fetched from Google Play Developer API before
 * any entitlement mutation. A notification can never establish ownership for
 * a purchase token that is not already known (or linked to a known token).
 */
export function createGooglePlayNotificationService({
    pool,
    publisherService = null,
    now = () => Date.now(),
    logger = console,
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        fail(
            'invalid_google_play_notification_configuration',
            'Google Play notification reconciliation requires PostgreSQL.',
            { status: 500 }
        );
    }
    if (typeof now !== 'function') {
        fail(
            'invalid_google_play_notification_configuration',
            'now must be a function.',
            { status: 500 }
        );
    }

    const publisher =
        publisherService ?? createGooglePlayPublisherService();

    async function processSubscriptionNotification({
        packageName,
        purchaseToken,
        subscriptionId = null,
    } = {}) {
        const cleanPackageName = clean(packageName, 255);
        const cleanPurchaseToken = clean(purchaseToken, 4096);
        const cleanSubscriptionId = optionalClean(subscriptionId, 200);

        if (!cleanPackageName || !cleanPurchaseToken) {
            fail(
                'invalid_google_play_notification',
                'Google Play notification data is incomplete.',
                { status: 400, retryable: false }
            );
        }

        const currentTime = Number(now());
        if (!Number.isFinite(currentTime) || currentTime < 0) {
            fail(
                'invalid_google_play_notification_configuration',
                'now() returned an invalid value.',
                { status: 500 }
            );
        }

        // The notification's state/type is never trusted. The raw token exists
        // only in memory long enough to re-query Google and is never persisted.
        const verified = await publisher.getSubscription({
            packageName: cleanPackageName,
            purchaseToken: cleanPurchaseToken,
        });
        const lineItem = lineItemForNotification(
            verified,
            cleanSubscriptionId
        );
        if (!lineItem) {
            return Object.freeze({
                processed: false,
                reason: 'unsupported_product',
            });
        }

        const productId = clean(lineItem.productId, 200);
        const purchaseTokenHash = sha256(cleanPurchaseToken);
        const linkedPurchaseToken = optionalClean(
            verified.linkedPurchaseToken,
            4096
        );
        const linkedPurchaseTokenHash = linkedPurchaseToken
            ? sha256(linkedPurchaseToken)
            : null;
        const externalAccountId = normalizeExternalAccountId(verified);
        const subscriptionState = normalizeState(
            verified.subscriptionState
        );
        const acknowledgementState =
            normalizeAcknowledgementState(
                verified.acknowledgementState
            );
        const expiryTime = parseDate(lineItem.expiryTime);
        const startTime = parseDate(verified.startTime);
        const status = stateToStatus(
            subscriptionState,
            expiryTime,
            currentTime
        );
        const offer = verifiedOfferDetails(lineItem);
        const autoRenewEnabled =
            verifiedAutoRenewEnabled(lineItem);
        const latestOrderId =
            verifiedLatestOrderId(verified, lineItem);
        const testPurchase = verified.testPurchase != null;

        const ownership = await withTransaction(
            pool,
            async (client) => {
                await client.query(
                    'SELECT pg_advisory_xact_lock(hashtext($1))',
                    [`google-play:${purchaseTokenHash}`]
                );

                const currentOwner = await findOwnershipRow(
                    client,
                    purchaseTokenHash
                );
                const linkedOwner = linkedPurchaseTokenHash
                    ? await findOwnershipRow(
                        client,
                        linkedPurchaseTokenHash
                    )
                    : null;

                if (
                    currentOwner &&
                    linkedOwner &&
                    currentOwner.accountId !== linkedOwner.accountId
                ) {
                    return {
                        processed: false,
                        reason: 'ownership_conflict',
                    };
                }

                const owner = currentOwner ?? linkedOwner;
                if (!owner) {
                    return {
                        processed: false,
                        reason: 'unowned_purchase',
                    };
                }

                if (
                    externalAccountId &&
                    externalAccountId.toLowerCase() !==
                        sha256(owner.accountId)
                ) {
                    return {
                        processed: false,
                        reason: 'external_account_mismatch',
                    };
                }

                await client.query(
                    `
                    INSERT INTO google_play_subscription_entitlements (
                        purchase_token_hash,
                        account_id,
                        package_name,
                        product_id,
                        base_plan_id,
                        offer_id,
                        subscription_state,
                        status,
                        is_trial,
                        start_time,
                        expiry_time,
                        acknowledgement_state,
                        auto_renew_enabled,
                        latest_order_id,
                        linked_purchase_token_hash,
                        pricing_cohort,
                        paywall_session_id,
                        obfuscated_external_account_id,
                        test_purchase,
                        verified_at,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9,
                        $10, $11, $12, $13, $14, $15, $16, $17,
                        $18, $19, $20, $20, $20
                    )
                    ON CONFLICT (purchase_token_hash) DO UPDATE SET
                        package_name = EXCLUDED.package_name,
                        product_id = EXCLUDED.product_id,
                        base_plan_id = EXCLUDED.base_plan_id,
                        offer_id = EXCLUDED.offer_id,
                        subscription_state = EXCLUDED.subscription_state,
                        status = EXCLUDED.status,
                        start_time = EXCLUDED.start_time,
                        expiry_time = EXCLUDED.expiry_time,
                        acknowledgement_state = EXCLUDED.acknowledgement_state,
                        auto_renew_enabled = EXCLUDED.auto_renew_enabled,
                        latest_order_id = EXCLUDED.latest_order_id,
                        linked_purchase_token_hash = COALESCE(
                            EXCLUDED.linked_purchase_token_hash,
                            google_play_subscription_entitlements.linked_purchase_token_hash
                        ),
                        obfuscated_external_account_id = COALESCE(
                            EXCLUDED.obfuscated_external_account_id,
                            google_play_subscription_entitlements.obfuscated_external_account_id
                        ),
                        test_purchase = EXCLUDED.test_purchase,
                        verified_at = EXCLUDED.verified_at,
                        updated_at = EXCLUDED.updated_at
                    `,
                    [
                        purchaseTokenHash,
                        owner.accountId,
                        cleanPackageName,
                        productId,
                        offer.basePlanId,
                        offer.offerId,
                        subscriptionState,
                        status,
                        owner.isTrial,
                        startTime,
                        expiryTime,
                        acknowledgementState,
                        autoRenewEnabled,
                        latestOrderId,
                        linkedPurchaseTokenHash,
                        owner.pricingCohort,
                        owner.paywallSessionId,
                        externalAccountId ??
                            owner.obfuscatedExternalAccountId,
                        testPurchase,
                        new Date(currentTime),
                    ]
                );

                return {
                    processed: true,
                    accountId: owner.accountId,
                };
            }
        );

        if (!ownership.processed) {
            return Object.freeze(ownership);
        }

        let acknowledged =
            acknowledgementState ===
                'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
        if (
            !acknowledged &&
            isEntitledStatus(status, expiryTime, currentTime)
        ) {
            try {
                await publisher.acknowledgeSubscription({
                    packageName: cleanPackageName,
                    productId,
                    purchaseToken: cleanPurchaseToken,
                });
                acknowledged = true;
                await pool.query(
                    `
                    UPDATE google_play_subscription_entitlements
                    SET
                        acknowledgement_state =
                            'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                        updated_at = NOW()
                    WHERE purchase_token_hash = $1
                      AND account_id = $2
                    `,
                    [purchaseTokenHash, ownership.accountId]
                );
            } catch (error) {
                logger?.error?.(
                    '[GooglePlayRTDN] Entitlement reconciled; acknowledgement deferred.',
                    {
                        errorCode:
                            error?.code ||
                            'google_play_acknowledgement_failed',
                        accountId: ownership.accountId,
                        productId,
                    }
                );
            }
        }

        return Object.freeze({
            processed: true,
            accountId: ownership.accountId,
            productId,
            status,
            subscriptionState,
            expiryTime: expiryTime?.toISOString() ?? null,
            isPro: isEntitledStatus(
                status,
                expiryTime,
                currentTime
            ),
            acknowledged,
        });
    }

    return Object.freeze({
        processSubscriptionNotification,
    });
}
