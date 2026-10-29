import express from 'express';

// Only conversation creation accepts the larger transcript and philosopher
// instructions. Keep the default 50 KB body cap for authentication, billing,
// settings and other unrelated endpoints.
export const DEBATE_JSON_BODY_LIMIT = '512kb';
export const DEBATE_JSON_CREATE_ROUTES = Object.freeze([
    '/api/ai-jobs',
    '/debate',
]);

export const debateJsonBodyParser = express.json({
    limit: DEBATE_JSON_BODY_LIMIT,
});

export function readablePayloadLimitError(error, request, response, next) {
    if (error?.type !== 'entity.too.large') {
        return next(error);
    }

    // A normal JSON response avoids leaking Express's HTML exception page
    // into the debate chat and does not echo submitted private messages.
    const isDebateCreate =
        request.method === 'POST' &&
        DEBATE_JSON_CREATE_ROUTES.includes(request.path);

    return response.status(413).json({
        success: false,
        error: isDebateCreate
            ? 'This debate has grown too long to send. Your conversation has not been submitted. Please save it and start a new debate.'
            : 'This request is too large to process.',
        code: isDebateCreate
            ? 'debate_request_too_large'
            : 'request_payload_too_large',
        retryable: false,
    });
}
