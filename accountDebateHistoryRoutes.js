import express from 'express';

import {
    AccountDebateHistoryError,
} from './lib/accountDebateHistoryService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AccountDebateHistoryRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'AccountDebateHistoryRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountDebateHistoryRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountDebateHistoryAsyncRoute(
        req,
        res,
        next
    ) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function requireJsonObject(req) {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail(
            'invalid_debate_history_payload',
            'A JSON object body is required.',
            { status: 400 }
        );
    }

    return body;
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


function requireSavedDebateId(value) {
    if (
        typeof value !== 'string' ||
        !UUID_RE.test(value.trim())
    ) {
        fail(
            'invalid_saved_debate_id',
            'The SavedDebate id is invalid.',
            { status: 400 }
        );
    }

    return value.trim().toLowerCase();
}

function optionalQueryString(
    value,
    fieldName,
    maximumLength
) {
    if (value == null) return null;

    if (
        typeof value !== 'string' ||
        value.length > maximumLength
    ) {
        fail(
            'invalid_debate_history_query',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (!cleaned) {
        fail(
            'invalid_debate_history_query',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function serializeDate(value) {
    if (value instanceof Date) return value.toISOString();

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            'Debate-history service returned an invalid date.'
        );
    }

    return date.toISOString();
}

function publicError(error) {
    if (error?.type === 'entity.too.large') {
        return {
            status: 413,
            body: {
                error: {
                    code: 'debate_history_payload_too_large',
                    message:
                        'The debate-history upload is too large.',
                    retryable: false,
                },
            },
        };
    }

    if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
        return {
            status: 400,
            body: {
                error: {
                    code: 'invalid_debate_history_json',
                    message: 'The request body is not valid JSON.',
                    retryable: false,
                },
            },
        };
    }

    if (
        error instanceof AccountDebateHistoryError ||
        error instanceof AccountDebateHistoryRouteError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 500;

        if (status >= 500) {
            return {
                status: 503,
                body: {
                    error: {
                        code: 'debate_history_sync_unavailable',
                        message:
                            'Debate history is temporarily unavailable.',
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
                        'debate_history_sync_failed',
                    message:
                        error.message ||
                        'Debate history could not be synchronized.',
                    retryable: Boolean(error.retryable),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'debate_history_sync_unavailable',
                message:
                    'Debate history is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function logUnexpectedError(logger, error, req) {
    const status = Number.isInteger(error?.status)
        ? error.status
        : 500;

    if (
        status < 500 ||
        !logger ||
        typeof logger.error !== 'function'
    ) {
        return;
    }

    // Never log debate messages, topics, reports, access tokens, or request
    // bodies. Only operational metadata and the sanitized error code are kept.
    logger.error('[AccountDebateHistory] Request failed.', {
        method: req.method,
        path: req.originalUrl ?? req.url,
        errorName: error?.name ?? 'Error',
        errorCode: error?.code ?? 'unknown_error',
    });
}

export function createAccountDebateHistoryRouter({
    service,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service.syncDebates !== 'function' ||
        typeof service.listDebates !== 'function' ||
        typeof service.deleteDebate !== 'function'
    ) {
        throw new Error(
            'A valid account debate-history service is required.'
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
        '/debates',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);

            const result = await service.listDebates({
                installationId,
                accessToken,
                limit: optionalQueryString(
                    req.query.limit,
                    'limit',
                    3
                ),
                cursor: optionalQueryString(
                    req.query.cursor,
                    'cursor',
                    512
                ),
            });

            return res.status(200).json({
                success: true,
                schemaVersion: result.schemaVersion,
                accountId: result.accountId,
                installationId: result.installationId,
                downloadedAt: serializeDate(
                    result.downloadedAt
                ),
                debates: result.debates,
                deletedDebateIds:
                    result.deletedDebateIds ?? [],
                nextCursor: result.nextCursor,
                hasMore: result.hasMore,
            });
        })
    );

    router.delete(
        '/debates/:savedDebateId',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);
            const savedDebateId = requireSavedDebateId(
                req.params.savedDebateId
            );

            const result = await service.deleteDebate({
                installationId,
                accessToken,
                savedDebateId,
            });

            return res.status(200).json({
                success: true,
                accountId: result.accountId,
                installationId: result.installationId,
                savedDebateId: result.savedDebateId,
                deleted: result.deleted,
                deletedAt: serializeDate(result.deletedAt),
            });
        })
    );

    router.post(
        '/debates/sync',
        asyncRoute(async (req, res) => {
            const body = requireJsonObject(req);
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);

            const result = await service.syncDebates({
                installationId,
                accessToken,
                schemaVersion: body.schemaVersion,
                debates: body.debates,
            });

            return res.status(200).json({
                success: true,
                accountId: result.accountId,
                installationId: result.installationId,
                syncedAt: serializeDate(result.syncedAt),
                results: result.results.map((item) => ({
                    savedDebateId: item.savedDebateId,
                    status: item.status,
                    contentUpdatedAt: serializeDate(
                        item.contentUpdatedAt
                    ),
                    lastSyncedAt: serializeDate(
                        item.lastSyncedAt
                    ),
                })),
            });
        })
    );

    router.use((error, req, res, _next) => {
        logUnexpectedError(logger, error, req);
        const response = publicError(error);
        return res.status(response.status).json(response.body);
    });

    return router;
}
