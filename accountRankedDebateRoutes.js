import express from 'express';

import {
    AccountRankedDebateError,
    accountRankedDebateConstants,
} from './lib/accountRankedDebateService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const MAX_INSTALLATION_ID_LENGTH = 128;

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INSTALLATION_ID_RE =
    /^[A-Za-z0-9-]{8,128}$/;

class AccountRankedDebateRouteError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
            details = null,
        } = {}
    ) {
        super(message);

        this.name =
            'AccountRankedDebateRouteError';

        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(
    code,
    message,
    options
) {
    throw new AccountRankedDebateRouteError(
        code,
        message,
        options
    );
}

function asyncRoute(handler) {
    return function accountRankedDebateAsyncRoute(
        req,
        res,
        next
    ) {
        Promise.resolve(
            handler(req, res, next)
        ).catch(next);
    };
}

function requireInstallationId(req) {
    const rawValue =
        req.get('X-Installation-ID');

    if (
        typeof rawValue !== 'string'
    ) {
        fail(
            'missing_installation_id',
            'X-Installation-ID header is required.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    const value =
        rawValue.trim();

    if (
        !value ||
        value.length >
            MAX_INSTALLATION_ID_LENGTH ||
        !INSTALLATION_ID_RE.test(value)
    ) {
        fail(
            'invalid_installation_id',
            'X-Installation-ID header is invalid.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return value;
}

function requireBearerToken(req) {
    const authorization =
        req.get('Authorization');

    if (
        typeof authorization !== 'string' ||
        authorization.length >
            MAX_AUTHORIZATION_HEADER_LENGTH
    ) {
        fail(
            'missing_access_token',
            'A Bearer access token is required.',
            {
                status: 401,
                retryable: false,
            }
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
            {
                status: 401,
                retryable: false,
            }
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
            'invalid_ranked_debate_request',
            'A JSON request body is required.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return req.body;
}

function requireUuid(
    value,
    fieldName,
    {
        missingCode =
            'missing_ranked_debate_field',
        invalidCode =
            'invalid_ranked_debate_field',
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            missingCode,
            `${fieldName} is required.`,
            {
                status: 400,
                retryable: false,
            }
        );
    }

    const cleaned =
        value.trim().toLowerCase();

    if (!UUID_RE.test(cleaned)) {
        fail(
            invalidCode,
            `${fieldName} must be a valid UUID.`,
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return cleaned;
}

function requireDebateId(req) {
    return requireUuid(
        req.params?.debateId,
        'debateId',
        {
            missingCode:
                'missing_ranked_debate_id',
            invalidCode:
                'invalid_ranked_debate_id',
        }
    );
}

function requireRequestId(body) {
    return requireUuid(
        body.requestId,
        'requestId',
        {
            missingCode:
                'missing_ranked_request_id',
            invalidCode:
                'invalid_ranked_request_id',
        }
    );
}

function requireExpectedStateVersion(
    body
) {
    const value =
        body.expectedStateVersion;

    if (
        !Number.isSafeInteger(value) ||
        value < 1
    ) {
        fail(
            'invalid_ranked_state_version',
            'expectedStateVersion must be a positive integer.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return value;
}

function requireTurnContent(body) {
    if (typeof body.content !== 'string') {
        fail(
            'missing_ranked_turn_content',
            'content is required.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    const content =
        body.content.trim();

    if (!content) {
        fail(
            'invalid_ranked_turn_content',
            'content cannot be empty.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    if (
        content.length >
        accountRankedDebateConstants
            .maxUserMessageLength
    ) {
        fail(
            'ranked_turn_content_too_long',
            `content cannot exceed ${accountRankedDebateConstants.maxUserMessageLength} characters.`,
            {
                status: 413,
                retryable: false,
            }
        );
    }

    return content;
}

function serializeDate(
    value,
    fieldName
) {
    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `Ranked debate service returned an invalid ${fieldName}.`
        );
    }

    return date.toISOString();
}

function serializeOptionalDate(
    value,
    fieldName
) {
    if (value == null) {
        return null;
    }

    return serializeDate(
        value,
        fieldName
    );
}

function serializeMessage(message) {
    return {
        id: message.id,
        requestId:
            message.requestId,
        role: message.role,
        kind: message.kind,
        content: message.content,
        roundNumber:
            message.roundNumber,
        scoreText:
            message.scoreText,
        scoreValue:
            message.scoreValue,
        createdAt:
            serializeDate(
                message.createdAt,
                'message.createdAt'
            ),
        completedAt:
            serializeDate(
                message.completedAt,
                'message.completedAt'
            ),
    };
}

function serializePendingGeneration(
    pendingGeneration
) {
    if (pendingGeneration == null) {
        return null;
    }

    return {
        requestId:
            pendingGeneration.requestId,
        kind:
            pendingGeneration.kind,
        roundNumber:
            pendingGeneration.roundNumber,
        status:
            pendingGeneration.status,
        retryable:
            Boolean(
                pendingGeneration.retryable
            ),
        generationStartedAt:
            serializeOptionalDate(
                pendingGeneration
                    .generationStartedAt,
                'pendingGeneration.generationStartedAt'
            ),
        failureCode:
            pendingGeneration.failureCode,
    };
}

function serializeDebate(debate) {
    if (
        !debate ||
        typeof debate !== 'object' ||
        Array.isArray(debate)
    ) {
        throw new Error(
            'Ranked debate service returned an invalid debate.'
        );
    }

    if (!Array.isArray(debate.messages)) {
        throw new Error(
            'Ranked debate service returned invalid messages.'
        );
    }

    return {
        id: debate.id,
        accountId:
            debate.accountId,
        startRequestId:
            debate.startRequestId,
        ...(debate.completionRequestId
            ? {
                completionRequestId:
                    debate
                        .completionRequestId,
            }
            : {}),
        ...(debate.forfeitRequestId
            ? {
                forfeitRequestId:
                    debate
                        .forfeitRequestId,
            }
            : {}),
        debateKind:
            debate.debateKind,
        placementTrialNumber:
            debate.placementTrialNumber,
        status:
            debate.status,
        philosopherId:
            debate.philosopherId,
        philosopherName:
            debate.philosopherName,
        debateMode:
            debate.debateMode,
        topic:
            debate.topic,
        topicFingerprint:
            debate.topicFingerprint,
        topicTheme:
            debate.topicTheme,
        topicModelProvider:
            debate.topicModelProvider,
        topicModelName:
            debate.topicModelName,
        topicGeneratedAt:
            serializeDate(
                debate.topicGeneratedAt,
                'debate.topicGeneratedAt'
            ),
        messages:
            debate.messages.map(
                serializeMessage
            ),
        pendingGeneration:
            serializePendingGeneration(
                debate.pendingGeneration
            ),
        currentScoreText:
            debate.currentScoreText,
        currentScoreValue:
            debate.currentScoreValue,
        ...(debate.finalScoreValue != null
            ? {
                finalScoreText:
                    debate.finalScoreText,
                finalScoreValue:
                    debate.finalScoreValue,
            }
            : {}),
        roundCount:
            debate.roundCount,
        ...(debate.debateKind === 'ladder'
            ? {
                startingRankKey:
                    debate.startingRankKey,
                startingDivision:
                    debate.startingDivision,
                startingRP:
                    debate.startingRP,
                forfeitRPLossPreview:
                    debate.forfeitRPLossPreview,
                rpDelta:
                    debate.rpDelta,
                endingRankKey:
                    debate.endingRankKey,
                endingDivision:
                    debate.endingDivision,
                endingRP:
                    debate.endingRP,
                promoted:
                    Boolean(debate.promoted),
                demoted:
                    Boolean(debate.demoted),
                protectionApplied:
                    Boolean(
                        debate.protectionApplied
                    ),
                protectionConsumed:
                    Boolean(
                        debate.protectionConsumed
                    ),
            }
            : {}),
        rankedRulesVersion:
            debate.rankedRulesVersion,
        philosopherPromptVersion:
            debate.philosopherPromptVersion,
        scoringPromptVersion:
            debate.scoringPromptVersion,
        reportPromptVersion:
            debate.reportPromptVersion,
        topicGeneratorVersion:
            debate.topicGeneratorVersion,
        rpFormulaVersion:
            debate.rpFormulaVersion,
        modelProvider:
            debate.modelProvider,
        modelName:
            debate.modelName,
        stateVersion:
            debate.stateVersion,
        startedAt:
            serializeDate(
                debate.startedAt,
                'debate.startedAt'
            ),
        lastActivityAt:
            serializeDate(
                debate.lastActivityAt,
                'debate.lastActivityAt'
            ),
        ...(debate.completedAt
            ? {
                completedAt:
                    serializeDate(
                        debate.completedAt,
                        'debate.completedAt'
                    ),
            }
            : {}),
        updatedAt:
            serializeDate(
                debate.updatedAt,
                'debate.updatedAt'
            ),
    };
}

function serializeReply(reply) {
    if (reply == null) {
        return null;
    }

    return serializeMessage(reply);
}


function serializePlacementCompletion(
    placement
) {
    if (
        !placement ||
        typeof placement !== 'object' ||
        Array.isArray(placement)
    ) {
        throw new Error(
            'Ranked debate service returned invalid placement completion data.'
        );
    }

    return {
        trialNumber:
            placement.trialNumber,
        weightBasisPoints:
            placement.weightBasisPoints,
        weightedScoreContribution:
            placement
                .weightedScoreContribution,
        trialsCompleted:
            placement.trialsCompleted,
        trialsRequired:
            placement.trialsRequired,
        placementCompleted:
            Boolean(
                placement
                    .placementCompleted
            ),
        placementWeightedScore:
            placement
                .placementWeightedScore,
        startingRankKey:
            placement.startingRankKey,
        startingDivision:
            placement.startingDivision,
        startingRP:
            placement.startingRP,
        demotionProtectionDebatesRemaining:
            placement
                .demotionProtectionDebatesRemaining,
    };
}

function serializeLadderCompletion(
    ladder
) {
    if (
        !ladder ||
        typeof ladder !== 'object' ||
        Array.isArray(ladder)
    ) {
        throw new Error(
            'Ranked debate service returned invalid ladder completion data.'
        );
    }

    return {
        rpDelta:
            ladder.rpDelta,
        beforeRankKey:
            ladder.beforeRankKey,
        beforeDivision:
            ladder.beforeDivision,
        beforeRP:
            ladder.beforeRP,
        afterRankKey:
            ladder.afterRankKey,
        afterDivision:
            ladder.afterDivision,
        afterRP:
            ladder.afterRP,
        promoted:
            Boolean(ladder.promoted),
        demoted:
            Boolean(ladder.demoted),
        protectionBefore:
            ladder.protectionBefore,
        protectionAfter:
            ladder.protectionAfter,
        protectionApplied:
            Boolean(
                ladder.protectionApplied
            ),
        protectionConsumed:
            Boolean(
                ladder.protectionConsumed
            ),
        peakRankKey:
            ladder.peakRankKey,
        peakDivision:
            ladder.peakDivision,
        peakReachedAt:
            serializeOptionalDate(
                ladder.peakReachedAt,
                'completion.ladder.peakReachedAt'
            ),
        forfeitRPLossPreview:
            ladder.forfeitRPLossPreview,
        formulaComponents:
            ladder.formulaComponents ?? {},
    };
}

function serializeCompletion(
    completion
) {
    if (
        !completion ||
        typeof completion !== 'object' ||
        Array.isArray(completion)
    ) {
        throw new Error(
            'Ranked debate service returned invalid completion data.'
        );
    }

    return {
        outcome:
            completion.outcome,
        completedAt:
            serializeDate(
                completion.completedAt,
                'completion.completedAt'
            ),
        finalScoreText:
            completion.finalScoreText,
        finalScoreValue:
            completion.finalScoreValue,
        scoredRoundCount:
            completion.scoredRoundCount,
        placement:
            completion.placement == null
                ? null
                : serializePlacementCompletion(
                    completion.placement
                ),
        ladder:
            completion.ladder == null
                ? null
                : serializeLadderCompletion(
                    completion.ladder
                ),
    };
}

function serializeSafeErrorDetails(
    details
) {
    if (
        !details ||
        typeof details !== 'object' ||
        Array.isArray(details)
    ) {
        return null;
    }

    const output = {};

    if (
        Number.isSafeInteger(
            details.expectedStateVersion
        )
    ) {
        output.expectedStateVersion =
            details.expectedStateVersion;
    }

    if (
        Number.isSafeInteger(
            details.currentStateVersion
        )
    ) {
        output.currentStateVersion =
            details.currentStateVersion;
    }

    if (
        typeof details.requestId ===
            'string' &&
        UUID_RE.test(
            details.requestId
        )
    ) {
        output.requestId =
            details.requestId.toLowerCase();
    }

    for (
        const field
        of [
            'minimumUserTurns',
            'currentUserTurns',
            'scoredRoundCount',
            'rpLoss',
        ]
    ) {
        if (
            Number.isSafeInteger(
                details[field]
            ) &&
            details[field] >= 0
        ) {
            output[field] =
                details[field];
        }
    }

    return Object.keys(output).length > 0
        ? output
        : null;
}

function publicError(error) {
    if (
        error instanceof
            AccountRankedDebateError ||
        error instanceof
            AccountRankedDebateRouteError
    ) {
        const status =
            Number.isInteger(
                error.status
            )
                ? error.status
                : 500;

        const details =
            serializeSafeErrorDetails(
                error.details
            );

        return {
            status,
            body: {
                error: {
                    code:
                        error.code ||
                        'ranked_debate_request_failed',
                    message:
                        error.message ||
                        'The Ranked debate request could not be completed.',
                    retryable:
                        Boolean(
                            error.retryable
                        ),
                    ...(details
                        ? { details }
                        : {}),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code:
                    'ranked_debate_unavailable',
                message:
                    'Ranked debate is temporarily unavailable.',
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
        typeof error !==
            'object' ||
        depth > 4
    ) {
        return null;
    }

    const diagnostic = {};

    const copyTextField = (
        sourceField,
        outputField =
            sourceField,
        maximumLength = 500
    ) => {
        const value =
            error[sourceField];

        if (
            typeof value ===
                'string' &&
            value.trim()
        ) {
            diagnostic[outputField] =
                value
                    .trim()
                    .slice(
                        0,
                        maximumLength
                    );
        }
    };

    copyTextField(
        'name'
    );
    copyTextField(
        'code'
    );
    copyTextField(
        'constraint'
    );
    copyTextField(
        'table'
    );
    copyTextField(
        'column'
    );
    copyTextField(
        'schema'
    );
    copyTextField(
        'routine'
    );
    copyTextField(
        'severity'
    );

    const cause =
        error.cause;

    if (
        cause &&
        cause !== error
    ) {
        const nested =
            serializeDiagnosticCause(
                cause,
                depth + 1
            );

        if (nested) {
            diagnostic.cause =
                nested;
        }
    }

    return Object.keys(
        diagnostic
    ).length > 0
        ? diagnostic
        : null;
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

    logger.error(
        '[AccountRankedDebate] Request failed.',
        {
            method:
                req.method,
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
                serializeDiagnosticCause(
                    error
                ),
        }
    );
}

function setSecurityHeaders(
    _req,
    res,
    next
) {
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
}

export function createAccountRankedDebateRouter({
    service,
    logger = console,
} = {}) {
    if (
        !service ||
        typeof service
            .resumeActiveDebate !==
            'function' ||
        typeof service
            .generateOpening !==
            'function' ||
        typeof service
            .submitTurn !==
            'function' ||
        typeof service
            .completeDebate !==
            'function' ||
        typeof service
            .forfeitDebate !==
            'function'
    ) {
        throw new Error(
            'A valid account Ranked debate service is required.'
        );
    }

    const router =
        express.Router();

    router.use(
        setSecurityHeaders
    );

    router.get(
        '/debates/active',
        asyncRoute(
            async (req, res) => {
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
                        .resumeActiveDebate({
                            installationId,
                            accessToken,
                        });

                return res
                    .status(200)
                    .json({
                        success: true,
                        schemaVersion:
                            result.schemaVersion,
                        accountId:
                            result.accountId,
                        installationId:
                            result.installationId,
                        resumedAt:
                            serializeDate(
                                result.resumedAt,
                                'resumedAt'
                            ),
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                    });
            }
        )
    );

    router.get(
        '/debates/:debateId/result',
        asyncRoute(
            async (req, res) => {
                const installationId =
                    requireInstallationId(
                        req
                    );

                const accessToken =
                    requireBearerToken(
                        req
                    );

                const debateId =
                    requireDebateId(
                        req
                    );

                if (
                    typeof service
                        .getResolvedDebateResult !==
                        'function'
                ) {
                    throw new Error(
                        'Ranked result retrieval is not configured.'
                    );
                }

                const result =
                    await service
                        .getResolvedDebateResult({
                            installationId,
                            accessToken,
                            debateId,
                        });

                return res
                    .status(200)
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
                        created: false,
                        retrievedAt:
                            serializeDate(
                                result.retrievedAt,
                                'retrievedAt'
                            ),
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                        completion:
                            serializeCompletion(
                                result.completion
                            ),
                    });
            }
        )
    );

    router.post(
        '/debates/:debateId/opening',
        asyncRoute(
            async (req, res) => {
                const installationId =
                    requireInstallationId(
                        req
                    );

                const accessToken =
                    requireBearerToken(
                        req
                    );

                const debateId =
                    requireDebateId(
                        req
                    );

                const body =
                    requireBody(
                        req
                    );

                const requestId =
                    requireRequestId(
                        body
                    );

                const expectedStateVersion =
                    requireExpectedStateVersion(
                        body
                    );

                const result =
                    await service
                        .generateOpening({
                            installationId,
                            accessToken,
                            debateId,
                            requestId,
                            expectedStateVersion,
                        });

                return res
                    .status(
                        result.created
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
                        requestId:
                            result.requestId,
                        created:
                            result.created,
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                        reply:
                            serializeReply(
                                result.reply
                            ),
                    });
            }
        )
    );

    router.post(
        '/debates/:debateId/turns',
        asyncRoute(
            async (req, res) => {
                const installationId =
                    requireInstallationId(
                        req
                    );

                const accessToken =
                    requireBearerToken(
                        req
                    );

                const debateId =
                    requireDebateId(
                        req
                    );

                const body =
                    requireBody(
                        req
                    );

                const requestId =
                    requireRequestId(
                        body
                    );

                const expectedStateVersion =
                    requireExpectedStateVersion(
                        body
                    );

                const content =
                    requireTurnContent(
                        body
                    );

                const result =
                    await service
                        .submitTurn({
                            installationId,
                            accessToken,
                            debateId,
                            requestId,
                            expectedStateVersion,
                            content,
                        });

                return res
                    .status(
                        result.created
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
                        requestId:
                            result.requestId,
                        created:
                            result.created,
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                        reply:
                            serializeReply(
                                result.reply
                            ),
                    });
            }
        )
    );


    router.post(
        '/debates/:debateId/complete',
        asyncRoute(
            async (req, res) => {
                const installationId =
                    requireInstallationId(
                        req
                    );

                const accessToken =
                    requireBearerToken(
                        req
                    );

                const debateId =
                    requireDebateId(
                        req
                    );

                const body =
                    requireBody(
                        req
                    );

                const requestId =
                    requireRequestId(
                        body
                    );

                const expectedStateVersion =
                    requireExpectedStateVersion(
                        body
                    );

                const result =
                    await service
                        .completeDebate({
                            installationId,
                            accessToken,
                            debateId,
                            requestId,
                            expectedStateVersion,
                        });

                return res
                    .status(
                        result.created
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
                        requestId:
                            result.requestId,
                        created:
                            result.created,
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                        completion:
                            serializeCompletion(
                                result.completion
                            ),
                    });
            }
        )
    );



    router.post(
        '/debates/:debateId/forfeit',
        asyncRoute(
            async (req, res) => {
                const installationId =
                    requireInstallationId(
                        req
                    );

                const accessToken =
                    requireBearerToken(
                        req
                    );

                const debateId =
                    requireDebateId(
                        req
                    );

                const body =
                    requireBody(
                        req
                    );

                const requestId =
                    requireRequestId(
                        body
                    );

                const expectedStateVersion =
                    requireExpectedStateVersion(
                        body
                    );

                const result =
                    await service
                        .forfeitDebate({
                            installationId,
                            accessToken,
                            debateId,
                            requestId,
                            expectedStateVersion,
                        });

                return res
                    .status(
                        result.created
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
                        requestId:
                            result.requestId,
                        created:
                            result.created,
                        debate:
                            serializeDebate(
                                result.debate
                            ),
                        completion:
                            serializeCompletion(
                                result.completion
                            ),
                    });
            }
        )
    );

    router.use(
        (
            error,
            req,
            res,
            _next
        ) => {
            logUnexpectedError(
                logger,
                error,
                req
            );

            const response =
                publicError(
                    error
                );

            return res
                .status(
                    response.status
                )
                .json(
                    response.body
                );
        }
    );

    return router;
}
