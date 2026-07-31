import express from 'express';

import {
    AccountRankedProfileError,
} from './lib/accountRankedProfileService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

class AccountRankedProfileRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'AccountRankedProfileRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountRankedProfileRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountRankedProfileAsyncRoute(
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

function serializeDate(value, fieldName) {
    const date = value instanceof Date
        ? value
        : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `Ranked profile service returned an invalid ${fieldName}.`
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
        ladderEnabled:
            configuration.ladderEnabled,
        leaderboardEnabled:
            configuration.leaderboardEnabled,
        populationLimitsEnabled:
            configuration.populationLimitsEnabled,
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
        updatedAt: serializeDate(
            configuration.updatedAt,
            'configuration.updatedAt'
        ),
    };
}

function serializeProfile(profile) {
    return {
        accountId: profile.accountId,
        placementStatus:
            profile.placementStatus,
        placementTrialsCompleted:
            profile.placementTrialsCompleted,
        placementWeightedScore:
            profile.placementWeightedScore,
        currentRankKey:
            profile.currentRankKey,
        currentDivision:
            profile.currentDivision,
        currentRP:
            profile.currentRP,
        peakRankKey:
            profile.peakRankKey,
        peakDivision:
            profile.peakDivision,
        peakReachedAt:
            serializeOptionalDate(
                profile.peakReachedAt,
                'profile.peakReachedAt'
            ),
        demotionProtectionDebatesRemaining:
            profile.demotionProtectionDebatesRemaining,
        demotionProtectionReason:
            profile.demotionProtectionReason,
        demotionProtectionGrantedAt:
            serializeOptionalDate(
                profile.demotionProtectionGrantedAt,
                'profile.demotionProtectionGrantedAt'
            ),
        rankedDebatesCompleted:
            profile.rankedDebatesCompleted,
        rankedForfeits:
            profile.rankedForfeits,
        rankedInvalidResults:
            profile.rankedInvalidResults,
        lastRankedDebateCompletedAt:
            serializeOptionalDate(
                profile.lastRankedDebateCompletedAt,
                'profile.lastRankedDebateCompletedAt'
            ),
        stateVersion:
            profile.stateVersion,
        createdAt: serializeDate(
            profile.createdAt,
            'profile.createdAt'
        ),
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
        finalScoreValue:
            trial.finalScoreValue,
        weightedScoreContribution:
            trial.weightedScoreContribution,
        startedAt: serializeOptionalDate(
            trial.startedAt,
            'placementTrial.startedAt'
        ),
        completedAt: serializeOptionalDate(
            trial.completedAt,
            'placementTrial.completedAt'
        ),
        createdAt: serializeDate(
            trial.createdAt,
            'placementTrial.createdAt'
        ),
        updatedAt: serializeDate(
            trial.updatedAt,
            'placementTrial.updatedAt'
        ),
    };
}

function serializeActiveDebate(activeDebate) {
    if (activeDebate == null) return null;

    return {
        id: activeDebate.id,
        debateKind:
            activeDebate.debateKind,
        placementTrialNumber:
            activeDebate.placementTrialNumber,
        philosopherId:
            activeDebate.philosopherId,
        philosopherName:
            activeDebate.philosopherName,
        debateMode:
            activeDebate.debateMode,
        topic:
            activeDebate.topic,
        currentScoreText:
            activeDebate.currentScoreText,
        currentScoreValue:
            activeDebate.currentScoreValue,
        roundCount:
            activeDebate.roundCount,
        lastActivityAt: serializeDate(
            activeDebate.lastActivityAt,
            'activeDebate.lastActivityAt'
        ),
        stateVersion:
            activeDebate.stateVersion,
    };
}

function publicError(error) {
    if (
        error instanceof AccountRankedProfileError ||
        error instanceof AccountRankedProfileRouteError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 500;

        if (status >= 500) {
            return {
                status: 503,
                body: {
                    error: {
                        code:
                            'ranked_profile_unavailable',
                        message:
                            'Ranked profile is temporarily unavailable.',
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
                        'ranked_profile_request_failed',
                    message:
                        error.message ||
                        'The Ranked profile request could not be completed.',
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
                code: 'ranked_profile_unavailable',
                message:
                    'Ranked profile is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function serializeDiagnosticCause(
    error,
    depth = 0
) {
    if (
        !error ||
        typeof error !== 'object' ||
        depth > 4
    ) {
        return null;
    }

    const diagnostic = {};

    const copyTextField = (
        sourceField,
        outputField = sourceField,
        maximumLength = 500
    ) => {
        const value = error[sourceField];

        if (
            typeof value === 'string' &&
            value.trim()
        ) {
            diagnostic[outputField] =
                value
                    .trim()
                    .slice(0, maximumLength);
        }
    };

    copyTextField('name');
    copyTextField('code');
    copyTextField('constraint');
    copyTextField('table');
    copyTextField('column');
    copyTextField('schema');
    copyTextField('routine');
    copyTextField('severity');
    copyTextField('detail', 'detail', 1_000);
    copyTextField('hint', 'hint', 1_000);
    copyTextField('message', 'message', 1_000);

    const cause = error.cause;

    if (cause && cause !== error) {
        const nested = serializeDiagnosticCause(
            cause,
            depth + 1
        );

        if (nested) {
            diagnostic.cause = nested;
        }
    }

    return Object.keys(diagnostic).length > 0
        ? diagnostic
        : null;
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
        '[AccountRankedProfile] Request failed.',
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
            diagnosticCause:
                serializeDiagnosticCause(error),
        }
    );
}

export function createAccountRankedProfileRouter({
    service,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service.bootstrapProfile !== 'function'
    ) {
        throw new Error(
            'A valid account Ranked profile service is required.'
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
        '/profile/bootstrap',
        asyncRoute(async (req, res) => {
            const installationId =
                requireInstallationId(req);
            const accessToken =
                requireBearerToken(req);

            const result =
                await service.bootstrapProfile({
                    installationId,
                    accessToken,
                });

            return res
                .status(
                    result.profileCreated
                        ? 201
                        : 200
                )
                .json({
                    success: true,
                    schemaVersion:
                        result.schemaVersion,
                    accountId:
                        result.accountId,
                    installationId:
                        result.installationId,
                    bootstrappedAt:
                        serializeDate(
                            result.bootstrappedAt,
                            'bootstrappedAt'
                        ),
                    profileCreated:
                        result.profileCreated,
                    configuration:
                        serializeConfiguration(
                            result.configuration
                        ),
                    profile:
                        serializeProfile(
                            result.profile
                        ),
                    placementTrials:
                        result.placementTrials.map(
                            serializePlacementTrial
                        ),
                    rankTiers:
                        result.rankTiers,
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

        const response = publicError(error);

        return res
            .status(response.status)
            .json(response.body);
    });

    return router;
}
