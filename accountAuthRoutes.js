import express from 'express';

import {
    AccountAuthError,
    createAccountAuthService,
} from './lib/accountAuthService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const SIGN_OUT_REASON = 'signed_out';

class AccountAuthRouteError extends Error {
    constructor(code, message, { status = 400, retryable = false } = {}) {
        super(message);
        this.name = 'AccountAuthRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountAuthRouteError(code, message, options);
}

function asyncRoute(handler) {
    return function accountAuthAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function requireJsonObject(req) {
    const body = req.body;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        fail('invalid_request', 'A JSON object body is required.', {
            status: 400,
        });
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

function optionalHeader(req, name) {
    const value = req.get(name);

    if (typeof value !== 'string') return null;

    const cleaned = value.trim();
    return cleaned || null;
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

function requestMetadata(req) {
    return {
        installationId: requireInstallationId(req),
        iosVersion: optionalHeader(req, 'X-iOS-Version'),
        iosBuild: optionalHeader(req, 'X-iOS-Build'),
        ipAddress: req.ip ?? req.socket?.remoteAddress ?? null,
        userAgent: optionalHeader(req, 'User-Agent'),
    };
}

function serializeDate(value) {
    if (value == null) return null;

    if (value instanceof Date) {
        return value.toISOString();
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error('Authentication service returned an invalid date.');
    }

    return date.toISOString();
}

function signInResponse(result) {
    return {
        account: {
            id: result.account.id,
            status: result.account.status,
            authVersion: result.account.authVersion,
            displayName: result.account.displayName ?? null,
            isNewAccount: Boolean(result.account.isNewAccount),
        },
        session: {
            id: result.session.id,
            expiresAt: serializeDate(result.session.expiresAt),
        },
        tokenType: 'Bearer',
        accessToken: result.accessToken,
        accessTokenExpiresAt: serializeDate(
            result.accessTokenExpiresAt
        ),
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: serializeDate(
            result.session.expiresAt
        ),
    };
}

function refreshResponse(result) {
    return {
        account: {
            id: result.accountId,
        },
        session: {
            id: result.session.id,
            expiresAt: serializeDate(result.session.expiresAt),
        },
        tokenType: 'Bearer',
        accessToken: result.accessToken,
        accessTokenExpiresAt: serializeDate(
            result.accessTokenExpiresAt
        ),
        refreshToken: result.refreshToken,
        refreshTokenExpiresAt: serializeDate(
            result.session.expiresAt
        ),
    };
}

function authorizationResponse(result) {
    return {
        authenticated: true,
        account: {
            id: result.accountId,
            authVersion: result.authVersion,
            displayName: result.displayName ?? null,
        },
        session: {
            id: result.sessionId,
            expiresAt: serializeDate(result.sessionExpiresAt),
        },
        installationId: result.installationId,
        accessTokenExpiresAt: serializeDate(
            result.accessTokenExpiresAt
        ),
    };
}

function publicError(error) {
    if (
        error instanceof AccountAuthError ||
        error instanceof AccountAuthRouteError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 500;

        if (status >= 500) {
            return {
                status: 503,
                body: {
                    error: {
                        code: 'account_authentication_unavailable',
                        message:
                            'Account authentication is temporarily unavailable.',
                        retryable: true,
                    },
                },
            };
        }

        return {
            status,
            body: {
                error: {
                    code: error.code ?? 'account_authentication_failed',
                    message:
                        error.message ||
                        'Account authentication could not be completed.',
                    retryable: Boolean(error.retryable),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'account_authentication_unavailable',
                message:
                    'Account authentication is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function logUnexpectedAuthenticationError(logger, error, req) {
    if (!logger || typeof logger.error !== 'function') return;

    const status = Number.isInteger(error?.status)
        ? error.status
        : 500;

    if (status < 500) return;

    logger.error('[AccountAuth] Request failed.', {
        method: req.method,
        path: req.originalUrl ?? req.url,
        errorName: error?.name ?? 'Error',
        errorCode: error?.code ?? 'unknown_error',
    });
}

export function createPostgresAccountSessionRevoker(pool) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error(
            'A PostgreSQL pool is required for account session revocation.'
        );
    }

    return async function revokeAccountSession({
        accountId,
        sessionId,
        installationId,
        revokedAt,
    }) {
        const result = await pool.query(
            `
                /* account-auth-route:sign-out-session */
                UPDATE account_sessions AS s
                SET
                    revoked_at = $4,
                    revocation_reason = $5,
                    last_used_at = GREATEST(s.last_used_at, $4)
                FROM account_installations AS ai
                WHERE s.id = $1
                  AND s.account_id = $2
                  AND s.account_installation_id = ai.id
                  AND ai.account_id = s.account_id
                  AND ai.installation_id = $3
                  AND ai.unlinked_at IS NULL
                  AND s.revoked_at IS NULL
                RETURNING s.id
            `,
            [
                sessionId,
                accountId,
                installationId,
                revokedAt,
                SIGN_OUT_REASON,
            ]
        );

        return result.rowCount === 1;
    };
}

export function createAccountAuthRouter(
    pool,
    {
        service = null,
        revokeSession = null,
        logger = console,
        now = () => Date.now(),
    } = {}
) {
    const accountAuthService =
        service ?? createAccountAuthService({ pool });

    const revokeAccountSession =
        revokeSession ?? createPostgresAccountSessionRevoker(pool);

    const requiredServiceMethods = [
        'createAppleChallenge',
        'signInWithApple',
        'refreshSession',
        'authorizeAccessToken',
    ];

    for (const method of requiredServiceMethods) {
        if (typeof accountAuthService?.[method] !== 'function') {
            throw new Error(
                `Account authentication service is missing ${method}().`
            );
        }
    }

    if (typeof revokeAccountSession !== 'function') {
        throw new Error('revokeSession must be a function.');
    }

    if (typeof now !== 'function') {
        throw new Error('now must be a function.');
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.post(
        '/apple/challenge',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);

            const challenge =
                await accountAuthService.createAppleChallenge({
                    installationId,
                    purpose: 'sign_in_with_apple',
                });

            return res.status(201).json({
                challengeId: challenge.challengeId,
                purpose: challenge.purpose,
                rawNonce: challenge.rawNonce,
                nonceSha256: challenge.nonceSha256,
                expiresAt: serializeDate(challenge.expiresAt),
            });
        })
    );

    router.post(
        '/apple/sign-in',
        asyncRoute(async (req, res) => {
            const body = requireJsonObject(req);
            const metadata = requestMetadata(req);

            const result = await accountAuthService.signInWithApple({
                ...metadata,
                challengeId: body.challengeId,
                rawNonce: body.rawNonce,
                identityToken: body.identityToken,
                authorizationCode: body.authorizationCode,
                displayName: body.displayName ?? null,
            });

            return res
                .status(result.account.isNewAccount ? 201 : 200)
                .json(signInResponse(result));
        })
    );

    router.post(
        '/session/refresh',
        asyncRoute(async (req, res) => {
            const body = requireJsonObject(req);
            const metadata = requestMetadata(req);

            const result = await accountAuthService.refreshSession({
                ...metadata,
                refreshToken: body.refreshToken,
            });

            return res.status(200).json(refreshResponse(result));
        })
    );

    router.get(
        '/session',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);

            const result =
                await accountAuthService.authorizeAccessToken({
                    installationId,
                    accessToken,
                });

            return res.status(200).json(
                authorizationResponse(result)
            );
        })
    );

    router.post(
        '/session/sign-out',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);

            const authorization =
                await accountAuthService.authorizeAccessToken({
                    installationId,
                    accessToken,
                });

            const nowMilliseconds = now();

            if (
                !Number.isFinite(nowMilliseconds) ||
                nowMilliseconds < 0
            ) {
                throw new Error('now() returned an invalid value.');
            }

            const revoked = await revokeAccountSession({
                accountId: authorization.accountId,
                sessionId: authorization.sessionId,
                installationId,
                revokedAt: new Date(nowMilliseconds),
            });

            if (!revoked) {
                throw new AccountAuthRouteError(
                    'invalid_access_token',
                    'The access token is invalid or expired.',
                    { status: 401 }
                );
            }

            return res.status(204).end();
        })
    );

    router.use((error, req, res, _next) => {
        logUnexpectedAuthenticationError(logger, error, req);

        const response = publicError(error);

        return res.status(response.status).json(response.body);
    });

    return router;
}

export const accountAuthRouteConstants = Object.freeze({
    signOutReason: SIGN_OUT_REASON,
});
