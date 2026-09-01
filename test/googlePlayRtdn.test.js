import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createGoogleOidcPushVerifier } from '../lib/googleOidcPushVerifier.js';
import { createGooglePlayRtdnService } from '../lib/googlePlayRtdnService.js';

const PACKAGE_NAME = 'com.bhernaurd.theagora';
const ACCOUNT_ID = '123e4567-e89b-42d3-a456-426614174000';

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function signedGoogleJwt({ audience, email, nowMillis, privateKey, kid }) {
    const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }),
        'utf8'
    ).toString('base64url');
    const nowSeconds = Math.floor(nowMillis / 1000);
    const payload = Buffer.from(
        JSON.stringify({
            iss: 'https://accounts.google.com',
            aud: audience,
            sub: '1234567890',
            email,
            email_verified: true,
            iat: nowSeconds - 5,
            exp: nowSeconds + 300,
        }),
        'utf8'
    ).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = crypto
        .sign('RSA-SHA256', Buffer.from(unsigned, 'ascii'), privateKey)
        .toString('base64url');
    return `${unsigned}.${signature}`;
}

test('Google Pub/Sub OIDC verifier requires Google signature, audience, and service-account email', async () => {
    const nowMillis = Date.UTC(2026, 8, 1, 20, 0, 0);
    const audience = 'https://debate-arena-backend.example/api/account/google-play/rtdn';
    const email = 'play-rtdn@example-project.iam.gserviceaccount.com';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    jwk.kid = 'test-key';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const verifier = createGoogleOidcPushVerifier({
        now: () => nowMillis,
        expectedAudienceProvider: () => audience,
        expectedEmailProvider: () => email,
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => 'public, max-age=3600' },
            async json() {
                return { keys: [jwk] };
            },
        }),
    });

    const token = signedGoogleJwt({
        audience,
        email,
        nowMillis,
        privateKey,
        kid: jwk.kid,
    });
    const verified = await verifier.verifyBearerToken(token);
    assert.equal(verified.audience, audience);
    assert.equal(verified.email, email);

    const wrongAudienceToken = signedGoogleJwt({
        audience: `${audience}/wrong`,
        email,
        nowMillis,
        privateKey,
        kid: jwk.kid,
    });
    await assert.rejects(
        () => verifier.verifyBearerToken(wrongAudienceToken),
        (error) => error?.code === 'invalid_google_push_audience'
    );
});

test('RTDN for a known purchase reuses the stored account but sends the raw token only to the verifier', async () => {
    const purchaseToken = 'raw-play-token-known';
    const tokenHash = sha256Hex(purchaseToken);
    const queryParameters = [];
    const pool = {
        async query(_sql, params) {
            queryParameters.push(params);
            if (params?.[0] === tokenHash) {
                return {
                    rows: [{
                        account_id: ACCOUNT_ID,
                        product_id: 'agora_pro_monthly',
                        pricing_cohort: 'standard',
                        pricing_cohort_paywall_session_id: 'session-1',
                    }],
                };
            }
            return { rows: [] };
        },
    };

    let publisherReads = 0;
    const publisherClient = {
        async getSubscription() {
            publisherReads += 1;
            throw new Error('Known RTDN should not need a preflight publisher read.');
        },
    };
    let syncInput = null;
    const googlePlaySubscriptionService = {
        async syncVerifiedPurchase(input) {
            syncInput = input;
            return {
                acknowledged: true,
                entitlement: { isPro: false, subscriptionState: 'SUBSCRIPTION_STATE_ON_HOLD' },
            };
        },
    };

    const service = createGooglePlayRtdnService({
        pool,
        publisherClient,
        googlePlaySubscriptionService,
        expectedPackageName: PACKAGE_NAME,
    });

    const result = await service.processNotification({
        packageName: PACKAGE_NAME,
        subscriptionNotification: {
            notificationType: 5,
            purchaseToken,
        },
    });

    assert.equal(result.processed, true);
    assert.equal(publisherReads, 0);
    assert.equal(syncInput.authorization.accountId, ACCOUNT_ID);
    assert.equal(syncInput.purchaseToken, purchaseToken);
    assert.equal(syncInput.productId, 'agora_pro_monthly');
    assert.equal(syncInput.basePlanId, null);
    assert.equal(syncInput.offerId, null);
    assert.equal(queryParameters[0][0], tokenHash);
    assert.notEqual(queryParameters[0][0], purchaseToken);
});

test('RTDN replacement token can inherit ownership only from an already-verified linked token', async () => {
    const purchaseToken = 'new-replacement-token';
    const linkedToken = 'old-verified-token';
    const currentHash = sha256Hex(purchaseToken);
    const linkedHash = sha256Hex(linkedToken);

    const pool = {
        async query(_sql, params) {
            if (params?.[0] === currentHash) return { rows: [] };
            if (params?.[0] === linkedHash) {
                return {
                    rows: [{
                        account_id: ACCOUNT_ID,
                        product_id: 'agora_pro_monthly',
                        pricing_cohort: 'founding_2026',
                        pricing_cohort_paywall_session_id: 'founding-session',
                    }],
                };
            }
            return { rows: [] };
        },
    };
    const publisherClient = {
        async getSubscription() {
            return {
                linkedPurchaseToken: linkedToken,
                lineItems: [{
                    productId: 'agora_pro_yearly',
                    expiryTime: '2027-09-01T00:00:00Z',
                }],
            };
        },
    };
    let syncInput = null;
    const googlePlaySubscriptionService = {
        async syncVerifiedPurchase(input) {
            syncInput = input;
            return {
                acknowledged: true,
                entitlement: { isPro: true },
            };
        },
    };

    const service = createGooglePlayRtdnService({
        pool,
        publisherClient,
        googlePlaySubscriptionService,
        expectedPackageName: PACKAGE_NAME,
    });

    const result = await service.processNotification({
        packageName: PACKAGE_NAME,
        subscriptionNotification: {
            notificationType: 4,
            purchaseToken,
        },
    });

    assert.equal(result.processed, true);
    assert.equal(syncInput.authorization.accountId, ACCOUNT_ID);
    assert.equal(syncInput.productId, 'agora_pro_yearly');
    assert.equal(syncInput.pricingCohortHint, 'founding_2026');
});

test('RTDN never guesses ownership for a first-ever unclaimed purchase', async () => {
    const purchaseToken = 'first-purchase-token';
    const pool = {
        async query() {
            return { rows: [] };
        },
    };
    const publisherClient = {
        async getSubscription() {
            return {
                externalAccountIdentifiers: {
                    obfuscatedExternalAccountId: sha256Hex(ACCOUNT_ID),
                },
                lineItems: [{
                    productId: 'agora_pro_monthly',
                    expiryTime: '2026-10-01T00:00:00Z',
                }],
            };
        },
    };
    let syncCalls = 0;
    const googlePlaySubscriptionService = {
        async syncVerifiedPurchase() {
            syncCalls += 1;
            throw new Error('Unclaimed purchase must not be auto-owned.');
        },
    };

    const service = createGooglePlayRtdnService({
        pool,
        publisherClient,
        googlePlaySubscriptionService,
        expectedPackageName: PACKAGE_NAME,
    });

    const result = await service.processNotification({
        packageName: PACKAGE_NAME,
        subscriptionNotification: {
            notificationType: 4,
            purchaseToken,
        },
    });

    assert.deepEqual(result, {
        processed: false,
        reason: 'unclaimed_purchase',
    });
    assert.equal(syncCalls, 0);
});

test('RTDN route verifies Google push identity before processing decoded Pub/Sub data', async () => {
    const source = await readFile(
        new URL('../googlePlaySubscriptionRoutes.js', import.meta.url),
        'utf8'
    );
    const routeStart = source.indexOf("router.post('/rtdn'");
    const verifierCall = source.indexOf(
        'googleOidcPushVerifier.verifyBearerToken(pushToken)',
        routeStart
    );
    const decodeCall = source.indexOf(
        'decodeGooglePlayNotification(req.body)',
        routeStart
    );
    const processCall = source.indexOf(
        'rtdnService.processNotification(notification)',
        routeStart
    );

    assert.ok(routeStart >= 0);
    assert.ok(verifierCall > routeStart);
    assert.ok(decodeCall > verifierCall);
    assert.ok(processCall > decodeCall);
    assert.doesNotMatch(
        source.slice(routeStart, source.indexOf("router.post('/sync-purchase'", routeStart)),
        /logger\.(?:info|error)\([^)]*purchaseToken/s
    );
});
