import express from 'express';

import {
    AccountRankedPlacementError,
} from './lib/accountRankedPlacementService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHILOSOPHER_ID_RE = /^[a-z][a-z0-9_-]{0,99}$/;

class AccountRankedPlacementRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'AccountRankedPlacementRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountRankedPlacementRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountRankedPlacementAsyncRoute(
        req,
        res,
        next
    ) {
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

function requireBody(req) {
    if (
        !req.body ||
        typeof req.body !== 'object' ||
        Array.isArray(req.body)
    ) {
        fail(
            'invalid_ranked_placement_request',
            'A JSON request body is required.',
            { status: 400 }
        );
    }

    return req.body;
}

function requireRequestId(body) {
    if (typeof body.requestId !== 'string') {
        fail(
            'missing_ranked_start_request_id',
            'requestId is required.',
            { status: 400 }
        );
    }

    const value = body.requestId.trim().toLowerCase();

    if (!UUID_RE.test(value)) {
        fail(
            'invalid_ranked_start_request_id',
            'requestId must be a valid UUID.',
            { status: 400 }
        );
    }

    return value;
}

function requirePhilosopherId(body) {
    if (typeof body.philosopherId !== 'string') {
        fail(
            'missing_ranked_philosopher_id',
            'philosopherId is required.',
            { status: 400 }
        );
    }

    const value = body.philosopherId.trim().toLowerCase();

    if (!PHILOSOPHER_ID_RE.test(value)) {
        fail(
            'invalid_ranked_philosopher_id',
            'philosopherId has an invalid format.',
            { status: 400 }
        );
    }

    return value;
}

function serializeDate(value, fieldName) {
    const date = value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `Ranked placement service returned an invalid ${fieldName}.`
        );
    }

    return date.toISOString();
}

function serializeOptionalDate(value, fieldName) {
    if (value == null) return null;
    return serializeDate(value, fieldName);
}

function serializeConfiguration(configuration) {
    return {
        isEnabled: configuration.isEnabled,
        allowNewDebates:
            configuration.allowNewDebates,
        allowResumeActiveDebates:
            configuration.allowResumeActiveDebates,
        placementsEnabled:
            configuration.placementsEnabled,
        rankedRulesVersion:
            configuration.rankedRulesVersion,
        philosopherPromptVersion:
            configuration.philosopherPromptVersion,
        scoringPromptVersion:
            configuration.scoringPromptVersion,
        reportPromptVersion:
            configuration.reportPromptVersion,
        topicGeneratorVersion:
            configuration.topicGeneratorVersion,
        rpFormulaVersion:
            configuration.rpFormulaVersion,
        debateModelProvider:
            configuration.debateModelProvider,
        debateModelName:
            configuration.debateModelName,
    };
}

function serializeProfile(profile) {
    return {
        accountId: profile.accountId,
        placementStatus:
            profile.placementStatus,
        placementTrialsCompleted:
            profile.placementTrialsCompleted,
        stateVersion:
            profile.stateVersion,
        updatedAt: serializeDate(
            profile.updatedAt,
            'profile.updatedAt'
        ),
    };
}

function serializePlacementTrial(trial) {
    return {
        trialNumber: trial.trialNumber,
        requiredMode: trial.requiredMode,
        weightBasisPoints:
            trial.weightBasisPoints,
        status: trial.status,
        rankedDebateId:
            trial.rankedDebateId,
        philosopherId:
            trial.philosopherId,
        philosopherName:
            trial.philosopherName,
        topicFingerprint:
            trial.topicFingerprint,
        startedAt: serializeOptionalDate(
            trial.startedAt,
            'placementTrial.startedAt'
        ),
        updatedAt: serializeDate(
            trial.updatedAt,
            'placementTrial.updatedAt'
        ),
    };
}

function serializeActiveDebate(debate) {
    return {
        id: debate.id,
        accountId: debate.accountId,
        startRequestId:
            debate.startRequestId,
        debateKind:
            debate.debateKind,
        placementTrialNumber:
            debate.placementTrialNumber,
        status: debate.status,
        philosopherId:
            debate.philosopherId,
        philosopherName:
            debate.philosopherName,
        debateMode:
            debate.debateMode,
        topic: debate.topic,
        topicFingerprint:
            debate.topicFingerprint,
        topicTheme:
            debate.topicTheme,
        topicModelProvider:
            debate.topicModelProvider,
        topicModelName:
            debate.topicModelName,
        topicGeneratedAt: serializeDate(
            debate.topicGeneratedAt,
            'activeDebate.topicGeneratedAt'
        ),
        modelProvider:
            debate.modelProvider,
        modelName:
            debate.modelName,
        stateVersion:
            debate.stateVersion,
        startedAt: serializeDate(
            debate.startedAt,
            'activeDebate.startedAt'
        ),
        lastActivityAt: serializeDate(
            debate.lastActivityAt,
            'activeDebate.lastActivityAt'
        ),
    };
}

function publicError(error) {
    if (
        error instanceof AccountRankedPlacementError ||
        error instanceof AccountRankedPlacementRouteError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 500;

        return {
            status,
            body: {
                error: {
                    code:
                        error.code ||
                        'ranked_placement_request_failed',
                    message:
                        error.message ||
                        'The Ranked placement request could not be completed.',
                    retryable:
                        Boolean(error.retryable),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'ranked_placement_unavailable',
                message:
                    'Ranked placement is temporarily unavailable.',
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

    logger.error(
        '[AccountRankedPlacement] Request failed.',
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

export function createAccountRankedPlacementRouter({
    service,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service.startPlacement !== 'function'
    ) {
        throw new Error(
            'A valid account Ranked placement service is required.'
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
        '/placements/start',
        asyncRoute(async (req, res) => {
            const installationId =
                requireInstallationId(req);
            const accessToken =
                requireBearerToken(req);
            const body = requireBody(req);
            const requestId =
                requireRequestId(body);
            const philosopherId =
                requirePhilosopherId(body);

            const result =
                await service.startPlacement({
                    installationId,
                    accessToken,
                    requestId,
                    philosopherId,
                });

            return res
                .status(result.created ? 201 : 200)
                .json({
                    success: true,
                    schemaVersion:
                        result.schemaVersion,
                    accountId:
                        result.accountId,
                    installationId:
                        result.installationId,
                    requestId:
                        result.requestId,
                    created:
                        result.created,
                    configuration:
                        serializeConfiguration(
                            result.configuration
                        ),
                    profile:
                        serializeProfile(
                            result.profile
                        ),
                    placementTrial:
                        serializePlacementTrial(
                            result.placementTrial
                        ),
                    activeDebate:
                        serializeActiveDebate(
                            result.activeDebate
                        ),
                });
        })
    );

    router.use((error, req, res, _next) => {
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
    });

    return router;
}
