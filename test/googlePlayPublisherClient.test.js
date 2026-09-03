import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    createGooglePlayPublisherClient,
} from '../lib/googlePlaySubscriptionService.js';

const PACKAGE_NAME = 'com.bhernaurd.theagora';
const PRODUCT_ID = 'agora_pro_monthly';
const PURCHASE_TOKEN = 'token/with+reserved characters';
const NOW = Date.parse('2026-08-31T03:30:00.000Z');
const TOKEN_ENDPOINT = 'https://oauth.example.test/token';
const PUBLISHER_ENDPOINT = 'https://publisher.example.test/androidpublisher/v3';
const ACCESS_TOKEN = 'publisher-access-token';

function decodeJwtPart(value) {
    return JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8')
    );
}

function makeJsonResponse(status, value) {
    return {
        status,
        ok: status >= 200 && status < 300,
        async json() {
            return value;
        },
        async text() {
            return JSON.stringify(value);
        },
    };
}

test(
    'Publisher client signs the Android Publisher service-account JWT and uses the v2/v1 endpoints correctly',
    async () => {
        const {
            privateKey,
            publicKey,
        } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
        });
        const privateKeyPem = privateKey.export({
            type: 'pkcs8',
            format: 'pem',
        });
        const publicKeyPem = publicKey.export({
            type: 'spki',
            format: 'pem',
        });

        const requests = [];
        let tokenRequests = 0;
        let publisherGets = 0;
        let acknowledgements = 0;

        const fetchImpl = async (url, options = {}) => {
            requests.push({ url: String(url), options });

            if (String(url) === TOKEN_ENDPOINT) {
                tokenRequests += 1;
                assert.equal(options.method, 'POST');
                assert.match(
                    String(options.headers?.['Content-Type']),
                    /application\/x-www-form-urlencoded/
                );

                const form = new URLSearchParams(
                    String(options.body)
                );
                assert.equal(
                    form.get('grant_type'),
                    'urn:ietf:params:oauth:grant-type:jwt-bearer'
                );

                const assertion = form.get('assertion');
                assert.ok(assertion);
                const [encodedHeader, encodedClaims, encodedSignature] =
                    assertion.split('.');
                const header = decodeJwtPart(encodedHeader);
                const claims = decodeJwtPart(encodedClaims);

                assert.equal(header.alg, 'RS256');
                assert.equal(header.typ, 'JWT');
                assert.equal(header.kid, 'test-key-id');
                assert.equal(
                    claims.iss,
                    'publisher-service@example.test'
                );
                assert.equal(
                    claims.scope,
                    'https://www.googleapis.com/auth/androidpublisher'
                );
                assert.equal(claims.aud, TOKEN_ENDPOINT);
                assert.equal(
                    claims.iat,
                    Math.floor(NOW / 1000)
                );
                assert.equal(
                    claims.exp,
                    Math.floor(NOW / 1000) + 3600
                );

                const signatureValid = crypto.verify(
                    'RSA-SHA256',
                    Buffer.from(
                        `${encodedHeader}.${encodedClaims}`,
                        'ascii'
                    ),
                    publicKeyPem,
                    Buffer.from(encodedSignature, 'base64url')
                );
                assert.equal(signatureValid, true);

                return makeJsonResponse(200, {
                    access_token: ACCESS_TOKEN,
                    expires_in: 3600,
                    token_type: 'Bearer',
                });
            }

            assert.equal(
                options.headers?.Authorization,
                `Bearer ${ACCESS_TOKEN}`
            );

            const encodedPackage =
                encodeURIComponent(PACKAGE_NAME);
            const encodedProduct =
                encodeURIComponent(PRODUCT_ID);
            const encodedToken =
                encodeURIComponent(PURCHASE_TOKEN);

            if (
                String(url) ===
                `${PUBLISHER_ENDPOINT}/applications/${encodedPackage}` +
                `/purchases/subscriptionsv2/tokens/${encodedToken}`
            ) {
                publisherGets += 1;
                assert.equal(options.method, 'GET');
                return makeJsonResponse(200, {
                    subscriptionState:
                        'SUBSCRIPTION_STATE_ACTIVE',
                    lineItems: [],
                });
            }

            if (
                String(url) ===
                `${PUBLISHER_ENDPOINT}/applications/${encodedPackage}` +
                `/purchases/subscriptions/${encodedProduct}` +
                `/tokens/${encodedToken}:acknowledge`
            ) {
                acknowledgements += 1;
                assert.equal(options.method, 'POST');
                assert.deepEqual(
                    JSON.parse(String(options.body)),
                    {}
                );
                return {
                    status: 204,
                    ok: true,
                    async json() {
                        return null;
                    },
                    async text() {
                        return '';
                    },
                };
            }

            throw new Error(`Unexpected URL: ${url}`);
        };

        const client = createGooglePlayPublisherClient({
            fetchImpl,
            now: () => NOW,
            tokenEndpoint: TOKEN_ENDPOINT,
            publisherEndpoint: PUBLISHER_ENDPOINT,
            credentialsProvider: () => ({
                clientEmail:
                    'publisher-service@example.test',
                privateKey: privateKeyPem,
                privateKeyId: 'test-key-id',
            }),
        });

        const snapshot = await client.getSubscription({
            packageName: PACKAGE_NAME,
            purchaseToken: PURCHASE_TOKEN,
        });
        assert.equal(
            snapshot.subscriptionState,
            'SUBSCRIPTION_STATE_ACTIVE'
        );

        const acknowledged =
            await client.acknowledgeSubscription({
                packageName: PACKAGE_NAME,
                productId: PRODUCT_ID,
                purchaseToken: PURCHASE_TOKEN,
            });

        assert.equal(acknowledged, true);
        assert.equal(tokenRequests, 1);
        assert.equal(publisherGets, 1);
        assert.equal(acknowledgements, 1);
        assert.equal(requests.length, 3);
    }
);
