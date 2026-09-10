import crypto from 'crypto';

import {
    AGORA_RECURRING_PRO_PRODUCT_IDS,
} from './agoraProProducts.js';

const DEFAULT_PACKAGE_NAME = 'com.bhernaurd.theagora';
const ANDROID_PUBLISHER_SCOPE =
    'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_TOKEN_ENDPOINT =
    'https://oauth2.googleapis.com/token';
const GOOGLE_PUBLISHER_ENDPOINT =
    'https://androidpublisher.googleapis.com/androidpublisher/v3';
const TOKEN_ASSERTION_GRANT =
    'urn:ietf:params:oauth:grant-type:jwt-bearer';
const MAX_PURCHASE_TOKEN_LENGTH = 16_384;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PRICING_COHORTS = new Set([
    'unknown',
    'founding_2026',
    'standard',
]);

const ENTITLED_NORMALIZED_STATUSES = new Set([
    'trial',
    'active',
    'grace_period',
]);

export class GooglePlaySubscriptionError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
            retryable = false,
            cause,
        } = {}
    ) {
        super(message, cause ? { cause } : undefined);
        this.name = 'GooglePlaySubscriptionError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new GooglePlaySubscriptionError(
        code,
        message,
        options
    );
}

function safeString(value, maximum = 255) {
    if (typeof value !== 'string') return null;
    const cleaned = value.trim();
    if (!cleaned || cleaned.length > maximum) return null;
    return cleaned;
}

function requireString(value, fieldName, maximum = 255) {
    const cleaned = safeString(value, maximum);
    if (!cleaned) {
        fail(
            'invalid_google_play_purchase',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }
    return cleaned;
}

function normalizeAccountId(value) {
    const cleaned = safeString(value, 64);
    if (!cleaned || !UUID_RE.test(cleaned)) {
        fail(
            'invalid_account_session',
            'The Agora account session is invalid or expired.',
            { status: 401 }
        );
    }
    return cleaned.toLowerCase();
}

function sha256Hex(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function constantTimeHexEqual(left, right) {
    const a = safeString(left, 128)?.toLowerCase();
    const b = safeString(right, 128)?.toLowerCase();
    if (!a || !b || !SHA256_HEX_RE.test(a) || !SHA256_HEX_RE.test(b)) {
        return false;
    }
    return crypto.timingSafeEqual(
        Buffer.from(a, 'ascii'),
        Buffer.from(b, 'ascii')
    );
}

function parseDate(value) {
    const cleaned = safeString(value, 128);
    if (!cleaned) return null;
    const date = new Date(cleaned);
    return Number.isNaN(date.getTime()) ? null : date;
}

function encodeJwtPart(value) {
    return Buffer
        .from(JSON.stringify(value), 'utf8')
        .toString('base64url');
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

function loadServiceAccountCredentials() {
    const fromJson = parseServiceAccountJson(
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
    );

    const clientEmail = safeString(
        fromJson?.client_email ??
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL,
        512
    );
    const rawPrivateKey = safeString(
        fromJson?.private_key ??
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY,
        100_000
    );
    const privateKeyId = safeString(
        fromJson?.private_key_id,
        512
    );

    if (!clientEmail || !rawPrivateKey) {
        fail(
            'google_play_not_configured',
            'Google Play subscription verification is not configured.',
            { status: 503, retryable: false }
        );
    }

    return Object.freeze({
        clientEmail,
        privateKey: rawPrivateKey.replace(/\\n/g, '\n'),
        privateKeyId,
    });
}

function googleApiFailureStatus(statusCode) {
    if (statusCode === 404) {
        return {
            code: 'google_play_purchase_not_found',
            status: 400,
            retryable: false,
            message: 'Google Play could not verify this purchase.',
        };
    }

    if (statusCode === 400) {
        return {
            code: 'invalid_google_play_purchase',
            status: 400,
            retryable: false,
            message: 'Google Play could not verify this purchase.',
        };
    }

    if (statusCode === 401 || statusCode === 403) {
        return {
            code: 'google_play_verification_unavailable',
            status: 503,
            retryable: false,
            message: 'Google Play subscription verification is temporarily unavailable.',
        };
    }

    return {
        code: 'google_play_verification_unavailable',
        status: 503,
        retryable: statusCode === 429 || statusCode >= 500,
        message: 'Google Play subscription verification is temporarily unavailable.',
    };
}

export function createGooglePlayPublisherClient({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    credentialsProvider = loadServiceAccountCredentials,
    tokenEndpoint = GOOGLE_TOKEN_ENDPOINT,
    publisherEndpoint = GOOGLE_PUBLISHER_ENDPOINT,
} = {}) {
    let tokenCache = null;

    async function mintAccessToken(force = false) {
        const current = Number(now());
        if (
            !force &&
            tokenCache?.accessToken &&
            tokenCache.expiresAt > current + 60_000
        ) {
            return tokenCache.accessToken;
        }

        if (typeof fetchImpl !== 'function') {
            fail(
                'google_play_verification_unavailable',
                'Google Play subscription verification is temporarily unavailable.',
                { status: 503, retryable: true }
            );
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
            scope: ANDROID_PUBLISHER_SCOPE,
            aud: tokenEndpoint,
            iat: issuedAt,
            exp: issuedAt + 3600,
        };
        const unsigned = `${encodeJwtPart(header)}.${encodeJwtPart(claims)}`;

        let signature;
        try {
            signature = crypto.sign(
                'RSA-SHA256',
                Buffer.from(unsigned, 'ascii'),
                credentials.privateKey
            ).toString('base64url');
        } catch (cause) {
            fail(
                'google_play_not_configured',
                'Google Play subscription verification is not configured.',
                { status: 503, retryable: false, cause }
            );
        }

        let response;
        try {
            response = await fetchImpl(tokenEndpoint, {
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
        } catch (cause) {
            fail(
                'google_play_verification_unavailable',
                'Google Play subscription verification is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }

        let body = null;
        try {
            body = await response.json();
        } catch {}

        const accessToken = safeString(body?.access_token, 16_384);
        const expiresIn = Number(body?.expires_in || 3600);

        if (!response.ok || !accessToken) {
            fail(
                'google_play_verification_unavailable',
                'Google Play subscription verification is temporarily unavailable.',
                {
                    status: 503,
                    retryable: response.status >= 500 || response.status === 429,
                }
            );
        }

        tokenCache = {
            accessToken,
            expiresAt:
                current +
                Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
        };

        return accessToken;
    }

    async function publisherRequest(
        path,
        {
            method = 'GET',
            body = null,
            retryAuthentication = true,
        } = {}
    ) {
        const accessToken = await mintAccessToken(false);
        let response;

        try {
            response = await fetchImpl(`${publisherEndpoint}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    ...(body != null
                        ? { 'Content-Type': 'application/json' }
                        : {}),
                },
                body: body == null ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(12_000),
            });
        } catch (cause) {
            fail(
                'google_play_verification_unavailable',
                'Google Play subscription verification is temporarily unavailable.',
                { status: 503, retryable: true, cause }
            );
        }

        if (response.status === 401 && retryAuthentication) {
            await mintAccessToken(true);
            return publisherRequest(path, {
                method,
                body,
                retryAuthentication: false,
            });
        }

        if (!response.ok) {
            const failure = googleApiFailureStatus(response.status);
            fail(
                failure.code,
                failure.message,
                {
                    status: failure.status,
                    retryable: failure.retryable,
                }
            );
        }

        if (response.status === 204) return null;
        const text = await response.text();
        if (!text) return null;

        try {
            return JSON.parse(text);
        } catch (cause) {
            fail(
                'google_play_verification_unavailable',
                'Google Play subscription verification returned an invalid response.',
                { status: 503, retryable: true, cause }
            );
        }
    }

    return Object.freeze({
        async getSubscription({
            packageName,
            purchaseToken,
        }) {
            return publisherRequest(
                `/applications/${encodeURIComponent(packageName)}` +
                `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`
            );
        },

        async acknowledgeSubscription({
            packageName,
            productId,
            purchaseToken,
        }) {
            await publisherRequest(
                `/applications/${encodeURIComponent(packageName)}` +
                `/purchases/subscriptions/${encodeURIComponent(productId)}` +
                `/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
                {
                    method: 'POST',
                    body: {},
                }
            );
            return true;
        },
    });
}

function verifiedLineItem(snapshot, claimedProductId) {
    const lines = Array.isArray(snapshot?.lineItems)
        ? snapshot.lineItems.filter(
            (item) => item && typeof item === 'object'
        )
        : [];

    const matches = lines.filter(
        (item) => safeString(item?.productId, 200) === claimedProductId
    );

    if (matches.length === 0) {
        fail(
            'google_play_product_mismatch',
            'The verified Google Play purchase does not match this Agora Pro product.',
            { status: 409 }
        );
    }

    return matches
        .slice()
        .sort((left, right) => {
            const leftTime = parseDate(left?.expiryTime)?.getTime() ?? 0;
            const rightTime = parseDate(right?.expiryTime)?.getTime() ?? 0;
            return rightTime - leftTime;
        })[0];
}

function normalizedStatus({
    subscriptionState,
    expiryDate,
    isTrial,
    checkedAt,
}) {
    const hasFutureExpiry =
        expiryDate instanceof Date &&
        expiryDate.getTime() > checkedAt.getTime();

    switch (subscriptionState) {
        case 'SUBSCRIPTION_STATE_ACTIVE':
        case 'SUBSCRIPTION_STATE_CANCELED':
            return hasFutureExpiry
                ? (isTrial ? 'trial' : 'active')
                : 'expired';

        case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
            return hasFutureExpiry
                ? 'grace_period'
                : 'expired';

        case 'SUBSCRIPTION_STATE_PENDING':
        case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
            return 'pending';

        case 'SUBSCRIPTION_STATE_PAUSED':
            return 'paused';

        case 'SUBSCRIPTION_STATE_ON_HOLD':
            return 'on_hold';

        case 'SUBSCRIPTION_STATE_EXPIRED':
        case 'SUBSCRIPTION_STATE_UNSPECIFIED':
        default:
            return 'expired';
    }
}

function schemaUnavailable(error) {
    return error?.code === '42P01';
}

export function createGooglePlaySubscriptionService({
    pool,
    publisherClient = createGooglePlayPublisherClient(),
    expectedPackageName =
        process.env.GOOGLE_PLAY_PACKAGE_NAME ||
        DEFAULT_PACKAGE_NAME,
    now = () => Date.now(),
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error(
            'Google Play subscription service requires a PostgreSQL pool.'
        );
    }

    if (
        !publisherClient ||
        typeof publisherClient.getSubscription !== 'function' ||
        typeof publisherClient.acknowledgeSubscription !== 'function'
    ) {
        throw new Error(
            'Google Play subscription service requires a publisher client.'
        );
    }

    const packageName = requireString(
        expectedPackageName,
        'expectedPackageName',
        255
    );

    async function syncVerifiedPurchase({
        authorization,
        requestedPackageName,
        purchaseToken,
        productId,
        basePlanId = null,
        offerId = null,
        pricingCohortHint = 'unknown',
        paywallSessionId = null,
    }) {
        const accountId = normalizeAccountId(
            authorization?.accountId
        );
        const requestedPackage = requireString(
            requestedPackageName,
            'packageName',
            255
        );
        const token = requireString(
            purchaseToken,
            'purchaseToken',
            MAX_PURCHASE_TOKEN_LENGTH
        );
        const claimedProductId = requireString(
            productId,
            'productId',
            200
        );
        const claimedBasePlanId = basePlanId == null
            ? null
            : requireString(basePlanId, 'basePlanId', 255);
        const claimedOfferId = offerId == null
            ? null
            : requireString(offerId, 'offerId', 255);
        const pricingCohort = safeString(
            pricingCohortHint,
            40
        )?.toLowerCase();
        const cleanPaywallSessionId = paywallSessionId == null
            ? null
            : requireString(paywallSessionId, 'paywallSessionId', 128);

        if (requestedPackage !== packageName) {
            fail(
                'google_play_package_mismatch',
                'The Google Play purchase belongs to a different application.',
                { status: 409 }
            );
        }

        if (!AGORA_RECURRING_PRO_PRODUCT_IDS.has(claimedProductId)) {
            fail(
                'google_play_product_mismatch',
                'The Google Play purchase is not an Agora Pro subscription.',
                { status: 409 }
            );
        }

        if (!pricingCohort || !PRICING_COHORTS.has(pricingCohort)) {
            fail(
                'invalid_google_play_purchase',
                'pricingCohortHint is invalid.',
                { status: 400 }
            );
        }

        const snapshot = await publisherClient.getSubscription({
            packageName,
            purchaseToken: token,
        });

        const lineItem = verifiedLineItem(
            snapshot,
            claimedProductId
        );
        const verifiedBasePlanId = safeString(
            lineItem?.offerDetails?.basePlanId,
            255
        );
        const verifiedOfferId = safeString(
            lineItem?.offerDetails?.offerId,
            255
        );

        if (
            claimedBasePlanId &&
            verifiedBasePlanId !== claimedBasePlanId
        ) {
            fail(
                'google_play_base_plan_mismatch',
                'The verified Google Play base plan does not match this purchase.',
                { status: 409 }
            );
        }

        if (
            claimedOfferId &&
            verifiedOfferId !== claimedOfferId
        ) {
            fail(
                'google_play_offer_mismatch',
                'The verified Google Play offer does not match this purchase.',
                { status: 409 }
            );
        }

        const expectedObfuscatedAccountId = sha256Hex(accountId);
        const verifiedObfuscatedAccountId = safeString(
            snapshot?.externalAccountIdentifiers
                ?.obfuscatedExternalAccountId,
            128
        )?.toLowerCase();

        if (
            !verifiedObfuscatedAccountId ||
            !constantTimeHexEqual(
                verifiedObfuscatedAccountId,
                expectedObfuscatedAccountId
            )
        ) {
            fail(
                'google_play_account_mismatch',
                'This Google Play subscription is linked to a different Agora account.',
                { status: 409 }
            );
        }

        const checkedAt = new Date(Number(now()));
        if (Number.isNaN(checkedAt.getTime())) {
            throw new Error('now() returned an invalid value.');
        }

        const subscriptionState =
            safeString(snapshot?.subscriptionState, 100) ||
            'SUBSCRIPTION_STATE_UNSPECIFIED';
        const expiryDate = parseDate(lineItem?.expiryTime);
        const startTime = parseDate(snapshot?.startTime);
        const isTrial = Boolean(lineItem?.offerPhase?.freeTrial);
        const status = normalizedStatus({
            subscriptionState,
            expiryDate,
            isTrial,
            checkedAt,
        });
        const isPro = ENTITLED_NORMALIZED_STATUSES.has(status);
        const autoRenewEnabled =
            typeof lineItem?.autoRenewingPlan?.autoRenewEnabled === 'boolean'
                ? lineItem.autoRenewingPlan.autoRenewEnabled
                : null;
        const acknowledgementState =
            safeString(snapshot?.acknowledgementState, 100) ||
            'ACKNOWLEDGEMENT_STATE_UNSPECIFIED';
        const purchaseTokenSha256 = sha256Hex(token);
        const linkedPurchaseToken = safeString(
            snapshot?.linkedPurchaseToken,
            MAX_PURCHASE_TOKEN_LENGTH
        );
        const linkedPurchaseTokenSha256 = linkedPurchaseToken
            ? sha256Hex(linkedPurchaseToken)
            : null;
        const latestOrderId = safeString(
            lineItem?.latestSuccessfulOrderId,
            255
        );
        const regionCode = safeString(
            snapshot?.regionCode,
            16
        );
        const testPurchase =
            snapshot?.testPurchase != null;

        let client;

        try {
            client = await pool.connect();
            await client.query('BEGIN');

            await client.query(
                `
                SELECT pg_advisory_xact_lock(
                    hashtext('google-play-subscription'),
                    hashtext($1)
                )
                `,
                [purchaseTokenSha256]
            );

            const existingResult = await client.query(
                `
                SELECT account_id
                FROM google_play_subscription_entitlements
                WHERE purchase_token_sha256 = $1
                FOR UPDATE
                `,
                [purchaseTokenSha256]
            );

            const existingAccountId = existingResult.rows[0]?.account_id
                ? String(existingResult.rows[0].account_id).toLowerCase()
                : null;

            if (
                existingAccountId &&
                existingAccountId !== accountId
            ) {
                fail(
                    'google_play_subscription_already_claimed',
                    'This Google Play subscription is already linked to another Agora account.',
                    { status: 409 }
                );
            }

            if (
                linkedPurchaseTokenSha256 &&
                linkedPurchaseTokenSha256 !== purchaseTokenSha256
            ) {
                const linkedResult = await client.query(
                    `
                    SELECT account_id
                    FROM google_play_subscription_entitlements
                    WHERE purchase_token_sha256 = $1
                    FOR UPDATE
                    `,
                    [linkedPurchaseTokenSha256]
                );

                const linkedAccountId = linkedResult.rows[0]?.account_id
                    ? String(linkedResult.rows[0].account_id).toLowerCase()
                    : null;

                if (
                    linkedAccountId &&
                    linkedAccountId !== accountId
                ) {
                    fail(
                        'google_play_subscription_already_claimed',
                        'The linked Google Play subscription belongs to another Agora account.',
                        { status: 409 }
                    );
                }
            }

            await client.query(
                `
                INSERT INTO google_play_subscription_entitlements (
                    purchase_token_sha256,
                    account_id,
                    package_name,
                    product_id,
                    base_plan_id,
                    offer_id,
                    subscription_state,
                    normalized_status,
                    is_trial,
                    auto_renew_enabled,
                    acknowledgement_state,
                    test_purchase,
                    obfuscated_external_account_id,
                    linked_purchase_token_sha256,
                    latest_order_id,
                    region_code,
                    start_time,
                    expires_date,
                    pricing_cohort,
                    pricing_cohort_source,
                    pricing_cohort_paywall_session_id,
                    verification_source,
                    last_verified_at,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8,
                    $9, $10, $11, $12, $13, $14, $15, $16,
                    $17, $18, $19, $20, $21,
                    'google_play_subscriptions_v2', $22, $22
                )
                ON CONFLICT (purchase_token_sha256) DO UPDATE SET
                    package_name = EXCLUDED.package_name,
                    product_id = EXCLUDED.product_id,
                    base_plan_id = EXCLUDED.base_plan_id,
                    offer_id = EXCLUDED.offer_id,
                    subscription_state = EXCLUDED.subscription_state,
                    normalized_status = EXCLUDED.normalized_status,
                    is_trial = EXCLUDED.is_trial,
                    auto_renew_enabled = EXCLUDED.auto_renew_enabled,
                    acknowledgement_state = EXCLUDED.acknowledgement_state,
                    test_purchase = EXCLUDED.test_purchase,
                    obfuscated_external_account_id =
                        EXCLUDED.obfuscated_external_account_id,
                    linked_purchase_token_sha256 =
                        EXCLUDED.linked_purchase_token_sha256,
                    latest_order_id = EXCLUDED.latest_order_id,
                    region_code = EXCLUDED.region_code,
                    start_time = COALESCE(
                        EXCLUDED.start_time,
                        google_play_subscription_entitlements.start_time
                    ),
                    expires_date = EXCLUDED.expires_date,
                    pricing_cohort = CASE
                        WHEN google_play_subscription_entitlements.pricing_cohort
                            IN ('founding_2026', 'standard')
                            THEN google_play_subscription_entitlements.pricing_cohort
                        ELSE EXCLUDED.pricing_cohort
                    END,
                    pricing_cohort_source = CASE
                        WHEN google_play_subscription_entitlements.pricing_cohort
                            IN ('founding_2026', 'standard')
                            THEN google_play_subscription_entitlements.pricing_cohort_source
                        ELSE EXCLUDED.pricing_cohort_source
                    END,
                    pricing_cohort_paywall_session_id = COALESCE(
                        google_play_subscription_entitlements
                            .pricing_cohort_paywall_session_id,
                        EXCLUDED.pricing_cohort_paywall_session_id
                    ),
                    last_verified_at = EXCLUDED.last_verified_at,
                    updated_at = EXCLUDED.updated_at
                `,
                [
                    purchaseTokenSha256,
                    accountId,
                    packageName,
                    claimedProductId,
                    verifiedBasePlanId,
                    verifiedOfferId,
                    subscriptionState,
                    status,
                    isTrial,
                    autoRenewEnabled,
                    acknowledgementState,
                    testPurchase,
                    verifiedObfuscatedAccountId,
                    linkedPurchaseTokenSha256,
                    latestOrderId,
                    regionCode,
                    startTime,
                    expiryDate,
                    pricingCohort,
                    pricingCohort === 'unknown'
                        ? null
                        : 'client_hint_after_google_verification',
                    cleanPaywallSessionId,
                    checkedAt,
                ]
            );

            if (
                linkedPurchaseTokenSha256 &&
                linkedPurchaseTokenSha256 !== purchaseTokenSha256
            ) {
                await client.query(
                    `
                    UPDATE google_play_subscription_entitlements
                    SET
                        normalized_status = 'replaced',
                        updated_at = NOW()
                    WHERE purchase_token_sha256 = $1
                      AND account_id = $2
                    `,
                    [linkedPurchaseTokenSha256, accountId]
                );
            }

            await client.query('COMMIT');
        } catch (error) {
            if (client) {
                try {
                    await client.query('ROLLBACK');
                } catch {}
            }

            if (error instanceof GooglePlaySubscriptionError) {
                throw error;
            }

            if (schemaUnavailable(error)) {
                fail(
                    'google_play_schema_unavailable',
                    'Google Play subscription verification is not ready on this server.',
                    { status: 503, retryable: true, cause: error }
                );
            }

            fail(
                'google_play_entitlement_unavailable',
                'The Google Play subscription could not be saved.',
                { status: 503, retryable: true, cause: error }
            );
        } finally {
            client?.release();
        }

        let acknowledged =
            acknowledgementState ===
            'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';

        if (
            isPro &&
            !acknowledged &&
            acknowledgementState ===
                'ACKNOWLEDGEMENT_STATE_PENDING'
        ) {
            try {
                acknowledged = await publisherClient
                    .acknowledgeSubscription({
                        packageName,
                        productId: claimedProductId,
                        purchaseToken: token,
                    });
            } catch {
                // Entitlement has already been committed. Android's BillingClient
                // is the safe acknowledgement fallback and will retry locally.
                acknowledged = false;
            }

            if (acknowledged) {
                try {
                    await pool.query(
                        `
                        UPDATE google_play_subscription_entitlements
                        SET
                            acknowledgement_state =
                                'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                            updated_at = NOW()
                        WHERE purchase_token_sha256 = $1
                          AND account_id = $2
                        `,
                        [purchaseTokenSha256, accountId]
                    );
                } catch {
                    // Acknowledgement already succeeded at Google. A later sync
                    // will repair this diagnostic field from the v2 snapshot.
                }
            }
        }

        return Object.freeze({
            acknowledged: Boolean(acknowledged),
            accountOwnership: Object.freeze({
                linked: true,
                accountId,
                migratedLegacyOwnership: false,
                claimSource: 'google_play_verified_account',
            }),
            entitlement: Object.freeze({
                isPro,
                productId: claimedProductId,
                basePlanId: verifiedBasePlanId,
                offerId: verifiedOfferId,
                subscriptionState,
                expiryTime: expiryDate
                    ? expiryDate.toISOString()
                    : null,
                inFreeTrial: isTrial,
            }),
        });
    }

    return Object.freeze({
        syncVerifiedPurchase,
    });
}
