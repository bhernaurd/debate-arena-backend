import express from 'express';

import {
    AccountAchievementError,
} from './lib/accountAchievementService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

class AccountAchievementRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name =
            'AccountAchievementRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAchievementRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountAchievementAsyncRoute(
        req,
        res,
        next
    ) {
        Promise.resolve(
            handler(req, res, next)
        ).catch(next);
    };
}

function requireJsonObject(req) {
    const body = req.body;

    if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body)
    ) {
        fail(
            'invalid_achievement_payload',
            'A JSON object body is required.',
            { status: 400 }
        );
    }

    return body;
}

function requireInstallationId(req) {
    const value = req.get(
        'X-Installation-ID'
    );

    if (
        typeof value !== 'string' ||
        !value.trim()
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
    const authorization = req.get(
        'Authorization'
    );

    if (
        typeof authorization !== 'string' ||
        authorization.length >
            MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_access_token',
            'A Bearer access token is required.',
            { status: 401 }
        );
    }

    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(
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
    if (value instanceof Date) {
        return value.toISOString();
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            'Achievement service returned an invalid date.'
        );
    }

    return date.toISOString();
}

function publicError(error) {
    if (
        error?.type ===
        'entity.too.large'
    ) {
        return {
            status: 413,
            body: {
                error: {
                    code:
                        'achievement_payload_too_large',
                    message:
                        'The achievement sync payload is too large.',
                    retryable: false,
                },
            },
        };
    }

    if (
        error instanceof SyntaxError &&
        error?.type ===
            'entity.parse.failed'
    ) {
        return {
            status: 400,
            body: {
                error: {
                    code:
                        'invalid_achievement_json',
                    message:
                        'The request body is not valid JSON.',
                    retryable: false,
                },
            },
        };
    }

    if (
        error instanceof
            AccountAchievementError ||
        error instanceof
            AccountAchievementRouteError
    ) {
        const status =
            Number.isInteger(
                error.status
            )
                ? error.status
                : 500;

        if (status >= 500) {
            return {
                status: 503,
                body: {
                    error: {
                        code:
                            'achievement_sync_unavailable',
                        message:
                            'Achievement unlocks are temporarily unavailable.',
                        retryable: true,
                    },
                },
            };
        }

        return {
            status,
            body: {
                error: {
                    code:
                        error.code ||
                        'achievement_sync_failed',
                    message:
                        error.message ||
                        'Achievement unlocks could not be synchronized.',
                    retryable:
                        Boolean(
                            error.retryable
                        ),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code:
                    'achievement_sync_unavailable',
                message:
                    'Achievement unlocks are temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function logUnexpectedError(
    logger,
    error,
    req
) {
    const status =
        Number.isInteger(
            error?.status
        )
            ? error.status
            : 500;

    if (
        status < 500 ||
        !logger ||
        typeof logger.error !==
            'function'
    ) {
        return;
    }

    // Never log access tokens or request bodies.
    logger.error(
        '[AccountAchievements] Request failed.',
        {
            method: req.method,
            path:
                req.originalUrl ??
                req.url,
            errorName:
                error?.name ??
                'Error',
            errorCode:
                error?.code ??
                'unknown_error',
        }
    );
}

export function createAccountAchievementRouter({
    service,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service.syncUnlocks !==
            'function'
    ) {
        throw new Error(
            'A valid account achievement service is required.'
        );
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader(
            'Cache-Control',
            'no-store'
        );
        res.setHeader(
            'Pragma',
            'no-cache'
        );
        res.setHeader(
            'X-Content-Type-Options',
            'nosniff'
        );
        next();
    });

    router.post(
        '/sync',
        asyncRoute(
            async (req, res) => {
                const body =
                    requireJsonObject(
                        req
                    );
                const installationId =
                    requireInstallationId(
                        req
                    );
                const accessToken =
                    requireBearerToken(
                        req
                    );

                const result =
                    await service
                        .syncUnlocks({
                            installationId,
                            accessToken,
                            schemaVersion:
                                body.schemaVersion,
                            records:
                                body.records,
                        });

                return res
                    .status(200)
                    .json({
                        success: true,
                        accountId:
                            result.accountId,
                        installationId:
                            result.installationId,
                        syncedAt:
                            serializeDate(
                                result.syncedAt
                            ),
                        submittedCount:
                            result
                                .submittedCount,
                        records:
                            result.records.map(
                                (record) => ({
                                    achievementId:
                                        record
                                            .achievementId,
                                    unlockedAt:
                                        serializeDate(
                                            record
                                                .unlockedAt
                                        ),
                                    lastSyncedAt:
                                        serializeDate(
                                            record
                                                .lastSyncedAt
                                        ),
                                })
                            ),
                    });
            }
        )
    );

    router.use(
        (error, req, res, _next) => {
            logUnexpectedError(
                logger,
                error,
                req
            );
            const response =
                publicError(error);

            return res
                .status(response.status)
                .json(response.body);
        }
    );

    return router;
}
