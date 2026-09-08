import express from 'express';
import rateLimit from 'express-rate-limit';
import { resolveRequestLanguage } from './lib/languageSupport.js';

import {
    AccountRankedLadderError,
} from './lib/accountRankedLadderService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const RANKED_ACCESS_SCHEMA_VERSION = 1;

function readBooleanEnvironmentVariable(
    name,
    { defaultValue }
) {
    const rawValue = process.env[name];

    if (rawValue == null || rawValue.trim() === '') {
        return defaultValue;
    }

    switch (rawValue.trim().toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
        return true;

    case 'false':
    case '0':
    case 'no':
    case 'off':
        return false;

    default:
        throw new Error(`${name} must be true or false.`);
    }
}

const rankedFreeAccessEnabled =
    readBooleanEnvironmentVariable(
        'RANKED_FREE_ACCESS_ENABLED',
        { defaultValue: false }
    );

let defaultAccessPolicyPromise = null;

async function loadDefaultAccessPolicy() {
    if (!defaultAccessPolicyPromise) {
        defaultAccessPolicyPromise = import(
            './lib/rankedFreeAccessPolicy.js'
        ).then((module) => module.rankedFreeAccessPolicy);
    }

    return defaultAccessPolicyPromise;
}

class AccountRankedLadderRouteError extends Error {
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
        this.name = 'AccountRankedLadderRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }
}

function fail(code, message, options) {
    throw new AccountRankedLadderRouteError(code, message, options);
}

function asyncRoute(handler) {
    return function accountRankedLadderAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
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

function requireBody(req) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        fail(
            'invalid_ranked_ladder_request',
            'A JSON request body is required.',
            { status: 400 }
        );
    }

    return req.body;
}

function requireUUID(value, fieldName) {
    if (typeof value !== 'string' || !UUID_RE.test(value.trim())) {
        fail(
            'invalid_ranked_ladder_request',
            `${fieldName} must be a valid UUID.`,
            { status: 400 }
        );
    }

    return value.trim().toLowerCase();
}

function requireText(value, fieldName, maximumLength) {
    if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > maximumLength
    ) {
        fail(
            'invalid_ranked_ladder_request',
            `${fieldName} is required.`,
            { status: 400 }
        );
    }

    return value.trim();
}

function optionalText(value, fieldName, maximumLength) {
    if (value == null || String(value).trim() === '') {
        return null;
    }

    if (typeof value !== 'string' || value.length > maximumLength) {
        fail(
            'invalid_ranked_ladder_request',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return value.trim();
}

function serializeAccess(access, freeAccessEnabled) {
    return {
        tier: access.tier,
        isPro: access.isPro,
        timezone: access.timezone,
        challengeDate: access.challengeDate,
        dailyPhilosopherId: access.dailyPhilosopherId,
        dailyPhilosopherName: access.dailyPhilosopherName,
        freeLadderStartAvailable:
            access.isPro ||
            (freeAccessEnabled && access.freeLadderStartAvailable),
        windowStartsAt: access.windowStartsAt,
        windowExpiresAt: access.windowExpiresAt,
    };
}

function serializeDate(value, fieldName) {
    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `Ranked ladder service returned an invalid ${fieldName}.`
        );
    }

    return date.toISOString();
}

function serializeOptionalDate(value, fieldName) {
    return value == null ? null : serializeDate(value, fieldName);
}

function serializeConfiguration(configuration) {
    return {
        isEnabled: configuration.isEnabled,
        allowNewDebates: configuration.allowNewDebates,
        allowResumeActiveDebates: configuration.allowResumeActiveDebates,
        placementsEnabled: configuration.placementsEnabled,
        ladderEnabled: configuration.ladderEnabled,
        rankedRulesVersion: configuration.rankedRulesVersion,
        philosopherPromptVersion: configuration.philosopherPromptVersion,
        scoringPromptVersion: configuration.scoringPromptVersion,
        reportPromptVersion: configuration.reportPromptVersion,
        topicGeneratorVersion: configuration.topicGeneratorVersion,
        rpFormulaVersion: configuration.rpFormulaVersion,
        debateModelProvider: configuration.debateModelProvider,
        debateModelName: configuration.debateModelName,
    };
}

function serializeProfile(profile) {
    return {
        accountId: profile.accountId,
        placementStatus: profile.placementStatus,
        placementTrialsCompleted: profile.placementTrialsCompleted,
        placementWeightedScore: profile.placementWeightedScore,
        currentRankKey: profile.currentRankKey,
        currentDivision: profile.currentDivision,
        currentRP: profile.currentRP,
        peakRankKey: profile.peakRankKey,
        peakDivision: profile.peakDivision,
        peakReachedAt: serializeDate(profile.peakReachedAt, 'profile.peakReachedAt'),
        demotionProtectionDebatesRemaining:
            profile.demotionProtectionDebatesRemaining,
        demotionProtectionReason: profile.demotionProtectionReason,
        rankedDebatesCompleted: profile.rankedDebatesCompleted,
        rankedForfeits: profile.rankedForfeits,
        rankedInvalidResults: profile.rankedInvalidResults,
        stateVersion: profile.stateVersion,
        updatedAt: serializeDate(profile.updatedAt, 'profile.updatedAt'),
    };
}

function serializeActiveDebate(debate) {
    return {
        id: debate.id,
        accountId: debate.accountId,
        startRequestId: debate.startRequestId,
        debateKind: debate.debateKind,
        placementTrialNumber: debate.placementTrialNumber,
        status: debate.status,
        philosopherId: debate.philosopherId,
        philosopherName: debate.philosopherName,
        debateMode: debate.debateMode,
        topic: debate.displayTopic || debate.topic,
        language: debate.languageCode || 'en',
        topicFingerprint: debate.topicFingerprint,
        topicTheme: debate.topicTheme,
        topicModelProvider: debate.topicModelProvider,
        topicModelName: debate.topicModelName,
        topicGeneratedAt: serializeDate(
            debate.topicGeneratedAt,
            'activeDebate.topicGeneratedAt'
        ),
        messages: debate.messages,
        pendingGeneration: debate.pendingGeneration,
        currentScoreText: debate.currentScoreText,
        currentScoreValue: debate.currentScoreValue,
        finalScoreText: debate.finalScoreText,
        finalScoreValue: debate.finalScoreValue,
        roundCount: debate.roundCount,
        startingRankKey: debate.startingRankKey,
        startingDivision: debate.startingDivision,
        startingRP: debate.startingRP,
        forfeitRPLossPreview: debate.forfeitRPLossPreview,
        rpDelta: debate.rpDelta,
        endingRankKey: debate.endingRankKey,
        endingDivision: debate.endingDivision,
        endingRP: debate.endingRP,
        promoted: debate.promoted,
        demoted: debate.demoted,
        protectionApplied: debate.protectionApplied,
        protectionConsumed: debate.protectionConsumed,
        rankedRulesVersion: debate.rankedRulesVersion,
        philosopherPromptVersion: debate.philosopherPromptVersion,
        scoringPromptVersion: debate.scoringPromptVersion,
        reportPromptVersion: debate.reportPromptVersion,
        topicGeneratorVersion: debate.topicGeneratorVersion,
        rpFormulaVersion: debate.rpFormulaVersion,
        modelProvider: debate.modelProvider,
        modelName: debate.modelName,
        stateVersion: debate.stateVersion,
        startedAt: serializeDate(debate.startedAt, 'activeDebate.startedAt'),
        lastActivityAt: serializeDate(
            debate.lastActivityAt,
            'activeDebate.lastActivityAt'
        ),
        completedAt: serializeOptionalDate(
            debate.completedAt,
            'activeDebate.completedAt'
        ),
        updatedAt: serializeDate(debate.updatedAt, 'activeDebate.updatedAt'),
    };
}

function serializeSafeDetails(details) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) {
        return null;
    }

    const output = {};

    if (
        typeof details.activeDebateId === 'string' &&
        UUID_RE.test(details.activeDebateId)
    ) {
        output.activeDebateId = details.activeDebateId.toLowerCase();
    }

    return Object.keys(output).length > 0 ? output : null;
}

function publicError(error) {
    if (
        error instanceof AccountRankedLadderError ||
        error instanceof AccountRankedLadderRouteError ||
        error?.name === 'RankedFreeAccessPolicyError'
    ) {
        const details = serializeSafeDetails(error.details);

        return {
            status: Number.isInteger(error.status) ? error.status : 500,
            body: {
                error: {
                    code: error.code || 'ranked_ladder_request_failed',
                    message:
                        error.message ||
                        'The Ranked ladder request could not be completed.',
                    retryable: Boolean(error.retryable),
                    ...(details ? { details } : {}),
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'ranked_ladder_unavailable',
                message: 'The Ranked ladder is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function logUnexpectedError(logger, error, req) {
    const status = Number.isInteger(error?.status) ? error.status : 500;

    if (status < 500 || !logger || typeof logger.error !== 'function') {
        return;
    }

    logger.error('[AccountRankedLadder] Request failed.', {
        method: req.method,
        path: req.originalUrl ?? req.url,
        errorName: error?.name ?? 'Error',
        errorCode: error?.code ?? 'unknown_error',
        message: error?.message ?? 'Unknown error',
        causeCode: error?.cause?.code ?? null,
        constraint: error?.cause?.constraint ?? error?.constraint ?? null,
    });
}

export function createAccountRankedLadderRouter({
    service,
    accessPolicy = null,
    freeAccessEnabled = rankedFreeAccessEnabled,
    logger = console,
} = {}) {
    if (!service || typeof service.startLadderDebate !== 'function') {
        throw new Error('A valid account Ranked ladder service is required.');
    }

    if (typeof freeAccessEnabled !== 'boolean') {
        throw new Error('freeAccessEnabled must be a boolean.');
    }

    if (
        accessPolicy != null &&
        (
            typeof accessPolicy.authorizeAndGetAccess !== 'function' ||
            typeof accessPolicy.authorizeAndReserveLadderStart !== 'function'
        )
    ) {
        throw new Error('A valid Ranked free-access policy is required.');
    }

    let resolvedAccessPolicy = accessPolicy;

    async function getAccessPolicy() {
        if (!resolvedAccessPolicy) {
            resolvedAccessPolicy = await loadDefaultAccessPolicy();
        }

        return resolvedAccessPolicy;
    }

    const accessLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: {
            error: {
                code: 'too_many_ranked_access_requests',
                message: 'Too many Ranked access requests. Please try again shortly.',
                retryable: true,
            },
        },
    });

    const router = express.Router();

    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.post(
        '/access',
        accessLimiter,
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);
            const body = requireBody(req);
            const timezone = optionalText(
                body.timezone,
                'timezone',
                100
            );
            const policy = await getAccessPolicy();
            const result = await policy.authorizeAndGetAccess({
                installationId,
                accessToken,
                timezone,
            });

            return res.status(200).json({
                success: true,
                schemaVersion: RANKED_ACCESS_SCHEMA_VERSION,
                accountId: result.accountId,
                installationId: result.installationId,
                access: serializeAccess(
                    result.access,
                    freeAccessEnabled
                ),
            });
        })
    );

    router.post(
        '/ladder/start',
        asyncRoute(async (req, res) => {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);
            const body = requireBody(req);
            const requestId = requireUUID(body.requestId, 'requestId');
            const philosopherId = requireText(
                body.philosopherId,
                'philosopherId',
                100
            );
            const debateMode = requireText(
                body.debateMode,
                'debateMode',
                20
            );
            const timezone = optionalText(
                body.timezone,
                'timezone',
                100
            );

            let reservedAccess = null;

            // This is intentionally rollout-gated. While the flag is false,
            // the live App Store client follows the exact pre-change start
            // path. Enabling the flag adds the free-tier reservation before
            // any ladder debate can be created, preserving one-start-per-day
            // semantics across retries and multiple devices.
            if (freeAccessEnabled) {
                const policy = await getAccessPolicy();
                reservedAccess =
                    await policy.authorizeAndReserveLadderStart({
                        installationId,
                        accessToken,
                        requestId,
                        philosopherId,
                        timezone,
                    });
            }

            const result = await service.startLadderDebate({
                installationId,
                accessToken,
                requestId,
                philosopherId,
                debateMode,
                language: resolveRequestLanguage(req),
            });

            if (
                reservedAccess &&
                (
                    result.accountId !== reservedAccess.accountId ||
                    result.installationId !== reservedAccess.installationId
                )
            ) {
                fail(
                    'ranked_access_identity_mismatch',
                    'The Ranked access reservation returned an inconsistent account identity.',
                    { status: 503, retryable: true }
                );
            }

            return res
                .status(result.created ? 201 : 200)
                .json({
                    success: true,
                    schemaVersion: result.schemaVersion,
                    accountId: result.accountId,
                    installationId: result.installationId,
                    requestId: result.requestId,
                    created: result.created,
                    configuration: serializeConfiguration(result.configuration),
                    profile: serializeProfile(result.profile),
                    activeDebate: serializeActiveDebate(result.activeDebate),
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
