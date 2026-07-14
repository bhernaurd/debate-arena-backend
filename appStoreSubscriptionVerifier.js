import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    Environment,
    SignedDataVerifier,
} from '@apple/app-store-server-library';

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = dirname(currentFilePath);

const APP_STORE_BUNDLE_ID =
    process.env.APP_STORE_BUNDLE_ID?.trim() ||
    'com.bhernaurd.TheAgora';

const APP_STORE_APP_APPLE_ID = Number(
    process.env.APP_STORE_APP_APPLE_ID?.trim() ||
    '6762416967'
);

const AGORA_PRO_PRODUCT_IDS = new Set([
    'agora_pro_monthly',
    'agora_pro_yearly',
]);

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

function readClaimedEnvironment(jws) {
    try {
        const parts = String(jws).split('.');

        if (parts.length !== 3) {
            return null;
        }

        const payloadJSON = Buffer
            .from(parts[1], 'base64url')
            .toString('utf8');

        const payload = JSON.parse(payloadJSON);

        return typeof payload.environment === 'string'
            ? payload.environment
            : null;
    } catch {
        return null;
    }
}

async function verifySignedTransaction(jws) {
    const claimedEnvironment = readClaimedEnvironment(jws);

    // The unverified environment is used only to select the verifier.
    // Access is granted only after cryptographic verification succeeds.
    if (claimedEnvironment === Environment.SANDBOX) {
        const transaction =
            await sandboxVerifier.verifyAndDecodeTransaction(jws);

        return {
            transaction,
            environment: Environment.SANDBOX,
        };
    }

    if (claimedEnvironment === Environment.PRODUCTION) {
        const transaction =
            await productionVerifier.verifyAndDecodeTransaction(jws);

        return {
            transaction,
            environment: Environment.PRODUCTION,
        };
    }

    // Fallback for an unexpected or absent environment claim.
    try {
        const transaction =
            await productionVerifier.verifyAndDecodeTransaction(jws);

        return {
            transaction,
            environment: Environment.PRODUCTION,
        };
    } catch (productionError) {
        try {
            const transaction =
                await sandboxVerifier.verifyAndDecodeTransaction(jws);

            return {
                transaction,
                environment: Environment.SANDBOX,
            };
        } catch (sandboxError) {
            const verificationError = new Error(
                'The App Store transaction could not be verified.'
            );

            verificationError.cause = {
                productionError,
                sandboxError,
            };

            throw verificationError;
        }
    }
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
            transaction,
            environment,
        } = await verifySignedTransaction(
            proTransactionJWS.trim()
        );

        const productId =
            typeof transaction.productId === 'string'
                ? transaction.productId
                : '';

        if (!AGORA_PRO_PRODUCT_IDS.has(productId)) {
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
            };
        }

        const expirationTimestamp =
            Number(transaction.expiresDate);

        if (
            !Number.isFinite(expirationTimestamp) ||
            expirationTimestamp <= Date.now()
        ) {
            return {
                isVerifiedPro: false,
                reason: 'expired_subscription',
                environment,
                productId,
                expiresDate: Number.isFinite(expirationTimestamp)
                    ? expirationTimestamp
                    : null,
            };
        }

        return {
            isVerifiedPro: true,
            reason: 'verified_active_subscription',
            environment,
            productId,
            transactionId:
                transaction.transactionId ?? null,
            originalTransactionId:
                transaction.originalTransactionId ?? null,
            expiresDate: expirationTimestamp,
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
