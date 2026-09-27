const ACTIVE_STATES = new Set(['active', 'trial']);
const EXPIRED_STATES = new Set(['expired', 'revoked']);

function normalizeOffer(value) {
  return String(value || '').trim().toUpperCase();
}

function asBoolean(value) {
  if (value === true || value === false) return value;
  return null;
}

function asTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

function round6(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function classifyAffiliateTrackingFact(fact, {
  currentOfferIdentifier,
  acceptedOfferIdentifiers = [],
  now = Date.now(),
} = {}) {
  const status = String(fact?.status || '').trim().toLowerCase();
  const autoRenewEnabled = asBoolean(fact?.autoRenewEnabled);
  const normalizedOffer = normalizeOffer(fact?.normalizedOfferIdentifier);
  const currentOffer = normalizeOffer(currentOfferIdentifier);
  const acceptedOffers = new Set(
    [currentOffer, ...(acceptedOfferIdentifiers || []).map(normalizeOffer)]
      .filter(Boolean)
  );
  const hasPaid = Boolean(fact?.hasStandardPaidFollowup);
  const expiresAt = asTime(fact?.expiresAt);
  const graceAt = asTime(fact?.gracePeriodExpiresAt);
  const hasEntitlement = Boolean(fact?.hasEntitlement);

  const active =
    (ACTIVE_STATES.has(status) && expiresAt != null && expiresAt > now) ||
    (status === 'grace_period' && graceAt != null && graceAt > now);

  const isCurrentOffer = Boolean(currentOffer) && normalizedOffer === currentOffer;
  const offerRecognized = Boolean(normalizedOffer) && acceptedOffers.has(normalizedOffer);
  const cancelled = autoRenewEnabled === false || Boolean(fact?.autoRenewDisabledAt);

  let state = 'pending';
  if (!hasEntitlement) {
    state = 'missing_entitlement';
  } else if (!isCurrentOffer) {
    if (hasPaid) state = 'previous_offer_converted';
    else if (cancelled) state = 'previous_offer_cancelled';
    else if (EXPIRED_STATES.has(status)) state = 'previous_offer_ended';
    else if (active) state = 'previous_offer_active';
    else state = 'previous_offer_pending';
  } else if (status === 'billing_retry') {
    state = 'billing_retry';
  } else if (EXPIRED_STATES.has(status) && !hasPaid) {
    state = 'trial_expired_without_conversion';
  } else if (EXPIRED_STATES.has(status)) {
    state = 'expired';
  } else if (active && hasPaid && cancelled) {
    state = 'paid_canceling';
  } else if (active && hasPaid) {
    state = 'paid_renewing';
  } else if (active && !hasPaid && cancelled) {
    state = 'trial_canceling';
  } else if (active && !hasPaid) {
    state = 'trial_active';
  }

  return {
    ...fact,
    normalizedOfferIdentifier: normalizedOffer,
    isCurrentOffer,
    offerRecognized,
    active,
    cancelled,
    hasPaid,
    state,
  };
}

export function summarizeAffiliateTrackingFacts(facts = [], options = {}) {
  const classified = facts.map((fact) =>
    classifyAffiliateTrackingFact(fact, options)
  );

  const stateCounts = {};
  for (const row of classified) {
    stateCounts[row.state] = Number(stateCounts[row.state] || 0) + 1;
  }

  const currentProgram = classified.filter((row) => row.isCurrentOffer);
  const historical = classified.filter((row) => !row.isCurrentOffer);

  const currentSubscribers = classified.filter(
    (row) => row.active && !row.cancelled
  ).length;
  const cancelledSubscribers = classified.filter((row) => row.cancelled).length;

  const currentStateCounts = {};
  for (const row of currentProgram) {
    currentStateCounts[row.state] =
      Number(currentStateCounts[row.state] || 0) + 1;
  }

  const historicalStateCounts = {};
  for (const row of historical) {
    historicalStateCounts[row.state] =
      Number(historicalStateCounts[row.state] || 0) + 1;
  }

  return {
    totalReferrals: classified.length,
    currentSubscribers,
    cancelledSubscribers,
    currentProgramReferrals: currentProgram.length,
    historicalReferrals: historical.length,
    missingEntitlements: classified.filter((row) => !row.hasEntitlement).length,
    unlinkedAccounts: classified.filter((row) => !row.accountId).length,
    unrecognizedOffers: classified.filter((row) => !row.offerRecognized).length,
    stateCounts,
    currentStateCounts,
    historicalStateCounts,
    classified,
  };
}

export function evaluateAffiliateTrackingInvariants({
  rawSummary,
  publishedOverview,
  duplicateOwnership = 0,
  payoutRows = [],
} = {}) {
  const errors = [];
  const warnings = [];

  const total = Number(rawSummary?.totalReferrals || 0);
  const current = Number(rawSummary?.currentSubscribers || 0);
  const cancelled = Number(rawSummary?.cancelledSubscribers || 0);
  const currentProgram = Number(rawSummary?.currentProgramReferrals || 0);
  const historical = Number(rawSummary?.historicalReferrals || 0);

  if (current + cancelled > total) {
    errors.push({
      code: 'overview_double_count',
      message: 'Current plus cancelled subscribers exceeds total referrals.',
    });
  }

  if (currentProgram + historical !== total) {
    errors.push({
      code: 'offer_partition_mismatch',
      message: 'Current and historical offer referrals do not partition total referrals.',
    });
  }

  const stateTotal = Object.values(rawSummary?.stateCounts || {})
    .reduce((sum, value) => sum + Number(value || 0), 0);
  if (stateTotal !== total) {
    errors.push({
      code: 'state_partition_mismatch',
      message: 'Subscriber state buckets do not reconcile to total referrals.',
    });
  }

  if (Number(rawSummary?.unrecognizedOffers || 0) > 0) {
    errors.push({
      code: 'unrecognized_offer_attribution',
      message: 'One or more attributed chains reference an Apple offer not mapped to this affiliate.',
    });
  }

  if (Number(duplicateOwnership || 0) > 0) {
    errors.push({
      code: 'duplicate_chain_ownership',
      message: 'One or more Apple subscription chains are attributed to multiple affiliates.',
    });
  }

  if (Number(rawSummary?.missingEntitlements || 0) > 0) {
    warnings.push({
      code: 'missing_entitlement_rows',
      message: 'Some attributed chains are still awaiting a matching entitlement row.',
    });
  }

  if (Number(rawSummary?.unlinkedAccounts || 0) > 0) {
    warnings.push({
      code: 'unlinked_account_rows',
      message: 'Some attributed chains are not linked to an Agora account, so a subscriber name may be unavailable.',
    });
  }

  const published = publishedOverview || {};
  for (const [field, expected] of [
    ['totalReferrals', total],
    ['currentSubscribers', current],
    ['cancelledSubscribers', cancelled],
  ]) {
    const actual = Number(published?.[field] || 0);
    if (actual !== expected) {
      errors.push({
        code: 'dashboard_metric_mismatch',
        field,
        expected,
        actual,
        message: `Published dashboard ${field} does not match the independent raw-chain calculation.`,
      });
    }
  }

  let payoutMathChecked = 0;
  let payoutMathFailures = 0;
  for (const row of payoutRows || []) {
    const eligibleRevenue = Number(row.eligible_revenue || 0);
    const commissionRate = Number(row.commission_rate || 0);
    const commissionExact = Number(row.commission_earned_exact || 0);
    if (
      !Number.isFinite(eligibleRevenue) ||
      !Number.isFinite(commissionRate) ||
      !Number.isFinite(commissionExact)
    ) {
      payoutMathFailures += 1;
      continue;
    }

    payoutMathChecked += 1;
    const expected = round6(eligibleRevenue * commissionRate);
    if (Math.abs(expected - round6(commissionExact)) > 0.000001) {
      payoutMathFailures += 1;
      errors.push({
        code: 'commission_math_mismatch',
        payoutPeriod: row.payout_period,
        expected: expected.toFixed(6),
        actual: round6(commissionExact).toFixed(6),
        message: 'Stored commission does not equal eligible revenue multiplied by the affiliate commission rate.',
      });
    }
  }

  return {
    status: errors.length === 0
      ? (warnings.length ? 'verified_with_warnings' : 'verified')
      : 'mismatch',
    errors,
    warnings,
    checks: {
      totalReferralsReconcile:
        Number(published?.totalReferrals || 0) === total,
      currentSubscribersReconcile:
        Number(published?.currentSubscribers || 0) === current,
      cancelledSubscribersReconcile:
        Number(published?.cancelledSubscribers || 0) === cancelled,
      statePartitionReconciles: stateTotal === total,
      offerPartitionReconciles: currentProgram + historical === total,
      duplicateOwnershipClear: Number(duplicateOwnership || 0) === 0,
      commissionMathReconciles: payoutMathFailures === 0,
      payoutMathChecked,
    },
  };
}

async function loadAcceptedOffers(pool, affiliateId, currentOfferIdentifier) {
  const result = await pool.query(
    `
    SELECT normalized_offer_identifier
    FROM affiliate_apple_offer_aliases
    WHERE affiliate_id = $1
    `,
    [affiliateId]
  );

  return Array.from(new Set([
    normalizeOffer(currentOfferIdentifier),
    ...result.rows.map((row) => normalizeOffer(row.normalized_offer_identifier)),
  ].filter(Boolean)));
}

async function loadRawFacts(pool, affiliate) {
  const result = await pool.query(
    `
    SELECT
      attribution.original_transaction_id,
      attribution.account_id,
      attribution.normalized_offer_identifier,
      entitlement.original_transaction_id IS NOT NULL AS has_entitlement,
      entitlement.status,
      entitlement.auto_renew_enabled,
      entitlement.expires_date,
      entitlement.grace_period_expires_date,
      EXISTS (
        SELECT 1
        FROM app_store_transactions tx
        WHERE tx.original_transaction_id = attribution.original_transaction_id
          AND tx.environment = attribution.environment
          AND tx.transaction_id IS DISTINCT FROM attribution.attribution_transaction_id
          AND tx.revocation_date IS NULL
          AND COALESCE(tx.price_milliunits, 0) > 0
          AND COALESCE(UPPER(tx.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
      ) AS has_standard_paid_followup,
      (
        SELECT MIN(event.event_at)
        FROM subscription_events event
        WHERE event.original_transaction_id = attribution.original_transaction_id
          AND event.environment = attribution.environment
          AND UPPER(event.event_type) = 'DID_CHANGE_RENEWAL_STATUS'
          AND UPPER(COALESCE(event.subtype, '')) = 'AUTO_RENEW_DISABLED'
      ) AS auto_renew_disabled_at
    FROM affiliate_subscription_attributions attribution
    LEFT JOIN subscription_entitlements entitlement
      ON entitlement.original_transaction_id = attribution.original_transaction_id
     AND entitlement.environment = attribution.environment
    WHERE attribution.affiliate_id = $1
      AND attribution.environment = $2
    ORDER BY attribution.attributed_at ASC, attribution.original_transaction_id ASC
    `,
    [affiliate.id, affiliate.is_test ? 'Sandbox' : 'Production']
  );

  return result.rows.map((row) => ({
    originalTransactionId: row.original_transaction_id,
    accountId: row.account_id,
    normalizedOfferIdentifier: row.normalized_offer_identifier,
    hasEntitlement: Boolean(row.has_entitlement),
    status: row.status,
    autoRenewEnabled: row.auto_renew_enabled,
    expiresAt: row.expires_date,
    gracePeriodExpiresAt: row.grace_period_expires_date,
    hasStandardPaidFollowup: Boolean(row.has_standard_paid_followup),
    autoRenewDisabledAt: row.auto_renew_disabled_at,
  }));
}

async function loadDuplicateOwnership(pool, affiliateId) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS count
    FROM (
      SELECT
        original_transaction_id,
        environment
      FROM affiliate_subscription_attributions
      GROUP BY original_transaction_id, environment
      HAVING COUNT(DISTINCT affiliate_id) > 1
         AND BOOL_OR(affiliate_id = $1)
    ) duplicate
    `,
    [affiliateId]
  );
  return Number(result.rows[0]?.count || 0);
}

async function loadPayoutRows(pool, affiliateId) {
  const result = await pool.query(
    `
    SELECT
      payout_period,
      eligible_revenue,
      commission_rate,
      commission_earned_exact,
      adjustments_total,
      amount_due,
      amount_paid,
      status,
      data_status
    FROM affiliate_monthly_payouts
    WHERE affiliate_id = $1
    ORDER BY payout_period DESC
    LIMIT 36
    `,
    [affiliateId]
  );
  return result.rows;
}


function normalizeMoneyMap(value) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(
    Object.entries(source)
      .map(([currency, amount]) => [
        String(currency || 'USD').trim().toUpperCase() || 'USD',
        round6(Number(amount || 0)),
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function moneyMapsEqual(left, right) {
  const a = normalizeMoneyMap(left);
  const b = normalizeMoneyMap(right);
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys.every((key) => Math.abs(Number(a[key] || 0) - Number(b[key] || 0)) <= 0.000001);
}

export function evaluateAdminOverviewInvariants({
  rawOverview,
  publishedOverview,
} = {}) {
  const raw = rawOverview || {};
  const published = publishedOverview || {};
  const errors = [];

  const numericChecks = [
    ['activeAffiliates', Number(raw.activeAffiliates || 0)],
    ['totalReferrals', Number(raw.totalReferrals || 0)],
    ['currentSubscribers', Number(raw.currentSubscribers || 0)],
    ['cancelledSubscribers', Number(raw.cancelledSubscribers || 0)],
    ['openPartnerAlerts', Number(raw.openPartnerAlerts || 0)],
  ];

  const checks = {};
  for (const [field, expected] of numericChecks) {
    const actual = Number(published[field] || 0);
    const ok = actual === expected;
    checks[`${field}Reconciles`] = ok;
    if (!ok) {
      errors.push({
        code: 'admin_overview_metric_mismatch',
        field,
        expected,
        actual,
        message: `Owner dashboard ${field} does not match the independent raw production calculation.`,
      });
    }
  }

  const estimatedOk = moneyMapsEqual(
    raw.estimatedThisMonthByCurrency,
    published.estimatedThisMonthByCurrency
  );
  const owedOk = moneyMapsEqual(
    raw.currentlyOwedByCurrency,
    published.currentlyOwedByCurrency
  );
  checks.estimatedThisMonthReconciles = estimatedOk;
  checks.currentlyOwedReconciles = owedOk;

  if (!estimatedOk) {
    errors.push({
      code: 'admin_overview_estimate_mismatch',
      expected: normalizeMoneyMap(raw.estimatedThisMonthByCurrency),
      actual: normalizeMoneyMap(published.estimatedThisMonthByCurrency),
      message: 'Owner dashboard Estimated This Month does not reconcile to current-month payout rows.',
    });
  }
  if (!owedOk) {
    errors.push({
      code: 'admin_overview_owed_mismatch',
      expected: normalizeMoneyMap(raw.currentlyOwedByCurrency),
      actual: normalizeMoneyMap(published.currentlyOwedByCurrency),
      message: 'Owner dashboard Currently Owed does not reconcile to finalized unpaid payout rows.',
    });
  }

  return {
    status: errors.length ? 'mismatch' : 'verified',
    errors,
    checks,
    raw: {
      ...raw,
      estimatedThisMonthByCurrency: normalizeMoneyMap(raw.estimatedThisMonthByCurrency),
      currentlyOwedByCurrency: normalizeMoneyMap(raw.currentlyOwedByCurrency),
    },
    published: {
      ...published,
      estimatedThisMonthByCurrency: normalizeMoneyMap(published.estimatedThisMonthByCurrency),
      currentlyOwedByCurrency: normalizeMoneyMap(published.currentlyOwedByCurrency),
    },
  };
}

async function loadRawAdminOverview(pool) {
  const metricsResult = await pool.query(
    `
    SELECT
      COUNT(DISTINCT affiliate.id) FILTER (
        WHERE affiliate.status = 'active'
      )::int AS active_affiliates,
      COUNT(attribution.original_transaction_id)::int AS total_referrals,
      COUNT(attribution.original_transaction_id) FILTER (
        WHERE
          (
            (entitlement.status IN ('active', 'trial') AND entitlement.expires_date > NOW())
            OR (
              entitlement.status = 'grace_period'
              AND entitlement.grace_period_expires_date > NOW()
            )
          )
          AND NOT (
            entitlement.auto_renew_enabled = FALSE
            OR EXISTS (
              SELECT 1
              FROM subscription_events event
              WHERE event.original_transaction_id = attribution.original_transaction_id
                AND event.environment = attribution.environment
                AND UPPER(event.event_type) = 'DID_CHANGE_RENEWAL_STATUS'
                AND UPPER(COALESCE(event.subtype, '')) = 'AUTO_RENEW_DISABLED'
            )
          )
      )::int AS current_subscribers,
      COUNT(attribution.original_transaction_id) FILTER (
        WHERE
          entitlement.auto_renew_enabled = FALSE
          OR EXISTS (
            SELECT 1
            FROM subscription_events event
            WHERE event.original_transaction_id = attribution.original_transaction_id
              AND event.environment = attribution.environment
              AND UPPER(event.event_type) = 'DID_CHANGE_RENEWAL_STATUS'
              AND UPPER(COALESCE(event.subtype, '')) = 'AUTO_RENEW_DISABLED'
          )
      )::int AS cancelled_subscribers
    FROM affiliates affiliate
    LEFT JOIN affiliate_subscription_attributions attribution
      ON attribution.affiliate_id = affiliate.id
     AND attribution.environment = 'Production'
    LEFT JOIN subscription_entitlements entitlement
      ON entitlement.original_transaction_id = attribution.original_transaction_id
     AND entitlement.environment = attribution.environment
    WHERE affiliate.is_test = FALSE
      AND affiliate.status <> 'archived'
    `
  );

  const alertResult = await pool.query(
    `
    SELECT COUNT(*)::int AS open_partner_alerts
    FROM affiliate_alerts alert
    JOIN affiliates affiliate
      ON affiliate.id = alert.affiliate_id
    WHERE affiliate.is_test = FALSE
      AND affiliate.status <> 'archived'
      AND alert.status = 'open'
    `
  );

  const estimateResult = await pool.query(
    `
    SELECT
      UPPER(COALESCE(affiliate.payout_currency, 'USD')) AS currency,
      COALESCE(SUM(payout.amount_due), 0)::text AS amount
    FROM affiliate_monthly_payouts payout
    JOIN affiliates affiliate
      ON affiliate.id = payout.affiliate_id
    WHERE affiliate.is_test = FALSE
      AND affiliate.status <> 'archived'
      AND payout.environment = 'production'
      AND payout.payout_period = date_trunc('month', CURRENT_DATE)::date
    GROUP BY UPPER(COALESCE(affiliate.payout_currency, 'USD'))
    `
  );

  const owedResult = await pool.query(
    `
    SELECT
      UPPER(COALESCE(affiliate.payout_currency, 'USD')) AS currency,
      COALESCE(SUM(
        GREATEST(payout.amount_due - payout.amount_paid, 0)
      ), 0)::text AS amount
    FROM affiliate_monthly_payouts payout
    JOIN affiliates affiliate
      ON affiliate.id = payout.affiliate_id
    WHERE affiliate.is_test = FALSE
      AND affiliate.status <> 'archived'
      AND payout.environment = 'production'
      AND payout.status IN ('ready_to_pay', 'partially_paid')
    GROUP BY UPPER(COALESCE(affiliate.payout_currency, 'USD'))
    `
  );

  const metrics = metricsResult.rows[0] || {};
  const estimatedThisMonthByCurrency = {};
  for (const row of estimateResult.rows || []) {
    estimatedThisMonthByCurrency[row.currency || 'USD'] = Number(row.amount || 0);
  }
  const currentlyOwedByCurrency = {};
  for (const row of owedResult.rows || []) {
    currentlyOwedByCurrency[row.currency || 'USD'] = Number(row.amount || 0);
  }

  return {
    activeAffiliates: Number(metrics.active_affiliates || 0),
    totalReferrals: Number(metrics.total_referrals || 0),
    currentSubscribers: Number(metrics.current_subscribers || 0),
    cancelledSubscribers: Number(metrics.cancelled_subscribers || 0),
    openPartnerAlerts: Number(alertResult.rows[0]?.open_partner_alerts || 0),
    estimatedThisMonthByCurrency,
    currentlyOwedByCurrency,
  };
}

export function createAffiliateTrackingHealthService({
  pool,
  projectPublishedDashboard,
  projectAdminOverview,
} = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Affiliate tracking health service requires a Postgres pool.');
  }
  if (typeof projectPublishedDashboard !== 'function') {
    throw new Error('Affiliate tracking health service requires a dashboard projection callback.');
  }
  if (typeof projectAdminOverview !== 'function') {
    throw new Error('Affiliate tracking health service requires an admin overview projection callback.');
  }

  async function getHealth({ includeInactive = false } = {}) {
    const affiliateResult = await pool.query(
      `
      SELECT
        id,
        display_name,
        normalized_code,
        status,
        code_status,
        is_test,
        normalized_apple_offer_identifier
      FROM affiliates
      WHERE is_test = FALSE
        AND status <> 'archived'
        AND ($1::boolean = TRUE OR status = 'active')
      ORDER BY display_name ASC
      `,
      [Boolean(includeInactive)]
    );

    const affiliates = [];
    for (const affiliate of affiliateResult.rows) {
      const [
        acceptedOffers,
        rawFacts,
        duplicateOwnership,
        payoutRows,
        publishedDashboard,
      ] = await Promise.all([
        loadAcceptedOffers(
          pool,
          affiliate.id,
          affiliate.normalized_apple_offer_identifier
        ),
        loadRawFacts(pool, affiliate),
        loadDuplicateOwnership(pool, affiliate.id),
        loadPayoutRows(pool, affiliate.id),
        projectPublishedDashboard(affiliate),
      ]);

      const rawSummary = summarizeAffiliateTrackingFacts(rawFacts, {
        currentOfferIdentifier: affiliate.normalized_apple_offer_identifier,
        acceptedOfferIdentifiers: acceptedOffers,
      });
      const validation = evaluateAffiliateTrackingInvariants({
        rawSummary,
        publishedOverview: publishedDashboard?.overview || {},
        duplicateOwnership,
        payoutRows,
      });

      affiliates.push({
        affiliateId: affiliate.id,
        displayName: affiliate.display_name,
        code: affiliate.normalized_code,
        status: affiliate.status,
        currentOfferIdentifier: affiliate.normalized_apple_offer_identifier,
        health: validation.status,
        checks: validation.checks,
        errors: validation.errors,
        warnings: validation.warnings,
        raw: {
          totalReferrals: rawSummary.totalReferrals,
          currentSubscribers: rawSummary.currentSubscribers,
          cancelledSubscribers: rawSummary.cancelledSubscribers,
          currentProgramReferrals: rawSummary.currentProgramReferrals,
          historicalReferrals: rawSummary.historicalReferrals,
          missingEntitlements: rawSummary.missingEntitlements,
          unlinkedAccounts: rawSummary.unlinkedAccounts,
          unrecognizedOffers: rawSummary.unrecognizedOffers,
          duplicateOwnership,
        },
        published: {
          totalReferrals: Number(publishedDashboard?.overview?.totalReferrals || 0),
          currentSubscribers: Number(publishedDashboard?.overview?.currentSubscribers || 0),
          cancelledSubscribers: Number(publishedDashboard?.overview?.cancelledSubscribers || 0),
        },
      });
    }

    const [rawAdminOverview, publishedAdminOverview] = await Promise.all([
      loadRawAdminOverview(pool),
      projectAdminOverview(),
    ]);
    const adminOverview = evaluateAdminOverviewInvariants({
      rawOverview: rawAdminOverview,
      publishedOverview: publishedAdminOverview,
    });

    const affiliateMismatchCount = affiliates.filter((item) => item.health === 'mismatch').length;
    const warningCount = affiliates.filter((item) => item.health === 'verified_with_warnings').length;
    const ownerOverviewMismatch = adminOverview.status === 'mismatch';
    const mismatchCount = affiliateMismatchCount + (ownerOverviewMismatch ? 1 : 0);

    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      overall:
        mismatchCount > 0
          ? 'mismatch'
          : (warningCount > 0 ? 'verified_with_warnings' : 'verified'),
      mismatchCount,
      affiliateMismatchCount,
      ownerOverviewMismatch,
      warningCount,
      affiliateCount: affiliates.length,
      adminOverview,
      affiliates,
    };
  }

  return { getHealth };
}
