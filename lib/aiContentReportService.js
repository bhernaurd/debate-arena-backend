const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const PHILOSOPHER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESPONSE_CHARS = 12_000;

const DEBATE_KINDS = new Set([
    'standard',
    'daily_challenge',
    'ranked',
]);

const REPORT_REASONS = new Set([
    'offensive_or_harmful',
    'inaccurate_or_misleading',
    'misrepresents_philosopher',
    'other',
]);

export class AiContentReportError extends Error {
    constructor(code, message, { status = 400, retryable = false, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'AiContentReportError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AiContentReportError(code, message, options);
}

function requiredText(value, fieldName, maxLength) {
    if (typeof value !== 'string') {
        fail('invalid_ai_content_report', `${fieldName} must be a string.`);
    }
    const cleaned = value.trim();
    if (!cleaned) {
        fail('invalid_ai_content_report', `${fieldName} must not be empty.`);
    }
    if (cleaned.length > maxLength) {
        fail('invalid_ai_content_report', `${fieldName} is too long.`);
    }
    return cleaned;
}

function optionalText(value, fieldName, maxLength) {
    if (value == null) return null;
    return requiredText(value, fieldName, maxLength);
}

function requireUuid(value, fieldName) {
    const cleaned = requiredText(value, fieldName, 64);
    if (!UUID_RE.test(cleaned)) {
        fail('invalid_ai_content_report', `${fieldName} must be a UUID.`);
    }
    return cleaned.toLowerCase();
}

function requireInstallationId(value) {
    const cleaned = requiredText(value, 'installationId', 128);
    if (!INSTALLATION_ID_RE.test(cleaned)) {
        fail('invalid_installation_id', 'X-Installation-ID is invalid.');
    }
    return cleaned;
}

function normalizeReport(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
        fail('invalid_ai_content_report', 'A JSON report object is required.');
    }

    const debateId = requireUuid(report.debateId, 'debateId');
    const messageId = requireUuid(report.messageId, 'messageId');
    const philosopherId = requiredText(report.philosopherId, 'philosopherId', 64);
    if (!PHILOSOPHER_ID_RE.test(philosopherId)) {
        fail('invalid_ai_content_report', 'philosopherId is invalid.');
    }

    const debateKind = requiredText(report.debateKind, 'debateKind', 32);
    if (!DEBATE_KINDS.has(debateKind)) {
        fail('invalid_ai_content_report', 'debateKind is not supported.');
    }

    const reason = requiredText(report.reason, 'reason', 64);
    if (!REPORT_REASONS.has(reason)) {
        fail('invalid_ai_content_report', 'reason is not supported.');
    }

    if (typeof report.responseText !== 'string' || !report.responseText.trim()) {
        fail('invalid_ai_content_report', 'responseText must not be empty.');
    }
    const fullResponse = report.responseText.trim();
    const responseTruncated = fullResponse.length > MAX_RESPONSE_CHARS;
    const responseText = fullResponse.slice(0, MAX_RESPONSE_CHARS);

    return Object.freeze({
        debateId,
        messageId,
        philosopherId,
        debateKind,
        challengeId: optionalText(report.challengeId, 'challengeId', 128),
        reason,
        responseText,
        responseTruncated,
    });
}

function normalizeClientPlatform(value) {
    const cleaned = typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
    if (cleaned === 'ios' || cleaned === 'android') return cleaned;
    return 'android';
}

export function createAiContentReportService({
    pool,
    accountAuthService,
    now = () => new Date(),
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error('AI content reports require a PostgreSQL pool.');
    }
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'AI content reports require accountAuthService.authorizeAccessToken().'
        );
    }

    return Object.freeze({
        async submitReport({
            installationId,
            accessToken,
            report,
            clientPlatform,
            appVersion,
            appBuild,
        } = {}) {
            const cleanInstallationId = requireInstallationId(installationId);
            const cleanAccessToken = requiredText(accessToken, 'accessToken', 16_384);
            const authorization = await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
            });
            const normalized = normalizeReport(report);
            const reportedAt = now();
            if (!(reportedAt instanceof Date) || Number.isNaN(reportedAt.getTime())) {
                throw new Error('AI content report clock returned an invalid date.');
            }

            const result = await pool.query(
                `
                    INSERT INTO ai_content_reports (
                        account_id,
                        installation_id,
                        debate_id,
                        message_id,
                        philosopher_id,
                        debate_kind,
                        challenge_id,
                        reason,
                        response_text,
                        response_truncated,
                        client_platform,
                        app_version,
                        app_build,
                        created_at,
                        last_reported_at
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8,
                        $9, $10, $11, $12, $13, $14, $14
                    )
                    ON CONFLICT (account_id, message_id)
                    DO UPDATE SET
                        installation_id = EXCLUDED.installation_id,
                        debate_id = EXCLUDED.debate_id,
                        philosopher_id = EXCLUDED.philosopher_id,
                        debate_kind = EXCLUDED.debate_kind,
                        challenge_id = EXCLUDED.challenge_id,
                        reason = EXCLUDED.reason,
                        response_text = EXCLUDED.response_text,
                        response_truncated = EXCLUDED.response_truncated,
                        client_platform = EXCLUDED.client_platform,
                        app_version = EXCLUDED.app_version,
                        app_build = EXCLUDED.app_build,
                        last_reported_at = EXCLUDED.last_reported_at
                    RETURNING id, created_at, last_reported_at
                `,
                [
                    authorization.accountId,
                    cleanInstallationId,
                    normalized.debateId,
                    normalized.messageId,
                    normalized.philosopherId,
                    normalized.debateKind,
                    normalized.challengeId,
                    normalized.reason,
                    normalized.responseText,
                    normalized.responseTruncated,
                    normalizeClientPlatform(clientPlatform),
                    optionalText(appVersion, 'appVersion', 64),
                    optionalText(appBuild, 'appBuild', 64),
                    reportedAt,
                ]
            );

            const row = result.rows[0];
            if (!row?.id) {
                fail(
                    'ai_content_report_unavailable',
                    'The report could not be saved. Please try again.',
                    { status: 503, retryable: true }
                );
            }

            return Object.freeze({
                accepted: true,
                reportId: row.id,
                acceptedAt: new Date(row.last_reported_at || reportedAt),
                responseTruncated: normalized.responseTruncated,
            });
        },
    });
}

export const aiContentReportConstants = Object.freeze({
    debateKinds: Object.freeze([...DEBATE_KINDS]),
    reasons: Object.freeze([...REPORT_REASONS]),
    maximumResponseCharacters: MAX_RESPONSE_CHARS,
});
