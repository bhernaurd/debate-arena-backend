const INSTALLATION_ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CLAIM_SOURCE_AUTHENTICATED = 'authenticated_sync';
const CLAIM_SOURCE_LEGACY = 'existing_installation_migration';

export class AccountSubscriptionOwnershipError extends Error {
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
        this.name = 'AccountSubscriptionOwnershipError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountSubscriptionOwnershipError(
        code,
        message,
        options
    );
}

function requireObject(value, fieldName) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(
            'invalid_subscription_ownership_input',
            `${fieldName} must be an object.`,
            { status: 400 }
        );
    }

    return value;
}

function requireString(
    value,
    fieldName,
    {
        maxLength = 255,
        pattern = null,
    } = {}
) {
    if (typeof value !== 'string') {
        fail(
            'invalid_subscription_ownership_input',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (!cleaned || cleaned.length > maxLength) {
        fail(
            'invalid_subscription_ownership_input',
            `${fieldName} is invalid.`,
            { status: 400 }
        );
    }

    if (pattern && !pattern.test(cleaned)) {
        fail(
            'invalid_subscription_ownership_input',
            `${fieldName} has an invalid format.`,
            { status: 400 }
        );
    }

    return cleaned;
}

function requireUuid(value, fieldName) {
    return requireString(value, fieldName, {
        maxLength: 64,
        pattern: UUID_RE,
    }).toLowerCase();
}

function requireInstallationId(value) {
    return requireString(value, 'installationId', {
        maxLength: 128,
        pattern: INSTALLATION_ID_RE,
    });
}

function normalizeUuid(value) {
    if (typeof value !== 'string') return null;

    const cleaned = value.trim();
    return UUID_RE.test(cleaned)
        ? cleaned.toLowerCase()
        : null;
}

function normalizeOwnershipType(value) {
    return String(value ?? '')
        .trim()
        .toUpperCase();
}

function isFamilySharedTransaction(transaction) {
    const ownershipType = normalizeOwnershipType(
        transaction?.inAppOwnershipType ??
        transaction?.ownershipType
    );

    return ownershipType.includes('FAMILY');
}

function nowDate(now) {
    const value = now();

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            fail(
                'invalid_subscription_ownership_configuration',
                'now() returned an invalid Date.'
            );
        }

        return value;
    }

    if (!Number.isFinite(value) || value < 0) {
        fail(
            'invalid_subscription_ownership_configuration',
            'now() returned an invalid value.'
        );
    }

    return new Date(value);
}

function normalizeOwnershipRow(row) {
    if (!row) return null;

    return {
        originalTransactionId:
            row.original_transaction_id ??
            row.originalTransactionId,
        environment: row.environment,
        accountId:
            row.account_id ??
            row.accountId,
        ownershipStatus:
            row.ownership_status ??
            row.ownershipStatus,
        claimSource:
            row.claim_source ??
            row.claimSource,
        claimedFromInstallationId:
            row.claimed_from_installation_id ??
            row.claimedFromInstallationId ??
            null,
        verifiedTransactionId:
            row.verified_transaction_id ??
            row.verifiedTransactionId ??
            null,
        observedAppAccountToken:
            row.observed_app_account_token ??
            row.observedAppAccountToken ??
            null,
        claimedAt:
            row.claimed_at ??
            row.claimedAt ??
            null,
        lastVerifiedAt:
            row.last_verified_at ??
            row.lastVerifiedAt ??
            null,
        releasedAt:
            row.released_at ??
            row.releasedAt ??
            null,
        updatedAt:
            row.updated_at ??
            row.updatedAt ??
            null,
    };
}

export function createPostgresAccountSubscriptionOwnershipRepository() {
    return Object.freeze({
        async findLegacyEvidence({
            client,
            accountId,
            installationId,
            originalTransactionId,
            environment,
            observedAppAccountToken,
        }) {
            const result = await client.query(
                `
                SELECT
                    EXISTS (
                        SELECT 1
                        FROM account_installations
                        WHERE account_id = $1
                          AND installation_id = $2
                          AND unlinked_at IS NULL
                    ) AS current_installation_linked,

                    CASE
                        WHEN $5::text IS NULL THEN FALSE
                        ELSE EXISTS (
                            SELECT 1
                            FROM account_installations
                            WHERE account_id = $1
                              AND LOWER(installation_id) = LOWER($5)
                              AND unlinked_at IS NULL
                        )
                    END AS observed_token_linked,

                    EXISTS (
                        SELECT 1
                        FROM subscription_entitlements
                        WHERE original_transaction_id = $3
                          AND environment = $4
                          AND user_id = $2
                    ) AS entitlement_installation_match,

                    EXISTS (
                        SELECT 1
                        FROM subscription_installation_links
                        WHERE original_transaction_id = $3
                          AND environment = $4
                          AND user_id = $2
                    ) AS subscription_link_match
                `,
                [
                    accountId,
                    installationId,
                    originalTransactionId,
                    environment,
                    observedAppAccountToken,
                ]
            );

            const row = result.rows[0] ?? {};

            return Object.freeze({
                currentInstallationLinked:
                    row.current_installation_linked === true,
                observedTokenLinked:
                    row.observed_token_linked === true,
                entitlementInstallationMatch:
                    row.entitlement_installation_match === true,
                subscriptionLinkMatch:
                    row.subscription_link_match === true,
            });
        },


        async lockOwnershipChain({
            client,
            originalTransactionId,
            environment,
        }) {
            await client.query(
                `
                SELECT pg_advisory_xact_lock(
                    hashtext($1),
                    hashtext($2)
                )
                `,
                [originalTransactionId, environment]
            );
        },

        async lockOwnership({
            client,
            originalTransactionId,
            environment,
        }) {
            const result = await client.query(
                `
                SELECT
                    original_transaction_id,
                    environment,
                    account_id,
                    ownership_status,
                    claim_source,
                    claimed_from_installation_id,
                    verified_transaction_id,
                    observed_app_account_token,
                    claimed_at,
                    last_verified_at,
                    released_at,
                    updated_at
                FROM account_subscription_ownership
                WHERE original_transaction_id = $1
                  AND environment = $2
                FOR UPDATE
                `,
                [originalTransactionId, environment]
            );

            return normalizeOwnershipRow(result.rows[0] ?? null);
        },

        async insertOwnership({
            client,
            originalTransactionId,
            environment,
            accountId,
            claimSource,
            installationId,
            transactionId,
            observedAppAccountToken,
            verifiedAt,
        }) {
            const result = await client.query(
                `
                INSERT INTO account_subscription_ownership (
                    original_transaction_id,
                    environment,
                    account_id,
                    ownership_status,
                    claim_source,
                    claimed_from_installation_id,
                    verified_transaction_id,
                    observed_app_account_token,
                    claimed_at,
                    last_verified_at,
                    released_at,
                    updated_at
                )
                VALUES (
                    $1, $2, $3, 'active', $4, $5, $6, $7::uuid,
                    $8, $8, NULL, $8
                )
                RETURNING
                    original_transaction_id,
                    environment,
                    account_id,
                    ownership_status,
                    claim_source,
                    claimed_from_installation_id,
                    verified_transaction_id,
                    observed_app_account_token,
                    claimed_at,
                    last_verified_at,
                    released_at,
                    updated_at
                `,
                [
                    originalTransactionId,
                    environment,
                    accountId,
                    claimSource,
                    installationId,
                    transactionId,
                    observedAppAccountToken,
                    verifiedAt,
                ]
            );

            return normalizeOwnershipRow(result.rows[0]);
        },

        async refreshOwnership({
            client,
            originalTransactionId,
            environment,
            accountId,
            claimSource,
            installationId,
            transactionId,
            observedAppAccountToken,
            verifiedAt,
        }) {
            const result = await client.query(
                `
                UPDATE account_subscription_ownership
                SET
                    ownership_status = 'active',
                    claim_source = CASE
                        WHEN claim_source = 'existing_installation_migration'
                         AND $4 = 'authenticated_sync'
                            THEN 'authenticated_sync'
                        ELSE claim_source
                    END,
                    claimed_from_installation_id =
                        COALESCE(
                            claimed_from_installation_id,
                            $5
                        ),
                    verified_transaction_id =
                        COALESCE($6, verified_transaction_id),
                    observed_app_account_token =
                        COALESCE(
                            $7::uuid,
                            observed_app_account_token
                        ),
                    last_verified_at = $8,
                    released_at = NULL,
                    updated_at = $8
                WHERE original_transaction_id = $1
                  AND environment = $2
                  AND account_id = $3
                RETURNING
                    original_transaction_id,
                    environment,
                    account_id,
                    ownership_status,
                    claim_source,
                    claimed_from_installation_id,
                    verified_transaction_id,
                    observed_app_account_token,
                    claimed_at,
                    last_verified_at,
                    released_at,
                    updated_at
                `,
                [
                    originalTransactionId,
                    environment,
                    accountId,
                    claimSource,
                    installationId,
                    transactionId,
                    observedAppAccountToken,
                    verifiedAt,
                ]
            );

            return normalizeOwnershipRow(result.rows[0]);
        },

        async transferReleasedOwnership({
            client,
            originalTransactionId,
            environment,
            accountId,
            claimSource,
            installationId,
            transactionId,
            observedAppAccountToken,
            verifiedAt,
        }) {
            const result = await client.query(
                `
                UPDATE account_subscription_ownership
                SET
                    account_id = $3,
                    ownership_status = 'active',
                    claim_source = $4,
                    claimed_from_installation_id = $5,
                    verified_transaction_id = $6,
                    observed_app_account_token = $7::uuid,
                    claimed_at = $8,
                    last_verified_at = $8,
                    released_at = NULL,
                    updated_at = $8
                WHERE original_transaction_id = $1
                  AND environment = $2
                  AND ownership_status = 'released'
                RETURNING
                    original_transaction_id,
                    environment,
                    account_id,
                    ownership_status,
                    claim_source,
                    claimed_from_installation_id,
                    verified_transaction_id,
                    observed_app_account_token,
                    claimed_at,
                    last_verified_at,
                    released_at,
                    updated_at
                `,
                [
                    originalTransactionId,
                    environment,
                    accountId,
                    claimSource,
                    installationId,
                    transactionId,
                    observedAppAccountToken,
                    verifiedAt,
                ]
            );

            return normalizeOwnershipRow(result.rows[0] ?? null);
        },
    });
}

export function createAccountSubscriptionOwnershipService({
    pool = null,
    repository = null,
    accountAuthService,
    now = () => Date.now(),
} = {}) {
    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        fail(
            'invalid_subscription_ownership_configuration',
            'accountAuthService.authorizeAccessToken() is required.'
        );
    }

    if (typeof now !== 'function') {
        fail(
            'invalid_subscription_ownership_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountSubscriptionOwnershipRepository();

    const requiredRepositoryMethods = [
        'findLegacyEvidence',
        'lockOwnershipChain',
        'lockOwnership',
        'insertOwnership',
        'refreshOwnership',
        'transferReleasedOwnership',
    ];

    for (const method of requiredRepositoryMethods) {
        if (typeof repo?.[method] !== 'function') {
            fail(
                'invalid_subscription_ownership_configuration',
                `Subscription ownership repository is missing ${method}().`
            );
        }
    }

    if (
        pool &&
        typeof pool.connect !== 'function'
    ) {
        fail(
            'invalid_subscription_ownership_configuration',
            'pool.connect() must be a function.'
        );
    }

    async function authorizeSubscriptionSync({
        installationId,
        accessToken,
    }) {
        const cleanInstallationId =
            requireInstallationId(installationId);
        const cleanAccessToken = requireString(
            accessToken,
            'accessToken',
            { maxLength: 16_384 }
        );

        try {
            return await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
            });
        } catch (error) {
            fail(
                error?.code || 'invalid_account_session',
                error?.message ||
                    'The Agora account session is invalid or expired.',
                {
                    status:
                        Number.isInteger(error?.status)
                            ? error.status
                            : 401,
                    retryable: Boolean(error?.retryable),
                    cause: error,
                }
            );
        }
    }

    async function claimVerifiedSubscription({
        client,
        authorization,
        transaction,
        environment,
    }) {
        if (!client || typeof client.query !== 'function') {
            fail(
                'invalid_subscription_ownership_input',
                'A PostgreSQL transaction client is required.',
                { status: 500 }
            );
        }

        const auth = requireObject(
            authorization,
            'authorization'
        );
        const verifiedTransaction = requireObject(
            transaction,
            'transaction'
        );

        const accountId = requireUuid(
            auth.accountId,
            'authorization.accountId'
        );
        const installationId = requireInstallationId(
            auth.installationId
        );
        const originalTransactionId = requireString(
            verifiedTransaction.originalTransactionId,
            'transaction.originalTransactionId',
            { maxLength: 255 }
        );
        const transactionId = requireString(
            verifiedTransaction.transactionId,
            'transaction.transactionId',
            { maxLength: 255 }
        );
        const cleanEnvironment = requireString(
            environment,
            'environment',
            { maxLength: 64 }
        );
        const observedAppAccountToken = normalizeUuid(
            verifiedTransaction.appAccountToken
        );

        if (isFamilySharedTransaction(verifiedTransaction)) {
            fail(
                'family_shared_subscription_not_claimable',
                'A family-shared subscription cannot be assigned as exclusive Agora account ownership.',
                { status: 409 }
            );
        }

        const evidence = await repo.findLegacyEvidence({
            client,
            accountId,
            installationId,
            originalTransactionId,
            environment: cleanEnvironment,
            observedAppAccountToken,
        });

        if (!evidence.currentInstallationLinked) {
            fail(
                'subscription_installation_not_linked',
                'The authenticated installation is not linked to this Agora account.',
                { status: 401 }
            );
        }

        let claimSource;

        if (observedAppAccountToken === accountId) {
            claimSource = CLAIM_SOURCE_AUTHENTICATED;
        } else {
            const hasLegacyEvidence =
                observedAppAccountToken == null ||
                observedAppAccountToken === installationId.toLowerCase() ||
                evidence.observedTokenLinked ||
                evidence.entitlementInstallationMatch ||
                evidence.subscriptionLinkMatch;

            if (!hasLegacyEvidence) {
                fail(
                    'subscription_account_token_mismatch',
                    'The verified subscription is linked to a different account or installation.',
                    { status: 409 }
                );
            }

            claimSource = CLAIM_SOURCE_LEGACY;
        }

        const verifiedAt = nowDate(now);

        // Serialize every claim for this App Store transaction chain, including
        // the first claim when no ownership row exists yet. SELECT ... FOR
        // UPDATE cannot lock a row that has not been inserted.
        await repo.lockOwnershipChain({
            client,
            originalTransactionId,
            environment: cleanEnvironment,
        });

        const existing = await repo.lockOwnership({
            client,
            originalTransactionId,
            environment: cleanEnvironment,
        });

        const writeInput = {
            client,
            originalTransactionId,
            environment: cleanEnvironment,
            accountId,
            claimSource,
            installationId,
            transactionId,
            observedAppAccountToken,
            verifiedAt,
        };

        let ownership;

        if (!existing) {
            ownership = await repo.insertOwnership(
                writeInput
            );
        } else if (
            String(existing.accountId).toLowerCase() === accountId
        ) {
            if (existing.ownershipStatus === 'disputed') {
                fail(
                    'subscription_ownership_disputed',
                    'This subscription ownership requires support review.',
                    { status: 409 }
                );
            }

            ownership = await repo.refreshOwnership(
                writeInput
            );
        } else if (
            existing.ownershipStatus === 'released'
        ) {
            ownership = await repo.transferReleasedOwnership(
                writeInput
            );

            if (!ownership) {
                fail(
                    'subscription_ownership_conflict',
                    'This subscription was claimed by another account.',
                    { status: 409 }
                );
            }
        } else {
            fail(
                'subscription_already_claimed',
                'This subscription is already linked to another Agora account.',
                { status: 409 }
            );
        }

        if (!ownership) {
            fail(
                'subscription_ownership_persistence_failed',
                'Subscription ownership could not be saved.',
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        return Object.freeze({
            ownership: Object.freeze({
                ...ownership,
                accountId:
                    String(ownership.accountId).toLowerCase(),
            }),
            migratedLegacyOwnership:
                claimSource === CLAIM_SOURCE_LEGACY,
        });
    }

    async function claimVerifiedSubscriptionWithTransaction(input) {
        if (!pool) {
            fail(
                'invalid_subscription_ownership_configuration',
                'A PostgreSQL pool is required for managed transactions.'
            );
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await claimVerifiedSubscription({
                ...input,
                client,
            });

            await client.query('COMMIT');
            return result;
        } catch (error) {
            try {
                await client.query('ROLLBACK');
            } catch {}

            throw error;
        } finally {
            client.release();
        }
    }

    return Object.freeze({
        authorizeSubscriptionSync,
        claimVerifiedSubscription,
        claimVerifiedSubscriptionWithTransaction,
    });
}

export const accountSubscriptionOwnershipConstants =
    Object.freeze({
        claimSources: Object.freeze({
            authenticated: CLAIM_SOURCE_AUTHENTICATED,
            legacyMigration: CLAIM_SOURCE_LEGACY,
        }),
    });
