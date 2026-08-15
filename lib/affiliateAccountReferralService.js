const CODE_RE = /^[A-Z0-9]{2,64}$/;
const INSTALLATION_RE = /^[A-Za-z0-9-]{8,128}$/;
const CLAIM_SOURCES = new Set([
    'creator_code_entry',
    'referral_link',
]);

function fail(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.status = statusCode;
    error.code = code;
    return error;
}

function normalizeCode(value) {
    const code = typeof value === 'string'
        ? value.trim().toUpperCase()
        : '';

    if (!CODE_RE.test(code)) {
        throw fail(
            400,
            'invalid_affiliate_code',
            'Creator code must contain only letters and numbers.'
        );
    }

    return code;
}

function requireInstallationId(value) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!INSTALLATION_RE.test(clean)) {
        throw fail(
            401,
            'invalid_installation_id',
            'A valid installation ID is required.'
        );
    }
    return clean;
}

function requireAccessToken(value) {
    const clean = typeof value === 'string' ? value.trim() : '';
    if (!clean || clean.length > 16_384) {
        throw fail(
            401,
            'invalid_account_session',
            'A valid Agora account session is required.'
        );
    }
    return clean;
}

function normalizeClaimSource(value) {
    const source = String(value || 'creator_code_entry')
        .trim()
        .toLowerCase();

    if (!CLAIM_SOURCES.has(source)) {
        throw fail(
            400,
            'invalid_affiliate_claim_source',
            'Invalid affiliate claim source.'
        );
    }

    return source;
}

async function withTransaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the original error.
        }
        throw error;
    } finally {
        client.release();
    }
}

function normalizeClaimRow(row) {
    if (!row) return null;
    return {
        accountId: row.account_id,
        affiliateId: row.affiliate_id,
        creatorCode: row.normalized_code,
        claimSource: row.claim_source,
        claimedAt: row.claimed_at,
        affiliateDisplayName: row.display_name || null,
        affiliateStatus: row.affiliate_status || null,
        codeStatus: row.code_status || null,
    };
}

export function createAffiliateAccountReferralService({
    pool,
    accountAuthService,
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error(
            'Affiliate account referral service requires a PostgreSQL pool.'
        );
    }

    if (
        !accountAuthService ||
        typeof accountAuthService.authorizeAccessToken !== 'function'
    ) {
        throw new Error(
            'Affiliate account referral service requires the shared account auth service.'
        );
    }

    async function authorize({ installationId, accessToken }) {
        const cleanInstallationId = requireInstallationId(installationId);
        const cleanAccessToken = requireAccessToken(accessToken);

        try {
            return await accountAuthService.authorizeAccessToken({
                installationId: cleanInstallationId,
                accessToken: cleanAccessToken,
            });
        } catch (error) {
            throw fail(
                Number.isInteger(error?.status) ? error.status : 401,
                error?.code || 'invalid_account_session',
                error?.message ||
                    'The Agora account session is invalid or expired.'
            );
        }
    }

    async function loadClaim(client, accountId, { forUpdate = false } = {}) {
        const result = await client.query(
            `
            SELECT
                claim.account_id,
                claim.affiliate_id,
                claim.creator_code,
                claim.normalized_code,
                claim.claim_source,
                claim.claimed_at,
                affiliate.display_name,
                affiliate.status AS affiliate_status,
                affiliate.code_status
            FROM affiliate_account_referrals claim
            JOIN affiliates affiliate
              ON affiliate.id = claim.affiliate_id
            WHERE claim.account_id = $1
            ${forUpdate ? 'FOR UPDATE OF claim' : ''}
            `,
            [accountId]
        );

        return result.rows[0] || null;
    }

    async function getCurrentClaim({ installationId, accessToken } = {}) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });

        const result = await pool.query(
            `
            SELECT
                claim.account_id,
                claim.affiliate_id,
                claim.creator_code,
                claim.normalized_code,
                claim.claim_source,
                claim.claimed_at,
                affiliate.display_name,
                affiliate.status AS affiliate_status,
                affiliate.code_status
            FROM affiliate_account_referrals claim
            JOIN affiliates affiliate
              ON affiliate.id = claim.affiliate_id
            WHERE claim.account_id = $1
            LIMIT 1
            `,
            [authorization.accountId]
        );

        return {
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            claim: normalizeClaimRow(result.rows[0]),
        };
    }

    async function claimCreatorCode({
        installationId,
        accessToken,
        customCode,
        source = 'creator_code_entry',
    } = {}) {
        const authorization = await authorize({
            installationId,
            accessToken,
        });
        const normalizedCode = normalizeCode(customCode);
        const claimSource = normalizeClaimSource(source);

        const result = await withTransaction(pool, async (client) => {
            await client.query(
                `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
                [`affiliate-account:${authorization.accountId}`]
            );

            const affiliateResult = await client.query(
                `
                SELECT
                    id,
                    display_name,
                    normalized_code,
                    status,
                    code_status,
                    is_test
                FROM affiliates
                WHERE normalized_code = $1
                LIMIT 1
                `,
                [normalizedCode]
            );
            const affiliate = affiliateResult.rows[0] || null;

            if (!affiliate) {
                throw fail(
                    404,
                    'affiliate_code_not_found',
                    'That creator code is not recognized.'
                );
            }

            if (
                affiliate.status !== 'active' ||
                affiliate.code_status !== 'active'
            ) {
                throw fail(
                    409,
                    'affiliate_code_not_active',
                    'That creator code is not currently active.'
                );
            }

            const existing = await loadClaim(
                client,
                authorization.accountId,
                { forUpdate: true }
            );

            if (existing) {
                if (existing.affiliate_id === affiliate.id) {
                    return {
                        created: false,
                        claim: existing,
                    };
                }

                // Return the conflict so the transaction can commit without
                // changing the locked claim. The audit alert is written after
                // commit; throwing here would roll the alert back with the
                // transaction.
                return {
                    conflict: true,
                    existing,
                    attemptedAffiliate: affiliate,
                };
            }

            const inserted = await client.query(
                `
                INSERT INTO affiliate_account_referrals (
                    account_id,
                    affiliate_id,
                    creator_code,
                    normalized_code,
                    claim_source,
                    claimed_at
                )
                VALUES ($1, $2, $3, $3, $4, NOW())
                RETURNING *
                `,
                [
                    authorization.accountId,
                    affiliate.id,
                    affiliate.normalized_code,
                    claimSource,
                ]
            );

            return {
                created: true,
                claim: {
                    ...inserted.rows[0],
                    display_name: affiliate.display_name,
                    affiliate_status: affiliate.status,
                    code_status: affiliate.code_status,
                },
            };
        });

        if (result.conflict) {
            await pool.query(
                `
                INSERT INTO affiliate_alerts (
                    affiliate_id,
                    alert_type,
                    severity,
                    status,
                    title,
                    message,
                    dedupe_key,
                    related_record_type,
                    related_record_id
                )
                VALUES (
                    $1,
                    'account_affiliate_claim_conflict',
                    'warning',
                    'open',
                    'Agora account attempted to change affiliate creator code',
                    $2,
                    $3,
                    'account',
                    $4
                )
                ON CONFLICT (dedupe_key)
                    WHERE status = 'open' AND dedupe_key IS NOT NULL
                DO UPDATE SET
                    message = EXCLUDED.message,
                    triggered_at = NOW()
                `,
                [
                    result.existing.affiliate_id,
                    `Account ${authorization.accountId} already has creator code ${result.existing.normalized_code}; a later attempt to claim ${result.attemptedAffiliate.normalized_code} was rejected. Existing affiliate ownership was preserved.`,
                    `account_affiliate_claim_conflict:${authorization.accountId}`,
                    authorization.accountId,
                ]
            );

            throw fail(
                409,
                'affiliate_claim_already_set',
                'This Agora account already has a creator-code attribution. It cannot be changed automatically.'
            );
        }

        return {
            accountId: authorization.accountId,
            installationId: authorization.installationId,
            created: result.created,
            claim: normalizeClaimRow(result.claim),
        };
    }

    return Object.freeze({
        authorize,
        getCurrentClaim,
        claimCreatorCode,
    });
}
