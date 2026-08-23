import crypto from 'crypto';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_SKEW_MILLISECONDS = 60_000;

export class FcmServiceError extends Error {
    constructor(code, message, { retryable = false, permanent = false, status = 500, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'FcmServiceError';
        this.code = code;
        this.retryable = retryable;
        this.permanent = permanent;
        this.status = status;
    }
}

function fail(code, message, options) {
    throw new FcmServiceError(code, message, options);
}

function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(value) {
    return String(value || '').replace(/\\n/g, '\n').trim();
}

export function loadFcmServiceAccountConfig(environment = process.env) {
    const rawJson = String(environment.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    let parsed = null;

    if (rawJson) {
        try {
            parsed = JSON.parse(rawJson);
        } catch (error) {
            fail(
                'invalid_firebase_service_account_json',
                'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
                { cause: error }
            );
        }
    }

    const clientEmail = String(
        parsed?.client_email || environment.FIREBASE_CLIENT_EMAIL || ''
    ).trim();
    const privateKey = normalizePrivateKey(
        parsed?.private_key || environment.FIREBASE_PRIVATE_KEY || ''
    );
    const projectId = String(
        parsed?.project_id || environment.FIREBASE_PROJECT_ID || ''
    ).trim();
    const tokenUri = String(
        parsed?.token_uri || environment.FIREBASE_TOKEN_URI || GOOGLE_OAUTH_TOKEN_URL
    ).trim();

    if (!clientEmail || !privateKey || !projectId) {
        fail(
            'firebase_not_configured',
            'Firebase service-account credentials are not configured for Android push delivery.',
            { retryable: false }
        );
    }

    return Object.freeze({
        clientEmail,
        privateKey,
        projectId,
        tokenUri: tokenUri || GOOGLE_OAUTH_TOKEN_URL,
    });
}

function createServiceAccountAssertion(config, nowMilliseconds) {
    const issuedAt = Math.floor(nowMilliseconds / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(JSON.stringify({
        iss: config.clientEmail,
        sub: config.clientEmail,
        aud: config.tokenUri,
        scope: FCM_SCOPE,
        iat: issuedAt,
        exp: issuedAt + DEFAULT_TOKEN_LIFETIME_SECONDS,
    }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), config.privateKey)
        .toString('base64url');
    return `${unsigned}.${signature}`;
}

function normalizeData(data) {
    const normalized = {};
    for (const [key, value] of Object.entries(data || {})) {
        if (value == null) continue;
        normalized[String(key)] = String(value);
    }
    return normalized;
}

function googleErrorCode(payload) {
    const details = Array.isArray(payload?.error?.details) ? payload.error.details : [];
    for (const detail of details) {
        if (typeof detail?.errorCode === 'string' && detail.errorCode.trim()) {
            return detail.errorCode.trim().toUpperCase();
        }
    }
    const status = String(payload?.error?.status || '').trim().toUpperCase();
    return status || null;
}

function classifyFcmFailure(responseStatus, payload) {
    const code = googleErrorCode(payload) || `HTTP_${responseStatus}`;
    const permanent = code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH';
    const retryable = !permanent && (
        responseStatus === 408 ||
        responseStatus === 429 ||
        responseStatus >= 500 ||
        code === 'UNAVAILABLE' ||
        code === 'INTERNAL' ||
        code === 'QUOTA_EXCEEDED'
    );
    const message = String(payload?.error?.message || `FCM request failed with HTTP ${responseStatus}.`);
    return { code, message, permanent, retryable };
}

export function createFcmService({
    config = null,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
} = {}) {
    if (typeof fetchImpl !== 'function') {
        fail('invalid_fcm_configuration', 'A fetch implementation is required for FCM delivery.');
    }

    let cachedConfig = config;
    let accessToken = null;
    let accessTokenExpiresAt = 0;

    function resolvedConfig() {
        if (!cachedConfig) cachedConfig = loadFcmServiceAccountConfig();
        return cachedConfig;
    }

    async function getAccessToken() {
        const currentTime = now();
        if (accessToken && currentTime + TOKEN_REFRESH_SKEW_MILLISECONDS < accessTokenExpiresAt) {
            return accessToken;
        }

        const serviceConfig = resolvedConfig();
        const assertion = createServiceAccountAssertion(serviceConfig, currentTime);
        const body = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        });

        let response;
        try {
            response = await fetchImpl(serviceConfig.tokenUri, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            });
        } catch (error) {
            fail('firebase_oauth_unavailable', 'Firebase OAuth token exchange is unavailable.', {
                retryable: true,
                cause: error,
            });
        }

        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) {
            fail('firebase_oauth_failed', 'Firebase OAuth token exchange failed.', {
                retryable: response.status >= 500 || response.status === 429,
                status: response.status || 500,
            });
        }

        const expiresInSeconds = Number(payload.expires_in);
        const lifetime = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
            ? expiresInSeconds
            : DEFAULT_TOKEN_LIFETIME_SECONDS;
        accessToken = payload.access_token;
        accessTokenExpiresAt = currentTime + lifetime * 1000;
        return accessToken;
    }

    async function send({ token, title, body, data = {} }) {
        const registrationToken = String(token || '').trim();
        if (!registrationToken) {
            return Object.freeze({
                ok: false,
                reason: 'INVALID_REGISTRATION_TOKEN',
                permanent: true,
                retryable: false,
            });
        }

        try {
            const serviceConfig = resolvedConfig();
            const oauthToken = await getAccessToken();
            const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(serviceConfig.projectId)}/messages:send`;
            const response = await fetchImpl(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${oauthToken}`,
                    'Content-Type': 'application/json; charset=utf-8',
                },
                body: JSON.stringify({
                    message: {
                        token: registrationToken,
                        notification: {
                            title: String(title || 'The Agora'),
                            body: String(body || ''),
                        },
                        data: normalizeData(data),
                        android: {
                            priority: 'normal',
                            notification: {
                                channel_id: 'agora_daily_challenge',
                            },
                        },
                    },
                }),
            });

            const payload = await response.json().catch(() => ({}));
            if (response.ok) {
                return Object.freeze({
                    ok: true,
                    messageName: payload.name || null,
                    permanent: false,
                    retryable: false,
                });
            }

            const failure = classifyFcmFailure(response.status, payload);
            return Object.freeze({
                ok: false,
                reason: failure.code,
                message: failure.message,
                permanent: failure.permanent,
                retryable: failure.retryable,
            });
        } catch (error) {
            if (error instanceof FcmServiceError) {
                return Object.freeze({
                    ok: false,
                    reason: error.code,
                    message: error.message,
                    permanent: error.permanent,
                    retryable: error.retryable,
                });
            }
            return Object.freeze({
                ok: false,
                reason: 'FCM_SEND_FAILED',
                message: error?.message || 'FCM delivery failed.',
                permanent: false,
                retryable: true,
            });
        }
    }

    return Object.freeze({ send, getAccessToken });
}

const defaultFcmService = createFcmService();

export async function sendFcmPush(token, title, body, data = {}) {
    return defaultFcmService.send({ token, title, body, data });
}
