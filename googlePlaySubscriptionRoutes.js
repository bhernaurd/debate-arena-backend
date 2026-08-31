import express from 'express';

import { AccountAuthError } from './lib/accountAuthService.js';
import {
    GooglePlaySubscriptionError,
} from './lib/googlePlaySubscriptionService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;

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

function requireInstallationId(req) {
    const value = req.get('X-Installation-ID');
    if (
        typeof value !== 'string' ||
        !INSTALLATION_ID_RE.test(value.trim())
    ) {
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

function routeError(error) {
    if (
        error instanceof GooglePlaySubscriptionError ||
        error instanceof GooglePlaySubscriptionRouteError ||
        error instanceof AccountAuthError
    ) {
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
                    'Google Play subscription verification failed.',
                errorCode:
                    error?.code ||
                    'google_play_subscription_verification_failed',
                retryable:
                    status >= 500 ||
                    Boolean(error?.retryable),
            },
        };
    }

    return {
        status: 503,
        body: {
            success: false,
            error:
                'Google Play subscription verification is temporarily unavailable.',
            errorCode:
                'google_play_subscription_verification_unavailable',
            retryable: true,
        },
    };
}

export function createGooglePlaySubscriptionRouter({
    accountAuthService,
    googlePlaySubscriptionService,
    logger = console,
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'Google Play subscription routes require accountAuthService.authorizeAccessToken().'
        );
    }

    if (
        !googlePlaySubscriptionService ||
        typeof googlePlaySubscriptionService.syncVerifiedPurchase !== 'function'
    ) {
        throw new Error(
            'Google Play subscription routes require googlePlaySubscriptionService.syncVerifiedPurchase().'
        );
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.post('/sync-purchase', async (req, res) => {
        try {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);
            const authorization =
                await accountAuthService.authorizeAccessToken({
                    installationId,
                    accessToken,
                });

            const result =
                await googlePlaySubscriptionService
                    .syncVerifiedPurchase({
                        authorization,
                        requestedPackageName:
                            req.body?.packageName,
                        purchaseToken:
                            req.body?.purchaseToken,
                        productId:
                            req.body?.productId,
                        basePlanId:
                            req.body?.basePlanId ?? null,
                        offerId:
                            req.body?.offerId ?? null,
                        pricingCohortHint:
                            req.body?.pricingCohortHint ??
                            'unknown',
                        paywallSessionId:
                            req.body?.paywallSessionId ?? null,
                    });

            return res.status(200).json({
                success: true,
                acknowledged: result.acknowledged,
                accountOwnership:
                    result.accountOwnership,
                entitlement:
                    result.entitlement,
            });
        } catch (error) {
            const response = routeError(error);

            if (
                response.status >= 500 &&
                logger &&
                typeof logger.error === 'function'
            ) {
                logger.error(
                    '[GooglePlaySubscriptions] Sync failed.',
                    {
                        errorCode:
                            error?.code ||
                            'google_play_subscription_verification_failed',
                        retryable:
                            response.body.retryable,
                    }
                );
            }

            return res
                .status(response.status)
                .json(response.body);
        }
    });

    return router;
}
