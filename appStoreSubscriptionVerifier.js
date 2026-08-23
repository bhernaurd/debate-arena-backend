import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    Environment,
    SignedDataVerifier,
} from '@apple/app-store-server-library';

import {
    AGORA_PRO_LIFETIME_PRODUCT_ID,
    AGORA_PRO_PRODUCT_IDS,
    AGORA_RECURRING_PRO_PRODUCT_IDS,
    classifyAgoraProProduct,
} from './lib/agoraProProducts.js';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);

const APP_STORE_BUNDLE_ID =
    process.env.APP_STORE_BUNDLE_ID?.trim() ||
    'com.bhernaurd.TheAgora';

const APP_STORE_APP_APPLE_ID = Number(
    process.env.APP_STORE_APP_APPLE_ID?.trim() ||
    '6762416967'
);

const appleRootCertificates = [
    'AppleIncRootCertificate.cer',
    'AppleRootCA-G2.cer',
    'AppleRootCA-G3.cer',
].map((fileName) =>
    readFileSync(
        join(
            currentDirectory,
            'certs',
            'apple',
            fileName
        )
    )
);

const enableOnlineChecks = true;

const productionVerifier = new SignedDataVerifier(
    appleRootCertificates,
    enableOnlineChecks,
    Environment.PRODUCTION,
    APP_STORE_BUNDLE_ID,
    APP_STORE_APP_APPLE_ID
);

const sandboxVerifier = new SignedDataVerifier(
    appleRootCertificates,
    enableOnlineChecks,
    Environment.SANDBOX,
    APP_STORE_BUNDLE_ID
);

function safeString(value) {
    return typeof value === 'string' ? value : null;
}

function readUnverifiedPayload(jws) {
    try {
        const parts = String(jws).split('.');

        if (parts.length !== 3) {
            return null;
        }

        return JSON.parse(
            Buffer.from(parts[1], 'base64url').toString('utf8')
        );
    } catch {
        return null;
    }
}

function readClaimedEnvironment(jws) {
    const payload = readUnverifiedPayload(jws);

    if (!payload || typeof payload !== 'object') {
        return null;
    }

    return safeString(payload.environment) ||
        safeString(payload.data?.environment) ||
        null;
}

async function verifyByEnvironment({
    jws,
    productionMethod,
    sandboxMethod,
}) {
    const claimedEnvironment = readClaimedEnvironment(jws);

    // The unverified environment is used only to select the verifier.
    // Trust is granted only after cryptographic verification succeeds.
    if (claimedEnvironment === Environment.SANDBOX) {
        return {
            decoded: await sandboxMethod(jws),
            environment: Environment.SANDBOX,
        };
    }

    if (claimedEnvironment === Environment.PRODUCTION) {
        return {
            decoded: await productionMethod(jws),
            environment: Environment.PRODUCTION,
        };
    }

    try {
        return {
            decoded: await productionMethod(jws),
            environment: Environment.PRODUCTION,
        };
    } catch (productionError) {
        try {
            return {
                decoded: await sandboxMethod(jws),
                environment: Environment.SANDBOX,
            };
        } catch (sandboxError) {
            const verificationError = new Error(
                'The App Store signed payload could not be verified.'
            );

            verificationError.cause = {
                productionError,
                sandboxError,
            };

            throw verificationError;
        }
    }
}

export async function verifyAppStoreTransactionJWS(jws) {
    return verifyByEnvironment({
        jws,
        productionMethod: (value) =>
            productionVerifier.verifyAndDecodeTransaction(value),
        sandboxMethod: (value) =>
            sandboxVerifier.verifyAndDecodeTransaction(value),
    });
}

export async function verifyAppStoreRenewalInfoJWS(jws) {
    return verifyByEnvironment({
        jws,
        productionMethod: (value) =>
            productionVerifier.verifyAndDecodeRenewalInfo(value),
        sandboxMethod: (value) =>
            sandboxVerifier.verifyAndDecodeRenewalInfo(value),
    });
}

export async function verifyAppStoreNotificationJWS(jws) {
    return verifyByEnvironment({
        jws,
        productionMethod: (value) =>
            productionVerifier.verifyAndDecodeNotification(value),
        sandboxMethod: (value) =>
            sandboxVerifier.verifyAndDecodeNotification(value),
    });
}

function isFreeTrialTransaction(transaction) {
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

export async function verifyAgoraProTransactionJWS(
    proTransactionJWS
) {
    if (
        typeof proTransactionJWS !== 'string' ||
        proTransactionJWS.trim().length === 0
    ) {
        return {
            isVerifiedPro: false,
            reason: 'missing_transaction_proof',
        };
    }

    try {
        const {
            decoded: transaction,
            environment,
        } = await verifyAppStoreTransactionJWS(
            proTransactionJWS.trim()
        );

        const productId =
            typeof transaction.productId === 'string'
                ? transaction.productId
                : '';
        const productClassification =
            classifyAgoraProProduct(productId);

        if (!productClassification) {
            return {
                isVerifiedPro: false,
                reason: 'unrecognized_product',
                environment,
                productId,
            };
        }

        if (transaction.revocationDate != null) {
            return {
                isVerifiedPro: false,
                reason: 'revoked_subscription',
                environment,
                productId,
                entitlementSource:
                    productClassification.accessSource,
                isRecurring:
                    productClassification.isRecurring,
                isLifetime:
                    productClassification.isLifetime,
                revocationDate:
                    Number(transaction.revocationDate) || null,
            };
        }

        if (transaction.isUpgraded === true) {
            return {
                isVerifiedPro: false,
                reason: 'upgraded_transaction',
                environment,
                productId,
                entitlementSource:
                    productClassification.accessSource,
                isRecurring:
                    productClassification.isRecurring,
                isLifetime:
                    productClassification.isLifetime,
                transactionId: transaction.transactionId ?? null,
                originalTransactionId:
                    transaction.originalTransactionId ?? null,
            };
        }

        // A non-consumable Lifetime Pro purchase is permanent by design and
        // does not have a subscription expiration date. Apple remains the
        // authority for revocation/refund state, handled above.
        if (productClassification.isLifetime) {
            return {
                isVerifiedPro: true,
                reason: 'verified_lifetime_non_consumable',

                // Preserve the existing generic Pro analytics/model-routing
                // contract. Recurring business metrics must use the explicit
                // entitlement source/product fields instead of treating every
                // Pro entitlement as subscription revenue.
                analyticsAccessTier: 'paid_pro',

                isTrial: false,
                environment,
                productId,
                entitlementSource:
                    productClassification.accessSource,
                isRecurring: false,
                isLifetime: true,
                transactionId:
                    transaction.transactionId ?? null,
                originalTransactionId:
                    transaction.originalTransactionId ?? null,
                appAccountToken:
                    transaction.appAccountToken ?? null,
                purchaseDate:
                    Number(transaction.purchaseDate) || null,
                originalPurchaseDate:
                    Number(transaction.originalPurchaseDate) || null,
                expiresDate: null,
                offerType:
                    transaction.offerType ?? null,
                offerIdentifier:
                    transaction.offerIdentifier ?? null,
                offerDiscountType:
                    transaction.offerDiscountType ?? null,
                transactionReason:
                    transaction.transactionReason ?? null,
                signedDate:
                    Number(transaction.signedDate) || null,
            };
        }

        const expirationTimestamp = Number(transaction.expiresDate);

        if (
            !Number.isFinite(expirationTimestamp) ||
            expirationTimestamp <= Date.now()
        ) {
            return {
                isVerifiedPro: false,
                reason: 'expired_subscription',
                environment,
                productId,
                entitlementSource:
                    productClassification.accessSource,
                isRecurring: true,
                isLifetime: false,
                transactionId:
                    transaction.transactionId ?? null,
                originalTransactionId:
                    transaction.originalTransactionId ?? null,
                appAccountToken:
                    transaction.appAccountToken ?? null,
                expiresDate: Number.isFinite(expirationTimestamp)
                    ? expirationTimestamp
                    : null,
            };
        }

        const isTrial = isFreeTrialTransaction(transaction);

        return {
            isVerifiedPro: true,
            reason: 'verified_active_subscription',
            analyticsAccessTier: isTrial ? 'trial' : 'paid_pro',
            isTrial,
            environment,
            productId,
            entitlementSource:
                productClassification.accessSource,
            isRecurring: true,
            isLifetime: false,
            transactionId:
                transaction.transactionId ?? null,
            originalTransactionId:
                transaction.originalTransactionId ?? null,
            appAccountToken:
                transaction.appAccountToken ?? null,
            purchaseDate:
                Number(transaction.purchaseDate) || null,
            originalPurchaseDate:
                Number(transaction.originalPurchaseDate) || null,
            expiresDate: expirationTimestamp,
            offerType:
                transaction.offerType ?? null,
            offerIdentifier:
                transaction.offerIdentifier ?? null,
            offerDiscountType:
                transaction.offerDiscountType ?? null,
            transactionReason:
                transaction.transactionReason ?? null,
            signedDate:
                Number(transaction.signedDate) || null,
        };
    } catch (error) {
        console.warn(
            '[AppStoreVerification] Transaction verification failed:',
            error instanceof Error
                ? error.message
                : String(error)
        );

        return {
            isVerifiedPro: false,
            reason: 'invalid_transaction_proof',
        };
    }
}

export {
    AGORA_PRO_LIFETIME_PRODUCT_ID,
    AGORA_PRO_PRODUCT_IDS,
    AGORA_RECURRING_PRO_PRODUCT_IDS,
    APP_STORE_APP_APPLE_ID,
    APP_STORE_BUNDLE_ID,
};
