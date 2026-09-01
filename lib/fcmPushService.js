import crypto from 'crypto';

const FIREBASE_MESSAGING_SCOPE =
    'https://www.googleapis.com/auth/firebase.messaging';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1';
const TOKEN_ASSERTION_GRANT =
    'urn:ietf:params:oauth:grant-type:jwt-bearer';
const DEFAULT_ANDROID_PACKAGE = 'com.bhernaurd.theagora';
const MAX_DEVICE_TOKEN_LENGTH = 4096;

function safeString(value, maximum = 4096) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function parseServiceAccountJson(rawValue) {
    const raw = safeString(rawValue, 200_000);
    if (!raw) return null;

    const candidates = [raw];
    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        if (decoded && decoded !== raw) candidates.push(decoded);
    } catch {}

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {}
    }

    return null;
}

function loadFirebaseCredentials() {
    const fromJson = parseServiceAccountJson(
        process.env.FIREBASE_MESSAGING_SERVICE_ACCOUNT_JSON ||
        process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );

    const clientEmail = safeString(
        fromJson?.client_email ?? process.env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
        512
    );
    const rawPrivateKey = safeString(
        fromJson?.private_key ?? process.env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
        100_000
    );
    const privateKeyId = safeString(fromJson?.private_key_id, 512);
    const projectId = safeString(
        process.env.FIREBASE_PROJECT_ID ?? fromJson?.project_id,
        512
    );

    if (!clientEmail || !rawPrivateKey || !projectId) {
        const error = new Error(
            'Firebase Cloud Messaging is not configured on this server.'
        );
        error.code = 'FCM_NOT_CONFIGURED';
        throw error;
    }

    return Object.freeze({
        clientEmail,
        privateKey: rawPrivateKey.replace(/\\n/g, '\n'),
        privateKeyId,
        projectId,
    });
}

function encodeJwtPart(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function normalizeData(data = {}, { title, body } = {}) {
    const normalized = {
        type: 'daily_challenge',
        title: String(title || ''),
        body: String(body || ''),
        deepLink: 'theagora://daily-challenge',
    };

    if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) {
            if (value == null) continue;
            const cleanKey = String(key || '').trim();
            if (!cleanKey) continue;
            normalized[cleanKey] = String(value);
        }
    }

    return normalized;
}

function fcmErrorCode(body) {
    const details = Array.isArray(body?.error?.details)
        ? body.error.details
        : [];
    for (const detail of details) {
        if (
            detail?.['@type'] ===
            'type.googleapis.com/google.firebase.fcm.v1.FcmError'
        ) {
            const code = safeString(detail?.errorCode, 128);
            if (code) return code;
        }
    }
    return safeString(body?.error?.status, 128) || 'UNKNOWN';
}

export function classifyFcmFailure(statusCode, body) {
    const code = fcmErrorCode(body);
    const permanent =
        code === 'UNREGISTERED' ||
        code === 'SENDER_ID_MISMATCH';
    const retryable =
        statusCode === 429 ||
        statusCode >= 500 ||
        code === 'UNAVAILABLE' ||
        code === 'INTERNAL' ||
        code === 'RESOURCE_EXHAUSTED';

    return Object.freeze({
        code,
        permanent,
        retryable,
    });
}

export function createFcmPushService({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    credentialsProvider = loadFirebaseCredentials,
    tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
    fcmEndpoint = FCM_ENDPOINT,
    androidPackageName =
        process.env.GOOGLE_PLAY_PACKAGE_NAME || DEFAULT_ANDROID_PACKAGE,
} = {}) {
    let tokenCache = null;

    async function mintAccessToken(force = false) {
        const current = Number(now());
        if (
            !force &&
            tokenCache?.accessToken &&
            tokenCache.expiresAt > current + 60_000
        ) {
            return {
                accessToken: tokenCache.accessToken,
                projectId: tokenCache.projectId,
            };
        }

        if (typeof fetchImpl !== 'function') {
            throw Object.assign(new Error('FCM transport is unavailable.'), {
                code: 'FCM_TRANSPORT_UNAVAILABLE',
            });
        }

        const credentials = credentialsProvider();
        const issuedAt = Math.floor(current / 1000);
        const header = {
            alg: 'RS256',
            typ: 'JWT',
            ...(credentials.privateKeyId
                ? { kid: credentials.privateKeyId }
                : {}),
        };
        const claims = {
            iss: credentials.clientEmail,
            scope: FIREBASE_MESSAGING_SCOPE,
            aud: tokenEndpoint,
            iat: issuedAt,
            exp: issuedAt + 3600,
        };
        const unsigned = `${encodeJwtPart(header)}.${encodeJwtPart(claims)}`;
        const signature = crypto
            .sign(
                'RSA-SHA256',
                Buffer.from(unsigned, 'ascii'),
                credentials.privateKey
            )
            .toString('base64url');

        const response = await fetchImpl(tokenEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams({
                grant_type: TOKEN_ASSERTION_GRANT,
                assertion: `${unsigned}.${signature}`,
            }),
            signal: AbortSignal.timeout(10_000),
        });

        let body = null;
        try {
            body = await response.json();
        } catch {}

        const accessToken = safeString(body?.access_token, 16_384);
        if (!response.ok || !accessToken) {
            throw Object.assign(
                new Error('Firebase Cloud Messaging authentication failed.'),
                { code: 'FCM_AUTHENTICATION_FAILED' }
            );
        }

        const expiresIn = Number(body?.expires_in || 3600);
        tokenCache = {
            accessToken,
            projectId: credentials.projectId,
            expiresAt:
                current +
                Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
        };

        return {
            accessToken,
            projectId: credentials.projectId,
        };
    }

    async function sendRequest({
        accessToken,
        projectId,
        deviceToken,
        title,
        body,
        data,
    }) {
        return fetchImpl(
            `${fcmEndpoint}/projects/${encodeURIComponent(projectId)}/messages:send`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    message: {
                        token: deviceToken,
                        data: normalizeData(data, { title, body }),
                        android: {
                            priority: 'HIGH',
                            ttl: '3600s',
                            restricted_package_name: androidPackageName,
                        },
                    },
                }),
                signal: AbortSignal.timeout(12_000),
            }
        );
    }

    async function sendPush(deviceToken, title, body, data = {}) {
        const cleanToken = safeString(deviceToken, MAX_DEVICE_TOKEN_LENGTH);
        if (!cleanToken) {
            return {
                ok: false,
                reason: 'FCM_INVALID_TOKEN',
                permanent: true,
                retryable: false,
                provider: 'fcm',
            };
        }

        try {
            let credentials = await mintAccessToken(false);
            let response = await sendRequest({
                ...credentials,
                deviceToken: cleanToken,
                title,
                body,
                data,
            });

            if (response.status === 401) {
                credentials = await mintAccessToken(true);
                response = await sendRequest({
                    ...credentials,
                    deviceToken: cleanToken,
                    title,
                    body,
                    data,
                });
            }

            let responseBody = null;
            try {
                responseBody = await response.json();
            } catch {}

            if (response.ok) {
                console.log(`[FCM] Sent to ${cleanToken.slice(0, 8)}...`);
                return {
                    ok: true,
                    reason: null,
                    permanent: false,
                    retryable: false,
                    provider: 'fcm',
                    messageName: safeString(responseBody?.name, 2048),
                };
            }

            const failure = classifyFcmFailure(
                response.status,
                responseBody
            );
            console.error(
                `[FCM] Failed to send to ${cleanToken.slice(0, 8)}...: ` +
                `${failure.code} (HTTP ${response.status})`
            );

            return {
                ok: false,
                reason: `FCM_${failure.code}`,
                permanent: failure.permanent,
                retryable: failure.retryable,
                provider: 'fcm',
                statusCode: response.status,
            };
        } catch (error) {
            const reason = safeString(error?.code, 128) || 'FCM_SEND_ERROR';
            console.error(
                `[FCM] Send error to ${cleanToken.slice(0, 8)}...: ${reason}`
            );
            return {
                ok: false,
                reason,
                permanent: false,
                retryable: true,
                provider: 'fcm',
            };
        }
    }

    return Object.freeze({ sendPush });
}

const sharedFcmPushService = createFcmPushService();

export async function sendFcmPush(deviceToken, title, body, data = {}) {
    return sharedFcmPushService.sendPush(deviceToken, title, body, data);
}

export default { sendFcmPush };
