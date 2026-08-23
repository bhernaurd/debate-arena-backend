import crypto from 'node:crypto';

import {
    GooglePlayPublisherError,
    createGooglePlayPublisherService,
} from './googlePlayPublisherService.js';

const GOOGLE_PLAY_PRO_PRODUCT_IDS = new Set([
    'agora_pro_monthly',
    'agora_pro_yearly',
]);

const PRICING_COHORTS = new Set([
    'unknown',
    'founding_2026',
    'standard',
]);

export class GooglePlaySubscriptionError extends Error {
    constructor(code, message, {
        status = 500,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlaySubscriptionError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlaySubscriptionError(code, message, options);
}

function clean(value, maxLength = 4096) {
    if (typeof value !== 'string') return '';
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maxLength) return '';
    return cleaned;
}

function optionalClean(value, maxLength = 255) {
    if (value == null || value === '') return null;
    const valueString = clean(value, maxLength);
    return valueString || null;
}

function sha256(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function normalizePricingCohort(value) {
    const cohort = clean(value, 40).toLowerCase() || 'unknown';
    if (!PRICING_COHORTS.has(cohort)) {
        fail(
            'invalid_pricing_cohort',
            'The subscription pricing cohort is invalid.',
            { status: 400 }
        );
    }
    return cohort;
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
            return hasFutureAccess ? 'active' : 'expired';
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
    if (!['trial', 'active', 'grace_period'].includes(status)) {
        return false;
    }
    return Boolean(expiryTime && expiryTime.getTime() > nowMs);
}

function findVerifiedLineItem(subscription, productId) {
    const lineItems = Array.isArray(subscription?.lineItems)
        ? subscription.lineItems
        : [];
    return lineItems.find(
        (item) => clean(item?.productId, 200) === productId
    ) || null;
}

function verifiedOfferDetails(lineItem) {
    const details = lineItem?.offerDetails;
    if (!details || typeof details !== 'object') {
        return {
            basePlanId: null,
            offerId: null,
        };
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

function verifyOptionalHint(name, requested, verified) {
    const requestedValue = optionalClean(requested, 200);
    if (requested != null && requested !== '' && !requestedValue) {
        fail(
            'invalid_google_play_offer_hint',
            `The Google Play ${name} hint is invalid.`,
            { status: 400, retryable: false }
        );
    }
    if (!requestedValue || !verified) return;
    if (requestedValue !== verified) {
        fail(
            'google_play_offer_mismatch',
            `The verified Google Play ${name} does not match the purchase request.`,
            { status: 409, retryable: false }
        );
    }
}

function normalizeExternalAccountId(subscription) {
    return optionalClean(
        subscription?.externalAccountIdentifiers?.obfuscatedExternalAccountId,
        255
    );
}

function publisherError(error) {
    if (error instanceof GooglePlayPublisherError) {
        return new GooglePlaySubscriptionError(
            error.code,
            error.message,
            {
                status: error.status,
                retryable: error.retryable,
                cause: error,
            }
        );
    }
    return error;
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
            // Preserve the original error.
        }
        throw error;
    } finally {
        client.release();
    }
}

export function createGooglePlaySubscriptionService({
    pool,
    accountAuthService,
    publisherService = null,
    now = () => Date.now(),
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error(
            'Google Play subscription service requires a PostgreSQL pool.'
        );
    }
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'Google Play subscription service requires the shared account auth service.'
        );
    }
    if (typeof now !== 'function') {
        throw new Error('now must be a function.');
    }

    const publisher =
        publisherService ?? createGooglePlayPublisherService();

    async function authorize({ installationId, accessToken }) {
        try {
            return await accountAuthService.authorizeAccessToken({
                installationId,
                accessToken,
            });
        } catch (error) {
            fail(
                error?.code || 'invalid_account_session',
                error?.message ||
                    'The Agora account session is invalid or expired.',
                {
                    status:
                        Number.isInteger(error?.status)
                            ? error.status
                            : 401,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function syncPurchase({
        installationId,
        accessToken,
        packageName,
        purchaseToken,
        productId,
        basePlanId,
        offerId,
        pricingCohortHint,
        paywallSessionId,
    } = {}) {
        const token = clean(purchaseToken, 4096);
        const product = clean(productId, 200);
        const packageValue = clean(packageName, 255);

        if (!token || !product || !packageValue) {
            fail(
                'invalid_google_play_purchase',
                'Google Play purchase information is incomplete or invalid.',
                { status: 400 }
            );
        }
        if (!GOOGLE_PLAY_PRO_PRODUCT_IDS.has(product)) {
            fail(
                'unsupported_google_play_product',
                'This Google Play product does not grant Agora Pro.',
                { status: 400 }
            );
        }

        const authorization = await authorize({
            installationId,
            accessToken,
        });
        const accountId = clean(authorization.accountId, 64).toLowerCase();
        if (!accountId) {
            fail(
                'invalid_account_session',
                'The Agora account session is invalid or expired.',
                { status: 401 }
            );
        }

        const currentTime = Number(now());
        if (!Number.isFinite(currentTime) || currentTime < 0) {
            throw new Error('now() returned an invalid value.');
        }

        let verified;
        try {
            verified = await publisher.getSubscription({
                packageName: packageValue,
                purchaseToken: token,
            });
        } catch (error) {
            throw publisherError(error);
        }

        const lineItem = findVerifiedLineItem(verified, product);
        if (!lineItem) {
            fail(
                'google_play_product_mismatch',
                'The verified Google Play purchase does not contain the requested Agora Pro product.',
                { status: 409, retryable: false }
            );
        }

        const offer = verifiedOfferDetails(lineItem);
        verifyOptionalHint('base plan', basePlanId, offer.basePlanId);
        verifyOptionalHint('offer', offerId, offer.offerId);

        const externalAccountId =
            normalizeExternalAccountId(verified);
        if (
            externalAccountId &&
            externalAccountId.toLowerCase() !== accountId
        ) {
            fail(
                'google_play_account_mismatch',
                'This Google Play subscription is linked to a different Agora account.',
                { status: 409, retryable: false }
            );
        }

        const expiryTime = parseDate(lineItem.expiryTime);
        const subscriptionState = normalizeState(
            verified.subscriptionState
        );
        const status = stateToStatus(
            subscriptionState,
            expiryTime,
            currentTime
        );
        const acknowledgementState =
            normalizeAcknowledgementState(
                verified.acknowledgementState
            );
        const purchaseTokenHash = sha256(token);
        const linkedPurchaseToken =
            optionalClean(verified.linkedPurchaseToken, 4096);
        const linkedPurchaseTokenHash = linkedPurchaseToken
            ? sha256(linkedPurchaseToken)
            : null;
        const pricingCohort = normalizePricingCohort(
            pricingCohortHint
        );
        const startTime = parseDate(verified.startTime);
        const testPurchase =
            verified.testPurchase != null;
        const autoRenewEnabled =
            verifiedAutoRenewEnabled(lineItem);
        const latestOrderId =
            verifiedLatestOrderId(verified, lineItem);
        const paywallSession =
            optionalClean(paywallSessionId, 255);

        if (paywallSessionId != null && paywallSessionId !== '' && !paywallSession) {
            fail(
                'invalid_paywall_session_id',
                'The paywall session identifier is invalid.',
                { status: 400, retryable: false }
            );
        }

        await withTransaction(pool, async (client) => {
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtext($1))`,
                [`google-play:${purchaseTokenHash}`]
            );

            const existing = await client.query(
                `
                SELECT account_id
                FROM google_play_subscription_entitlements
                WHERE purchase_token_hash = $1
                FOR UPDATE
                `,
                [purchaseTokenHash]
            );
            const existingAccount =
                existing.rows[0]?.account_id?.toString().toLowerCase();
            if (existingAccount && existingAccount !== accountId) {
                fail(
                    'google_play_subscription_already_claimed',
                    'This Google Play subscription is already linked to a different Agora account.',
                    { status: 409, retryable: false }
                );
            }

            if (linkedPurchaseTokenHash) {
                const linked = await client.query(
                    `
                    SELECT account_id
                    FROM google_play_subscription_entitlements
                    WHERE purchase_token_hash = $1
                    LIMIT 1
                    `,
                    [linkedPurchaseTokenHash]
                );
                const linkedAccount =
                    linked.rows[0]?.account_id?.toString().toLowerCase();
                if (linkedAccount && linkedAccount !== accountId) {
                    fail(
                        'google_play_subscription_chain_conflict',
                        'This Google Play subscription chain belongs to a different Agora account.',
                        { status: 409, retryable: false }
                    );
                }
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
                    $1, $2, $3, $4, $5, $6, $7, $8, FALSE,
                    $9, $10, $11, $12, $13, $14, $15, $16, $17,
                    $18, $19, $19, $19
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
                    pricing_cohort = CASE
                        WHEN google_play_subscription_entitlements.pricing_cohort = 'unknown'
                            THEN EXCLUDED.pricing_cohort
                        ELSE google_play_subscription_entitlements.pricing_cohort
                    END,
                    paywall_session_id = COALESCE(
                        google_play_subscription_entitlements.paywall_session_id,
                        EXCLUDED.paywall_session_id
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
                    accountId,
                    packageValue,
                    product,
                    offer.basePlanId,
                    offer.offerId,
                    subscriptionState,
                    status,
                    startTime,
                    expiryTime,
                    acknowledgementState,
                    autoRenewEnabled,
                    latestOrderId,
                    linkedPurchaseTokenHash,
                    pricingCohort,
                    paywallSession,
                    externalAccountId,
                    testPurchase,
                    new Date(currentTime),
                ]
            );
        });

        let acknowledged =
            acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';

        if (!acknowledged && isEntitledStatus(status, expiryTime, currentTime)) {
            try {
                await publisher.acknowledgeSubscription({
                    packageName: packageValue,
                    productId: product,
                    purchaseToken: token,
                });
                acknowledged = true;
                await pool.query(
                    `
                    UPDATE google_play_subscription_entitlements
                    SET
                        acknowledgement_state = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                        updated_at = NOW()
                    WHERE purchase_token_hash = $1
                      AND account_id = $2
                    `,
                    [purchaseTokenHash, accountId]
                );
            } catch (error) {
                const mapped = publisherError(error);
                console.error('[GooglePlay] Purchase verified; acknowledgement deferred.', {
                    code: mapped?.code || 'google_play_acknowledgement_failed',
                    retryable: Boolean(mapped?.retryable),
                    accountId,
                    productId: product,
                });
            }
        }

        return Object.freeze({
            success: true,
            acknowledged,
            accountOwnership: Object.freeze({
                linked: true,
                accountId,
                migratedLegacyOwnership: false,
                claimSource: 'authenticated_google_play_sync',
            }),
            entitlement: Object.freeze({
                isPro: isEntitledStatus(
                    status,
                    expiryTime,
                    currentTime
                ),
                productId: product,
                basePlanId: offer.basePlanId,
                offerId: offer.offerId,
                subscriptionState,
                expiryTime: expiryTime?.toISOString() || null,
                inFreeTrial: null,
            }),
        });
    }

    return Object.freeze({ syncPurchase });
}

export const googlePlaySubscriptionConstants = Object.freeze({
    proProductIds: Object.freeze(
        Array.from(GOOGLE_PLAY_PRO_PRODUCT_IDS)
    ),
});