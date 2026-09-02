import express from 'express';

import { AccountAuthError } from './lib/accountAuthService.js';
import {
    AiContentReportError,
} from './lib/aiContentReportService.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 16_512;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;

function requireInstallationId(req) {
    const value = req.get('X-Installation-ID');
    if (
        typeof value !== 'string' ||
        !INSTALLATION_ID_RE.test(value.trim())
    ) {
        throw new AiContentReportError(
            'invalid_installation_id',
            'X-Installation-ID is required.',
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
        throw new AiContentReportError(
            'missing_access_token',
            'A Bearer access token is required.',
            { status: 401 }
        );
    }

    const match =
        /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/
            .exec(authorization.trim());
    if (!match) {
        throw new AiContentReportError(
            'invalid_access_token',
            'The access token is invalid or expired.',
            { status: 401 }
        );
    }
    return match[1];
}

function optionalHeader(req, name) {
    const value = req.get(name);
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

function publicError(error) {
    if (error?.type === 'entity.too.large') {
        return {
            status: 413,
            body: {
                error: {
                    code: 'ai_content_report_too_large',
                    message: 'The report payload is too large.',
                    retryable: false,
                },
            },
        };
    }

    if (
        error instanceof AiContentReportError ||
        error instanceof AccountAuthError
    ) {
        const status = Number.isInteger(error.status)
            ? error.status
            : 400;
        return {
            status,
            body: {
                error: {
                    code: error.code || 'ai_content_report_failed',
                    message: error.message || 'The report could not be submitted.',
                    retryable: Boolean(error.retryable) || status >= 500,
                },
            },
        };
    }

    return {
        status: 503,
        body: {
            error: {
                code: 'ai_content_report_unavailable',
                message: 'The report could not be submitted. Please try again.',
                retryable: true,
            },
        },
    };
}

function logUnexpectedError(error, logger) {
    if (
        error instanceof AiContentReportError ||
        error instanceof AccountAuthError ||
        error?.type === 'entity.too.large'
    ) {
        return;
    }

    // Never log access tokens, request bodies, or the reported AI response.
    logger?.error?.('[AIContentReport] Submission failed.', {
        errorName: error?.name || 'Error',
        errorCode: error?.code || 'ai_content_report_unavailable',
    });
}

export function createAiContentReportRouter({ service, logger = console } = {}) {
    if (!service || typeof service.submitReport !== 'function') {
        throw new Error('AI content report routes require service.submitReport().');
    }

    const router = express.Router();

    router.use((_, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    router.post('/', async (req, res) => {
        try {
            const installationId = requireInstallationId(req);
            const accessToken = requireBearerToken(req);
            const result = await service.submitReport({
                installationId,
                accessToken,
                report: req.body,
                clientPlatform: optionalHeader(req, 'X-Client-Platform'),
                appVersion:
                    optionalHeader(req, 'X-Android-Version') ||
                    optionalHeader(req, 'X-iOS-Version'),
                appBuild:
                    optionalHeader(req, 'X-Android-Build') ||
                    optionalHeader(req, 'X-iOS-Build'),
            });

            return res.status(201).json({
                accepted: true,
                reportId: result.reportId,
                acceptedAt: result.acceptedAt.toISOString(),
            });
        } catch (error) {
            logUnexpectedError(error, logger);
            const response = publicError(error);
            return res.status(response.status).json(response.body);
        }
    });

    return router;
}
