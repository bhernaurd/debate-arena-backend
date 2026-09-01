import express from 'express';

import { AccountAuthError } from './lib/accountAuthService.js';
import {
    GoogleOidcPushVerificationError,
    createGoogleOidcPushVerifier,
} from './lib/googleOidcPushVerifier.js';
import {
    GooglePlayRtdnError,
    createGooglePlayRtdnService,
} from './lib/googlePlayRtdnService.js';
import {
    GooglePlaySubscriptionError,
} from './lib/googlePlaySubscriptionService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const MAX_PUBSUB_DATA_LENGTH = 131_072;
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

function requireGooglePushBearerToken(req) {
    const authorization = req.get('Authorization');
    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_google_push_token',
            'Google push authentication is required.',
            { status: 401 }
        );
    }

    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
    if (!match || match[1].length > MAX_AUTHORIZATION_HEADER_LENGTH) {
        fail(
            'invalid_google_push_token',
            'Invalid Google push authentication token.',
            { status: 401 }
        );
    }

    return match[1];
}

function decodeGooglePlayNotification(body) {
    const encoded = body?.message?.data;
    if (
        typeof encoded !== 'string' ||
        encoded.length === 0 ||
        encoded.length > MAX_PUBSUB_DATA_LENGTH
    ) {
        fail(
            'invalid_google_play_rtdn',
            'Google Play notification payload is invalid.',
            { status: 400 }
        );
    }

    try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Notification is not an object.');
        }
        return parsed;
    } catch {
        fail(
            'invalid_google_play_rtdn',
            'Google Play notification payload is invalid.',
            { status: 400 }
        );
    }
}

function routeError(error) {
    if (
        error instanceof GooglePlaySubscriptionError ||
        error instanceof GooglePlaySubscriptionRouteError ||
        error instanceof GoogleOidcPushVerificationError ||
        error instanceof GooglePlayRtdnError ||
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
    googleOidcPushVerifier = createGoogleOidcPushVerifier(),
    googlePlayRtdnService = null,
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

    if (
        !googleOidcPushVerifier ||
        typeof googleOidcPushVerifier.verifyBearerToken !== 'function'
    ) {
        throw new Error(
            'Google Play subscription routes require googleOidcPushVerifier.verifyBearerToken().'
        );
    }

    const rtdnService =
        googlePlayRtdnService ||
        createGooglePlayRtdnService({
            googlePlaySubscriptionService,
        });

    if (
        !rtdnService ||
        typeof rtdnService.processNotification !== 'function'
    ) {
        throw new Error(
            'Google Play subscription routes require googlePlayRtdnService.processNotification().'
        );
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    // Google Cloud Pub/Sub authenticated push endpoint for Play RTDN. The push
    // JWT authenticates Google; the base64 message only identifies a state
    // change. Entitlement is always re-read from subscriptionsv2.get.
    router.post('/rtdn', async (req, res) => {
        try {
            const pushToken = requireGooglePushBearerToken(req);
            await googleOidcPushVerifier.verifyBearerToken(pushToken);

            const notification = decodeGooglePlayNotification(req.body);
            const result = await rtdnService.processNotification(notification);

            if (
                logger &&
                typeof logger.info === 'function' &&
                result?.processed
            ) {
                logger.info(
                    '[GooglePlaySubscriptions] RTDN refreshed entitlement.',
                    {
                        notificationType: result.notificationType,
                        isPro: Boolean(result.entitlement?.isPro),
                    }
                );
            }

            // 204 acknowledges Pub/Sub. Test, unsupported, and not-yet-claimed
            // purchases are intentionally acknowledged too; the Android purchase
            // callback remains the ownership-claim path for first-ever purchases.
            return res.status(204).end();
        } catch (error) {
            const response = routeError(error);

            if (
                logger &&
                typeof logger.error === 'function'
            ) {
                logger.error(
                    '[GooglePlaySubscriptions] RTDN processing failed.',
                    {
                        errorCode:
                            error?.code ||
                            'google_play_rtdn_processing_failed',
                        retryable: response.body.retryable,
                    }
                );
            }

            return res
                .status(response.status)
                .json(response.body);
        }
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
