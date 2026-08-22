import crypto from 'crypto';

const ANDROID_PUBLISHER_SCOPE =
    'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_TOKEN_AUDIENCE =
    'https://oauth2.googleapis.com/token';
const GOOGLE_PLAY_API_ORIGIN =
    'https://androidpublisher.googleapis.com';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ALLOWED_COHORTS = new Set([
    'unknown',
    'founding_2026',
    'standard',
]);
const DEFAULT_PRODUCT_IDS = Object.freeze([
    'agora_pro_monthly',
    'agora_pro_yearly',
]);
const ENTITLED_STATUSES = new Set([
    'active',
    'grace_period',
    'canceled_active',
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

function requireString(
    value,
    fieldName,
    {
        maxLength = 16_384,
        pattern = null,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_google_play_input',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (
        !cleaned ||
        cleaned.length > maxLength ||
        (pattern && !pattern.test(cleaned))
    ) {
        fail(
            'invalid_google_play_input',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function optionalString(value, maxLength = 255) {
    if (value == null) return null;
    if (typeof value !== 'string') {
        fail(
            'invalid_google_play_input',
            'An optional Google Play field has an invalid type.',
            { status: 400 }
        );
    }
    const cleaned = value.trim();
    if (!cleaned) return null;
    if (cleaned.length > maxLength) {
        fail(
            'invalid_google_play_input',
            'An optional Google Play field is too long.',
            { status: 400 }
        );
    }
    return cleaned;
}

function requireAccountId(value) {
    return requireString(
        value,
        'accountId',
        {
            maxLength: 64,
            pattern: UUID_RE,
        }
    ).toLowerCase();
}

function sha256Hex(value) {
    return crypto
        .createHash('sha256')
        .update(value, 'utf8')
        .digest('hex');
}

function serviceDate(now) {
    const raw = now();
    const date = raw instanceof Date
        ? new Date(raw.getTime())
        : new Date(raw);

    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_google_play_configuration',
            'now() returned an invalid date.'
        );
    }

    return date;
}

function parseDate(value, fieldName, { required = false } = {}) {
    if (value == null || value === '') {
        if (required) {
            fail(
                'invalid_google_play_response',
                `Google Play did not return ${fieldName}.`,
                { status: 503, retryable: true }
            );
        }
        return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        fail(
            'invalid_google_play_response',
            `Google Play returned an invalid ${fieldName}.`,
            { status: 503, retryable: true }
        );
    }
    return date;
}

function base64urlJson(value) {
    return Buffer.from(
        JSON.stringify(value),
        'utf8'
    ).toString('base64url');
}

function normalizePrivateKey(value) {
    const cleaned = requireString(
        value,
        'Google Play service-account private key',
        { maxLength: 32_768 }
    );
    return cleaned.includes('\\n')
        ? cleaned.replace(/\\n/g, '\n')
        : cleaned;
}

function loadServiceAccount(env) {
    const rawJson = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    if (typeof rawJson === 'string' && rawJson.trim()) {
        let parsed;
        try {
            parsed = JSON.parse(rawJson);
        } catch (error) {
            fail(
                'google_play_configuration_missing',
                'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.',
                { status: 503, retryable: false, cause: error }
            );
        }

        return Object.freeze({
            clientEmail: requireString(
                parsed.client_email,
                'Google Play service-account client email',
                { maxLength: 320 }
            ),
            privateKey: normalizePrivateKey(parsed.private_key),
            tokenUri:
                optionalString(parsed.token_uri, 2048) ||
                GOOGLE_TOKEN_AUDIENCE,
        });
    }

    const email = env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL;
    const key = env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY;
    if (
        typeof email !== 'string' ||
        !email.trim() ||
        typeof key !== 'string' ||
        !key.trim()
    ) {
        fail(
            'google_play_configuration_missing',
            'Google Play service-account credentials are not configured.',
            { status: 503, retryable: false }
        );
    }

    return Object.freeze({
        clientEmail: requireString(
            email,
            'Google Play service-account client email',
            { maxLength: 320 }
        ),
        privateKey: normalizePrivateKey(key),
        tokenUri:
            optionalString(
                env.GOOGLE_PLAY_SERVICE_ACCOUNT_TOKEN_URI,
                2048
            ) || GOOGLE_TOKEN_AUDIENCE,
    });
}

function loadEncryptionKey(env) {
    const raw = env.GOOGLE_PLAY_PURCHASE_TOKEN_ENCRYPTION_KEY;
    if (typeof raw !== 'string' || !raw.trim()) {
        fail(
            'google_play_configuration_missing',
            'GOOGLE_PLAY_PURCHASE_TOKEN_ENCRYPTION_KEY is not configured.',
            { status: 503, retryable: false }
        );
    }

    const cleaned = raw.trim();
    let key;
    try {
        key = Buffer.from(cleaned, 'base64');
    } catch (error) {
        fail(
            'invalid_google_play_configuration',
            'GOOGLE_PLAY_PURCHASE_TOKEN_ENCRYPTION_KEY is not valid Base64.',
            { status: 503, retryable: false, cause: error }
        );
    }

    if (
        key.length !== 32 ||
        key.toString('base64') !== cleaned
    ) {
        fail(
            'invalid_google_play_configuration',
            'GOOGLE_PLAY_PURCHASE_TOKEN_ENCRYPTION_KEY must be canonical Base64 for exactly 32 bytes.',
            { status: 503, retryable: false }
        );
    }

    return key;
}

function tokenAad({ accountId, packageName, tokenHash }) {
    return Buffer.from(
        JSON.stringify({
            purpose: 'agora-google-play-purchase-token-v1',
            accountId,
            packageName,
            tokenHash,
        }),
        'utf8'
    );
}

function encryptPurchaseToken(
    token,
    key,
    binding
) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        key,
        iv,
        { authTagLength: 16 }
    );
    cipher.setAAD(tokenAad(binding));
    const ciphertext = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
        'agoraplay',
        '1',
        iv.toString('base64url'),
        ciphertext.toString('base64url'),
        tag.toString('base64url'),
    ].join('.');
}

function decryptPurchaseToken(
    serialized,
    key,
    binding
) {
    const clean = requireString(
        serialized,
        'encrypted Google Play purchase token',
        { maxLength: 32_768 }
    );
    const parts = clean.split('.');
    if (
        parts.length !== 5 ||
        parts[0] !== 'agoraplay' ||
        parts[1] !== '1'
    ) {
        fail(
            'invalid_google_play_storage',
            'Stored Google Play purchase-token encryption is invalid.',
            { status: 503, retryable: false }
        );
    }

    try {
        const iv = Buffer.from(parts[2], 'base64url');
        const ciphertext = Buffer.from(parts[3], 'base64url');
        const tag = Buffer.from(parts[4], 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
            throw new Error('Invalid AES-GCM envelope.');
        }
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            iv,
            { authTagLength: 16 }
        );
        decipher.setAAD(tokenAad(binding));
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString('utf8');
    } catch (error) {
        fail(
            'invalid_google_play_storage',
            'Stored Google Play purchase token could not be decrypted.',
            { status: 503, retryable: false, cause: error }
        );
    }
}

function normalizeProductIds(env) {
    const configured = String(
        env.GOOGLE_PLAY_AGORA_PRO_PRODUCT_IDS || ''
    )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    return new Set(
        configured.length > 0
            ? configured
            : DEFAULT_PRODUCT_IDS
    );
}

function stateToEntitlementStatus(
    subscriptionState,
    expiryTime,
    checkedAt
) {
    const future =
        expiryTime != null &&
        expiryTime.getTime() > checkedAt.getTime();

    switch (subscriptionState) {
        case 'SUBSCRIPTION_STATE_ACTIVE':
            return future ? 'active' : 'expired';
        case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
            return future ? 'grace_period' : 'expired';
        case 'SUBSCRIPTION_STATE_CANCELED':
            return future ? 'canceled_active' : 'expired';
        case 'SUBSCRIPTION_STATE_PENDING':
            return 'pending';
        case 'SUBSCRIPTION_STATE_PAUSED':
            return 'paused';
        case 'SUBSCRIPTION_STATE_ON_HOLD':
            return 'on_hold';
        case 'SUBSCRIPTION_STATE_EXPIRED':
            return 'expired';
        case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
            return 'pending_purchase_canceled';
        default:
            return 'unknown';
    }
}

function newestMatchingLineItem(
    response,
    requestedProductId
) {
    const lineItems = Array.isArray(response?.lineItems)
        ? response.lineItems
        : [];
    const matching = lineItems.filter(
        (item) => item?.productId === requestedProductId
    );

    if (matching.length === 0) {
        fail(
            'google_play_product_mismatch',
            'The Google Play purchase does not contain the requested Agora Pro product.',
            { status: 403, retryable: false }
        );
    }

    return matching
        .map((item) => ({
            item,
            expiry:
                parseDate(
                    item.expiryTime,
                    'line-item expiryTime'
                )?.getTime() ?? 0,
        }))
        .sort((left, right) => right.expiry - left.expiry)[0]
        .item;
}

function normalizeGooglePurchase({
    response,
    accountId,
    requestedProductId,
    requestedBasePlanId,
    requestedOfferId,
    allowedProductIds,
    checkedAt,
}) {
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        fail(
            'invalid_google_play_response',
            'Google Play returned an invalid subscription response.',
            { status: 503, retryable: true }
        );
    }

    if (!allowedProductIds.has(requestedProductId)) {
        fail(
            'unsupported_google_play_product',
            'The Google Play product is not an Agora Pro subscription.',
            { status: 400, retryable: false }
        );
    }

    const externalAccountId =
        response.externalAccountIdentifiers
            ?.obfuscatedExternalAccountId;

    if (
        typeof externalAccountId !== 'string' ||
        externalAccountId.trim().toLowerCase() !== accountId
    ) {
        fail(
            'google_play_account_mismatch',
            'This Google Play purchase belongs to a different Agora account.',
            { status: 403, retryable: false }
        );
    }

    const lineItem = newestMatchingLineItem(
        response,
        requestedProductId
    );
    const expiryTime = parseDate(
        lineItem.expiryTime,
        'line-item expiryTime',
        { required: true }
    );
    const offerDetails =
        lineItem.offerDetails &&
        typeof lineItem.offerDetails === 'object'
            ? lineItem.offerDetails
            : {};
    const basePlanId =
        optionalString(
            offerDetails.basePlanId,
            200
        );
    const offerId =
        optionalString(
            offerDetails.offerId,
            200
        );

    if (
        requestedBasePlanId &&
        basePlanId &&
        requestedBasePlanId !== basePlanId
    ) {
        fail(
            'google_play_base_plan_mismatch',
            'The Google Play purchase belongs to a different base plan.',
            { status: 403, retryable: false }
        );
    }

    if (
        requestedOfferId &&
        offerId &&
        requestedOfferId !== offerId
    ) {
        fail(
            'google_play_offer_mismatch',
            'The Google Play purchase belongs to a different offer.',
            { status: 403, retryable: false }
        );
    }

    const subscriptionState = requireString(
        response.subscriptionState,
        'Google Play subscriptionState',
        { maxLength: 100 }
    );
    const entitlementStatus = stateToEntitlementStatus(
        subscriptionState,
        expiryTime,
        checkedAt
    );
    const isPro = ENTITLED_STATUSES.has(
        entitlementStatus
    );

    return Object.freeze({
        productId: requestedProductId,
        basePlanId:
            basePlanId || requestedBasePlanId || null,
        offerId:
            offerId || requestedOfferId || null,
        subscriptionState,
        entitlementStatus,
        isPro,
        inFreeTrial: null,
        expiryTime,
        acknowledgementState:
            optionalString(
                response.acknowledgementState,
                100
            ),
        latestOrderId:
            optionalString(
                response.latestOrderId,
                255
            ),
        linkedPurchaseToken:
            optionalString(
                response.linkedPurchaseToken,
                4096
            ),
    });
}

export function createGooglePlayDeveloperApiClient({
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
} = {}) {
    if (typeof fetchImpl !== 'function') {
        fail(
            'invalid_google_play_configuration',
            'A fetch implementation is required.'
        );
    }

    let cachedAccessToken = null;
    let cachedAccessTokenExpiryMs = 0;

    async function accessToken() {
        const nowDate = serviceDate(now);
        if (
            cachedAccessToken &&
            cachedAccessTokenExpiryMs - nowDate.getTime() > 60_000
        ) {
            return cachedAccessToken;
        }

        const credentials = loadServiceAccount(env);
        const iat = Math.floor(nowDate.getTime() / 1000);
        const assertionHeader = base64urlJson({
            alg: 'RS256',
            typ: 'JWT',
        });
        const assertionPayload = base64urlJson({
            iss: credentials.clientEmail,
            scope: ANDROID_PUBLISHER_SCOPE,
            aud: credentials.tokenUri,
            iat,
            exp: iat + 3600,
        });
        const signingInput =
            `${assertionHeader}.${assertionPayload}`;
        let signature;
        try {
            signature = crypto.sign(
                'RSA-SHA256',
                Buffer.from(signingInput, 'utf8'),
                credentials.privateKey
            ).toString('base64url');
        } catch (error) {
            fail(
                'invalid_google_play_configuration',
                'The Google Play service-account private key could not sign an OAuth assertion.',
                { status: 503, retryable: false, cause: error }
            );
        }

        const body = new URLSearchParams({
            grant_type:
                'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion:
                `${signingInput}.${signature}`,
        });

        let response;
        try {
            response = await fetchImpl(
                credentials.tokenUri,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type':
                            'application/x-www-form-urlencoded',
                        Accept: 'application/json',
                    },
                    body: body.toString(),
                }
            );
        } catch (error) {
            fail(
                'google_play_unavailable',
                'Google OAuth is temporarily unavailable.',
                { status: 503, retryable: true, cause: error }
            );
        }

        let payload;
        try {
            payload = await response.json();
        } catch (error) {
            fail(
                'google_play_unavailable',
                'Google OAuth returned an unreadable response.',
                { status: 503, retryable: true, cause: error }
            );
        }

        if (!response.ok || !payload?.access_token) {
            fail(
                'google_play_unavailable',
                'Google OAuth rejected the Android Publisher credentials.',
                {
                    status: 503,
                    retryable: response.status >= 500,
                }
            );
        }

        cachedAccessToken = requireString(
            payload.access_token,
            'Google OAuth access token',
            { maxLength: 16_384 }
        );
        const expiresIn = Number(payload.expires_in || 3600);
        cachedAccessTokenExpiryMs =
            nowDate.getTime() +
            Math.max(60, Math.min(expiresIn, 3600)) * 1000;
        return cachedAccessToken;
    }

    async function googleRequest(url, options = {}) {
        const token = await accessToken();
        let response;
        try {
            response = await fetchImpl(url, {
                ...options,
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    ...(options.headers || {}),
                },
            });
        } catch (error) {
            fail(
                'google_play_unavailable',
                'Google Play Developer API is temporarily unavailable.',
                { status: 503, retryable: true, cause: error }
            );
        }

        if (!response.ok) {
            const retryable =
                response.status === 429 ||
                response.status >= 500;
            if (response.status === 404) {
                fail(
                    'google_play_purchase_not_found',
                    'Google Play could not find this subscription purchase.',
                    { status: 404, retryable: false }
                );
            }
            fail(
                'google_play_unavailable',
                'Google Play could not verify the subscription purchase.',
                {
                    status: retryable ? 503 : 400,
                    retryable,
                }
            );
        }

        return response;
    }

    return Object.freeze({
        async getSubscription({
            packageName,
            purchaseToken,
        }) {
            const url =
                `${GOOGLE_PLAY_API_ORIGIN}/androidpublisher/v3/applications/` +
                `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
                encodeURIComponent(purchaseToken);
            const response = await googleRequest(url);
            try {
                return await response.json();
            } catch (error) {
                fail(
                    'invalid_google_play_response',
                    'Google Play returned an unreadable subscription response.',
                    { status: 503, retryable: true, cause: error }
                );
            }
        },

        async acknowledgeSubscription({
            packageName,
            productId,
            purchaseToken,
        }) {
            const url =
                `${GOOGLE_PLAY_API_ORIGIN}/androidpublisher/v3/applications/` +
                `${encodeURIComponent(packageName)}/purchases/subscriptions/` +
                `${encodeURIComponent(productId)}/tokens/` +
                `${encodeURIComponent(purchaseToken)}:acknowledge`;
            await googleRequest(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: '{}',
            });
            return true;
        },
    });
}

export function createPostgresGooglePlaySubscriptionRepository(
    pool
) {
    if (!pool || typeof pool.query !== 'function') {
        fail(
            'invalid_google_play_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    return Object.freeze({
        async withTransaction(work) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await work(client);
                await client.query('COMMIT');
                return result;
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }
        },

        async findByTokenHashForUpdate(client, tokenHash) {
            const result = await client.query(
                `
                SELECT account_id
                FROM google_play_subscription_entitlements
                WHERE purchase_token_hash = $1
                FOR UPDATE
                `,
                [tokenHash]
            );
            return result.rows[0] ?? null;
        },

        async upsert(client, record) {
            const result = await client.query(
                `
                INSERT INTO google_play_subscription_entitlements (
                    account_id,
                    package_name,
                    purchase_token_hash,
                    purchase_token_encrypted,
                    product_id,
                    base_plan_id,
                    offer_id,
                    pricing_cohort_hint,
                    paywall_session_id,
                    subscription_state,
                    entitlement_status,
                    is_pro,
                    in_free_trial,
                    expiry_time,
                    acknowledgement_state,
                    acknowledged_at,
                    latest_order_id,
                    linked_purchase_token_hash,
                    first_verified_at,
                    last_verified_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,$19,$19
                )
                ON CONFLICT (purchase_token_hash)
                DO UPDATE SET
                    package_name = EXCLUDED.package_name,
                    purchase_token_encrypted = EXCLUDED.purchase_token_encrypted,
                    product_id = EXCLUDED.product_id,
                    base_plan_id = EXCLUDED.base_plan_id,
                    offer_id = EXCLUDED.offer_id,
                    pricing_cohort_hint = EXCLUDED.pricing_cohort_hint,
                    paywall_session_id = COALESCE(EXCLUDED.paywall_session_id, google_play_subscription_entitlements.paywall_session_id),
                    subscription_state = EXCLUDED.subscription_state,
                    entitlement_status = EXCLUDED.entitlement_status,
                    is_pro = EXCLUDED.is_pro,
                    in_free_trial = EXCLUDED.in_free_trial,
                    expiry_time = EXCLUDED.expiry_time,
                    acknowledgement_state = EXCLUDED.acknowledgement_state,
                    acknowledged_at = COALESCE(EXCLUDED.acknowledged_at, google_play_subscription_entitlements.acknowledged_at),
                    latest_order_id = EXCLUDED.latest_order_id,
                    linked_purchase_token_hash = EXCLUDED.linked_purchase_token_hash,
                    last_verified_at = EXCLUDED.last_verified_at,
                    updated_at = EXCLUDED.updated_at
                RETURNING *
                `,
                [
                    record.accountId,
                    record.packageName,
                    record.tokenHash,
                    record.encryptedToken,
                    record.productId,
                    record.basePlanId,
                    record.offerId,
                    record.pricingCohortHint,
                    record.paywallSessionId,
                    record.subscriptionState,
                    record.entitlementStatus,
                    record.isPro,
                    record.inFreeTrial,
                    record.expiryTime,
                    record.acknowledgementState,
                    record.acknowledgedAt,
                    record.latestOrderId,
                    record.linkedPurchaseTokenHash,
                    record.verifiedAt,
                ]
            );
            return result.rows[0];
        },

        async markAcknowledged(tokenHash, acknowledgedAt) {
            const result = await pool.query(
                `
                UPDATE google_play_subscription_entitlements
                SET
                    acknowledgement_state = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
                    acknowledged_at = COALESCE(acknowledged_at, $2),
                    updated_at = $2
                WHERE purchase_token_hash = $1
                RETURNING *
                `,
                [tokenHash, acknowledgedAt]
            );
            return result.rows[0] ?? null;
        },

        async findBestCurrentForAccount(accountId, checkedAt) {
            const result = await pool.query(
                `
                SELECT *
                FROM google_play_subscription_entitlements
                WHERE account_id = $1
                  AND is_pro = TRUE
                  AND expiry_time > $2
                ORDER BY
                    expiry_time DESC,
                    last_verified_at DESC,
                    created_at DESC
                LIMIT 1
                `,
                [accountId, checkedAt]
            );
            return result.rows[0] ?? null;
        },
    });
}

function normalizedStoredAccess(row, accountId, checkedAt) {
    if (!row) {
        return Object.freeze({
            hasProAccess: false,
            accountId,
            source: 'google_play',
            checkedAt,
            entitlement: null,
        });
    }

    const expiryTime = parseDate(
        row.expiry_time,
        'stored Google Play expiryTime',
        { required: true }
    );
    const lastVerifiedAt = parseDate(
        row.last_verified_at,
        'stored Google Play lastVerifiedAt',
        { required: true }
    );

    return Object.freeze({
        hasProAccess:
            row.is_pro === true &&
            ENTITLED_STATUSES.has(row.entitlement_status) &&
            expiryTime.getTime() > checkedAt.getTime(),
        accountId,
        source: 'google_play',
        checkedAt,
        entitlement: Object.freeze({
            productId: row.product_id,
            basePlanId: row.base_plan_id ?? null,
            offerId: row.offer_id ?? null,
            subscriptionState: row.subscription_state,
            status: row.entitlement_status,
            isTrial: row.in_free_trial === true,
            accessExpiresAt: expiryTime,
            expiryTime,
            lastVerifiedAt,
            purchaseTokenHash: row.purchase_token_hash,
            purchaseTokenEncrypted: row.purchase_token_encrypted,
            packageName: row.package_name,
            acknowledgementState:
                row.acknowledgement_state ?? null,
        }),
    });
}

export function createGooglePlaySubscriptionService({
    pool = null,
    repository = null,
    googleClient = null,
    env = process.env,
    now = () => Date.now(),
} = {}) {
    const repo =
        repository ??
        createPostgresGooglePlaySubscriptionRepository(pool);
    if (
        !repo ||
        typeof repo.withTransaction !== 'function' ||
        typeof repo.findByTokenHashForUpdate !== 'function' ||
        typeof repo.upsert !== 'function' ||
        typeof repo.markAcknowledged !== 'function' ||
        typeof repo.findBestCurrentForAccount !== 'function'
    ) {
        fail(
            'invalid_google_play_configuration',
            'A valid Google Play subscription repository is required.'
        );
    }

    const client =
        googleClient ??
        createGooglePlayDeveloperApiClient({
            env,
            now,
        });
    const packageName =
        optionalString(
            env.GOOGLE_PLAY_PACKAGE_NAME,
            255
        ) || 'com.bhernaurd.theagora';
    const allowedProductIds = normalizeProductIds(env);
    const maxVerificationAgeSeconds = Math.max(
        30,
        Math.min(
            Number(
                env.GOOGLE_PLAY_ENTITLEMENT_MAX_VERIFICATION_AGE_SECONDS ||
                300
            ) || 300,
            3600
        )
    );

    function encryptionKey() {
        return loadEncryptionKey(env);
    }

    async function verifyAndPersist({
        accountId,
        requestedPackageName,
        purchaseToken,
        productId,
        basePlanId = null,
        offerId = null,
        pricingCohortHint = 'unknown',
        paywallSessionId = null,
        attemptAcknowledgement = true,
    }) {
        const cleanAccountId = requireAccountId(accountId);
        const cleanPackage = requireString(
            requestedPackageName,
            'packageName',
            { maxLength: 255 }
        );
        if (cleanPackage !== packageName) {
            fail(
                'google_play_package_mismatch',
                'The Google Play purchase belongs to a different Android package.',
                { status: 403, retryable: false }
            );
        }

        const cleanToken = requireString(
            purchaseToken,
            'purchaseToken',
            { maxLength: 16_384 }
        );
        const cleanProduct = requireString(
            productId,
            'productId',
            { maxLength: 200 }
        );
        const cleanBasePlan = optionalString(basePlanId, 200);
        const cleanOffer = optionalString(offerId, 200);
        const cohort = optionalString(pricingCohortHint, 64) || 'unknown';
        if (!ALLOWED_COHORTS.has(cohort)) {
            fail(
                'invalid_google_play_input',
                'pricingCohortHint is invalid.',
                { status: 400 }
            );
        }
        const cleanPaywallSession =
            optionalString(paywallSessionId, 255);
        const verifiedAt = serviceDate(now);
        const response = await client.getSubscription({
            packageName: cleanPackage,
            purchaseToken: cleanToken,
        });
        const normalized = normalizeGooglePurchase({
            response,
            accountId: cleanAccountId,
            requestedProductId: cleanProduct,
            requestedBasePlanId: cleanBasePlan,
            requestedOfferId: cleanOffer,
            allowedProductIds,
            checkedAt: verifiedAt,
        });
        const tokenHash = sha256Hex(cleanToken);
        const encryptedToken = encryptPurchaseToken(
            cleanToken,
            encryptionKey(),
            {
                accountId: cleanAccountId,
                packageName: cleanPackage,
                tokenHash,
            }
        );
        const linkedPurchaseTokenHash =
            normalized.linkedPurchaseToken
                ? sha256Hex(
                    normalized.linkedPurchaseToken
                )
                : null;

        let stored = await repo.withTransaction(
            async (tx) => {
                const existing =
                    await repo.findByTokenHashForUpdate(
                        tx,
                        tokenHash
                    );
                if (
                    existing &&
                    String(existing.account_id).toLowerCase() !==
                        cleanAccountId
                ) {
                    fail(
                        'google_play_purchase_owner_conflict',
                        'This Google Play purchase is already linked to another Agora account.',
                        { status: 409, retryable: false }
                    );
                }

                return repo.upsert(tx, {
                    accountId: cleanAccountId,
                    packageName: cleanPackage,
                    tokenHash,
                    encryptedToken,
                    productId: normalized.productId,
                    basePlanId: normalized.basePlanId,
                    offerId: normalized.offerId,
                    pricingCohortHint: cohort,
                    paywallSessionId: cleanPaywallSession,
                    subscriptionState:
                        normalized.subscriptionState,
                    entitlementStatus:
                        normalized.entitlementStatus,
                    isPro: normalized.isPro,
                    inFreeTrial: normalized.inFreeTrial,
                    expiryTime: normalized.expiryTime,
                    acknowledgementState:
                        normalized.acknowledgementState,
                    acknowledgedAt:
                        normalized.acknowledgementState ===
                        'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'
                            ? verifiedAt
                            : null,
                    latestOrderId:
                        normalized.latestOrderId,
                    linkedPurchaseTokenHash,
                    verifiedAt,
                });
            }
        );

        let acknowledged =
            normalized.acknowledgementState ===
            'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';

        if (
            attemptAcknowledgement &&
            normalized.isPro &&
            !acknowledged
        ) {
            try {
                await client.acknowledgeSubscription({
                    packageName: cleanPackage,
                    productId: normalized.productId,
                    purchaseToken: cleanToken,
                });
                acknowledged = true;
                stored =
                    await repo.markAcknowledged(
                        tokenHash,
                        serviceDate(now)
                    ) || stored;
            } catch (error) {
                // Entitlement verification succeeded and is safely stored. The
                // Android client will also acknowledge only after this server
                // verification response, so an acknowledgement outage must not
                // incorrectly revoke an otherwise valid paid entitlement.
                acknowledged = false;
            }
        }

        return Object.freeze({
            accountId: cleanAccountId,
            packageName: cleanPackage,
            tokenHash,
            acknowledged,
            entitlement: Object.freeze({
                isPro: normalized.isPro,
                productId: normalized.productId,
                basePlanId: normalized.basePlanId,
                offerId: normalized.offerId,
                subscriptionState:
                    normalized.subscriptionState,
                entitlementStatus:
                    normalized.entitlementStatus,
                expiryTime: normalized.expiryTime,
                inFreeTrial:
                    normalized.inFreeTrial,
            }),
            stored,
        });
    }

    async function syncPurchase(input) {
        return verifyAndPersist({
            accountId: input.accountId,
            requestedPackageName:
                input.packageName,
            purchaseToken: input.purchaseToken,
            productId: input.productId,
            basePlanId: input.basePlanId,
            offerId: input.offerId,
            pricingCohortHint:
                input.pricingCohortHint,
            paywallSessionId:
                input.paywallSessionId,
            attemptAcknowledgement: true,
        });
    }

    async function getCurrentAccess({
        accountId,
        forceRefresh = false,
    }) {
        const cleanAccountId = requireAccountId(accountId);
        const checkedAt = serviceDate(now);
        const row = await repo.findBestCurrentForAccount(
            cleanAccountId,
            checkedAt
        );
        let access = normalizedStoredAccess(
            row,
            cleanAccountId,
            checkedAt
        );
        if (!access.hasProAccess || !access.entitlement) {
            return access;
        }

        const ageMs =
            checkedAt.getTime() -
            access.entitlement.lastVerifiedAt.getTime();
        if (
            !forceRefresh &&
            ageMs <= maxVerificationAgeSeconds * 1000
        ) {
            return access;
        }

        const tokenHash =
            access.entitlement.purchaseTokenHash;
        if (!SHA256_RE.test(tokenHash)) {
            fail(
                'invalid_google_play_storage',
                'Stored Google Play purchase-token hash is invalid.',
                { status: 503, retryable: false }
            );
        }
        const purchaseToken = decryptPurchaseToken(
            access.entitlement.purchaseTokenEncrypted,
            encryptionKey(),
            {
                accountId: cleanAccountId,
                packageName:
                    access.entitlement.packageName,
                tokenHash,
            }
        );

        const refreshed = await verifyAndPersist({
            accountId: cleanAccountId,
            requestedPackageName:
                access.entitlement.packageName,
            purchaseToken,
            productId:
                access.entitlement.productId,
            basePlanId:
                access.entitlement.basePlanId,
            offerId:
                access.entitlement.offerId,
            pricingCohortHint: 'unknown',
            paywallSessionId: null,
            attemptAcknowledgement: true,
        });

        access = Object.freeze({
            hasProAccess:
                refreshed.entitlement.isPro,
            accountId: cleanAccountId,
            source: 'google_play',
            checkedAt: serviceDate(now),
            entitlement: Object.freeze({
                productId:
                    refreshed.entitlement.productId,
                basePlanId:
                    refreshed.entitlement.basePlanId,
                offerId:
                    refreshed.entitlement.offerId,
                subscriptionState:
                    refreshed.entitlement.subscriptionState,
                status:
                    refreshed.entitlement.entitlementStatus,
                isTrial:
                    refreshed.entitlement.inFreeTrial === true,
                accessExpiresAt:
                    refreshed.entitlement.expiryTime,
                expiryTime:
                    refreshed.entitlement.expiryTime,
                lastVerifiedAt: serviceDate(now),
            }),
        });
        return access;
    }

    return Object.freeze({
        syncPurchase,
        getCurrentAccess,
        verifyAndPersist,
    });
}

export const googlePlaySubscriptionConstants = Object.freeze({
    defaultProductIds: DEFAULT_PRODUCT_IDS,
    entitledStatuses: Object.freeze(
        [...ENTITLED_STATUSES]
    ),
});
