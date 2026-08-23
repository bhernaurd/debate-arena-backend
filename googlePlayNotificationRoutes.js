import express from 'express';

import {
    GoogleSignInError,
    createGoogleIdTokenVerifier,
} from './lib/googleSignIn.js';
import {
    GooglePlayNotificationError,
    createGooglePlayNotificationService,
} from './lib/googlePlayNotificationService.js';
import { GooglePlayPublisherError } from './lib/googlePlayPublisherService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const MAX_PUBSUB_DATA_LENGTH = 32_768;

class GooglePlayNotificationRouteError extends Error {
    constructor(code, message, {
        status = 400,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlayNotificationRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlayNotificationRouteError(
        code,
        message,
        options
    );
}

function clean(value, maximum = 4096) {
    if (typeof value !== 'string') return '';
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return '';
    return cleaned;
}

function asyncRoute(handler) {
    return function googlePlayNotificationAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function requireBearerToken(req) {
    const authorization = req.get('Authorization');
    if (
        typeof authorization !== 'string' ||
        authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_google_pubsub_identity',
            'Google Pub/Sub authentication is required.',
            { status: 401 }
        );
    }

    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
        authorization.trim()
    );
    if (!match) {
        fail(
            'invalid_google_pubsub_identity',
            'Google Pub/Sub authentication could not be verified.',
            { status: 401 }
        );
    }
    return match[1];
}

function constantTimeEmailEqual(left, right) {
    const a = Buffer.from(String(left ?? '').trim().toLowerCase(), 'utf8');
    const b = Buffer.from(String(right ?? '').trim().toLowerCase(), 'utf8');
    return a.length === b.length &&
        a.length > 0 &&
        cryptoTimingSafeEqual(a, b);
}

function cryptoTimingSafeEqual(left, right) {
    // Keep the crypto import surface out of route parsing until needed.
    // Buffer equality is only attempted after equal-length validation above.
    return left.equals(right);
}

function decodePubSubPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null;
    }
    const message = body.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return null;
    }
    const data = clean(message.data, MAX_PUBSUB_DATA_LENGTH);
    if (
        !data ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    ) {
        return null;
    }

    let payload;
    try {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        if (!decoded || Buffer.byteLength(decoded, 'utf8') > 16_384) {
            return null;
        }
        payload = JSON.parse(decoded);
    } catch {
        return null;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
    }
    if (payload.testNotification) {
        return Object.freeze({ testNotification: true });
    }

    const subscription = payload.subscriptionNotification;
    const packageName = clean(payload.packageName, 255);
    const purchaseToken = clean(subscription?.purchaseToken, 4096);
    const subscriptionId = clean(subscription?.subscriptionId, 200);

    if (!packageName || !purchaseToken) return null;
    return Object.freeze({
        testNotification: false,
        packageName,
        purchaseToken,
        subscriptionId: subscriptionId || null,
        notificationType:
            Number.isSafeInteger(Number(subscription?.notificationType))
                ? Number(subscription.notificationType)
                : null,
        messageId: clean(message.messageId, 255) || null,
    });
}

function publicFailure(error) {
    if (error instanceof GooglePlayNotificationRouteError) {
        return {
            status: error.status,
            body: {
                error: {
                    code: error.code,
                    message: error.message,
                    retryable: Boolean(error.retryable),
                },
            },
        };
    }

    if (
        error instanceof GooglePlayNotificationError ||
        error instanceof GooglePlayPublisherError ||
        error instanceof GoogleSignInError
    ) {
        // Pub/Sub should retry verified notifications whenever our own database,
        // Google OIDC verification infrastructure, or Play Developer API is
        // unavailable. Logical/malformed notification payloads are acknowledged
        // before reaching this error path.
        return {
            status: 503,
            body: {
                error: {
                    code: 'google_play_notification_unavailable',
                    message:
                        'Google Play notification processing is temporarily unavailable.',
                    retryable: true,
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'google_play_notification_unavailable',
                message:
                    'Google Play notification processing is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

export function createGooglePlayNotificationRouter(
    pool,
    {
        notificationService = null,
        verifyOidcToken = null,
        audience = process.env.GOOGLE_PLAY_RTDN_AUDIENCE ?? '',
        serviceAccountEmail =
            process.env.GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL ?? '',
        logger = console,
    } = {}
) {
    const expectedAudience = clean(audience, 2048);
    const expectedServiceAccountEmail = clean(
        serviceAccountEmail,
        320
    ).toLowerCase();
    let verifier = verifyOidcToken;
    let service = notificationService;

    function resolvedVerifier() {
        if (!expectedAudience || !expectedServiceAccountEmail) {
            fail(
                'google_play_rtdn_not_configured',
                'Google Play notification authentication is not configured.',
                { status: 503, retryable: false }
            );
        }
        if (!verifier) {
            verifier = createGoogleIdTokenVerifier({
                clientId: expectedAudience,
            });
        }
        return verifier;
    }

    function resolvedService() {
        if (!service) {
            service = createGooglePlayNotificationService({
                pool,
                logger,
            });
        }
        return service;
    }

    async function authenticate(req) {
        const token = requireBearerToken(req);
        let identity;
        try {
            identity = await resolvedVerifier()(token);
        } catch (error) {
            if (error instanceof GooglePlayNotificationRouteError) {
                throw error;
            }
            if (error instanceof GoogleSignInError) {
                if (error.status >= 500 || error.retryable) {
                    throw error;
                }
                fail(
                    'invalid_google_pubsub_identity',
                    'Google Pub/Sub authentication could not be verified.',
                    { status: 401, cause: error }
                );
            }
            throw error;
        }

        if (
            identity?.emailVerified !== true ||
            !constantTimeEmailEqual(
                identity.email,
                expectedServiceAccountEmail
            )
        ) {
            fail(
                'invalid_google_pubsub_identity',
                'Google Pub/Sub authentication could not be verified.',
                { status: 401 }
            );
        }
        return identity;
    }

    const router = express.Router();

    router.post(
        '/notifications',
        asyncRoute(async (req, res) => {
            await authenticate(req);
            const notification = decodePubSubPayload(req.body);

            // Authenticated but malformed/test/unsupported messages are
            // acknowledged so Pub/Sub does not retry a payload that cannot
            // become valid. No entitlement mutation occurs.
            if (!notification) {
                logger?.warn?.(
                    '[GooglePlayRTDN] Ignored malformed authenticated notification.'
                );
                return res.status(204).end();
            }
            if (notification.testNotification) {
                return res.status(204).end();
            }

            const result = await resolvedService()
                .processSubscriptionNotification({
                    packageName: notification.packageName,
                    purchaseToken: notification.purchaseToken,
                    subscriptionId: notification.subscriptionId,
                });

            if (!result.processed) {
                logger?.warn?.(
                    '[GooglePlayRTDN] Notification did not mutate entitlement.',
                    {
                        reason: result.reason,
                        messageId: notification.messageId,
                    }
                );
            }

            return res.status(204).end();
        })
    );

    router.use((error, req, res, _next) => {
        const response = publicFailure(error);
        if (response.status >= 500) {
            logger?.error?.(
                '[GooglePlayRTDN] Request failed.',
                {
                    method: req.method,
                    path: req.originalUrl ?? req.url,
                    errorCode: error?.code ?? 'unknown_error',
                }
            );
        }
        return res.status(response.status).json(response.body);
    });

    return router;
}
