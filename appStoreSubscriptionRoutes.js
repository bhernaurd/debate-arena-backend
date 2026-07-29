import { createHash } from 'node:crypto';
import express from 'express';

import {
    AccountSubscriptionOwnershipError,
} from './lib/accountSubscriptionOwnership.js';

import {
    AGORA_PRO_PRODUCT_IDS,
    verifyAppStoreNotificationJWS,
    verifyAppStoreRenewalInfoJWS,
    verifyAppStoreTransactionJWS,
} from './appStoreSubscriptionVerifier.js';

const USER_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRICING_COHORTS = new Set([
    'unknown',
    'founding_2026',
    'standard',
]);

// The founding offer begins July 22 and ends when September 1 begins in each
// user's local time zone. UTC+14 reaches a local date first; UTC-12 reaches it
// last. Client hints are accepted only when the verified purchase itself falls
// inside the worldwide possible window. Notification-only snapshots inside an
// early/late boundary remain unknown until a later verified client sync
// disambiguates them.
const FOUNDING_OFFER_START_EARLIEST_UTC = Date.parse(
    '2026-07-21T10:00:00Z'
);
const FOUNDING_OFFER_START_LATEST_UTC = Date.parse(
    '2026-07-22T12:00:00Z'
);
const FOUNDING_OFFER_END_EARLIEST_UTC = Date.parse(
    '2026-08-31T10:00:00Z'
);
const FOUNDING_OFFER_END_LATEST_UTC = Date.parse(
    '2026-09-01T12:00:00Z'
);

function cleanString(value, maxLength = 50000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function normalizePricingCohortHint(value) {
    const clean = cleanString(value, 40).toLowerCase();

    if (!clean) return 'unknown';
    return PRICING_COHORTS.has(clean) ? clean : null;
}

function derivePricingCohortAssignment({
    transaction,
    pricingCohortHint = 'unknown',
}) {
    const purchaseTimestamp = Number(
        transaction?.purchaseDate ||
        transaction?.originalPurchaseDate ||
        0
    );
    const originalPurchaseTimestamp = Number(
        transaction?.originalPurchaseDate ||
        transaction?.purchaseDate ||
        0
    );

    const hasValidPurchaseDate =
        Number.isFinite(purchaseTimestamp) &&
        purchaseTimestamp > 0;
    const hasValidOriginalPurchaseDate =
        Number.isFinite(originalPurchaseTimestamp) &&
        originalPurchaseTimestamp > 0;

    const purchaseInsidePossibleFoundingWindow =
        hasValidPurchaseDate &&
        purchaseTimestamp >= FOUNDING_OFFER_START_EARLIEST_UTC &&
        purchaseTimestamp < FOUNDING_OFFER_END_LATEST_UTC;

    const originalPurchaseInsideUnambiguousFoundingWindow =
        hasValidOriginalPurchaseDate &&
        originalPurchaseTimestamp >= FOUNDING_OFFER_START_LATEST_UTC &&
        originalPurchaseTimestamp < FOUNDING_OFFER_END_EARLIEST_UTC;

    if (
        pricingCohortHint === 'founding_2026' &&
        purchaseInsidePossibleFoundingWindow
    ) {
        return {
            pricingCohort: 'founding_2026',
            pricingCohortSource: 'client_hint_with_verified_transaction',
            pricingCohortAssignedAt: new Date(),
        };
    }

    // The standard paywall is itself the disambiguating signal during the
    // worldwide September 1 boundary. Once a chain has a permanent cohort,
    // the entitlement upsert below prevents later hints from overwriting it.
    if (pricingCohortHint === 'standard') {
        return {
            pricingCohort: 'standard',
            pricingCohortSource: 'client_hint_with_verified_transaction',
            pricingCohortAssignedAt: new Date(),
        };
    }

    if (hasValidOriginalPurchaseDate) {
        if (originalPurchaseInsideUnambiguousFoundingWindow) {
            return {
                pricingCohort: 'founding_2026',
                pricingCohortSource: 'verified_original_purchase_date',
                pricingCohortAssignedAt: new Date(),
            };
        }

        if (
            originalPurchaseTimestamp < FOUNDING_OFFER_START_EARLIEST_UTC ||
            originalPurchaseTimestamp >= FOUNDING_OFFER_END_LATEST_UTC
        ) {
            return {
                pricingCohort: 'standard',
                pricingCohortSource: 'verified_original_purchase_date',
                pricingCohortAssignedAt: new Date(),
            };
        }
    }

    return {
        pricingCohort: 'unknown',
        pricingCohortSource: null,
        pricingCohortAssignedAt: null,
    };
}

function normalizeUUID(value) {
    const clean = cleanString(value, 64);
    return UUID_RE.test(clean) ? clean.toUpperCase() : null;
}

function isValidUserId(value) {
    return typeof value === 'string' && USER_ID_RE.test(value);
}

function requestInstallationId(req) {
    const value = cleanString(req.get('x-installation-id'), 128);
    return isValidUserId(value) ? value : null;
}


function optionalBearerAccessToken(req) {
    const authorization = req.get('authorization');

    if (authorization == null || authorization === '') {
        return null;
    }

    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        throw new AccountSubscriptionOwnershipError(
            'invalid_access_token',
            'The Agora account access token is invalid or expired.',
            { status: 401 }
        );
    }

    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(authorization.trim());

    if (!match) {
        throw new AccountSubscriptionOwnershipError(
            'invalid_access_token',
            'The Agora account access token is invalid or expired.',
            { status: 401 }
        );
    }

    return match[1];
}

function ownershipErrorResponse(error) {
    const status =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status <= 599
            ? error.status
            : 503;

    return {
        status,
        body: {
            success: false,
            error:
                error?.message ||
                'Subscription ownership could not be verified.',
            errorCode:
                error?.code ||
                'subscription_ownership_unavailable',
            retryable:
                status >= 500 ||
                Boolean(error?.retryable),
        },
    };
}

function toDate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return new Date(numeric);
}

function enumText(value) {
    if (value === undefined || value === null) return null;
    return String(value);
}

function jsonSafe(value) {
    if (value === undefined || value === null) return null;

    return JSON.parse(
        JSON.stringify(value, (_, item) =>
            typeof item === 'bigint' ? item.toString() : item
        )
    );
}

function notificationForStorage(notification) {
    const stored = jsonSafe(notification);

    if (!stored || typeof stored !== 'object') {
        return stored;
    }

    if (stored.data && typeof stored.data === 'object') {
        const hadTransactionJWS =
            typeof stored.data.signedTransactionInfo === 'string';
        const hadRenewalJWS =
            typeof stored.data.signedRenewalInfo === 'string';

        delete stored.data.signedTransactionInfo;
        delete stored.data.signedRenewalInfo;

        stored.data.hadSignedTransactionInfo = hadTransactionJWS;
        stored.data.hadSignedRenewalInfo = hadRenewalJWS;
    }

    return stored;
}

function isFreeTrial(transaction) {
    const discountType = String(transaction?.offerDiscountType || '')
        .trim()
        .toUpperCase();

    if (discountType === 'FREE_TRIAL') {
        return true;
    }

    // The Agora currently has one introductory offer and it is the seven-day
    // free trial. This fallback keeps trial classification working with older
    // server-library payload models that may not expose offerDiscountType.
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

function autoRenewEnabled(renewal) {
    const raw = renewal?.autoRenewStatus;

    if (raw === undefined || raw === null) return null;
    if (raw === true || raw === 1 || raw === '1') return true;
    if (raw === false || raw === 0 || raw === '0') return false;

    const normalized = String(raw).trim().toUpperCase();

    if (normalized.includes('ENABLED') || normalized === 'ON') return true;
    if (normalized.includes('DISABLED') || normalized === 'OFF') return false;

    return null;
}

function deriveStatus({
    transaction,
    renewal,
    notificationType,
    subtype,
}) {
    const now = Date.now();
    const revocationDate = Number(transaction?.revocationDate || 0);
    const expiresDate = Number(transaction?.expiresDate || 0);
    const gracePeriodExpiresDate = Number(
        renewal?.gracePeriodExpiresDate || 0
    );
    const isTrial = isFreeTrial(transaction);
    const type = String(notificationType || '').toUpperCase();
    const sub = String(subtype || '').toUpperCase();

    if (
        revocationDate > 0 ||
        type === 'REFUND' ||
        type === 'REVOKE'
    ) {
        return 'revoked';
    }

    if (transaction?.isUpgraded === true) {
        return 'expired';
    }

    // EXPIRED means Apple has ended the subscription state. Process it before
    // evaluating dates; stale delivery is handled separately by last_signed_date.
    if (type === 'EXPIRED') {
        return 'expired';
    }

    // When billing grace ends unsuccessfully, Apple continues attempting
    // recovery in billing retry. Service is no longer entitled, but the chain
    // should remain distinguishable from a final EXPIRED state.
    if (type === 'GRACE_PERIOD_EXPIRED') {
        return 'billing_retry';
    }

    if (
        sub === 'GRACE_PERIOD' &&
        gracePeriodExpiresDate > now
    ) {
        return 'grace_period';
    }

    if (expiresDate > now) {
        return isTrial ? 'trial' : 'active';
    }

    if (
        renewal?.isInBillingRetryPeriod === true ||
        type === 'DID_FAIL_TO_RENEW'
    ) {
        return 'billing_retry';
    }

    return expiresDate > 0 ? 'expired' : 'unknown';
}

async function resolveExistingUserId(
    client,
    originalTransactionId,
    environment
) {
    if (!originalTransactionId) return null;

    const result = await client.query(
        `
        SELECT user_id
        FROM (
            SELECT
                user_id,
                1 AS priority,
                updated_at AS seen_at
            FROM subscription_entitlements
            WHERE original_transaction_id = $1
              AND environment = $2
              AND user_id IS NOT NULL

            UNION ALL

            SELECT
                user_id,
                2 AS priority,
                MIN(created_at) AS seen_at
            FROM app_store_transactions
            WHERE original_transaction_id = $1
              AND environment = $2
              AND user_id IS NOT NULL
            GROUP BY user_id

            UNION ALL

            SELECT
                user_id,
                3 AS priority,
                first_seen_at AS seen_at
            FROM subscription_installation_links
            WHERE original_transaction_id = $1
              AND environment = $2
              AND user_id IS NOT NULL
        ) candidates
        ORDER BY priority, seen_at ASC, user_id ASC
        LIMIT 1
        `,
        [originalTransactionId, environment]
    );

    return result.rows[0]?.user_id || null;
}

async function resolveUserId({
    client,
    transaction,
    requestedUserId,
    environment,
}) {
    const existingUserId = await resolveExistingUserId(
        client,
        transaction?.originalTransactionId,
        environment
    );
    // Legacy user_id columns remain installation identifiers. The verified
    // App Store appAccountToken may now contain an Agora account UUID, so it
    // must never become the legacy canonical user_id.
    return existingUserId || requestedUserId || null;
}

async function upsertTransaction(client, {
    transaction,
    environment,
    userId,
}) {
    const transactionId = cleanString(
        transaction?.transactionId,
        128
    );
    const originalTransactionId = cleanString(
        transaction?.originalTransactionId,
        128
    );
    const productId = cleanString(transaction?.productId, 200);

    if (!transactionId || !originalTransactionId || !productId) {
        throw new Error(
            'Verified App Store transaction is missing required identifiers.'
        );
    }

    if (!AGORA_PRO_PRODUCT_IDS.has(productId)) {
        return null;
    }

    const appAccountToken = normalizeUUID(
        transaction?.appAccountToken
    );

    await client.query(
        `
        INSERT INTO app_store_transactions (
            transaction_id,
            original_transaction_id,
            user_id,
            app_account_token,
            product_id,
            subscription_group_identifier,
            environment,
            transaction_type,
            transaction_reason,
            offer_type,
            offer_identifier,
            offer_discount_type,
            is_trial,
            ownership_type,
            purchase_date,
            original_purchase_date,
            expires_date,
            revocation_date,
            signed_date,
            storefront,
            storefront_id,
            currency,
            price_milliunits,
            quantity,
            raw_transaction
        )
        VALUES (
            $1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21, $22, $23, $24, $25::jsonb
        )
        ON CONFLICT (transaction_id, environment) DO UPDATE SET
            original_transaction_id = EXCLUDED.original_transaction_id,
            user_id = COALESCE(app_store_transactions.user_id, EXCLUDED.user_id),
            app_account_token = COALESCE(EXCLUDED.app_account_token, app_store_transactions.app_account_token),
            product_id = EXCLUDED.product_id,
            subscription_group_identifier = COALESCE(EXCLUDED.subscription_group_identifier, app_store_transactions.subscription_group_identifier),
            environment = EXCLUDED.environment,
            transaction_type = COALESCE(EXCLUDED.transaction_type, app_store_transactions.transaction_type),
            transaction_reason = COALESCE(EXCLUDED.transaction_reason, app_store_transactions.transaction_reason),
            offer_type = COALESCE(EXCLUDED.offer_type, app_store_transactions.offer_type),
            offer_identifier = COALESCE(EXCLUDED.offer_identifier, app_store_transactions.offer_identifier),
            offer_discount_type = COALESCE(EXCLUDED.offer_discount_type, app_store_transactions.offer_discount_type),
            is_trial = EXCLUDED.is_trial,
            ownership_type = COALESCE(EXCLUDED.ownership_type, app_store_transactions.ownership_type),
            purchase_date = COALESCE(EXCLUDED.purchase_date, app_store_transactions.purchase_date),
            original_purchase_date = COALESCE(EXCLUDED.original_purchase_date, app_store_transactions.original_purchase_date),
            expires_date = COALESCE(EXCLUDED.expires_date, app_store_transactions.expires_date),
            revocation_date = COALESCE(EXCLUDED.revocation_date, app_store_transactions.revocation_date),
            signed_date = COALESCE(EXCLUDED.signed_date, app_store_transactions.signed_date),
            storefront = COALESCE(EXCLUDED.storefront, app_store_transactions.storefront),
            storefront_id = COALESCE(EXCLUDED.storefront_id, app_store_transactions.storefront_id),
            currency = COALESCE(EXCLUDED.currency, app_store_transactions.currency),
            price_milliunits = COALESCE(EXCLUDED.price_milliunits, app_store_transactions.price_milliunits),
            quantity = COALESCE(EXCLUDED.quantity, app_store_transactions.quantity),
            raw_transaction = COALESCE(EXCLUDED.raw_transaction, app_store_transactions.raw_transaction),
            updated_at = NOW()
        WHERE
            app_store_transactions.signed_date IS NULL OR
            (
                EXCLUDED.signed_date IS NOT NULL AND
                EXCLUDED.signed_date >= app_store_transactions.signed_date
            )
        `,
        [
            transactionId,
            originalTransactionId,
            userId,
            appAccountToken,
            productId,
            enumText(transaction?.subscriptionGroupIdentifier),
            environment,
            enumText(transaction?.type),
            enumText(transaction?.transactionReason),
            enumText(transaction?.offerType),
            cleanString(transaction?.offerIdentifier, 200) || null,
            enumText(transaction?.offerDiscountType),
            isFreeTrial(transaction),
            enumText(transaction?.inAppOwnershipType),
            toDate(transaction?.purchaseDate),
            toDate(transaction?.originalPurchaseDate),
            toDate(transaction?.expiresDate),
            toDate(transaction?.revocationDate),
            toDate(transaction?.signedDate),
            cleanString(transaction?.storefront, 32) || null,
            cleanString(transaction?.storefrontId, 64) || null,
            cleanString(transaction?.currency, 16) || null,
            Number.isFinite(Number(transaction?.price))
                ? Number(transaction.price)
                : null,
            Number.isFinite(Number(transaction?.quantity))
                ? Number(transaction.quantity)
                : null,
            JSON.stringify(jsonSafe(transaction)),
        ]
    );

    return {
        transactionId,
        originalTransactionId,
        productId,
        appAccountToken,
    };
}

async function upsertEntitlement(client, {
    transaction,
    renewal,
    environment,
    userId,
    notificationType,
    subtype,
    source,
    snapshotSignedDate,
    pricingCohortHint = 'unknown',
    paywallSessionId = null,
}) {
    const originalTransactionId = cleanString(
        transaction?.originalTransactionId ||
        renewal?.originalTransactionId,
        128
    );
    const productId = cleanString(
        transaction?.productId || renewal?.autoRenewProductId,
        200
    );

    if (!originalTransactionId || !productId) {
        return null;
    }

    if (!AGORA_PRO_PRODUCT_IDS.has(productId)) {
        return null;
    }

    const status = deriveStatus({
        transaction,
        renewal,
        notificationType,
        subtype,
    });
    const trial = isFreeTrial(transaction);
    const appAccountToken = normalizeUUID(
        transaction?.appAccountToken || renewal?.appAccountToken
    );
    const autoRenew = autoRenewEnabled(renewal);
    const cohortAssignment = derivePricingCohortAssignment({
        transaction,
        pricingCohortHint,
    });

    const upsertResult = await client.query(
        `
        INSERT INTO subscription_entitlements (
            original_transaction_id,
            user_id,
            app_account_token,
            product_id,
            environment,
            status,
            is_trial,
            auto_renew_enabled,
            purchase_date,
            original_purchase_date,
            expires_date,
            grace_period_expires_date,
            revocation_date,
            expiration_intent,
            last_transaction_id,
            last_notification_type,
            last_notification_subtype,
            source,
            last_signed_date,
            pricing_cohort,
            pricing_cohort_source,
            pricing_cohort_assigned_at,
            pricing_cohort_paywall_session_id
        )
        VALUES (
            $1, $2, $3::uuid, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
            $20, $21, $22, $23
        )
        ON CONFLICT (original_transaction_id, environment) DO UPDATE SET
            user_id = COALESCE(subscription_entitlements.user_id, EXCLUDED.user_id),
            app_account_token = COALESCE(EXCLUDED.app_account_token, subscription_entitlements.app_account_token),
            product_id = EXCLUDED.product_id,
            environment = EXCLUDED.environment,
            status = EXCLUDED.status,
            is_trial = EXCLUDED.is_trial,
            auto_renew_enabled = COALESCE(EXCLUDED.auto_renew_enabled, subscription_entitlements.auto_renew_enabled),
            purchase_date = COALESCE(EXCLUDED.purchase_date, subscription_entitlements.purchase_date),
            original_purchase_date = COALESCE(EXCLUDED.original_purchase_date, subscription_entitlements.original_purchase_date),
            expires_date = COALESCE(EXCLUDED.expires_date, subscription_entitlements.expires_date),
            grace_period_expires_date = COALESCE(EXCLUDED.grace_period_expires_date, subscription_entitlements.grace_period_expires_date),
            revocation_date = COALESCE(EXCLUDED.revocation_date, subscription_entitlements.revocation_date),
            expiration_intent = COALESCE(EXCLUDED.expiration_intent, subscription_entitlements.expiration_intent),
            last_transaction_id = COALESCE(EXCLUDED.last_transaction_id, subscription_entitlements.last_transaction_id),
            last_notification_type = COALESCE(EXCLUDED.last_notification_type, subscription_entitlements.last_notification_type),
            last_notification_subtype = COALESCE(EXCLUDED.last_notification_subtype, subscription_entitlements.last_notification_subtype),
            source = CASE
                WHEN EXCLUDED.source = 'apple_notification'
                    THEN EXCLUDED.source
                ELSE subscription_entitlements.source
            END,
            last_signed_date = EXCLUDED.last_signed_date,
            pricing_cohort = CASE
                WHEN subscription_entitlements.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN subscription_entitlements.pricing_cohort
                WHEN EXCLUDED.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN EXCLUDED.pricing_cohort
                ELSE COALESCE(
                    subscription_entitlements.pricing_cohort,
                    'unknown'
                )
            END,
            pricing_cohort_source = CASE
                WHEN subscription_entitlements.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN subscription_entitlements.pricing_cohort_source
                WHEN EXCLUDED.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN EXCLUDED.pricing_cohort_source
                ELSE subscription_entitlements.pricing_cohort_source
            END,
            pricing_cohort_assigned_at = CASE
                WHEN subscription_entitlements.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN subscription_entitlements.pricing_cohort_assigned_at
                WHEN EXCLUDED.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN EXCLUDED.pricing_cohort_assigned_at
                ELSE subscription_entitlements.pricing_cohort_assigned_at
            END,
            pricing_cohort_paywall_session_id = CASE
                WHEN subscription_entitlements.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN subscription_entitlements.pricing_cohort_paywall_session_id
                WHEN EXCLUDED.pricing_cohort IN (
                    'founding_2026',
                    'standard'
                ) THEN COALESCE(
                    EXCLUDED.pricing_cohort_paywall_session_id,
                    subscription_entitlements.pricing_cohort_paywall_session_id
                )
                ELSE subscription_entitlements.pricing_cohort_paywall_session_id
            END,
            updated_at = NOW()
        WHERE
            subscription_entitlements.last_signed_date IS NULL OR
            EXCLUDED.last_signed_date >=
                subscription_entitlements.last_signed_date
        RETURNING
            original_transaction_id,
            product_id,
            status,
            is_trial,
            auto_renew_enabled,
            expires_date,
            last_signed_date,
            pricing_cohort,
            pricing_cohort_source,
            pricing_cohort_assigned_at,
            pricing_cohort_paywall_session_id
        `,
        [
            originalTransactionId,
            userId,
            appAccountToken,
            productId,
            environment,
            status,
            trial,
            autoRenew,
            toDate(transaction?.purchaseDate),
            toDate(transaction?.originalPurchaseDate),
            toDate(transaction?.expiresDate),
            toDate(renewal?.gracePeriodExpiresDate),
            toDate(transaction?.revocationDate),
            Number.isFinite(Number(renewal?.expirationIntent))
                ? Number(renewal.expirationIntent)
                : null,
            cleanString(transaction?.transactionId, 128) || null,
            cleanString(notificationType, 100) || null,
            cleanString(subtype, 100) || null,
            source,
            snapshotSignedDate ||
                toDate(transaction?.signedDate) ||
                new Date(),
            cohortAssignment.pricingCohort,
            cohortAssignment.pricingCohortSource,
            cohortAssignment.pricingCohortAssignedAt,
            cleanString(paywallSessionId, 128) || null,
        ]
    );

    let canonicalRow = upsertResult.rows[0] || null;

    // PostgreSQL returns no row when the ON CONFLICT ... WHERE guard rejects an
    // older snapshot. Load the canonical entitlement so status_after reflects
    // the state that actually remains after processing, not the stale incoming
    // notification.
    if (!canonicalRow) {
        const currentResult = await client.query(
            `
            SELECT
                original_transaction_id,
                product_id,
                status,
                is_trial,
                auto_renew_enabled,
                expires_date,
                last_signed_date,
                pricing_cohort,
                pricing_cohort_source,
                pricing_cohort_assigned_at,
                pricing_cohort_paywall_session_id
            FROM subscription_entitlements
            WHERE original_transaction_id = $1
              AND environment = $2
            LIMIT 1
            `,
            [originalTransactionId, environment]
        );

        canonicalRow = currentResult.rows[0] || null;
    }

    if (
        canonicalRow &&
        (canonicalRow.pricing_cohort || 'unknown') === 'unknown' &&
        cohortAssignment.pricingCohort !== 'unknown'
    ) {
        const cohortUpdate = await client.query(
            `
            UPDATE subscription_entitlements
            SET
                pricing_cohort = $3,
                pricing_cohort_source = $4,
                pricing_cohort_assigned_at = COALESCE(
                    pricing_cohort_assigned_at,
                    $5
                ),
                pricing_cohort_paywall_session_id = COALESCE(
                    pricing_cohort_paywall_session_id,
                    $6
                ),
                updated_at = NOW()
            WHERE original_transaction_id = $1
              AND environment = $2
              AND COALESCE(pricing_cohort, 'unknown') = 'unknown'
            RETURNING
                original_transaction_id,
                product_id,
                status,
                is_trial,
                auto_renew_enabled,
                expires_date,
                last_signed_date,
                pricing_cohort,
                pricing_cohort_source,
                pricing_cohort_assigned_at,
                pricing_cohort_paywall_session_id
            `,
            [
                originalTransactionId,
                environment,
                cohortAssignment.pricingCohort,
                cohortAssignment.pricingCohortSource,
                cohortAssignment.pricingCohortAssignedAt,
                cleanString(paywallSessionId, 128) || null,
            ]
        );

        canonicalRow = cohortUpdate.rows[0] || canonicalRow;
    }

    if (!canonicalRow) {
        return null;
    }

    return {
        originalTransactionId:
            canonicalRow.original_transaction_id,
        productId: canonicalRow.product_id,
        status: canonicalRow.status,
        isTrial: canonicalRow.is_trial === true,
        autoRenewEnabled:
            canonicalRow.auto_renew_enabled ?? null,
        expiresDate: canonicalRow.expires_date || null,
        lastSignedDate: canonicalRow.last_signed_date || null,
        pricingCohort: canonicalRow.pricing_cohort || 'unknown',
        pricingCohortSource:
            canonicalRow.pricing_cohort_source || null,
        pricingCohortAssignedAt:
            canonicalRow.pricing_cohort_assigned_at || null,
        pricingCohortPaywallSessionId:
            canonicalRow.pricing_cohort_paywall_session_id || null,
    };
}

async function linkSubscriptionInstallations(client, {
    originalTransactionId,
    environment,
    transaction,
    requestedUserId,
    canonicalUserId,
    source,
}) {
    if (!originalTransactionId || !environment) return;

    // Only installation identifiers belong in this legacy link table.
    // appAccountToken may now be the authenticated Agora account UUID.
    const candidates = new Set(
        [canonicalUserId, requestedUserId]
            .filter((value) => isValidUserId(value))
    );

    for (const userId of candidates) {
        const candidateAppAccountToken = null;

        await client.query(
            `
            INSERT INTO subscription_installation_links (
                original_transaction_id,
                environment,
                user_id,
                app_account_token,
                link_source
            )
            VALUES ($1, $2, $3, $4::uuid, $5)
            ON CONFLICT (
                original_transaction_id,
                environment,
                user_id
            ) DO UPDATE SET
                app_account_token = COALESCE(
                    EXCLUDED.app_account_token,
                    subscription_installation_links.app_account_token
                ),
                link_source = EXCLUDED.link_source,
                last_seen_at = NOW()
            `,
            [
                originalTransactionId,
                environment,
                userId,
                candidateAppAccountToken,
                source,
            ]
        );
    }
}

async function insertSubscriptionEvent(client, {
    eventKey,
    notificationUUID,
    source,
    userId,
    transaction,
    entitlement,
    notificationType,
    subtype,
    environment,
    eventAt,
    metadata,
}) {
    if (!entitlement) return;

    await client.query(
        `
        INSERT INTO subscription_events (
            event_key,
            notification_uuid,
            source,
            user_id,
            original_transaction_id,
            transaction_id,
            event_type,
            subtype,
            environment,
            product_id,
            status_after,
            is_trial,
            auto_renew_enabled,
            expires_date,
            event_at,
            metadata
        )
        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
        `,
        [
            eventKey,
            notificationUUID || null,
            source,
            userId,
            entitlement.originalTransactionId,
            cleanString(transaction?.transactionId, 128) || null,
            notificationType,
            subtype || null,
            environment,
            entitlement.productId,
            entitlement.status,
            entitlement.isTrial,
            entitlement.autoRenewEnabled,
            entitlement.expiresDate,
            eventAt || new Date(),
            JSON.stringify({
                ...(jsonSafe(metadata) || {}),
                pricingCohort:
                    entitlement.pricingCohort || 'unknown',
                pricingCohortSource:
                    entitlement.pricingCohortSource || null,
            }),
        ]
    );
}

async function persistVerifiedSnapshot(client, {
    transaction,
    renewal = null,
    environment,
    requestedUserId = null,
    notificationType,
    subtype = null,
    source,
    eventKey,
    notificationUUID = null,
    eventAt = null,
    metadata = null,
    pricingCohortHint = 'unknown',
    paywallSessionId = null,
}) {
    const userId = await resolveUserId({
        client,
        transaction,
        requestedUserId,
        environment,
    });

    const storedTransaction = await upsertTransaction(client, {
        transaction,
        environment,
        userId,
    });

    if (!storedTransaction) {
        return {
            ignored: true,
            reason: 'non_agora_product',
        };
    }

    const entitlement = await upsertEntitlement(client, {
        transaction,
        renewal,
        environment,
        userId,
        notificationType,
        subtype,
        source,
        snapshotSignedDate: eventAt,
        pricingCohortHint,
        paywallSessionId,
    });

    await linkSubscriptionInstallations(client, {
        originalTransactionId: storedTransaction.originalTransactionId,
        environment,
        transaction,
        requestedUserId,
        canonicalUserId: userId,
        source,
    });

    await insertSubscriptionEvent(client, {
        eventKey,
        notificationUUID,
        source,
        userId,
        transaction,
        entitlement,
        notificationType,
        subtype,
        environment,
        eventAt,
        metadata,
    });

    return {
        ignored: false,
        userId,
        entitlement,
    };
}

export function createAppStoreSubscriptionRouter(
    pool,
    {
        accountSubscriptionOwnershipService = null,
    } = {}
) {
    const router = express.Router();


    if (
        accountSubscriptionOwnershipService != null &&
        (
            typeof accountSubscriptionOwnershipService
                .authorizeSubscriptionSync !== 'function' ||
            typeof accountSubscriptionOwnershipService
                .claimVerifiedSubscription !== 'function'
        )
    ) {
        throw new Error(
            'A valid account subscription ownership service is required.'
        );
    }

    // Called by the iOS app after a locally verified purchase, restore, launch,
    // or StoreKit transaction update. The JWS is verified again on the server.
    router.post('/api/app-store/sync-transaction', async (req, res) => {
        const requestedUserId = requestInstallationId(req);
        let accessToken;

        try {
            accessToken = optionalBearerAccessToken(req);
        } catch (error) {
            const response = ownershipErrorResponse(error);
            return res.status(response.status).json(response.body);
        }

        const transactionJWS = cleanString(
            req.body?.transactionJWS,
            50000
        );
        const pricingCohortHint = normalizePricingCohortHint(
            req.body?.pricingCohortHint
        );
        const paywallSessionId = cleanString(
            req.body?.paywallSessionId,
            128
        ) || null;

        if (!requestedUserId) {
            return res.status(401).json({
                success: false,
                error: 'X-Installation-ID is required.',
            });
        }

        if (!transactionJWS) {
            return res.status(400).json({
                success: false,
                error: 'transactionJWS is required.',
            });
        }

        if (pricingCohortHint === null) {
            return res.status(400).json({
                success: false,
                error: 'invalid pricingCohortHint',
            });
        }

        let client;
        let processingStarted = false;
        let accountAuthorization = null;

        try {
            if (accessToken) {
                if (!accountSubscriptionOwnershipService) {
                    throw new AccountSubscriptionOwnershipError(
                        'subscription_ownership_unavailable',
                        'Authenticated subscription ownership is temporarily unavailable.',
                        {
                            status: 503,
                            retryable: true,
                        }
                    );
                }

                accountAuthorization =
                    await accountSubscriptionOwnershipService
                        .authorizeSubscriptionSync({
                            installationId: requestedUserId,
                            accessToken,
                        });
            }

            const {
                decoded: transaction,
                environment,
            } = await verifyAppStoreTransactionJWS(transactionJWS);

            processingStarted = true;
            client = await pool.connect();
            await client.query('BEGIN');

            const transactionId = cleanString(
                transaction?.transactionId,
                128
            );
            const signedDate = Number(transaction?.signedDate || 0);
            const eventKey = `client_sync:${environment}:${transactionId}:${signedDate || 'unknown'}`;

            const result = await persistVerifiedSnapshot(client, {
                transaction,
                environment,
                requestedUserId,
                notificationType: 'CLIENT_SYNC',
                source: 'client_sync',
                eventKey,
                eventAt: toDate(transaction?.signedDate) || new Date(),
                metadata: {
                    iosBuild: req.get('x-ios-build') || null,
                    pricingCohortHint,
                    paywallSessionId,
                    authenticatedAccountId:
                        accountAuthorization?.accountId || null,
                },
                pricingCohortHint,
                paywallSessionId,
            });

            let accountOwnership = null;

            if (
                accountAuthorization &&
                !result.ignored
            ) {
                const ownershipResult =
                    await accountSubscriptionOwnershipService
                        .claimVerifiedSubscription({
                            client,
                            authorization: accountAuthorization,
                            transaction,
                            environment,
                        });

                accountOwnership = {
                    linked: Boolean(
                        ownershipResult?.ownership
                    ),
                    accountId:
                        accountAuthorization.accountId,
                    migratedLegacyOwnership:
                        Boolean(
                            ownershipResult
                                ?.migratedLegacyOwnership
                        ),
                    claimSource:
                        ownershipResult
                            ?.ownership
                            ?.claimSource || null,
                };
            }

            await client.query('COMMIT');

            return res.json({
                success: true,
                ignored: result.ignored,
                reason: result.reason || null,
                status: result.entitlement?.status || null,
                pricingCohort:
                    result.entitlement?.pricingCohort || 'unknown',
                analyticsAccessTier:
                    result.entitlement?.isTrial &&
                    ['trial', 'active', 'grace_period'].includes(
                        result.entitlement?.status
                    )
                        ? 'trial'
                        : result.entitlement?.status === 'active' ||
                          result.entitlement?.status === 'grace_period'
                            ? 'paid_pro'
                            : 'free',
                accountOwnership,
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch {}
            }

            if (
                error instanceof
                    AccountSubscriptionOwnershipError
            ) {
                const response =
                    ownershipErrorResponse(error);

                if (response.status >= 500) {
                    console.error(
                        '[AppStoreSubscriptions] Account ownership sync failed.',
                        {
                            errorCode:
                                error.code ||
                                'subscription_ownership_unavailable',
                        }
                    );
                }

                return res
                    .status(response.status)
                    .json(response.body);
            }

            console.error(
                '[AppStoreSubscriptions] Client sync failed:',
                error?.message || error
            );

            const statusCode = Number(
                error?.statusCode ||
                (processingStarted ? 500 : 400)
            );

            return res.status(statusCode).json({
                success: false,
                error: processingStarted
                    ? 'Transaction sync processing failed.'
                    : (error?.message || 'Transaction verification failed.'),
            });
        } finally {
            client?.release();
        }
    });

    // App Store Server Notifications V2 endpoint.
    router.post('/api/app-store/notifications', async (req, res) => {
        const signedPayload = cleanString(
            req.body?.signedPayload,
            100000
        );

        if (!signedPayload) {
            return res.status(400).json({
                success: false,
                error: 'signedPayload is required.',
            });
        }

        let client;
        let processingStarted = false;

        try {
            const {
                decoded: notification,
                environment: verifiedEnvironment,
            } = await verifyAppStoreNotificationJWS(signedPayload);

            const notificationUUID = cleanString(
                notification?.notificationUUID,
                128
            );

            if (!notificationUUID) {
                throw new Error(
                    'Verified notification is missing notificationUUID.'
                );
            }

            const notificationType = cleanString(
                notification?.notificationType,
                100
            ) || 'UNKNOWN';
            const subtype = cleanString(
                notification?.subtype,
                100
            ) || null;
            const data = notification?.data || {};
            const environment = cleanString(
                data?.environment,
                32
            ) || verifiedEnvironment;

            let transaction = null;
            let renewal = null;

            if (data?.signedTransactionInfo) {
                const verifiedTransaction =
                    await verifyAppStoreTransactionJWS(
                        data.signedTransactionInfo
                    );

                if (verifiedTransaction.environment !== environment) {
                    throw new Error(
                        'Notification and transaction environments do not match.'
                    );
                }

                transaction = verifiedTransaction.decoded;
            }

            if (data?.signedRenewalInfo) {
                const verifiedRenewal =
                    await verifyAppStoreRenewalInfoJWS(
                        data.signedRenewalInfo
                    );

                if (verifiedRenewal.environment !== environment) {
                    throw new Error(
                        'Notification and renewal environments do not match.'
                    );
                }

                renewal = verifiedRenewal.decoded;
            }

            processingStarted = true;
            client = await pool.connect();
            await client.query('BEGIN');

            const insertNotification = await client.query(
                `
                INSERT INTO app_store_notifications (
                    notification_uuid,
                    notification_type,
                    subtype,
                    environment,
                    signed_date,
                    app_apple_id,
                    bundle_id,
                    version,
                    signed_payload_sha256,
                    decoded_payload
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
                )
                ON CONFLICT (notification_uuid) DO NOTHING
                RETURNING notification_uuid
                `,
                [
                    notificationUUID,
                    notificationType,
                    subtype,
                    environment,
                    toDate(notification?.signedDate),
                    Number.isFinite(Number(data?.appAppleId))
                        ? Number(data.appAppleId)
                        : null,
                    cleanString(data?.bundleId, 255) || null,
                    cleanString(notification?.version, 32) || null,
                    createHash('sha256')
                        .update(signedPayload)
                        .digest('hex'),
                    JSON.stringify(notificationForStorage(notification)),
                ]
            );

            if (insertNotification.rowCount === 0) {
                await client.query('COMMIT');
                return res.json({
                    success: true,
                    duplicate: true,
                });
            }

            if (transaction) {
                await persistVerifiedSnapshot(client, {
                    transaction,
                    renewal,
                    environment,
                    notificationType,
                    subtype,
                    source: 'apple_notification',
                    eventKey: `apple:${notificationUUID}`,
                    notificationUUID,
                    eventAt: toDate(notification?.signedDate) || new Date(),
                    metadata: {
                        notificationType,
                        subtype,
                    },
                });
            }

            await client.query(
                `
                UPDATE app_store_notifications
                SET processed_at = NOW(), processing_error = NULL
                WHERE notification_uuid = $1
                `,
                [notificationUUID]
            );

            await client.query('COMMIT');

            return res.json({
                success: true,
                notificationUUID,
            });
        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch {}
            }

            console.error(
                '[AppStoreSubscriptions] Notification failed:',
                error?.message || error
            );

            // Invalid/unverifiable payloads are client errors. Once cryptographic
            // verification and payload validation have succeeded, database or
            // persistence failures are server errors so Apple can retry them.
            return res.status(processingStarted ? 500 : 400).json({
                success: false,
                error: processingStarted
                    ? 'Notification processing failed.'
                    : 'Notification verification failed.',
            });
        } finally {
            client?.release();
        }
    });

    return router;
}
