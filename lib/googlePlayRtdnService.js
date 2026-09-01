import crypto from 'crypto';
import pg from 'pg';

import { AGORA_RECURRING_PRO_PRODUCT_IDS } from './agoraProProducts.js';
import { createGooglePlayPublisherClient } from './googlePlaySubscriptionService.js';

const { Pool } = pg;
const DEFAULT_PACKAGE_NAME = 'com.bhernaurd.theagora';
const MAX_PURCHASE_TOKEN_LENGTH = 16_384;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export class GooglePlayRtdnError extends Error {
    constructor(code, message, { status = 400, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlayRtdnError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlayRtdnError(code, message, options);
}

function safeString(value, maximum = 512) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function defaultPool() {
    return new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('railway')
            ? { rejectUnauthorized: false }
            : false,
        max: 3,
        idleTimeoutMillis: 30_000,
    });
}

function currentAgoraProduct(snapshot) {
    const lines = Array.isArray(snapshot?.lineItems)
        ? snapshot.lineItems.filter((item) => item && typeof item === 'object')
        : [];

    const candidates = lines.filter((item) =>
        AGORA_RECURRING_PRO_PRODUCT_IDS.has(safeString(item?.productId, 200))
    );

    return candidates
        .slice()
        .sort((left, right) => {
            const leftExpiry = Date.parse(left?.expiryTime || '') || 0;
            const rightExpiry = Date.parse(right?.expiryTime || '') || 0;
            return rightExpiry - leftExpiry;
        })[0] || null;
}

function normalizeStoredRow(row) {
    if (!row?.account_id || !row?.product_id) return null;
    return {
        accountId: String(row.account_id).trim().toLowerCase(),
        productId: String(row.product_id).trim(),
        pricingCohort: safeString(row.pricing_cohort, 40) || 'unknown',
        paywallSessionId:
            safeString(row.pricing_cohort_paywall_session_id, 128) || null,
    };
}

export function createGooglePlayRtdnService({
    pool = defaultPool(),
    googlePlaySubscriptionService,
    publisherClient = createGooglePlayPublisherClient(),
    expectedPackageName =
        process.env.GOOGLE_PLAY_PACKAGE_NAME || DEFAULT_PACKAGE_NAME,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error('Google Play RTDN service requires a PostgreSQL pool.');
    }
    if (
        !googlePlaySubscriptionService ||
        typeof googlePlaySubscriptionService.syncVerifiedPurchase !== 'function'
    ) {
        throw new Error(
            'Google Play RTDN service requires googlePlaySubscriptionService.syncVerifiedPurchase().'
        );
    }
    if (!publisherClient || typeof publisherClient.getSubscription !== 'function') {
        throw new Error('Google Play RTDN service requires a publisher client.');
    }

    const packageName = safeString(expectedPackageName, 255);
    if (!packageName) {
        throw new Error('Google Play RTDN expected package name is invalid.');
    }

    async function lookupByTokenHash(tokenHash) {
        try {
            const result = await pool.query(
                `
                SELECT
                    account_id,
                    product_id,
                    pricing_cohort,
                    pricing_cohort_paywall_session_id
                FROM google_play_subscription_entitlements
                WHERE purchase_token_sha256 = $1
                LIMIT 1
                `,
                [tokenHash]
            );
            return normalizeStoredRow(result.rows?.[0]);
        } catch (cause) {
            if (cause?.code === '42P01') {
                fail(
                    'google_play_schema_unavailable',
                    'Google Play subscription verification is not ready on this server.',
                    { status: 503, retryable: true, cause }
                );
            }
            fail(
                'google_play_rtdn_lookup_unavailable',
                'Google Play notification processing is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }
    }

    async function lookupByObfuscatedAccountId(obfuscatedAccountId) {
        if (!SHA256_HEX_RE.test(obfuscatedAccountId || '')) return null;
        try {
            const result = await pool.query(
                `
                SELECT
                    account_id,
                    product_id,
                    pricing_cohort,
                    pricing_cohort_paywall_session_id
                FROM google_play_subscription_entitlements
                WHERE obfuscated_external_account_id = $1
                ORDER BY last_verified_at DESC
                LIMIT 1
                `,
                [obfuscatedAccountId]
            );
            return normalizeStoredRow(result.rows?.[0]);
        } catch (cause) {
            if (cause?.code === '42P01') {
                fail(
                    'google_play_schema_unavailable',
                    'Google Play subscription verification is not ready on this server.',
                    { status: 503, retryable: true, cause }
                );
            }
            fail(
                'google_play_rtdn_lookup_unavailable',
                'Google Play notification processing is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }
    }

    async function resolveOwnership({ token, tokenHash }) {
        const existing = await lookupByTokenHash(tokenHash);
        if (existing) return existing;

        // New/replacement tokens can arrive through RTDN before Android performs
        // its next app-side sync. Read Google only to locate an already-verified
        // ownership chain. The authoritative write still goes through the normal
        // syncVerifiedPurchase path below.
        const snapshot = await publisherClient.getSubscription({
            packageName,
            purchaseToken: token,
        });
        const currentLine = currentAgoraProduct(snapshot);
        if (!currentLine) return null;

        const linkedToken = safeString(
            snapshot?.linkedPurchaseToken,
            MAX_PURCHASE_TOKEN_LENGTH
        );
        if (linkedToken) {
            const linked = await lookupByTokenHash(sha256Hex(linkedToken));
            if (linked) {
                return {
                    ...linked,
                    productId: safeString(currentLine.productId, 200) || linked.productId,
                };
            }
        }

        const obfuscatedAccountId = safeString(
            snapshot?.externalAccountIdentifiers?.obfuscatedExternalAccountId,
            128
        )?.toLowerCase();
        const byAccount = await lookupByObfuscatedAccountId(obfuscatedAccountId);
        if (byAccount) {
            return {
                ...byAccount,
                productId: safeString(currentLine.productId, 200) || byAccount.productId,
            };
        }

        // A first-ever purchase may beat the client purchase callback. There is
        // intentionally no reversible mapping from SHA-256(account UUID) back to
        // an account, so do not guess ownership. Android's normal purchase sync
        // will claim and verify it immediately after BillingClient returns.
        return null;
    }

    async function processNotification(notification) {
        if (!notification || typeof notification !== 'object') {
            fail('invalid_google_play_rtdn', 'Invalid Google Play notification.');
        }

        const requestedPackage = safeString(notification.packageName, 255);
        if (requestedPackage !== packageName) {
            fail(
                'google_play_package_mismatch',
                'The Google Play notification belongs to a different application.',
                { status: 409 }
            );
        }

        if (notification.testNotification) {
            return Object.freeze({ processed: false, reason: 'test_notification' });
        }

        const subscriptionNotification = notification.subscriptionNotification;
        if (!subscriptionNotification || typeof subscriptionNotification !== 'object') {
            return Object.freeze({ processed: false, reason: 'unsupported_notification' });
        }

        const token = safeString(
            subscriptionNotification.purchaseToken,
            MAX_PURCHASE_TOKEN_LENGTH
        );
        if (!token) {
            fail('invalid_google_play_rtdn', 'Google Play notification has no purchase token.');
        }

        const ownership = await resolveOwnership({
            token,
            tokenHash: sha256Hex(token),
        });
        if (!ownership) {
            return Object.freeze({
                processed: false,
                reason: 'unclaimed_purchase',
            });
        }

        const result = await googlePlaySubscriptionService.syncVerifiedPurchase({
            authorization: { accountId: ownership.accountId },
            requestedPackageName: packageName,
            purchaseToken: token,
            productId: ownership.productId,
            // Do not pin base-plan or offer IDs from an older row. Google can
            // legitimately change those across replacement and plan-change flows.
            basePlanId: null,
            offerId: null,
            pricingCohortHint: ownership.pricingCohort,
            paywallSessionId: ownership.paywallSessionId,
        });

        return Object.freeze({
            processed: true,
            notificationType: Number(subscriptionNotification.notificationType) || null,
            entitlement: result.entitlement,
            acknowledged: result.acknowledged,
        });
    }

    return Object.freeze({ processNotification });
}
