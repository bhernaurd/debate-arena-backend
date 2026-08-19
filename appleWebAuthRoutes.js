import express from 'express';

import { AppleWebAuthFlowError } from './lib/appleWebAuthFlow.js';

const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;

function errorEnvelope(res, error) {
    const status = Number.isInteger(error?.status)
        ? error.status
        : 500;
    const code = typeof error?.code === 'string' && error.code
        ? error.code
        : 'apple_web_auth_unavailable';
    const message = typeof error?.message === 'string' && error.message
        ? error.message
        : 'Android Sign in with Apple is temporarily unavailable.';

    return res.status(status).json({
        error: {
            code,
            message,
            retryable: Boolean(error?.retryable || status >= 500),
        },
    });
}

function installationId(req) {
    const value = req.get('X-Installation-ID')?.trim() ?? '';
    if (!INSTALLATION_ID_RE.test(value)) {
        throw new AppleWebAuthFlowError(
            'invalid_installation_id',
            'The installation identifier is invalid.',
            { status: 400 }
        );
    }
    return value;
}

function disabledError(config) {
    const missing = Array.isArray(config?.missing)
        ? config.missing.filter(Boolean)
        : [];
    return new AppleWebAuthFlowError(
        'apple_web_auth_disabled',
        missing.length > 0
            ? 'Android Sign in with Apple is not configured yet.'
            : 'Android Sign in with Apple is unavailable.',
        { status: 503, retryable: false }
    );
}

export function createAppleWebAuthRouter({
    config,
    flow = null,
} = {}) {
    const router = express.Router();

    router.get('/config', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({
            enabled: config?.enabled === true && flow != null,
            signInRequired: config?.enabled === true && flow != null,
        });
    });

    router.post('/start', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            if (!config?.enabled || !flow) throw disabledError(config);
            const result = flow.createAuthorizationStart({
                installationId: installationId(req),
                purpose: req.body?.purpose,
                challengeId: req.body?.challengeId,
                nonceSha256: req.body?.nonceSha256,
                challengeExpiresAt: req.body?.challengeExpiresAt,
            });
            return res.status(201).json({
                enabled: true,
                authorizationUrl: result.authorizationUrl,
                purpose: result.purpose,
                expiresAt: result.expiresAt,
            });
        } catch (error) {
            return errorEnvelope(res, error);
        }
    });

    router.post(
        '/callback',
        express.urlencoded({ extended: false, limit: '64kb' }),
        (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            try {
                if (!config?.enabled || !flow) throw disabledError(config);
                const returnUrl = flow.completeAuthorizationCallback({
                    state: req.body?.state,
                    code: req.body?.code,
                    identityToken: req.body?.id_token,
                    user: req.body?.user,
                    appleError: req.body?.error,
                    appleErrorDescription: req.body?.error_description,
                });
                return res.redirect(303, returnUrl);
            } catch (error) {
                const status = Number.isInteger(error?.status)
                    ? error.status
                    : 500;
                res.status(status).type('html').send(
                    '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
                    '<body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;line-height:1.5">' +
                    '<h2>The Agora</h2><p>Apple authentication could not be completed. Return to The Agora and try again.</p></body></html>'
                );
            }
        }
    );

    router.post('/redeem', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            if (!config?.enabled || !flow) throw disabledError(config);
            const credential = flow.redeemHandoff({
                handoff: req.body?.handoff,
                installationId: installationId(req),
            });
            return res.json({
                purpose: credential.purpose,
                challengeId: credential.challengeId,
                identityToken: credential.identityToken,
                authorizationCode: credential.authorizationCode,
                displayName: credential.displayName,
            });
        } catch (error) {
            return errorEnvelope(res, error);
        }
    });

    return router;
}
