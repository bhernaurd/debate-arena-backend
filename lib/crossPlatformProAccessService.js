import {
    AccountProAccessError,
    createAccountProAccessService,
} from './accountProAccessService.js';
import {
    AGORA_RECURRING_PRO_PRODUCT_IDS,
    classifyAgoraProProduct,
} from './agoraProProducts.js';

const PLAY_ENTITLED_STATUSES = new Set([
    'trial',
    'active',
    'grace_period',
]);

function validDate(value) {
    if (value == null) return null;
    const date = value instanceof Date
        ? value
        : new Date(value);
    return Number.isNaN(date.getTime())
        ? null
        : date;
}

function unavailable(message, cause = null) {
    throw new AccountProAccessError(
        'pro_access_unavailable',
        message,
        {
            status: 503,
            retryable: true,
            cause: cause || undefined,
        }
    );
}

/**
 * Cross-platform Agora Pro read model.
 *
 * Apple remains the existing canonical path and is queried first. Google Play
 * is consulted only when Apple does not already grant access. This means a
 * missing Play migration or not-yet-configured Play backend can never regress
 * existing App Store / Lifetime Pro access for the live iOS app.
 */
export function createCrossPlatformProAccessService({
    pool,
    appleService = null,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error(
            'Cross-platform Pro access requires a PostgreSQL pool.'
        );
    }

    const appStoreService =
        appleService ??
        createAccountProAccessService({ pool });

    if (
        !appStoreService ||
        typeof appStoreService.getCurrentAccess !== 'function'
    ) {
        throw new Error(
            'Cross-platform Pro access requires an Apple Pro access service.'
        );
    }

    async function playAccessOrFallback(
        appleResult
    ) {
        const accountId = appleResult.accountId;
        const checkedAt = validDate(
            appleResult.checkedAt
        );

        if (!checkedAt) {
            unavailable(
                'The subscription lookup returned an invalid verification time.'
            );
        }

        let result;

        try {
            result = await pool.query(
                `
                /* account-pro-access:find-current-google-play-entitlement */
                SELECT
                    account_id,
                    purchase_token_sha256,
                    product_id,
                    normalized_status,
                    is_trial,
                    expires_date,
                    last_verified_at
                FROM google_play_subscription_entitlements
                WHERE account_id = $1
                  AND product_id = ANY($2::text[])
                  AND normalized_status IN (
                        'trial',
                        'active',
                        'grace_period'
                  )
                  AND expires_date > $3
                ORDER BY
                    CASE normalized_status
                        WHEN 'active' THEN 0
                        WHEN 'trial' THEN 1
                        WHEN 'grace_period' THEN 2
                        ELSE 3
                    END,
                    expires_date DESC,
                    last_verified_at DESC,
                    purchase_token_sha256 ASC
                LIMIT 1
                `,
                [
                    accountId,
                    Array.from(
                        AGORA_RECURRING_PRO_PRODUCT_IDS
                    ),
                    checkedAt,
                ]
            );
        } catch (error) {
            // 42P01 = undefined_table. Production does not auto-run migrations,
            // so preserve the pre-Android Apple result until migration 033 is
            // intentionally installed.
            if (error?.code === '42P01') {
                return appleResult;
            }

            unavailable(
                'Pro access could not be verified.',
                error
            );
        }

        const row = result.rows[0];
        if (!row) return appleResult;

        const rowAccountId =
            String(row.account_id || '')
                .trim()
                .toLowerCase();
        const productId =
            String(row.product_id || '').trim();
        const status =
            String(row.normalized_status || '')
                .trim()
                .toLowerCase();
        const tokenHash =
            String(row.purchase_token_sha256 || '')
                .trim()
                .toLowerCase();
        const expiry = validDate(row.expires_date);
        const lastVerifiedAt =
            validDate(row.last_verified_at);
        const classification =
            classifyAgoraProProduct(productId);

        if (
            rowAccountId !== accountId ||
            !classification ||
            !classification.isRecurring ||
            !PLAY_ENTITLED_STATUSES.has(status) ||
            !/^[0-9a-f]{64}$/.test(tokenHash) ||
            !expiry ||
            expiry.getTime() <= checkedAt.getTime()
        ) {
            unavailable(
                'The Google Play subscription lookup returned an invalid entitlement.'
            );
        }

        const gracePeriodExpiresAt =
            status === 'grace_period'
                ? expiry
                : null;

        return Object.freeze({
            hasProAccess: true,
            accountId,
            checkedAt,
            entitlement: Object.freeze({
                // This is a stable server-side identifier only. The raw Google
                // Play purchase token is never persisted or returned.
                originalTransactionId:
                    `google-play:${tokenHash}`,
                environment: 'GooglePlay',
                productId,
                status,
                entitlementSource:
                    classification.accessSource,
                isRecurring: true,
                isLifetime: false,
                isTrial: row.is_trial === true,
                accessExpiresAt: expiry,
                expiresAt: expiry,
                gracePeriodExpiresAt,
                lastSignedAt: lastVerifiedAt,
            }),
        });
    }

    async function getCurrentAccess({
        accountId,
    }) {
        const appleResult =
            await appStoreService.getCurrentAccess({
                accountId,
            });

        if (appleResult.hasProAccess) {
            return appleResult;
        }

        return playAccessOrFallback(
            appleResult
        );
    }

    async function requireCurrentProAccess({
        accountId,
    }) {
        const result = await getCurrentAccess({
            accountId,
        });

        if (!result.hasProAccess) {
            throw new AccountProAccessError(
                'ranked_pro_required',
                'Agora Pro is required to enter Ranked.',
                {
                    status: 403,
                    retryable: false,
                }
            );
        }

        return result;
    }

    return Object.freeze({
        getCurrentAccess,
        requireCurrentProAccess,
    });
}
