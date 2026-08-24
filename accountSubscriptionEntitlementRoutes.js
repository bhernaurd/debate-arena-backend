import express from 'express';

import { AccountAuthError } from './lib/accountAuthService.js';
import { AccountProAccessError } from './lib/accountProAccessService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

class AccountSubscriptionEntitlementRouteError extends Error {
    constructor(code, message, { status = 400, retryable = false } = {}) {
        super(message);
        this.name = 'AccountSubscriptionEntitlementRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountSubscriptionEntitlementRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountSubscriptionEntitlementAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
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

    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
        authorization.trim()
    );

    if (!match) {
        fail(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }

    return match[1];
}

function serializeDate(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error('The Pro entitlement service returned an invalid date.');
    }

    return date.toISOString();
}

function responseBody(result) {
    const entitlement = result.entitlement;

    return {
        hasProAccess: Boolean(result.hasProAccess),
        accountId: result.accountId,
        checkedAt: serializeDate(result.checkedAt),
        entitlement: entitlement
            ? {
                originalTransactionId: entitlement.originalTransactionId,
                environment: entitlement.environment,
                productId: entitlement.productId,
                status: entitlement.status,
                entitlementSource: entitlement.entitlementSource,
                isRecurring: Boolean(entitlement.isRecurring),
                isLifetime: Boolean(entitlement.isLifetime),
                isTrial: Boolean(entitlement.isTrial),
                accessExpiresAt: serializeDate(entitlement.accessExpiresAt),
                expiresAt: serializeDate(entitlement.expiresAt),
                gracePeriodExpiresAt: serializeDate(
                    entitlement.gracePeriodExpiresAt
                ),
                lastSignedAt: serializeDate(entitlement.lastSignedAt),
            }
            : null,
    };
}

function publicError(error) {
    if (
        error instanceof AccountAuthError ||
        error instanceof AccountProAccessError ||
        error instanceof AccountSubscriptionEntitlementRouteError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 500;

        if (status >= 500) {
            return {
                status: 503,
                body: {
                    error: {
                        code: 'account_subscription_entitlement_unavailable',
                        message:
                            'Agora Pro access could not be verified right now.',
                        retryable: true,
                    },
                },
            };
        }

        return {
            status,
            body: {
                error: {
                    code: error.code ?? 'account_subscription_entitlement_failed',
                    message:
                        error.message ||
                        'Agora Pro access could not be verified.',
                    retryable: Boolean(error.retryable),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'account_subscription_entitlement_unavailable',
                message:
                    'Agora Pro access could not be verified right now.',
                retryable: true,
            },
        },
    };
}

export function createAccountSubscriptionEntitlementRouter({
    accountAuthService,
    proAccessService,
    logger = console,
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'Account subscription entitlement routes require accountAuthService.authorizeAccessToken().'
        );
    }

    if (
        !proAccessService ||
        typeof proAccessService.getCurrentAccess !== 'function'
    ) {
        throw new Error(
            'Account subscription entitlement routes require proAccessService.getCurrentAccess().'
        );
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.get(
        '/entitlement',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);

            const authorization =
                await accountAuthService.authorizeAccessToken({
                    installationId,
                    accessToken,
                });

            const result = await proAccessService.getCurrentAccess({
                accountId: authorization.accountId,
            });

            return res.status(200).json(responseBody(result));
        })
    );

    router.use((error, req, res, _next) => {
        const status = Number.isInteger(error?.status)
            ? error.status
            : 500;

        if (
            status >= 500 &&
            logger &&
            typeof logger.error === 'function'
        ) {
            logger.error('[AccountSubscriptionEntitlement] Request failed.', {
                method: req.method,
                path: req.originalUrl ?? req.url,
                errorName: error?.name ?? 'Error',
                errorCode: error?.code ?? 'unknown_error',
            });
        }

        const response = publicError(error);
        return res.status(response.status).json(response.body);
    });

    return router;
}
