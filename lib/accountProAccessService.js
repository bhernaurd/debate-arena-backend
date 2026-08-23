import {
    AGORA_PRO_PRODUCT_IDS,
} from '../appStoreSubscriptionVerifier.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PRO_ACCESS_STATUSES = Object.freeze([
    'trial',
    'active',
    'grace_period',
]);

export class AccountProAccessError extends Error {
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
        this.name = 'AccountProAccessError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new AccountProAccessError(
        code,
        message,
        options
    );
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
            'invalid_pro_access_input',
            `${fieldName} must be a string.`,
            { status: 400 }
        );
    }

    const cleaned = value.trim();

    if (
        !cleaned ||
        cleaned.length > maxLength ||
        (
            pattern &&
            !pattern.test(cleaned)
        )
    ) {
        fail(
            'invalid_pro_access_input',
            `${fieldName} is invalid.`,
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

function serviceDate(now) {
    const value = now();

    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            fail(
                'invalid_pro_access_configuration',
                'now() returned an invalid Date.'
            );
        }

        return value;
    }

    if (
        !Number.isFinite(value) ||
        value < 0
    ) {
        fail(
            'invalid_pro_access_configuration',
            'now() returned an invalid value.'
        );
    }

    return new Date(value);
}

function normalizeDate(
    value,
    fieldName,
    {
        required = false,
    } = {}
) {
    if (value == null) {
        if (required) {
            fail(
                'pro_access_unavailable',
                `The subscription record is missing ${fieldName}.`,
                {
                    status: 503,
                    retryable: true,
                }
            );
        }

        return null;
    }

    const date =
        value instanceof Date
            ? value
            : new Date(value);

    if (Number.isNaN(date.getTime())) {
        fail(
            'pro_access_unavailable',
            `The subscription record contains an invalid ${fieldName}.`,
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return date;
}

function rowValue(
    row,
    snakeCase,
    camelCase
) {
    if (
        Object.prototype.hasOwnProperty.call(
            row,
            snakeCase
        )
    ) {
        return row[snakeCase];
    }

    return row[camelCase];
}

function normalizeAccessRow(
    row,
    expectedAccountId,
    checkedAt
) {
    if (row == null) {
        return Object.freeze({
            hasProAccess: false,
            accountId: expectedAccountId,
            checkedAt,
            entitlement: null,
        });
    }

    if (
        typeof row !== 'object' ||
        Array.isArray(row)
    ) {
        fail(
            'pro_access_unavailable',
            'The subscription lookup returned an invalid record.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accountId = requireAccountId(
        rowValue(
            row,
            'account_id',
            'accountId'
        )
    );

    if (accountId !== expectedAccountId) {
        fail(
            'pro_access_account_mismatch',
            'The subscription lookup returned a different account.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    const originalTransactionId =
        requireString(
            rowValue(
                row,
                'original_transaction_id',
                'originalTransactionId'
            ),
            'originalTransactionId',
            { maxLength: 255 }
        );

    const environment =
        requireString(
            rowValue(
                row,
                'environment',
                'environment'
            ),
            'environment',
            { maxLength: 64 }
        );

    const productId =
        requireString(
            rowValue(
                row,
                'product_id',
                'productId'
            ),
            'productId',
            { maxLength: 200 }
        );

    const status =
        requireString(
            rowValue(
                row,
                'status',
                'status'
            ),
            'status',
            { maxLength: 64 }
        ).toLowerCase();

    if (!AGORA_PRO_PRODUCT_IDS.has(productId)) {
        fail(
            'pro_access_unavailable',
            'The subscription lookup returned an unsupported product.',
            {
                status: 503,
                retryable: false,
            }
        );
    }

    if (!PRO_ACCESS_STATUSES.includes(status)) {
        fail(
            'pro_access_unavailable',
            'The subscription lookup returned a non-entitled status.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const expiresAt =
        normalizeDate(
            rowValue(
                row,
                'expires_date',
                'expiresDate'
            ),
            'expiresDate',
            {
                required:
                    status === 'trial' ||
                    status === 'active',
            }
        );

    const gracePeriodExpiresAt =
        normalizeDate(
            rowValue(
                row,
                'grace_period_expires_date',
                'gracePeriodExpiresDate'
            ),
            'gracePeriodExpiresDate',
            {
                required:
                    status === 'grace_period',
            }
        );

    const revocationDate =
        normalizeDate(
            rowValue(
                row,
                'revocation_date',
                'revocationDate'
            ),
            'revocationDate'
        );

    const lastSignedAt =
        normalizeDate(
            rowValue(
                row,
                'last_signed_date',
                'lastSignedDate'
            ),
            'lastSignedDate'
        );

    if (revocationDate != null) {
        fail(
            'pro_access_unavailable',
            'The subscription lookup returned a revoked entitlement.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    const accessExpiresAt =
        status === 'grace_period'
            ? gracePeriodExpiresAt
            : expiresAt;

    if (
        !accessExpiresAt ||
        accessExpiresAt.getTime() <=
            checkedAt.getTime()
    ) {
        fail(
            'pro_access_unavailable',
            'The subscription lookup returned an expired entitlement.',
            {
                status: 503,
                retryable: true,
            }
        );
    }

    return Object.freeze({
        hasProAccess: true,
        accountId,
        checkedAt,
        entitlement: Object.freeze({
            originalTransactionId,
            environment,
            productId,
            status,
            isTrial:
                rowValue(
                    row,
                    'is_trial',
                    'isTrial'
                ) === true,
            accessExpiresAt,
            expiresAt,
            gracePeriodExpiresAt,
            lastSignedAt,
        }),
    });
}

export function createPostgresAccountProAccessRepository(
    pool
) {
    if (
        !pool ||
        typeof pool.query !== 'function'
    ) {
        fail(
            'invalid_pro_access_configuration',
            'A PostgreSQL pool is required.'
        );
    }

    return Object.freeze({
        async findCurrentAccess({
            accountId,
            checkedAt,
        }) {
            const productIds =
                Array.from(
                    AGORA_PRO_PRODUCT_IDS
                );

            const result =
                await pool.query(
                    `
                    /* account-pro-access:find-current-entitlement */
                    WITH candidate_access AS (
                        SELECT
                            ownership.account_id,
                            ownership.original_transaction_id,
                            ownership.environment,
                            entitlement.product_id,
                            entitlement.status,
                            entitlement.is_trial,
                            entitlement.expires_date,
                            entitlement.grace_period_expires_date,
                            entitlement.revocation_date,
                            entitlement.last_signed_date
                        FROM account_subscription_ownership AS ownership
                        INNER JOIN subscription_entitlements AS entitlement
                            ON entitlement.original_transaction_id =
                                ownership.original_transaction_id
                           AND entitlement.environment =
                                ownership.environment
                        WHERE ownership.account_id = $1
                          AND ownership.ownership_status = 'active'
                          AND entitlement.product_id =
                                ANY($2::text[])
                          AND entitlement.revocation_date IS NULL
                          AND (
                                (
                                    entitlement.status IN (
                                        'trial',
                                        'active'
                                    )
                                    AND entitlement.expires_date > $3
                                )
                                OR
                                (
                                    entitlement.status =
                                        'grace_period'
                                    AND entitlement.grace_period_expires_date > $3
                                )
                          )

                        UNION ALL

                        SELECT
                            google_play.account_id,
                            'google-play:' ||
                                google_play.purchase_token_hash AS
                                original_transaction_id,
                            CASE
                                WHEN google_play.test_purchase
                                    THEN 'GooglePlayTest'
                                ELSE 'GooglePlayProduction'
                            END AS environment,
                            google_play.product_id,
                            google_play.status,
                            google_play.is_trial,
                            google_play.expiry_time AS expires_date,
                            CASE
                                WHEN google_play.status = 'grace_period'
                                    THEN google_play.expiry_time
                                ELSE NULL
                            END AS grace_period_expires_date,
                            NULL::timestamptz AS revocation_date,
                            google_play.verified_at AS last_signed_date
                        FROM google_play_subscription_entitlements AS google_play
                        WHERE google_play.account_id = $1
                          AND google_play.product_id =
                                ANY($2::text[])
                          AND google_play.status IN (
                                'trial',
                                'active',
                                'grace_period'
                          )
                          AND google_play.expiry_time > $3
                    )
                    SELECT
                        account_id,
                        original_transaction_id,
                        environment,
                        product_id,
                        status,
                        is_trial,
                        expires_date,
                        grace_period_expires_date,
                        revocation_date,
                        last_signed_date
                    FROM candidate_access
                    ORDER BY
                        CASE status
                            WHEN 'active' THEN 1
                            WHEN 'trial' THEN 2
                            WHEN 'grace_period' THEN 3
                            ELSE 4
                        END,
                        COALESCE(
                            grace_period_expires_date,
                            expires_date
                        ) DESC,
                        last_signed_date DESC NULLS LAST,
                        original_transaction_id ASC
                    LIMIT 1
                    `,
                    [
                        accountId,
                        productIds,
                        checkedAt,
                    ]
                );

            return result.rows[0] ?? null;
        },
    });
}

export function createAccountProAccessService({
    pool = null,
    repository = null,
    now = () => Date.now(),
} = {}) {
    if (typeof now !== 'function') {
        fail(
            'invalid_pro_access_configuration',
            'now must be a function.'
        );
    }

    const repo =
        repository ??
        createPostgresAccountProAccessRepository(
            pool
        );

    if (
        !repo ||
        typeof repo.findCurrentAccess !==
            'function'
    ) {
        fail(
            'invalid_pro_access_configuration',
            'A valid Pro-access repository is required.'
        );
    }

    async function getCurrentAccess({
        accountId,
    }) {
        const cleanAccountId =
            requireAccountId(accountId);
        const checkedAt =
            serviceDate(now);

        let row;

        try {
            row =
                await repo.findCurrentAccess({
                    accountId:
                        cleanAccountId,
                    checkedAt,
                });
        } catch (error) {
            if (
                error instanceof
                    AccountProAccessError
            ) {
                throw error;
            }

            fail(
                'pro_access_unavailable',
                'Pro access could not be verified.',
                {
                    status: 503,
                    retryable: true,
                    cause: error,
                }
            );
        }

        return normalizeAccessRow(
            row,
            cleanAccountId,
            checkedAt
        );
    }

    async function requireCurrentProAccess({
        accountId,
    }) {
        const result =
            await getCurrentAccess({
                accountId,
            });

        if (!result.hasProAccess) {
            fail(
                'ranked_pro_required',
                'Agora Pro is required to enter Ranked.',
                {
                    status: 403,
                    retryable: false,
                }
            );
        }

        return result;
    }

    return Object.freeze({
        getCurrentAccess,
        requireCurrentProAccess,
    });
}

export const accountProAccessConstants =
    Object.freeze({
        entitledStatuses:
            PRO_ACCESS_STATUSES,
    });