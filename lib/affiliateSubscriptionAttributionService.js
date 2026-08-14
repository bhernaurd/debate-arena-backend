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

export function normalizeAppleOfferIdentifier(value) {
    const text = requiredText(value, 'appleOfferIdentifier', 200);
    return text.toUpperCase();
}

export function normalizeVerifiedAppleEnvironment(value) {
    const environment = String(value || '').trim().toLowerCase();

    if (environment === 'production') {
        return 'Production';
    }

    if (environment === 'sandbox') {
        return 'Sandbox';
    }

    const error = new Error(
        'Verified Apple environment must be Production or Sandbox.'
    );
    error.statusCode = 400;
    error.code = 'invalid_affiliate_attribution_environment';
    throw error;
}

export function isAppleOfferCodeTransaction(transaction) {
    const raw = transaction?.offerType;

    if (raw === 3) {
        return true;
    }

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
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
        return null;
    }

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
    resolutionNote = 'The affiliate attribution condition was resolved automatically.'
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
    if (!pool) {
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

    async function findAffiliateByOfferIdentifier(
        client,
        normalizedOfferIdentifier
    ) {
        const result = await client.query(
            `
            SELECT
                id,
                display_name,
                normalized_code,
                apple_offer_identifier,
                normalized_apple_offer_identifier,
                status,
                code_status
            FROM affiliates
            WHERE normalized_apple_offer_identifier = $1
            LIMIT 1
            `,
            [normalizedOfferIdentifier]
        );

        return result.rows[0] || null;
    }

    async function observeVerifiedTransaction({
        client,
        transaction,
        environment,
        source = 'app_store',
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
        const offerIdentifier = transaction?.offerIdentifier == null
            ? null
            : String(transaction.offerIdentifier).trim() || null;

        if (offerIdentifier && offerIdentifier.length > 200) {
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

        const normalizedOfferIdentifier = offerIdentifier
            ? normalizeAppleOfferIdentifier(offerIdentifier)
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

            if (offerCodeTransaction && !normalizedOfferIdentifier) {
                await createAlert(client, {
                    affiliateId: existing.affiliate_id,
                    alertType: 'missing_apple_offer_identifier',
                    severity: 'warning',
                    title: 'Apple offer-code transaction is missing its offer identifier',
                    message:
                        `Verified ${source} transaction ${transactionId} on owned subscription ` +
                        `chain ${originalTransactionId} is offerType 3 but has no offerIdentifier. ` +
                        'Existing affiliate ownership was preserved.',
                    dedupeKey:
                        `missing_apple_offer_identifier:${cleanEnvironment}:${originalTransactionId}`,
                    relatedRecordType:
                        'affiliate_subscription_attribution',
                    relatedRecordId: existing.id,
                });
            }

            if (offerCodeTransaction && normalizedOfferIdentifier) {
                const observedAffiliate =
                    await findAffiliateByOfferIdentifier(
                        client,
                        normalizedOfferIdentifier
                    );

                if (!observedAffiliate) {
                    await createAlert(client, {
                        affiliateId: existing.affiliate_id,
                        alertType: 'unknown_apple_offer_identifier',
                        severity: 'warning',
                        title: 'Verified Apple offer code has no affiliate mapping',
                        message:
                            `Verified ${source} transaction ${transactionId} on owned ` +
                            `subscription chain ${originalTransactionId} used Apple offer ` +
                            `identifier ${offerIdentifier}, but no affiliate mapping exists. ` +
                            'Existing ownership was preserved.',
                        dedupeKey:
                            `unknown_apple_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                        relatedRecordType:
                            'affiliate_subscription_attribution',
                        relatedRecordId: existing.id,
                    });
                } else if (!affiliateAcceptsNewAttribution(observedAffiliate)) {
                    await createAlert(client, {
                        affiliateId: existing.affiliate_id,
                        alertType: 'inactive_affiliate_offer_identifier',
                        severity: 'warning',
                        title: 'Apple offer points to an affiliate that is not active for new attribution',
                        message:
                            `Verified ${source} transaction ${transactionId} on owned ` +
                            `subscription chain ${originalTransactionId} used Apple offer ` +
                            `identifier ${offerIdentifier}, mapped to ${observedAffiliate.normalized_code}, ` +
                            `but that affiliate or code is not active for new attribution. ` +
                            'Existing ownership was preserved.',
                        dedupeKey:
                            `inactive_affiliate_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                        relatedRecordType:
                            'affiliate_subscription_attribution',
                        relatedRecordId: existing.id,
                    });
                } else if (
                    observedAffiliate.id !== existing.affiliate_id
                ) {
                    await createAlert(client, {
                        affiliateId: existing.affiliate_id,
                        alertType:
                            'subscription_chain_affiliate_conflict',
                        severity: 'critical',
                        title: 'Conflicting affiliate offer observed on an owned subscription chain',
                        message:
                            `Subscription chain ${originalTransactionId} is already owned by ` +
                            `${existing.normalized_code}, but verified transaction ${transactionId} ` +
                            `contains Apple offer identifier ${offerIdentifier}, which maps to ` +
                            `${observedAffiliate.normalized_code}. Ownership was not changed.`,
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
                } else {
                    await resolveOpenAlert(
                        client,
                        `unknown_apple_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                        'A verified Apple offer identifier now maps to the existing affiliate owner.'
                    );
                    await resolveOpenAlert(
                        client,
                        `inactive_affiliate_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                        'The Apple offer identifier is active again and matches the existing affiliate owner.'
                    );
                }
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
                    `${originalTransactionId} is offerType 3 but has no offerIdentifier, so ` +
                    'affiliate ownership could not be assigned.',
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

        const affiliate = await findAffiliateByOfferIdentifier(
            client,
            normalizedOfferIdentifier
        );

        if (!affiliate) {
            await createAlert(client, {
                affiliateId: null,
                alertType: 'unknown_apple_offer_identifier',
                severity: 'warning',
                title: 'Verified Apple offer code has no affiliate mapping',
                message:
                    `Verified ${source} transaction ${transactionId} on subscription chain ` +
                    `${originalTransactionId} used Apple offer identifier ${offerIdentifier}, ` +
                    'but no affiliate mapping exists for that identifier.',
                dedupeKey:
                    `unknown_apple_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                relatedRecordType: 'app_store_transaction',
                relatedRecordId: transactionId,
            });

            return {
                status: 'unknown_offer_identifier',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier,
            };
        }

        if (!affiliateAcceptsNewAttribution(affiliate)) {
            await createAlert(client, {
                affiliateId: affiliate.id,
                alertType: 'inactive_affiliate_offer_identifier',
                severity: 'warning',
                title: 'Apple offer points to an affiliate that is not active for new attribution',
                message:
                    `Verified ${source} transaction ${transactionId} on subscription chain ` +
                    `${originalTransactionId} used Apple offer identifier ${offerIdentifier}, ` +
                    `mapped to ${affiliate.normalized_code}, but that affiliate or code is not active ` +
                    'for new attribution. Ownership was not assigned.',
                dedupeKey:
                    `inactive_affiliate_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
                relatedRecordType: 'app_store_transaction',
                relatedRecordId: transactionId,
            });

            return {
                status: 'inactive_affiliate_offer_identifier',
                attributed: false,
                affiliateId: null,
                originalTransactionId,
                environment: cleanEnvironment,
                offerIdentifier,
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
                original_transaction_id,
                environment,
                attribution_transaction_id,
                offer_identifier,
                normalized_offer_identifier,
                offer_type,
                product_id,
                attributed_at,
                attribution_source,
                initial_price_milliunits,
                initial_currency,
                last_transaction_id
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, '3', $7, $8,
                'apple_offer_identifier', $9, $10, $4
            )
            ON CONFLICT (original_transaction_id, environment)
            DO NOTHING
            RETURNING *
            `,
            [
                affiliate.id,
                originalTransactionId,
                cleanEnvironment,
                transactionId,
                offerIdentifier,
                normalizedOfferIdentifier,
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

            if (raced.affiliate_id !== affiliate.id) {
                await createAlert(client, {
                    affiliateId: raced.affiliate_id,
                    alertType:
                        'subscription_chain_affiliate_conflict',
                    severity: 'critical',
                    title: 'Conflicting affiliate attribution race detected',
                    message:
                        `Subscription chain ${originalTransactionId} was concurrently attributed to ` +
                        `${raced.normalized_code}. Attempted ownership by ${affiliate.normalized_code} ` +
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
                    raced.affiliate_id === affiliate.id
                        ? 'inherited_existing'
                        : 'conflict_preserved_existing',
                attributed: true,
                affiliateId: raced.affiliate_id,
                normalizedCode: raced.normalized_code,
                originalTransactionId,
                environment: cleanEnvironment,
            };
        }

        await resolveOpenAlert(
            client,
            `unknown_apple_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
            'The Apple offer identifier is now mapped and the subscription chain was attributed.'
        );
        await resolveOpenAlert(
            client,
            `inactive_affiliate_offer_identifier:${cleanEnvironment}:${normalizedOfferIdentifier}`,
            'The Apple offer identifier is active and the subscription chain was attributed.'
        );
        await resolveOpenAlert(
            client,
            `missing_apple_offer_identifier:${cleanEnvironment}:${originalTransactionId}`,
            'A later verified Apple transaction supplied enough information to attribute the subscription chain.'
        );

        return {
            status: 'attributed_new',
            attributed: true,
            affiliateId: affiliate.id,
            normalizedCode: affiliate.normalized_code,
            originalTransactionId,
            environment: cleanEnvironment,
            offerIdentifier,
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

    return {
        observeVerifiedTransaction,
        getAttribution,
    };
}
