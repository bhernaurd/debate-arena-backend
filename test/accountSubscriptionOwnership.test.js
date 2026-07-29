import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AccountSubscriptionOwnershipError,
    accountSubscriptionOwnershipConstants,
    createAccountSubscriptionOwnershipService,
} from '../lib/accountSubscriptionOwnership.js';

const ACCOUNT_A =
    '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B =
    '22222222-2222-4222-8222-222222222222';
const INSTALLATION_A =
    '33333333-3333-4333-8333-333333333333';
const LEGACY_INSTALLATION =
    '44444444-4444-4444-8444-444444444444';

const BASE_TRANSACTION = Object.freeze({
    transactionId: 'transaction-100',
    originalTransactionId: 'original-100',
    productId: 'agora_pro_yearly',
    appAccountToken: ACCOUNT_A,
    inAppOwnershipType: 'PURCHASED',
});

function cryptoError(code) {
    return (error) => {
        assert.ok(
            error instanceof AccountSubscriptionOwnershipError
        );
        assert.equal(error.code, code);
        return true;
    };
}

function makeRepository(overrides = {}) {
    const calls = [];

    const repository = {
        async findLegacyEvidence(input) {
            calls.push(['findLegacyEvidence', input]);
            return {
                currentInstallationLinked: true,
                observedTokenLinked: false,
                entitlementInstallationMatch: false,
                subscriptionLinkMatch: false,
            };
        },

        async lockOwnership(input) {
            calls.push(['lockOwnership', input]);
            return null;
        },

        async insertOwnership(input) {
            calls.push(['insertOwnership', input]);
            return {
                originalTransactionId:
                    input.originalTransactionId,
                environment: input.environment,
                accountId: input.accountId,
                ownershipStatus: 'active',
                claimSource: input.claimSource,
                claimedFromInstallationId:
                    input.installationId,
                verifiedTransactionId:
                    input.transactionId,
                observedAppAccountToken:
                    input.observedAppAccountToken,
                claimedAt: input.verifiedAt,
                lastVerifiedAt: input.verifiedAt,
                releasedAt: null,
                updatedAt: input.verifiedAt,
            };
        },

        async refreshOwnership(input) {
            calls.push(['refreshOwnership', input]);
            return {
                originalTransactionId:
                    input.originalTransactionId,
                environment: input.environment,
                accountId: input.accountId,
                ownershipStatus: 'active',
                claimSource: input.claimSource,
                claimedFromInstallationId:
                    input.installationId,
                verifiedTransactionId:
                    input.transactionId,
                observedAppAccountToken:
                    input.observedAppAccountToken,
                claimedAt: input.verifiedAt,
                lastVerifiedAt: input.verifiedAt,
                releasedAt: null,
                updatedAt: input.verifiedAt,
            };
        },

        async transferReleasedOwnership(input) {
            calls.push(['transferReleasedOwnership', input]);
            return {
                originalTransactionId:
                    input.originalTransactionId,
                environment: input.environment,
                accountId: input.accountId,
                ownershipStatus: 'active',
                claimSource: input.claimSource,
                claimedFromInstallationId:
                    input.installationId,
                verifiedTransactionId:
                    input.transactionId,
                observedAppAccountToken:
                    input.observedAppAccountToken,
                claimedAt: input.verifiedAt,
                lastVerifiedAt: input.verifiedAt,
                releasedAt: null,
                updatedAt: input.verifiedAt,
            };
        },

        ...overrides,
    };

    return { repository, calls };
}

function makeService({
    repositoryOverrides = {},
    authorizeOverride = null,
} = {}) {
    const { repository, calls } =
        makeRepository(repositoryOverrides);

    const accountAuthService = {
        async authorizeAccessToken(input) {
            if (authorizeOverride) {
                return authorizeOverride(input);
            }

            return {
                accountId: ACCOUNT_A,
                sessionId:
                    '55555555-5555-4555-8555-555555555555',
                installationId: INSTALLATION_A,
                authVersion: 1,
            };
        },
    };

    const service =
        createAccountSubscriptionOwnershipService({
            repository,
            accountAuthService,
            now: () =>
                Date.UTC(2026, 6, 28, 21, 0, 0),
        });

    return { service, calls };
}

const fakeClient = {
    async query() {
        throw new Error(
            'The injected test repository should handle queries.'
        );
    },
};

test('authorizes subscription sync through the account session service', async () => {
    let captured;

    const { service } = makeService({
        authorizeOverride(input) {
            captured = input;
            return {
                accountId: ACCOUNT_A,
                sessionId:
                    '55555555-5555-4555-8555-555555555555',
                installationId: INSTALLATION_A,
                authVersion: 1,
            };
        },
    });

    const result =
        await service.authorizeSubscriptionSync({
            installationId: INSTALLATION_A,
            accessToken: 'header.payload.signature',
        });

    assert.equal(captured.installationId, INSTALLATION_A);
    assert.equal(
        captured.accessToken,
        'header.payload.signature'
    );
    assert.equal(result.accountId, ACCOUNT_A);
});

test('claims a new subscription whose appAccountToken is the Agora account ID', async () => {
    const { service, calls } = makeService();

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Sandbox',
        });

    assert.equal(
        result.ownership.claimSource,
        accountSubscriptionOwnershipConstants
            .claimSources.authenticated
    );
    assert.equal(result.migratedLegacyOwnership, false);
    assert.equal(calls.at(-1)[0], 'insertOwnership');
});

test('migrates a legacy subscription whose appAccountToken is the current installation ID', async () => {
    const { service } = makeService();

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                appAccountToken: INSTALLATION_A,
            },
            environment: 'Production',
        });

    assert.equal(
        result.ownership.claimSource,
        accountSubscriptionOwnershipConstants
            .claimSources.legacyMigration
    );
    assert.equal(result.migratedLegacyOwnership, true);
});

test('migrates a subscription tied to another installation already linked to the same account', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async findLegacyEvidence() {
                return {
                    currentInstallationLinked: true,
                    observedTokenLinked: true,
                    entitlementInstallationMatch: false,
                    subscriptionLinkMatch: false,
                };
            },
        },
    });

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                appAccountToken: LEGACY_INSTALLATION,
            },
            environment: 'Production',
        });

    assert.equal(result.migratedLegacyOwnership, true);
});

test('migrates a verified legacy transaction with no appAccountToken', async () => {
    const { service } = makeService();

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                appAccountToken: null,
            },
            environment: 'Production',
        });

    assert.equal(result.migratedLegacyOwnership, true);
});

test('accepts legacy database evidence for the current installation', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async findLegacyEvidence() {
                return {
                    currentInstallationLinked: true,
                    observedTokenLinked: false,
                    entitlementInstallationMatch: true,
                    subscriptionLinkMatch: false,
                };
            },
        },
    });

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                appAccountToken: ACCOUNT_B,
            },
            environment: 'Production',
        });

    assert.equal(result.migratedLegacyOwnership, true);
});

test('rejects an unknown appAccountToken without legacy evidence', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                appAccountToken: ACCOUNT_B,
            },
            environment: 'Production',
        }),
        cryptoError('subscription_account_token_mismatch')
    );
});

test('rejects family-shared subscriptions as exclusive account ownership', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: {
                ...BASE_TRANSACTION,
                inAppOwnershipType: 'FAMILY_SHARED',
            },
            environment: 'Production',
        }),
        cryptoError(
            'family_shared_subscription_not_claimable'
        )
    );
});

test('rejects ownership when the authenticated installation is no longer linked', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async findLegacyEvidence() {
                return {
                    currentInstallationLinked: false,
                    observedTokenLinked: false,
                    entitlementInstallationMatch: false,
                    subscriptionLinkMatch: false,
                };
            },
        },
    });

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        }),
        cryptoError(
            'subscription_installation_not_linked'
        )
    );
});

test('refreshes an existing ownership row for the same account', async () => {
    const { service, calls } = makeService({
        repositoryOverrides: {
            async lockOwnership() {
                return {
                    originalTransactionId: 'original-100',
                    environment: 'Production',
                    accountId: ACCOUNT_A,
                    ownershipStatus: 'active',
                    claimSource:
                        'existing_installation_migration',
                };
            },
        },
    });

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        });

    assert.equal(
        result.ownership.accountId,
        ACCOUNT_A.toLowerCase()
    );
    assert.equal(calls.at(-1)[0], 'refreshOwnership');
});

test('rejects a subscription actively owned by another account', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async lockOwnership() {
                return {
                    originalTransactionId: 'original-100',
                    environment: 'Production',
                    accountId: ACCOUNT_B,
                    ownershipStatus: 'active',
                    claimSource: 'authenticated_sync',
                };
            },
        },
    });

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        }),
        cryptoError('subscription_already_claimed')
    );
});

test('allows an explicitly released subscription to transfer accounts', async () => {
    const { service, calls } = makeService({
        repositoryOverrides: {
            async lockOwnership() {
                return {
                    originalTransactionId: 'original-100',
                    environment: 'Production',
                    accountId: ACCOUNT_B,
                    ownershipStatus: 'released',
                    claimSource: 'manual_support',
                };
            },
        },
    });

    const result =
        await service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        });

    assert.equal(result.ownership.accountId, ACCOUNT_A);
    assert.equal(
        calls.at(-1)[0],
        'transferReleasedOwnership'
    );
});

test('rejects a disputed ownership row even for the same account', async () => {
    const { service } = makeService({
        repositoryOverrides: {
            async lockOwnership() {
                return {
                    originalTransactionId: 'original-100',
                    environment: 'Production',
                    accountId: ACCOUNT_A,
                    ownershipStatus: 'disputed',
                    claimSource: 'manual_support',
                };
            },
        },
    });

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: ACCOUNT_A,
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        }),
        cryptoError('subscription_ownership_disputed')
    );
});

test('rejects malformed ownership input', async () => {
    const { service } = makeService();

    await assert.rejects(
        () => service.claimVerifiedSubscription({
            client: fakeClient,
            authorization: {
                accountId: 'not-a-uuid',
                installationId: INSTALLATION_A,
            },
            transaction: BASE_TRANSACTION,
            environment: 'Production',
        }),
        cryptoError(
            'invalid_subscription_ownership_input'
        )
    );
});
