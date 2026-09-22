import express from 'express';
import { AccountMirrorError } from './lib/accountMirrorService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;

class AccountMirrorRouteError extends Error {
    constructor(code, message, { status = 400, retryable = false } = {}) {
        super(message);
        this.name = 'AccountMirrorRouteError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountMirrorRouteError(code, message, options);
}

function asyncRoute(handler) {
    return function mirrorAsyncRoute(req, res, next) {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function requireInstallationId(req) {
    const value = req.get('X-Installation-ID');
    if (typeof value !== 'string' || !value.trim()) {
        fail('missing_installation_id', 'X-Installation-ID header is required.', { status: 400 });
    }
    return value.trim();
}

function requireBearerToken(req) {
    const authorization = req.get('Authorization');
    if (typeof authorization !== 'string' || authorization.length > MAX_AUTHORIZATION_HEADER_LENGTH) {
        fail('missing_access_token', 'A Bearer access token is required.', { status: 401 });
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
    if (!match) {
        fail('invalid_access_token', 'The access token is invalid or expired.', { status: 401 });
    }
    return match[1];
}

function requireObjectBody(req) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        fail('invalid_mirror_payload', 'A JSON object body is required.', { status: 400 });
    }
    return req.body;
}

function serialize(value) {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(serialize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]));
    }
    return value;
}

function publicError(error) {
    if (error instanceof AccountMirrorError || error instanceof AccountMirrorRouteError) {
        const status = Number.isInteger(error.status) ? error.status : 500;
        return {
            status: status >= 500 ? 503 : status,
            body: {
                error: {
                    code: error.code || 'mirror_request_failed',
                    message: status >= 500
                        ? 'The Mirror is temporarily unavailable.'
                        : (error.message || 'The Mirror request could not be completed.'),
                    retryable: status >= 500 ? true : Boolean(error.retryable),
                },
            },
        };
    }
    return {
        status: 503,
        body: {
            error: {
                code: 'mirror_unavailable',
                message: 'The Mirror is temporarily unavailable.',
                retryable: true,
            },
        },
    };
}

function authInput(req) {
    return {
        installationId: requireInstallationId(req),
        accessToken: requireBearerToken(req),
    };
}

export function createAccountMirrorRouter({ service, logger = console } = {}) {
    if (!service || typeof service.getState !== 'function') {
        throw new Error('A valid account Mirror service is required.');
    }

    const router = express.Router();
    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.get('/state', asyncRoute(async (req, res) => {
        const result = await service.getState(authInput(req));
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.put('/questionnaire/answer', asyncRoute(async (req, res) => {
        const body = requireObjectBody(req);
        const result = await service.saveAnswer({
            ...authInput(req),
            questionId: body.questionId,
            answerValue: body.answerValue,
        });
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.post('/questionnaire/submit', asyncRoute(async (req, res) => {
        const result = await service.submitQuestionnaire(authInput(req));
        return res.status(202).json({ success: true, cycle: serialize(result) });
    }));

    router.post('/analysis/retry', asyncRoute(async (req, res) => {
        const result = await service.retryGeneration(authInput(req));
        return res.status(202).json({ success: true, ...serialize(result) });
    }));

    router.get('/history', asyncRoute(async (req, res) => {
        const result = await service.getHistory(authInput(req));
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.get('/history/:cycleNumber', asyncRoute(async (req, res) => {
        const result = await service.getSnapshot({
            ...authInput(req),
            cycleNumber: req.params.cycleNumber,
        });
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.patch('/evidence/:kind/:evidenceItemId', asyncRoute(async (req, res) => {
        const body = requireObjectBody(req);
        if (typeof body.excluded !== 'boolean') {
            fail(
                'invalid_mirror_evidence_exclusion',
                'excluded must be a boolean.',
                { status: 400 }
            );
        }

        const result = await service.setEvidenceExclusion({
            ...authInput(req),
            kind: req.params.kind,
            evidenceItemId: req.params.evidenceItemId,
            excluded: body.excluded,
        });

        return res.status(200).json({
            success: true,
            ...serialize(result),
        });
    }));

    router.post('/test/make-eligible-now', asyncRoute(async (req, res) => {
        const result = await service.testMakeEligibleNow(authInput(req));
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.post('/test/reset', asyncRoute(async (req, res) => {
        const result = await service.testReset(authInput(req));
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.post('/test/reprocess-evidence', asyncRoute(async (req, res) => {
        const result = await service.testReprocessEvidence(authInput(req));
        return res.status(202).json({ success: true, ...serialize(result) });
    }));

    router.get('/test/state', asyncRoute(async (req, res) => {
        const result = await service.testState(authInput(req));
        return res.status(200).json({ success: true, ...serialize(result) });
    }));

    router.use((error, req, res, _next) => {
        if (Number(error?.status || 500) >= 500 && logger?.error) {
            logger.error('[AccountMirror] Request failed.', {
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
