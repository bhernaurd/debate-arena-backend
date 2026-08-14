import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAffiliateSubscriptionAttributionService,
    isAppleOfferCodeTransaction,
    normalizeAppleOfferIdentifier,
    normalizeVerifiedAppleEnvironment,
} from '../lib/affiliateSubscriptionAttributionService.js';

function makeClient({
    existingAttribution = null,
    affiliates = [],
} = {}) {
    const state = {
        attribution: existingAttribution,
        alerts: [],
        resolvedAlerts: [],
        updates: 0,
    };

    return {
        state,
        async query(sql, params = []) {
            const statement = String(sql);

            if (
                statement.includes(
                    'FROM affiliate_subscription_attributions attribution'
                )
            ) {
                return {
                    rows: state.attribution
                        ? [state.attribution]
                        : [],
                    rowCount: state.attribution ? 1 : 0,
                };
            }

            if (
                statement.includes('FROM affiliates') &&
                statement.includes(
                    'normalized_apple_offer_identifier'
                )
            ) {
                const affiliate = affiliates.find(
                    (item) =>
                        item.normalized_apple_offer_identifier ===
                        params[0]
                );

                const normalizedAffiliate = affiliate
                    ? {
                        status: 'active',
                        code_status: 'active',
                        ...affiliate,
                    }
                    : null;

                return {
                    rows: normalizedAffiliate
                        ? [normalizedAffiliate]
                        : [],
                    rowCount: normalizedAffiliate ? 1 : 0,
                };
            }

            if (
                statement.includes(
                    'UPDATE affiliate_subscription_attributions'
                )
            ) {
                state.updates += 1;
                return {
                    rows: [],
                    rowCount: state.attribution ? 1 : 0,
                };
            }

            if (statement.includes('INSERT INTO affiliate_alerts')) {
                state.alerts.push({ params });
                return { rows: [], rowCount: 1 };
            }

            if (statement.includes('UPDATE affiliate_alerts')) {
                state.resolvedAlerts.push({ params });
                return { rows: [], rowCount: 1 };
            }

            if (
                statement.includes(
                    'INSERT INTO affiliate_subscription_attributions'
                )
            ) {
                if (state.attribution) {
                    return { rows: [], rowCount: 0 };
                }

                state.attribution = {
                    id: 'attr-1',
                    affiliate_id: params[0],
                    original_transaction_id: params[1],
                    environment: params[2],
                    attribution_transaction_id: params[3],
                    offer_identifier: params[4],
                    normalized_offer_identifier: params[5],
                    normalized_code:
                        affiliates.find(
                            (item) => item.id === params[0]
                        )?.normalized_code || null,
                };

                return {
                    rows: [state.attribution],
                    rowCount: 1,
                };
            }

            throw new Error(
                `Unexpected SQL in test: ${statement}`
            );
        },
    };
}

const pool = {
    async connect() {
        throw new Error(
            'pool.connect should not be used by observeVerifiedTransaction tests'
        );
    },
};

test('recognizes Apple offerType 3 as an offer-code transaction', () => {
    assert.equal(
        isAppleOfferCodeTransaction({ offerType: 3 }),
        true
    );
    assert.equal(
        isAppleOfferCodeTransaction({ offerType: '3' }),
        true
    );
    assert.equal(
        isAppleOfferCodeTransaction({ offerType: 'OFFER_CODE' }),
        true
    );
    assert.equal(
        isAppleOfferCodeTransaction({ offerType: 2 }),
        false
    );
});

test('normalizes Apple offer reference names for exact matching', () => {
    assert.equal(
        normalizeAppleOfferIdentifier('  MaxAgora-Offer  '),
        'MAXAGORA-OFFER'
    );
});

test('rejects overlong Apple offer identifiers instead of truncating them', () => {
    assert.throws(
        () => normalizeAppleOfferIdentifier('A'.repeat(201)),
        (error) =>
            error?.code ===
            'invalid_affiliate_attribution_input'
    );
});

test('canonicalizes verified Apple environments to the database contract', () => {
    assert.equal(
        normalizeVerifiedAppleEnvironment('Production'),
        'Production'
    );
    assert.equal(
        normalizeVerifiedAppleEnvironment('production'),
        'Production'
    );
    assert.equal(
        normalizeVerifiedAppleEnvironment('Sandbox'),
        'Sandbox'
    );
    assert.throws(
        () => normalizeVerifiedAppleEnvironment('test'),
        (error) =>
            error?.code ===
            'invalid_affiliate_attribution_environment'
    );
});

test('attributes a verified Apple offer-code transaction to the matching affiliate', async () => {
    const client = makeClient({
        affiliates: [
            {
                id: 'affiliate-1',
                normalized_code: 'MAXAGORA',
                normalized_apple_offer_identifier:
                    'MAXAGORA-OFFER',
            },
        ],
    });
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        source: 'client_sync',
        transaction: {
            transactionId: 'tx-1',
            originalTransactionId: 'orig-1',
            offerType: 3,
            offerIdentifier: 'MaxAgora-Offer',
            productId: 'agora_pro_monthly',
            purchaseDate: Date.UTC(2026, 7, 14),
            price: 990,
            currency: 'USD',
        },
    });

    assert.equal(result.status, 'attributed_new');
    assert.equal(result.affiliateId, 'affiliate-1');
    assert.equal(result.environment, 'Production');
    assert.equal(
        client.state.attribution.original_transaction_id,
        'orig-1'
    );
    assert.equal(
        client.state.attribution.environment,
        'Production'
    );
});

test('later renewal without an offer inherits the existing affiliate ownership', async () => {
    const client = makeClient({
        existingAttribution: {
            id: 'attr-1',
            affiliate_id: 'affiliate-1',
            normalized_code: 'MAXAGORA',
            original_transaction_id: 'orig-1',
            environment: 'Production',
        },
    });
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        transaction: {
            transactionId: 'tx-renewal',
            originalTransactionId: 'orig-1',
            offerType: null,
            offerIdentifier: null,
        },
    });

    assert.equal(result.status, 'inherited_existing');
    assert.equal(result.affiliateId, 'affiliate-1');
    assert.equal(client.state.updates, 1);
});

test('a conflicting later affiliate offer never silently reassigns the chain', async () => {
    const client = makeClient({
        existingAttribution: {
            id: 'attr-1',
            affiliate_id: 'affiliate-1',
            normalized_code: 'MAXAGORA',
            original_transaction_id: 'orig-1',
            environment: 'Production',
        },
        affiliates: [
            {
                id: 'affiliate-2',
                normalized_code: 'OTHERAGORA',
                normalized_apple_offer_identifier:
                    'OTHER-OFFER',
            },
        ],
    });
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        transaction: {
            transactionId: 'tx-conflict',
            originalTransactionId: 'orig-1',
            offerType: 3,
            offerIdentifier: 'OTHER-OFFER',
        },
    });

    assert.equal(
        result.status,
        'conflict_preserved_existing'
    );
    assert.equal(result.affiliateId, 'affiliate-1');
    assert.equal(client.state.alerts.length, 1);
});

test('an overlong verified Apple offer identifier is reviewable and never truncated into a mapping', async () => {
    const client = makeClient({
        affiliates: [
            {
                id: 'affiliate-1',
                normalized_code: 'MAXAGORA',
                normalized_apple_offer_identifier: 'A'.repeat(200),
            },
        ],
    });
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        transaction: {
            transactionId: 'tx-overlong-offer',
            originalTransactionId: 'orig-overlong-offer',
            offerType: 3,
            offerIdentifier: 'A'.repeat(201),
        },
    });

    assert.equal(result.status, 'invalid_offer_identifier');
    assert.equal(result.attributed, false);
    assert.equal(client.state.attribution, null);
    assert.equal(client.state.alerts.length, 1);
});

test('a known but inactive affiliate offer never creates new chain ownership', async () => {
    const client = makeClient({
        affiliates: [
            {
                id: 'affiliate-inactive',
                normalized_code: 'OLDAGORA',
                normalized_apple_offer_identifier:
                    'OLD-OFFER',
                status: 'inactive',
                code_status: 'disabled',
            },
        ],
    });
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        transaction: {
            transactionId: 'tx-inactive',
            originalTransactionId: 'orig-inactive',
            offerType: 3,
            offerIdentifier: 'OLD-OFFER',
        },
    });

    assert.equal(
        result.status,
        'inactive_affiliate_offer_identifier'
    );
    assert.equal(result.attributed, false);
    assert.equal(client.state.attribution, null);
    assert.equal(client.state.alerts.length, 1);
});

test('unknown verified Apple offer identifier raises review alert and does not attribute', async () => {
    const client = makeClient();
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Production',
        transaction: {
            transactionId: 'tx-unknown',
            originalTransactionId: 'orig-unknown',
            offerType: 3,
            offerIdentifier: 'UNKNOWN-OFFER',
        },
    });

    assert.equal(result.status, 'unknown_offer_identifier');
    assert.equal(result.attributed, false);
    assert.equal(client.state.alerts.length, 1);
});

test('offer-code transaction missing offerIdentifier is reviewable and never guessed', async () => {
    const client = makeClient();
    const service =
        createAffiliateSubscriptionAttributionService({ pool });

    const result = await service.observeVerifiedTransaction({
        client,
        environment: 'Sandbox',
        transaction: {
            transactionId: 'tx-missing-offer',
            originalTransactionId: 'orig-missing-offer',
            offerType: 3,
            offerIdentifier: null,
        },
    });

    assert.equal(result.status, 'missing_offer_identifier');
    assert.equal(result.attributed, false);
    assert.equal(client.state.alerts.length, 1);
});
