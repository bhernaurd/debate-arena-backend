import express from 'express';

import {
    listEligibleRankedPhilosophers,
} from './lib/rankedPhilosopherCatalog.js';
import {
    rankedFreeAccessPolicy,
    RankedFreeAccessPolicyError,
} from './lib/rankedFreeAccessPolicy.js';

const RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION = 1;
const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

function asyncRoute(handler) {
    return function rankedAccessAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function routeError(code, message, { status = 400, retryable = false } = {}) {
    const error = new Error(message);
    error.name = 'RankedAccessRouteError';
    error.code = code;
    error.status = status;
    error.retryable = retryable;
    return error;
}

function requireInstallationId(req) {
    const value = req.get('X-Installation-ID');

    if (typeof value !== 'string' || !value.trim()) {
        throw routeError(
            'missing_installation_id',
            'X-Installation-ID header is required.'
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
        throw routeError(
            'missing_access_token',
            'A Bearer access token is required.',
            { status: 401 }
        );
    }

    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(authorization.trim());

    if (!match) {
        throw routeError(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }

    return match[1];
}

function optionalTimeZone(req) {
    const value = req.body?.timezone;

    if (value == null) {
        return null;
    }

    if (typeof value !== 'string' || value.length > 100) {
        throw routeError(
            'invalid_ranked_timezone',
            'The device time zone is invalid.'
        );
    }

    return value.trim() || null;
}

function requireBodyText(req, fieldName, maximumLength) {
    const value = req.body?.[fieldName];

    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximumLength
    ) {
        throw routeError(
            'invalid_ranked_access_request',
            `${fieldName} is invalid.`
        );
    }

    return value.trim();
}

function publicError(error) {
    if (
        error instanceof RankedFreeAccessPolicyError ||
        error?.name === 'RankedAccessRouteError'
    ) {
        return {
            status: Number.isInteger(error.status)
                ? error.status
                : 500,
            body: {
                error: {
                    code: error.code || 'ranked_access_request_failed',
                    message:
                        error.message ||
                        'Ranked access could not be verified.',
                    retryable: Boolean(error.retryable),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'ranked_access_unavailable',
                message: 'Ranked access is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

export function createRankedPhilosopherEligibilityRouter() {
    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.get(
        '/philosophers',
        (_req, res) => {
            const philosophers =
                listEligibleRankedPhilosophers();

            return res.status(200).json({
                success: true,
                schemaVersion:
                    RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION,
                philosopherIds:
                    philosophers.map(
                        (philosopher) => philosopher.id
                    ),
                philosophers,
                generatedAt:
                    new Date().toISOString(),
            });
        }
    );

    // Authenticated Ranked access metadata used by the app to present the
    // free-vs-Pro ladder experience. Placement trials are intentionally not
    // restricted by this policy.
    router.post(
        '/access',
        asyncRoute(async (req, res) => {
            const result =
                await rankedFreeAccessPolicy
                    .authorizeAndGetAccess({
                        installationId:
                            requireInstallationId(req),
                        accessToken:
                            requireBearerToken(req),
                        timezone:
                            optionalTimeZone(req),
                    });

            return res.status(200).json({
                success: true,
                schemaVersion:
                    RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION,
                accountId: result.accountId,
                installationId: result.installationId,
                access: result.access,
            });
        })
    );

    // This router is mounted before the existing ladder router. Reserve the
    // free daily start here, then pass the request through unchanged to the
    // battle-tested ladder service. Pro accounts pass through without a daily
    // reservation. The reservation itself is idempotent by requestId.
    router.post(
        '/ladder/start',
        asyncRoute(async (req, _res, next) => {
            await rankedFreeAccessPolicy
                .authorizeAndReserveLadderStart({
                    installationId:
                        requireInstallationId(req),
                    accessToken:
                        requireBearerToken(req),
                    requestId:
                        requireBodyText(
                            req,
                            'requestId',
                            64
                        ),
                    philosopherId:
                        requireBodyText(
                            req,
                            'philosopherId',
                            100
                        ),
                    timezone:
                        optionalTimeZone(req),
                });

            next();
        })
    );

    router.use((error, req, res, next) => {
        if (
            !(error instanceof RankedFreeAccessPolicyError) &&
            error?.name !== 'RankedAccessRouteError'
        ) {
            return next(error);
        }

        const response = publicError(error);

        if (response.status >= 500) {
            console.error(
                '[RankedAccess] Request failed.',
                {
                    method: req.method,
                    path: req.originalUrl ?? req.url,
                    code: error?.code ?? 'unknown_error',
                    message: error?.message ?? 'Unknown error',
                }
            );
        }

        return res
            .status(response.status)
            .json(response.body);
    });

    return router;
}

export const rankedPhilosopherEligibilityConstants =
    Object.freeze({
        schemaVersion:
            RANKED_PHILOSOPHER_ELIGIBILITY_SCHEMA_VERSION,
    });
