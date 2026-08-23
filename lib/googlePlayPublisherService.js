import crypto from 'node:crypto';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_PACKAGE_NAME = 'com.bhernaurd.theagora';

export class GooglePlayPublisherError extends Error {
    constructor(code, message, {
        status = 500,
        retryable = false,
        cause,
    } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlayPublisherError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlayPublisherError(code, message, options);
}

function base64Url(value) {
    return Buffer.from(value).toString('base64url');
}

function clean(value) {
    return String(value ?? '').trim();
}

function normalizePrivateKey(value) {
    return clean(value).replace(/\\n/g, '\n');
}

export function loadGooglePlayPublisherConfig(environment = process.env) {
    const rawJson = clean(environment.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
    let serviceAccount = null;

    if (rawJson) {
        try {
            serviceAccount = JSON.parse(rawJson);
        } catch (error) {
            fail(
                'invalid_google_play_service_account_json',
                'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.',
                { cause: error }
            );
        }
    }

    const clientEmail = clean(
        serviceAccount?.client_email ||
        environment.GOOGLE_PLAY_CLIENT_EMAIL
    );
    const privateKey = normalizePrivateKey(
        serviceAccount?.private_key ||
        environment.GOOGLE_PLAY_PRIVATE_KEY
    );
    const tokenUri = clean(
        serviceAccount?.token_uri ||
        environment.GOOGLE_PLAY_TOKEN_URI ||
        GOOGLE_OAUTH_TOKEN_URL
    );
    const packageName = clean(
        environment.GOOGLE_PLAY_PACKAGE_NAME ||
        DEFAULT_PACKAGE_NAME
    );

    if (!clientEmail || !privateKey) {
        fail(
            'google_play_not_configured',
            'Google Play service-account credentials are not configured.',
            { status: 503, retryable: false }
        );
    }

    if (!/^[A-Za-z0-9._]+(?:\.[A-Za-z0-9._]+)+$/.test(packageName)) {
        fail(
            'invalid_google_play_package_name',
            'GOOGLE_PLAY_PACKAGE_NAME is invalid.',
            { status: 500, retryable: false }
        );
    }

    return Object.freeze({
        clientEmail,
        privateKey,
        tokenUri: tokenUri || GOOGLE_OAUTH_TOKEN_URL,
        packageName,
    });
}

function createServiceAccountAssertion(config, nowMs) {
    const issuedAt = Math.floor(nowMs / 1000);
    const header = base64Url(JSON.stringify({
        alg: 'RS256',
        typ: 'JWT',
    }));
    const claims = base64Url(JSON.stringify({
        iss: config.clientEmail,
        scope: GOOGLE_PLAY_SCOPE,
        aud: config.tokenUri,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto
        .sign('RSA-SHA256', Buffer.from(unsigned), config.privateKey)
        .toString('base64url');
    return `${unsigned}.${signature}`;
}

function classifyHttpFailure(status) {
    return {
        retryable:
            status === 408 ||
            status === 429 ||
            status >= 500,
    };
}

function publisherFailureStatus(status) {
    if (status === 400 || status === 404) return 400;
    return 503;
}

function publicGoogleMessage(payload, fallback) {
    const message = clean(payload?.error?.message);
    return message || fallback;
}

export function createGooglePlayPublisherService({
    config = null,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
} = {}) {
    if (typeof fetchImpl !== 'function') {
        fail(
            'invalid_google_play_configuration',
            'A fetch implementation is required.',
            { status: 500 }
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_google_play_configuration',
            'now must be a function.',
            { status: 500 }
        );
    }

    let cachedConfig = config;
    let accessToken = null;
    let accessTokenExpiresAt = 0;

    function resolvedConfig() {
        if (!cachedConfig) {
            cachedConfig = loadGooglePlayPublisherConfig();
        }
        return cachedConfig;
    }

    async function getAccessToken() {
        const nowMs = Number(now());
        if (!Number.isFinite(nowMs) || nowMs < 0) {
            fail(
                'invalid_google_play_configuration',
                'now() returned an invalid value.',
                { status: 500 }
            );
        }

        if (
            accessToken &&
            nowMs + TOKEN_REFRESH_SKEW_MS < accessTokenExpiresAt
        ) {
            return accessToken;
        }

        const serviceConfig = resolvedConfig();
        let assertion;
        try {
            assertion = createServiceAccountAssertion(
                serviceConfig,
                nowMs
            );
        } catch (error) {
            fail(
                'invalid_google_play_private_key',
                'Google Play service-account signing is not configured correctly.',
                {
                    status: 503,
                    retryable: false,
                    cause: error,
                }
            );
        }

        const body = new URLSearchParams({
            grant_type:
                'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
        });

        let response;
        try {
            response = await fetchImpl(serviceConfig.tokenUri, {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded',
                },
                body: body.toString(),
            });
        } catch (error) {
            fail(
                'google_play_oauth_unavailable',
                'Google Play OAuth token exchange is unavailable.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        const payload = await response.json().catch(() => ({}));
        if (
            !response.ok ||
            typeof payload.access_token !== 'string' ||
            !payload.access_token.trim()
        ) {
            const classification = classifyHttpFailure(
                response.status || 500
            );
            fail(
                'google_play_oauth_failed',
                'Google Play OAuth token exchange failed.',
                {
                    // OAuth/service-account failure is server configuration,
                    // never an Agora user's access-token failure.
                    status: 503,
                    retryable: classification.retryable,
                }
            );
        }

        const expiresIn = Number(payload.expires_in);
        const lifetimeSeconds =
            Number.isFinite(expiresIn) && expiresIn > 0
                ? expiresIn
                : TOKEN_LIFETIME_SECONDS;

        accessToken = payload.access_token.trim();
        accessTokenExpiresAt =
            nowMs + lifetimeSeconds * 1000;
        return accessToken;
    }

    async function authorizedJsonRequest(
        url,
        {
            method = 'GET',
            body,
        } = {}
    ) {
        const token = await getAccessToken();
        let response;

        try {
            response = await fetchImpl(url, {
                method,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    ...(body == null
                        ? {}
                        : {
                            'Content-Type':
                                'application/json; charset=utf-8',
                        }),
                },
                ...(body == null
                    ? {}
                    : { body: JSON.stringify(body) }),
            });
        } catch (error) {
            fail(
                'google_play_api_unavailable',
                'Google Play Developer API is unavailable.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        const payload = await response.json().catch(() => ({}));
        return { response, payload };
    }

    async function getSubscription({
        packageName,
        purchaseToken,
    } = {}) {
        const serviceConfig = resolvedConfig();
        const cleanPackageName = clean(packageName);
        const cleanToken = clean(purchaseToken);

        if (!cleanPackageName || cleanPackageName !== serviceConfig.packageName) {
            fail(
                'google_play_package_mismatch',
                'The Google Play purchase package does not match The Agora.',
                { status: 400, retryable: false }
            );
        }

        if (!cleanToken || cleanToken.length > 4096) {
            fail(
                'invalid_google_play_purchase_token',
                'The Google Play purchase token is invalid.',
                { status: 400, retryable: false }
            );
        }

        const url =
            'https://androidpublisher.googleapis.com/androidpublisher/v3/' +
            `applications/${encodeURIComponent(cleanPackageName)}/` +
            'purchases/subscriptionsv2/tokens/' +
            encodeURIComponent(cleanToken);

        const { response, payload } =
            await authorizedJsonRequest(url);

        if (!response.ok) {
            const classification = classifyHttpFailure(response.status);
            const notFound = response.status === 404;
            const status = publisherFailureStatus(response.status);
            fail(
                notFound
                    ? 'google_play_purchase_not_found'
                    : 'google_play_verification_failed',
                notFound
                    ? 'Google Play could not verify this subscription purchase.'
                    : status >= 500
                        ? 'Google Play subscription verification is temporarily unavailable.'
                        : publicGoogleMessage(
                            payload,
                            'Google Play subscription verification failed.'
                        ),
                {
                    status,
                    retryable:
                        status >= 500 ||
                        classification.retryable,
                }
            );
        }

        if (!payload || typeof payload !== 'object') {
            fail(
                'invalid_google_play_response',
                'Google Play returned an invalid subscription response.',
                { status: 503, retryable: true }
            );
        }

        return payload;
    }

    async function acknowledgeSubscription({
        packageName,
        productId,
        purchaseToken,
    } = {}) {
        const serviceConfig = resolvedConfig();
        const cleanPackageName = clean(packageName);
        const cleanProductId = clean(productId);
        const cleanToken = clean(purchaseToken);

        if (!cleanPackageName || cleanPackageName !== serviceConfig.packageName) {
            fail(
                'google_play_package_mismatch',
                'The Google Play purchase package does not match The Agora.',
                { status: 400 }
            );
        }
        if (!cleanProductId || !cleanToken) {
            fail(
                'invalid_google_play_acknowledgement',
                'Google Play acknowledgement information is incomplete.',
                { status: 400 }
            );
        }

        const url =
            'https://androidpublisher.googleapis.com/androidpublisher/v3/' +
            `applications/${encodeURIComponent(cleanPackageName)}/` +
            `purchases/subscriptions/${encodeURIComponent(cleanProductId)}/` +
            `tokens/${encodeURIComponent(cleanToken)}:acknowledge`;

        const { response, payload } =
            await authorizedJsonRequest(url, {
                method: 'POST',
                body: {},
            });

        if (!response.ok) {
            const classification = classifyHttpFailure(response.status);
            const status = publisherFailureStatus(response.status);
            fail(
                'google_play_acknowledgement_failed',
                status >= 500
                    ? 'Google Play subscription acknowledgement is temporarily unavailable.'
                    : publicGoogleMessage(
                        payload,
                        'Google Play subscription acknowledgement failed.'
                    ),
                {
                    status,
                    retryable:
                        status >= 500 ||
                        classification.retryable,
                }
            );
        }

        return true;
    }

    return Object.freeze({
        packageName: () => resolvedConfig().packageName,
        getAccessToken,
        getSubscription,
        acknowledgeSubscription,
    });
}
