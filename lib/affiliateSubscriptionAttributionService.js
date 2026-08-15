const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value, maxLength = 500) {
    if (value == null) return null;
    const text = String(value).trim();
    if (!text) return null;
    return text.slice(0, maxLength);
}

function requiredText(value, field, maxLength = 500) {
    if (value == null) {
        const error = new Error(`${field} is required.`);
        error.statusCode = 400;
        error.code = 'invalid_affiliate_attribution_input';
        throw error;
    }

    const text = String(value).trim();
    if (!text) {
        const error = new Error(`${field} is required.`);
        error.statusCode = 400;
        error.code = 'invalid_affiliate_attribution_input';
        throw error;
    }

    if (text.length > maxLength) {
        const error = new Error(`${field} exceeds ${maxLength} characters.`);
        error.statusCode = 400;
        error.code = 'invalid_affiliate_attribution_input';
        throw error;
    }

    return text;
}

function normalizeUuid(value) {
    const text = cleanText(value, 64);
    return text && UUID_RE.test(text) ? text.toLowerCase() : null;
}

export function normalizeAppleOfferIdentifier(value) {
    const text = requiredText(value, 'appleOfferIdentifier', 200);
    return text.toUpperCase();
}

export function normalizeVerifiedAppleEnvironment(value) {
    const environment = String(value || '').trim().toLowerCase();

    if (environment === 'production') return 'Production';
    if (environment === 'sandbox') return 'Sandbox';

    const error = new Error(
        'Verified Apple environment must be Production or Sandbox.'
    );
    error.statusCode = 400;
    error.code = 'invalid_affiliate_attribution_environment';
    throw error;
}

export function isAppleOfferCodeTransaction(transaction) {
    const raw = transaction?.offerType;
    if (raw === 3) return true;

    const normalized = String(raw ?? '')
        .trim()
        .toUpperCase()
        .replaceAll('-', '_')
        .replaceAll(' ', '_');

    return normalized === '3' || normalized === 'OFFER_CODE';
}

function toDate(value) {
    if (value == null) return null;

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        const date = new Date(numeric);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function applePriceMilliunits(value) {
    if (value == null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return null;
    return numeric;
}

async function createAlert(
    client,
    {
        affiliateId = null,
        alertType,
        severity,
        title,
        message,
        dedupeKey,
        relatedRecordType = null,
        relatedRecordId = null,
    }
) {
    await client.query(
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
        VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8)
        ON CONFLICT (dedupe_key)
            WHERE status = 'open' AND dedupe_key IS NOT NULL
        DO UPDATE SET
            affiliate_id = COALESCE(EXCLUDED.affiliate_id, affiliate_alerts.affiliate_id),
            severity = EXCLUDED.severity,
            title = EXCLUDED.title,
            message = EXCLUDED.message,
            related_record_type = EXCLUDED.related_record_type,
            related_record_id = EXCLUDED.related_record_id,
            triggered_at = NOW()
        `,
        [
            affiliateId,
            alertType,
            severity,
            title,
            message,
            dedupeKey,
            relatedRecordType,
            relatedRecordId,
        ]
    );
}

async function resolveOpenAlert(
    client,
    dedupeKey,
    resolutionNote =
        'The affiliate attribution condition was resolved automatically.'
) {
    if (!dedupeKey) return;

    await client.query(
        `
        UPDATE affiliate_alerts
        SET
            status = 'resolved',
            resolved_at = NOW(),
            resolved_by = 'system:affiliate_attribution',
            resolution_note = $2
        WHERE dedupe_key = $1
          AND status = 'open'
        `,
        [dedupeKey, resolutionNote]
    );
}

function affiliateAcceptsNewAttribution(affiliate) {
    return Boolean(
        affiliate &&
        affiliate.status === 'active' &&
        affiliate.code_status === 'active'
    );
}

export function createAffiliateSubscriptionAttributionService({
    pool,
} = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error(
            'Affiliate subscription attribution service requires a PostgreSQL pool.'
        );
    }

    async function loadAttribution(
        client,
        originalTransactionId,
        environment
    ) {
        const result = await client.query(
            `
            SELECT
                attribution.*,
                affiliate.display_name,
                affiliate.normalized_code
            FROM affiliate_subscription_attributions attribution
            JOIN affiliates affiliate
              ON affiliate.id = attribution.affiliate_id
            WHERE attribution.original_transaction_id = $1
              AND attribution.environment = $2
            LIMIT 1
            `,
            [originalTransactionId, environment]
        );

        return result.rows[0] || null;
    }

    async function isKnownAffiliateCampaign(
        client,
        normalizedOfferIdentifier
    ) {
        const result = await client.query(
            `
            SELECT EXISTS (
                SELECT 1
                FROM affiliates
                WHERE normalized_apple_offer_identifier = $1
                  AND status IN ('active', 'inactive')
            ) AS known
            `,
            [normalizedOfferIdentifier]
        );

        return Boolean(result.rows[0]?.known);
    }

    async function resolveAccountId(
        client,
        {
            explicitAccountId = null,
            transaction,
            originalTransactionId,
            environment,
        }
    ) {
        const explicit = normalizeUuid(explicitAccountId);
        if (explicit) return explicit;

        const token = normalizeUuid(transaction?.appAccountToken);
        if (token) {
            const accountResult = await client.query(
                `
                SELECT id
                FROM accounts
                WHERE id = $1
                  AND status <> 'deleted'
                LIMIT 1
                `,
                [token]
            );
            if (accountResult.rowCount === 1) return token;
        }

        const ownershipResult = await client.query(
            `
            SELECT account_id
            FROM account_subscription_ownership
            WHERE original_transaction_id = $1
              AND environment = $2
              AND ownership_status = 'active'
            LIMIT 1
            `,
            [originalTransactionId, environment]
        );

        return normalizeUuid(ownershipResult.rows[0]?.account_id);
    }

    async function loadAccountClaim(client, accountId) {
        if (!accountId) return null;

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
                affiliate.status,
                affiliate.code_status,
                affiliate.apple_offer_identifier,
                affiliate.normalized_apple_offer_identifier
            FROM affiliate_account_referrals claim
            JOIN affiliates affiliate
              ON affiliate.id = claim.affiliate_id
            WHERE claim.account_id = $1
            LIMIT 1
            `,
            [accountId]
        );

        return result.rows[0] || null;
    }

    async function observeVerifiedTransaction({
        client,
        transaction,
        environment,
        source = 'app_store',
        accountId = null,
    } = {}) {
        if (!client || typeof client.query !== 'function') {
            throw new Error(
                'A PostgreSQL transaction client is required.'
            );
        }

        const originalTransactionId = requiredText(
            transaction?.originalTransactionId,
            'transaction.originalTransactionId',
            128
        );
        const transactionId = requiredText(
            transaction?.transactionId,
            'transaction.transactionId',
            128
        );
        const cleanEnvironment =
            normalizeVerifiedAppleEnvironment(environment);
        const existing = await loadAttribution(
            client,
            originalTransactionId,
            cleanEnvironment
        );
        const offerCodeTransaction =
            isAppleOfferCodeTransaction(transaction);
        const rawOfferIdentifier = transaction?.offerIdentifier == null
            ? null
            : String(transaction.offerIdentifier).trim() || null;

        if (rawOfferIdentifier && rawOfferIdentifier.length > 200) {
            await createAlert(client, {
                affiliateId: existing?.affiliate_id || null,
                alertType: 'invalid_apple_offer_identifier',
                severity: 'warning',
                title: 'Verified Apple offer identifier exceeds the supported length',
                message:
                    `Verified ${source} transaction ${transactionId} on subscription chain ` +
                    `${originalTransactionId} contains an Apple offer identifier longer than ` +
                    '200 characters. Affiliate ownership was not changed.',
                dedupeKey:
                    `invalid_apple_offer_identifier:${cleanEnvironment}:${originalTransactionId}`,
                relatedRecordType: existing
                    ? 'affiliate_subscription_attribution'
                    : 'app_store_transaction',
                relatedRecordId: existing?.id || transactionId,
            });

            return {
                status: 'invalid_offer_identifier',
                attributed: Boolean(existing),
                affiliateId: existing?.affiliate_id || null,
                normalizedCode: existing?.normalized_code || null,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        const normalizedOfferIdentifier = rawOfferIdentifier
            ? normalizeAppleOfferIdentifier(rawOfferIdentifier)
            : null;

        if (existing) {
            await client.query(
                `
                UPDATE affiliate_subscription_attributions
                SET
                    last_observed_at = NOW(),
                    last_transaction_id = $3,
                    updated_at = NOW()
                WHERE original_transaction_id = $1
                  AND environment = $2
                `,
                [
                    originalTransactionId,
                    cleanEnvironment,
                    transactionId,
                ]
            );

            const resolvedAccountId = await resolveAccountId(client, {
                explicitAccountId: accountId,
                transaction,
                originalTransactionId,
                environment: cleanEnvironment,
            });
            const observedClaim = await loadAccountClaim(
                client,
                resolvedAccountId
            );

            if (
                observedClaim &&
                observedClaim.affiliate_id !== existing.affiliate_id
            ) {
                await createAlert(client, {
                    affiliateId: existing.affiliate_id,
                    alertType: 'subscription_chain_affiliate_conflict',
                    severity: 'critical',
                    title: 'Conflicting creator-code claim observed on an owned subscription chain',
                    message:
                        `Subscription chain ${originalTransactionId} is already owned by ` +
                        `${existing.normalized_code}, but account ${resolvedAccountId} currently ` +
                        `claims creator code ${observedClaim.normalized_code}. Existing ownership was preserved.`,
                    dedupeKey:
                        `subscription_chain_affiliate_conflict:${cleanEnvironment}:${originalTransactionId}`,
                    relatedRecordType:
                        'affiliate_subscription_attribution',
                    relatedRecordId: existing.id,
                });

                return {
                    status: 'conflict_preserved_existing',
                    attributed: true,
                    affiliateId: existing.affiliate_id,
                    normalizedCode: existing.normalized_code,
                    originalTransactionId,
                    environment: cleanEnvironment,
                };
            }

            return {
                status: 'inherited_existing',
                attributed: true,
                affiliateId: existing.affiliate_id,
                normalizedCode: existing.normalized_code,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        if (!offerCodeTransaction) {
            return {
                status: 'not_attributed',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        if (!normalizedOfferIdentifier) {
            await createAlert(client, {
                affiliateId: null,
                alertType: 'missing_apple_offer_identifier',
                severity: 'warning',
                title: 'Apple offer-code transaction is missing its offer identifier',
                message:
                    `Verified ${source} transaction ${transactionId} on subscription chain ` +
                    `${originalTransactionId} is offerType 3 but has no offerIdentifier. ` +
                    'Creator-code ownership was not guessed.',
                dedupeKey:
                    `missing_apple_offer_identifier:${cleanEnvironment}:${originalTransactionId}`,
                relatedRecordType: 'app_store_transaction',
                relatedRecordId: transactionId,
            });

            return {
                status: 'missing_offer_identifier',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        const knownCampaign = await isKnownAffiliateCampaign(
            client,
            normalizedOfferIdentifier
        );

        if (!knownCampaign) {
            return {
                status: 'not_affiliate_offer',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier: rawOfferIdentifier,
            };
        }

        const resolvedAccountId = await resolveAccountId(client, {
            explicitAccountId: accountId,
            transaction,
            originalTransactionId,
            environment: cleanEnvironment,
        });

        if (!resolvedAccountId) {
            await createAlert(client, {
                affiliateId: null,
                alertType: 'affiliate_account_not_resolved',
                severity: 'info',
                title: 'Affiliate transaction is waiting for an Agora account link',
                message:
                    `Verified affiliate offer-code transaction ${transactionId} on chain ` +
                    `${originalTransactionId} used shared Apple offer ${rawOfferIdentifier}, but ` +
                    'the Agora account could not yet be resolved. The transaction remains unassigned and can be reconciled later.',
                dedupeKey:
                    `affiliate_account_not_resolved:${cleanEnvironment}:${originalTransactionId}`,
                relatedRecordType: 'app_store_transaction',
                relatedRecordId: transactionId,
            });

            return {
                status: 'awaiting_account_link',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier: rawOfferIdentifier,
            };
        }

        const claim = await loadAccountClaim(client, resolvedAccountId);

        if (!claim) {
            await createAlert(client, {
                affiliateId: null,
                alertType: 'affiliate_creator_code_claim_missing',
                severity: 'warning',
                title: 'Affiliate transaction is waiting for a creator code',
                message:
                    `Agora account ${resolvedAccountId} owns or is syncing subscription chain ` +
                    `${originalTransactionId}, and Apple verified shared affiliate offer ` +
                    `${rawOfferIdentifier}, but the account has no locked creator-code claim yet. ` +
                    'Do not guess an affiliate; reconcile after the user supplies the creator code.',
                dedupeKey:
                    `affiliate_creator_code_claim_missing:${cleanEnvironment}:${originalTransactionId}`,
                relatedRecordType: 'account',
                relatedRecordId: resolvedAccountId,
            });

            return {
                status: 'awaiting_creator_code_claim',
                attributed: false,
                affiliateId: null,
                accountId: resolvedAccountId,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier: rawOfferIdentifier,
            };
        }

        if (!affiliateAcceptsNewAttribution(claim)) {
            await createAlert(client, {
                affiliateId: claim.affiliate_id,
                alertType: 'inactive_affiliate_creator_code',
                severity: 'warning',
                title: 'Account creator code is not active for new attribution',
                message:
                    `Agora account ${resolvedAccountId} claims creator code ` +
                    `${claim.normalized_code}, but that affiliate or code is not active. ` +
                    'Ownership was not assigned.',
                dedupeKey:
                    `inactive_affiliate_creator_code:${resolvedAccountId}`,
                relatedRecordType: 'account',
                relatedRecordId: resolvedAccountId,
            });

            return {
                status: 'inactive_affiliate_creator_code',
                attributed: false,
                affiliateId: null,
                accountId: resolvedAccountId,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        if (
            !claim.normalized_apple_offer_identifier ||
            claim.normalized_apple_offer_identifier !==
                normalizedOfferIdentifier
        ) {
            await createAlert(client, {
                affiliateId: claim.affiliate_id,
                alertType: 'affiliate_claim_offer_mismatch',
                severity: 'warning',
                title: 'Creator-code claim does not match the verified Apple offer',
                message:
                    `Agora account ${resolvedAccountId} claims creator code ` +
                    `${claim.normalized_code}, but Apple verified offer ` +
                    `${rawOfferIdentifier}. The affiliate's configured shared offer is ` +
                    `${claim.apple_offer_identifier || 'not configured'}. Ownership was not assigned.`,
                dedupeKey:
                    `affiliate_claim_offer_mismatch:${cleanEnvironment}:${originalTransactionId}`,
                relatedRecordType: 'account',
                relatedRecordId: resolvedAccountId,
            });

            return {
                status: 'creator_code_offer_mismatch',
                attributed: false,
                affiliateId: null,
                accountId: resolvedAccountId,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier: rawOfferIdentifier,
            };
        }

        const attributedAt =
            toDate(transaction?.purchaseDate) ||
            toDate(transaction?.signedDate) ||
            new Date();
        const initialPriceMilliunits = applePriceMilliunits(
            transaction?.price
        );
        const currency = cleanText(transaction?.currency, 16);
        const productId = cleanText(transaction?.productId, 200);

        const inserted = await client.query(
            `
            INSERT INTO affiliate_subscription_attributions (
                affiliate_id,
                account_id,
                original_transaction_id,
                environment,
                attribution_transaction_id,
                offer_identifier,
                normalized_offer_identifier,
                offer_type,
                creator_code,
                normalized_creator_code,
                product_id,
                attributed_at,
                attribution_source,
                initial_price_milliunits,
                initial_currency,
                last_transaction_id
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, '3', $8, $8,
                $9, $10, 'account_creator_code', $11, $12, $5
            )
            ON CONFLICT (original_transaction_id, environment)
            DO NOTHING
            RETURNING *
            `,
            [
                claim.affiliate_id,
                resolvedAccountId,
                originalTransactionId,
                cleanEnvironment,
                transactionId,
                rawOfferIdentifier,
                normalizedOfferIdentifier,
                claim.normalized_code,
                productId,
                attributedAt,
                initialPriceMilliunits,
                currency,
            ]
        );

        if (inserted.rowCount === 0) {
            const raced = await loadAttribution(
                client,
                originalTransactionId,
                cleanEnvironment
            );

            if (!raced) {
                throw new Error(
                    'Affiliate attribution conflict occurred but the canonical row could not be loaded.'
                );
            }

            if (raced.affiliate_id !== claim.affiliate_id) {
                await createAlert(client, {
                    affiliateId: raced.affiliate_id,
                    alertType: 'subscription_chain_affiliate_conflict',
                    severity: 'critical',
                    title: 'Conflicting affiliate attribution race detected',
                    message:
                        `Subscription chain ${originalTransactionId} was concurrently attributed to ` +
                        `${raced.normalized_code}. Attempted ownership by ${claim.normalized_code} ` +
                        'was rejected and the existing owner was preserved.',
                    dedupeKey:
                        `subscription_chain_affiliate_conflict:${cleanEnvironment}:${originalTransactionId}`,
                    relatedRecordType:
                        'affiliate_subscription_attribution',
                    relatedRecordId: raced.id,
                });
            }

            return {
                status:
                    raced.affiliate_id === claim.affiliate_id
                        ? 'inherited_existing'
                        : 'conflict_preserved_existing',
                attributed: true,
                affiliateId: raced.affiliate_id,
                normalizedCode: raced.normalized_code,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        const resolutionKeys = [
            `affiliate_account_not_resolved:${cleanEnvironment}:${originalTransactionId}`,
            `affiliate_creator_code_claim_missing:${cleanEnvironment}:${originalTransactionId}`,
            `affiliate_claim_offer_mismatch:${cleanEnvironment}:${originalTransactionId}`,
            `missing_apple_offer_identifier:${cleanEnvironment}:${originalTransactionId}`,
        ];
        for (const key of resolutionKeys) {
            await resolveOpenAlert(
                client,
                key,
                'The authenticated account creator code and verified Apple offer now provide exact subscription-chain attribution.'
            );
        }

        return {
            status: 'attributed_new',
            attributed: true,
            affiliateId: claim.affiliate_id,
            normalizedCode: claim.normalized_code,
            accountId: resolvedAccountId,
            originalTransactionId,
            environment: cleanEnvironment,
            offerIdentifier: rawOfferIdentifier,
        };
    }

    async function reconcileAccount(accountId, { limit = 50 } = {}) {
        const cleanAccountId = normalizeUuid(accountId);
        if (!cleanAccountId) {
            const error = new Error('A valid accountId is required.');
            error.statusCode = 400;
            error.code = 'invalid_affiliate_attribution_account';
            throw error;
        }

        const safeLimit = Math.max(
            1,
            Math.min(Number.parseInt(String(limit), 10) || 50, 200)
        );

        const candidateResult = await pool.query(
            `
            SELECT DISTINCT ON (
                tx.original_transaction_id,
                tx.environment
            )
                tx.transaction_id,
                tx.original_transaction_id,
                tx.environment,
                tx.product_id,
                tx.offer_type,
                tx.offer_identifier,
                tx.app_account_token,
                tx.purchase_date,
                tx.signed_date,
                tx.price_milliunits,
                tx.currency
            FROM account_subscription_ownership ownership
            JOIN app_store_transactions tx
              ON tx.original_transaction_id = ownership.original_transaction_id
             AND tx.environment = ownership.environment
            WHERE ownership.account_id = $1
              AND ownership.ownership_status = 'active'
              AND UPPER(REPLACE(REPLACE(BTRIM(tx.offer_type), '-', '_'), ' ', '_'))
                    IN ('3', 'OFFER_CODE')
              AND tx.offer_identifier IS NOT NULL
              AND BTRIM(tx.offer_identifier) <> ''
              AND EXISTS (
                    SELECT 1
                    FROM affiliates affiliate
                    WHERE affiliate.normalized_apple_offer_identifier =
                          UPPER(BTRIM(tx.offer_identifier))
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM affiliate_subscription_attributions attribution
                    WHERE attribution.original_transaction_id =
                          tx.original_transaction_id
                      AND attribution.environment = tx.environment
              )
            ORDER BY
                tx.original_transaction_id,
                tx.environment,
                COALESCE(tx.purchase_date, tx.signed_date, tx.updated_at) ASC,
                tx.transaction_id ASC
            LIMIT $2
            `,
            [cleanAccountId, safeLimit]
        );

        const results = [];
        for (const row of candidateResult.rows) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await observeVerifiedTransaction({
                    client,
                    accountId: cleanAccountId,
                    source: 'account_creator_code_reconciliation',
                    environment: row.environment,
                    transaction: {
                        transactionId: row.transaction_id,
                        originalTransactionId:
                            row.original_transaction_id,
                        productId: row.product_id,
                        offerType: row.offer_type,
                        offerIdentifier: row.offer_identifier,
                        appAccountToken: row.app_account_token,
                        purchaseDate: row.purchase_date,
                        signedDate: row.signed_date,
                        price: row.price_milliunits,
                        currency: row.currency,
                    },
                });
                await client.query('COMMIT');
                results.push(result);
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    // Preserve original error.
                }
                throw error;
            } finally {
                client.release();
            }
        }

        return {
            accountId: cleanAccountId,
            attempted: candidateResult.rowCount,
            attributed: results.filter(item => item.attributed).length,
            results,
        };
    }

    async function getAttribution({
        originalTransactionId,
        environment = 'Production',
    } = {}) {
        const cleanOriginalTransactionId = requiredText(
            originalTransactionId,
            'originalTransactionId',
            128
        );
        const cleanEnvironment =
            normalizeVerifiedAppleEnvironment(environment);
        const client = await pool.connect();

        try {
            return await loadAttribution(
                client,
                cleanOriginalTransactionId,
                cleanEnvironment
            );
        } finally {
            client.release();
        }
    }

    return Object.freeze({
        observeVerifiedTransaction,
        reconcileAccount,
        getAttribution,
    });
}
