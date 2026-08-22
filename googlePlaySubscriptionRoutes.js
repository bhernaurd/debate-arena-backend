import express from 'express';

import { AccountAuthError } from './lib/accountAuthService.js';
import {
    GooglePlaySubscriptionError,
} from './lib/googlePlaySubscriptionService.js';
import {
    createAccountAIJobRouter,
} from './accountAIJobRoutes.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

class GooglePlaySubscriptionRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'GooglePlaySubscriptionRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlaySubscriptionRouteError(
        code,
        message,
        options
    );
}

function requireBody(req) {
    if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
    ) {
        fail(
            'invalid_google_play_request',
            'A JSON object body is required.',
            { status: 400 }
        );
    }
    return req.body;
}

function requireInstallationId(req) {
    const value = req.get('X-Installation-ID');
    if (typeof value !== 'string' || !value.trim()) {
        fail(
            'missing_installation_id',
            'X-Installation-ID header is required.',
            { status: 400 }
        );
    }
    return value.trim();
}

function requireBearerToken(req) {
    const authorization = req.get('Authorization');
    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_access_token',
            'A Bearer access token is required.',
            { status: 401 }
        );
    }

    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(authorization.trim());
    if (!match) {
        fail(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }
    return match[1];
}

function publicError(error) {
    if (
        error instanceof GooglePlaySubscriptionRouteError ||
        error instanceof GooglePlaySubscriptionError ||
        error instanceof AccountAuthError
    ) {
        const rawStatus = Number.isInteger(error.status)
            ? error.status
            : 500;
        const status = rawStatus >= 500 ? 503 : rawStatus;
        return {
            status,
            body: {
                success: false,
                error:
                    status >= 500
                        ? 'Google Play subscription verification is temporarily unavailable.'
                        : (error.message || 'Google Play subscription verification failed.'),
                errorCode:
                    status >= 500
                        ? 'google_play_unavailable'
                        : (error.code || 'google_play_verification_failed'),
                retryable:
                    status >= 500 || Boolean(error.retryable),
            },
        };
    }

    return {
        status: 503,
        body: {
            success: false,
            error:
                'Google Play subscription verification is temporarily unavailable.',
            errorCode: 'google_play_unavailable',
            retryable: true,
        },
    };
}

export function createGooglePlaySubscriptionRouter({
    service,
    accountAuthService,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service.syncPurchase !== 'function'
    ) {
        throw new Error(
            'Google Play subscription service is required.'
        );
    }
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    const router = express.Router();

    // Android account-authenticated AI creation reuses the existing persistent
    // ai_generation_jobs table and processor. The legacy /api/ai-jobs iOS path
    // remains unchanged.
    router.use(
        createAccountAIJobRouter({
            accountAuthService,
            logger,
        })
    );

    // Mounted inside /api/account by server.js through createAccountAuthRouter().
    router.post(
        '/google-play/sync-purchase',
        async (req, res) => {
            try {
                const body = requireBody(req);
                const installationId =
                    requireInstallationId(req);
                const accessToken =
                    requireBearerToken(req);
                const authorization =
                    await accountAuthService.authorizeAccessToken({
                        installationId,
                        accessToken,
                    });

                const result = await service.syncPurchase({
                    accountId: authorization.accountId,
                    packageName: body.packageName,
                    purchaseToken: body.purchaseToken,
                    productId: body.productId,
                    basePlanId: body.basePlanId ?? null,
                    offerId: body.offerId ?? null,
                    pricingCohortHint:
                        body.pricingCohortHint ?? 'unknown',
                    paywallSessionId:
                        body.paywallSessionId ?? null,
                });

                return res.status(200).json({
                    success: true,
                    acknowledged:
                        result.acknowledged === true,
                    accountOwnership: {
                        linked: true,
                        accountId:
                            authorization.accountId,
                        migratedLegacyOwnership: false,
                        claimSource:
                            'google_play_obfuscated_account_id',
                    },
                    entitlement: {
                        isPro:
                            result.entitlement.isPro === true,
                        productId:
                            result.entitlement.productId,
                        basePlanId:
                            result.entitlement.basePlanId ?? null,
                        offerId:
                            result.entitlement.offerId ?? null,
                        subscriptionState:
                            result.entitlement.subscriptionState,
                        expiryTime:
                            result.entitlement.expiryTime
                                ?.toISOString?.() ?? null,
                        inFreeTrial:
                            result.entitlement.inFreeTrial ?? null,
                    },
                });
            } catch (error) {
                const response = publicError(error);
                if (
                    response.status >= 500 &&
                    logger &&
                    typeof logger.error === 'function'
                ) {
                    logger.error(
                        '[GooglePlay] Subscription sync failed.',
                        {
                            code: error?.code ?? null,
                            message:
                                error?.message ?? String(error),
                        }
                    );
                }
                return res
                    .status(response.status)
                    .json(response.body);
            }
        }
    );

    return router;
}
