import crypto from 'crypto';

const RETIRED_OFFER = 'AFFILIATE FIRST MONTH $0.99';

function pct(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  return d > 0 ? (n / d) * 100 : null;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function alias(affiliateId, originalTransactionId) {
  return '#' + crypto
    .createHash('sha256')
    .update(affiliateId + ':' + originalTransactionId, 'utf8')
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
}

function currentOfferCopy(html) {
  if (typeof html !== 'string') return html;

  const replacements = [
    [
      'Subscribers currently in the $0.99 first-month promotional period. Each subscriber appears in only one current-state box. If auto-renew is turned off during the promo, the subscriber remains Promo Active until that access period ends.',
      'Subscribers currently in the 7-day free trial. Each subscriber appears in only one current-state box. If auto-renew is turned off during the trial, the subscriber remains Trial Active until that access period ends.'
    ],
    ['Promo Active', 'Trial Active'],
    [
      'The total revenue that has been accepted as commission eligible under your compensation agreement. Promotional $0.99 payments are excluded.',
      'The total revenue that has been accepted as commission eligible under your compensation agreement. Free-trial access does not generate commissionable revenue.'
    ],
    ['Promo Renewal Rate', 'Trial Conversion Rate'],
    [
      'The percentage of attributed $0.99 promo subscribers who later produced a verified commission-eligible paid renewal.',
      'The percentage of attributed 7-day trial subscribers who later produced a verified commission-eligible paid renewal.'
    ],
    ['Promo Non-Renewals', 'Trial Non-Conversions'],
    [
      'The number of referred subscribers whose $0.99 promotional period ended without a later commission-eligible paid renewal being verified.',
      'The number of referred subscribers whose 7-day free trial ended without a later commission-eligible paid renewal being verified.'
    ],
    ['Promo Non-Renewal Rate', 'Trial Non-Conversion Rate'],
    ['$0.99 Promo', 'Creator Offer'],
    [
      'The promotional $0.99 payment is excluded from commission. Commission begins only when a transaction becomes commission eligible under your plan.',
      'The 7-day creator trial is free and excluded from commission. Commission begins with the first verified standard paid renewal.'
    ],
    [
      'Shows promo outcomes, paid conversion, current retention, and cancellation for referrals acquired in the selected range.',
      'Shows trial outcomes, paid conversion, current retention, and cancellation for referrals acquired in the selected range.'
    ],
    [
      'Promotional $0.99 payments are excluded from commission.',
      'Free-trial access is excluded from commission.'
    ],
    [
      'The $0.99 promotional period is excluded.',
      'The 7-day free-trial period is excluded.'
    ],
    [
      'promo subscribers',
      'trial subscribers'
    ],
    ['<span class="number">Excluded</span>', '<span class="number">7-Day Free Trial</span>'],
  ];

  let updated = html;
  for (const [from, to] of replacements) {
    updated = updated.replaceAll(from, to);
  }
  return updated;
}

async function loadCurrentOfferAffiliate(pool, code) {
  const result = await pool.query(
    `
    SELECT
      id,
      normalized_code,
      apple_offer_identifier,
      normalized_apple_offer_identifier,
      CASE WHEN is_test THEN 'Sandbox' ELSE 'Production' END AS apple_environment
    FROM affiliates
    WHERE normalized_code = $1
    LIMIT 1
    `,
    [String(code || '').trim().toUpperCase()]
  );
  return result.rows[0] || null;
}

function stateFields(row, prefix = '') {
  const key = name => row[prefix + name];
  const totalReferrals = Number(key('total_referrals') || 0);
  const activeSubscribers = Number(key('active_subscribers') || 0);
  const trialActive = Number(key('trial_active_subscribers') || 0);
  const trialCanceling = Number(key('trial_canceling_subscribers') || 0);
  const paidRenewing = Number(key('paid_renewing_subscribers') || 0);
  const paidCanceling = Number(key('paid_canceling_subscribers') || 0);
  const billingRetry = Number(key('billing_retry') || 0);
  const expired = Number(key('expired') || 0);
  const pending = Number(key('pending_state_subscribers') || 0);
  const trialNonConversions = Number(key('trial_nonconversions') || 0);
  const canceling = Number(key('canceling') || 0);
  const cancelledSubscribers = Number(key('cancelled_subscribers') || 0);
  const converted = Number(key('converted_total') || 0);
  const completedTrials = converted + trialNonConversions;

  return {
    totalReferrals,
    activeSubscribers,
    currentSubscribers: activeSubscribers,
    promoSubscribers: trialActive,
    promoActiveSubscribers: trialActive,
    trialCancelingSubscribers: trialCanceling,
    paidRenewingSubscribers: paidRenewing,
    paidCancelingSubscribers: paidCanceling,
    billingRetry,
    expired,
    pendingStateSubscribers: pending,
    commissionEarningSubscribers: paidRenewing + paidCanceling,
    promoNonRenewals: trialNonConversions,
    canceling,
    cancelledSubscribers,
    promoRenewalRate: pct(converted, completedTrials),
    promoNonRenewalRate: pct(trialNonConversions, completedTrials),
    paidConversionRate: pct(converted, totalReferrals),
    activeRetention: pct(activeSubscribers, totalReferrals),
    cancellationRate: pct(canceling, activeSubscribers),
  };
}

async function currentOfferSnapshot(pool, affiliate, range) {
  const start = String(range?.start || '2000-01-01').slice(0, 10);
  const endExclusive = String(range?.endExclusive || '2999-01-01').slice(0, 10);

  const summaryResult = await pool.query(
    `
    WITH chains AS (
      SELECT
        a.original_transaction_id,
        a.attribution_transaction_id,
        a.attributed_at,
        a.last_observed_at,
        COALESCE(e.product_id, a.product_id) AS product_id,
        e.status,
        e.auto_renew_enabled,
        e.expires_date,
        e.grace_period_expires_date,
        e.expires_date,
        e.grace_period_expires_date,
        e.updated_at AS entitlement_updated_at,
        COALESCE(
          BOOL_OR(
            t.transaction_id <> a.attribution_transaction_id
            AND t.revocation_date IS NULL
            AND COALESCE(t.price_milliunits, 0) > 0
            AND COALESCE(UPPER(t.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
          ),
          FALSE
        ) AS has_standard_paid_followup,
        MAX(t.purchase_date) AS latest_purchase_at
      FROM affiliate_subscription_attributions a
      LEFT JOIN subscription_entitlements e
        ON e.original_transaction_id = a.original_transaction_id
       AND e.environment = a.environment
      LEFT JOIN app_store_transactions t
        ON t.original_transaction_id = a.original_transaction_id
       AND t.environment = a.environment
      WHERE a.affiliate_id = $1
        AND a.environment = $2
        AND a.normalized_offer_identifier = $3
      GROUP BY
        a.original_transaction_id,
        a.attribution_transaction_id,
        a.attributed_at,
        a.last_observed_at,
        a.product_id,
        e.product_id,
        e.status,
        e.auto_renew_enabled,
        e.expires_date,
        e.grace_period_expires_date,
        e.updated_at
    ),
    classified AS (
      SELECT
        *,
        (
          (status IN ('active', 'trial') AND expires_date > NOW())
          OR (
            status = 'grace_period'
            AND grace_period_expires_date > NOW()
          )
        ) AS is_active,
        (
          status IN ('expired', 'revoked')
          AND NOT has_standard_paid_followup
        ) AS is_trial_nonconversion,
        (
          timezone('America/Chicago', attributed_at)::date >= $4::date
          AND timezone('America/Chicago', attributed_at)::date < $5::date
        ) AS joined_in_range,
        COALESCE(
          GREATEST(last_observed_at, entitlement_updated_at, latest_purchase_at),
          attributed_at
        ) AS latest_activity_at
      FROM chains
    ),
    states AS (
      SELECT
        *,
        CASE
          WHEN status = 'billing_retry' THEN 'billing_retry'
          WHEN status IN ('expired', 'revoked') THEN 'expired'
          WHEN is_active AND has_standard_paid_followup AND auto_renew_enabled = FALSE
            THEN 'paid_canceling'
          WHEN is_active AND has_standard_paid_followup AND auto_renew_enabled = TRUE
            THEN 'paid_renewing'
          WHEN is_active AND NOT has_standard_paid_followup AND auto_renew_enabled = FALSE
            THEN 'trial_canceling'
          WHEN is_active AND NOT has_standard_paid_followup
            THEN 'promo_active'
          ELSE 'pending'
        END AS current_state
      FROM classified
    )
    SELECT
      COUNT(*)::int AS total_referrals,
      COUNT(*) FILTER (WHERE is_active)::int AS active_subscribers,
      COUNT(*) FILTER (WHERE current_state = 'promo_active')::int AS trial_active_subscribers,
      COUNT(*) FILTER (WHERE current_state = 'trial_canceling')::int AS trial_canceling_subscribers,
      COUNT(*) FILTER (WHERE current_state = 'paid_renewing')::int AS paid_renewing_subscribers,
      COUNT(*) FILTER (WHERE current_state = 'paid_canceling')::int AS paid_canceling_subscribers,
      COUNT(*) FILTER (WHERE current_state = 'billing_retry')::int AS billing_retry,
      COUNT(*) FILTER (WHERE current_state = 'expired')::int AS expired,
      COUNT(*) FILTER (WHERE current_state = 'pending')::int AS pending_state_subscribers,
      COUNT(*) FILTER (WHERE is_trial_nonconversion)::int AS trial_nonconversions,
      COUNT(*) FILTER (WHERE is_active AND auto_renew_enabled = FALSE)::int AS canceling,
      COUNT(*) FILTER (WHERE auto_renew_enabled = FALSE)::int AS cancelled_subscribers,
      COUNT(*) FILTER (WHERE has_standard_paid_followup)::int AS converted_total,

      COUNT(*) FILTER (WHERE joined_in_range)::int AS range_total_referrals,
      COUNT(*) FILTER (WHERE joined_in_range AND is_active)::int AS range_active_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'promo_active')::int AS range_trial_active_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'trial_canceling')::int AS range_trial_canceling_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'paid_renewing')::int AS range_paid_renewing_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'paid_canceling')::int AS range_paid_canceling_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'billing_retry')::int AS range_billing_retry,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'expired')::int AS range_expired,
      COUNT(*) FILTER (WHERE joined_in_range AND current_state = 'pending')::int AS range_pending_state_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND is_trial_nonconversion)::int AS range_trial_nonconversions,
      COUNT(*) FILTER (WHERE joined_in_range AND is_active AND auto_renew_enabled = FALSE)::int AS range_canceling,
      COUNT(*) FILTER (WHERE joined_in_range AND auto_renew_enabled = FALSE)::int AS range_cancelled_subscribers,
      COUNT(*) FILTER (WHERE joined_in_range AND has_standard_paid_followup)::int AS range_converted_total,
      MAX(latest_activity_at) AS latest_activity_at
    FROM states
    `,
    [
      affiliate.id,
      affiliate.apple_environment,
      affiliate.normalized_apple_offer_identifier,
      start,
      endExclusive,
    ]
  );

  const activityResult = await pool.query(
    `
    WITH chains AS (
      SELECT
        a.original_transaction_id,
        a.attribution_transaction_id,
        a.attributed_at,
        a.last_observed_at,
        COALESCE(e.product_id, a.product_id) AS product_id,
        e.status,
        e.auto_renew_enabled,
        e.expires_date,
        e.grace_period_expires_date,
        e.updated_at AS entitlement_updated_at,
        COALESCE(
          BOOL_OR(
            t.transaction_id <> a.attribution_transaction_id
            AND t.revocation_date IS NULL
            AND COALESCE(t.price_milliunits, 0) > 0
            AND COALESCE(UPPER(t.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
          ),
          FALSE
        ) AS has_standard_paid_followup,
        MAX(t.purchase_date) AS latest_purchase_at
      FROM affiliate_subscription_attributions a
      LEFT JOIN subscription_entitlements e
        ON e.original_transaction_id = a.original_transaction_id
       AND e.environment = a.environment
      LEFT JOIN app_store_transactions t
        ON t.original_transaction_id = a.original_transaction_id
       AND t.environment = a.environment
      WHERE a.affiliate_id = $1
        AND a.environment = $2
        AND a.normalized_offer_identifier = $3
      GROUP BY
        a.original_transaction_id,
        a.attribution_transaction_id,
        a.attributed_at,
        a.last_observed_at,
        a.product_id,
        e.product_id,
        e.status,
        e.auto_renew_enabled,
        e.expires_date,
        e.grace_period_expires_date,
        e.updated_at
    ),
    classified AS (
      SELECT
        *,
        (
          (status IN ('active', 'trial') AND expires_date > NOW())
          OR (
            status = 'grace_period'
            AND grace_period_expires_date > NOW()
          )
        ) AS is_active,
        COALESCE(
          GREATEST(last_observed_at, entitlement_updated_at, latest_purchase_at),
          attributed_at
        ) AS latest_activity_at
      FROM chains
    )
    SELECT
      original_transaction_id,
      attributed_at,
      product_id,
      status,
      auto_renew_enabled,
      expires_date,
      has_standard_paid_followup,
      CASE
        WHEN status = 'billing_retry' THEN 'billing_retry'
        WHEN status IN ('expired', 'revoked') THEN 'expired'
        WHEN is_active AND has_standard_paid_followup AND auto_renew_enabled = FALSE
          THEN 'paid_canceling'
        WHEN is_active AND has_standard_paid_followup AND auto_renew_enabled = TRUE
          THEN 'paid_renewing'
          WHEN is_active AND NOT has_standard_paid_followup AND auto_renew_enabled = FALSE
            THEN 'trial_canceling'
        WHEN is_active AND NOT has_standard_paid_followup
          THEN 'promo_active'
        ELSE 'pending'
      END AS current_state,
      latest_activity_at
    FROM classified
    WHERE timezone('America/Chicago', attributed_at)::date >= $4::date
      AND timezone('America/Chicago', attributed_at)::date < $5::date
    ORDER BY attributed_at DESC
    LIMIT 100
    `,
    [
      affiliate.id,
      affiliate.apple_environment,
      affiliate.normalized_apple_offer_identifier,
      start,
      endExclusive,
    ]
  );

  const priceResult = await pool.query(
    `
    WITH active_chains AS (
      SELECT
        a.original_transaction_id,
        a.environment,
        a.attribution_transaction_id,
        COALESCE(e.product_id, a.product_id) AS product_id
      FROM affiliate_subscription_attributions a
      JOIN subscription_entitlements e
        ON e.original_transaction_id = a.original_transaction_id
       AND e.environment = a.environment
      WHERE a.affiliate_id = $1
        AND a.environment = $2
        AND a.normalized_offer_identifier = $3
        AND (
          (e.status IN ('active', 'trial') AND e.expires_date > NOW())
          OR (e.status = 'grace_period' AND e.grace_period_expires_date > NOW())
        )
    ),
    latest_paid AS (
      SELECT
        chain.original_transaction_id,
        COALESCE(paid.product_id, chain.product_id) AS product_id,
        paid.price_milliunits,
        UPPER(COALESCE(NULLIF(paid.currency, ''), 'USD')) AS currency
      FROM active_chains chain
      JOIN LATERAL (
        SELECT t.product_id, t.price_milliunits, t.currency
        FROM app_store_transactions t
        WHERE t.original_transaction_id = chain.original_transaction_id
          AND t.environment = chain.environment
          AND t.transaction_id IS DISTINCT FROM chain.attribution_transaction_id
          AND t.revocation_date IS NULL
          AND COALESCE(t.price_milliunits, 0) > 0
          AND COALESCE(UPPER(t.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
        ORDER BY t.purchase_date DESC NULLS LAST, t.signed_date DESC NULLS LAST, t.transaction_id DESC
        LIMIT 1
      ) paid ON TRUE
    )
    SELECT
      price_milliunits::bigint AS price_milliunits,
      currency,
      product_id,
      COUNT(*)::int AS subscriber_count
    FROM latest_paid
    GROUP BY price_milliunits, currency, product_id
    ORDER BY product_id, price_milliunits, currency
    `,
    [
      affiliate.id,
      affiliate.apple_environment,
      affiliate.normalized_apple_offer_identifier,
    ]
  );

  const row = summaryResult.rows[0] || {};
  const lifetime = stateFields(row);
  const selected = stateFields(row, 'range_');
  const latestActivityAt = iso(row.latest_activity_at);

  return {
    lifetime,
    selected,
    latestActivityAt,
    activity: activityResult.rows.map(item => ({
      subscriberAlias: alias(affiliate.id, item.original_transaction_id),
      joinedAt: iso(item.attributed_at),
      plan: item.product_id || null,
      currentState: item.current_state || 'pending',
      stage: item.has_standard_paid_followup ? 'commission_earning' : 'promo',
      status: item.status || 'unknown',
      autoRenewEnabled: item.auto_renew_enabled == null ? null : Boolean(item.auto_renew_enabled),
      expiresAt: iso(item.expires_date),
      lastActivityAt: iso(item.latest_activity_at),
    })),
    activePaidPriceTiers: priceResult.rows.map(item => {
      const milli = Number(item.price_milliunits);
      return {
        priceMilliunits: Number.isSafeInteger(milli) ? milli : null,
        amount: Number.isSafeInteger(milli) && milli >= 0
          ? (milli / 1000).toFixed(3).replace(/0$/, '')
          : null,
        currency: String(item.currency || 'USD').toUpperCase(),
        productId: item.product_id || null,
        count: Number(item.subscriber_count || 0),
      };
    }),
  };
}

async function historicalRetiredOfferSnapshot(pool, affiliate, range) {
  const start = String(range?.start || '2000-01-01').slice(0, 10);
  const endExclusive = String(range?.endExclusive || '2999-01-01').slice(0, 10);

  const result = await pool.query(
    `
    WITH chains AS (
      SELECT
        a.original_transaction_id,
        a.attributed_at,
        a.attribution_transaction_id,
        e.status,
        e.auto_renew_enabled,
        COALESCE(
          BOOL_OR(
            t.transaction_id <> a.attribution_transaction_id
            AND t.revocation_date IS NULL
            AND COALESCE(t.price_milliunits, 0) > 0
            AND COALESCE(UPPER(t.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
          ),
          FALSE
        ) AS has_standard_paid_followup,
        MAX(t.purchase_date) AS latest_purchase_at
      FROM affiliate_subscription_attributions a
      LEFT JOIN subscription_entitlements e
        ON e.original_transaction_id = a.original_transaction_id
       AND e.environment = a.environment
      LEFT JOIN app_store_transactions t
        ON t.original_transaction_id = a.original_transaction_id
       AND t.environment = a.environment
      WHERE a.affiliate_id = $1
        AND a.environment = $2
        AND a.normalized_offer_identifier = $3
      GROUP BY
        a.original_transaction_id,
        a.attributed_at,
        a.attribution_transaction_id,
        e.status,
        e.auto_renew_enabled,
        e.expires_date,
        e.grace_period_expires_date
    ),
    classified AS (
      SELECT
        *,
        (
          timezone('America/Chicago', attributed_at)::date >= $4::date
          AND timezone('America/Chicago', attributed_at)::date < $5::date
        ) AS joined_in_range,
        (
          (status IN ('active', 'trial') AND expires_date > NOW())
          OR (
            status = 'grace_period'
            AND grace_period_expires_date > NOW()
          )
        ) AS is_active,
        (
          auto_renew_enabled = FALSE
          AND NOT has_standard_paid_followup
        ) AS cancelled_before_full_price
      FROM chains
    )
    SELECT
      COUNT(*)::int AS total_signups,
      COUNT(*) FILTER (
        WHERE is_active
      )::int AS active_subscribers,
      COUNT(*) FILTER (
        WHERE cancelled_before_full_price
      )::int AS cancelled_before_full_price,
      COUNT(*) FILTER (
        WHERE auto_renew_enabled = FALSE
      )::int AS cancelled_subscribers,
      COUNT(*) FILTER (
        WHERE has_standard_paid_followup
      )::int AS converted_to_paid,
      COUNT(*) FILTER (
        WHERE NOT has_standard_paid_followup
          AND status IN ('expired', 'revoked')
      )::int AS ended_without_paid_conversion,

      COUNT(*) FILTER (
        WHERE joined_in_range
      )::int AS range_total_signups,
      COUNT(*) FILTER (
        WHERE joined_in_range
          AND is_active
      )::int AS range_active_subscribers,
      COUNT(*) FILTER (
        WHERE joined_in_range
          AND cancelled_before_full_price
      )::int AS range_cancelled_before_full_price,
      COUNT(*) FILTER (
        WHERE joined_in_range
          AND auto_renew_enabled = FALSE
      )::int AS range_cancelled_subscribers,
      COUNT(*) FILTER (
        WHERE joined_in_range
          AND has_standard_paid_followup
      )::int AS range_converted_to_paid,
      COUNT(*) FILTER (
        WHERE joined_in_range
          AND NOT has_standard_paid_followup
          AND status IN ('expired', 'revoked')
      )::int AS range_ended_without_paid_conversion,

      MAX(COALESCE(latest_purchase_at, attributed_at)) AS latest_activity_at
    FROM classified
    `,
    [
      affiliate.id,
      affiliate.apple_environment,
      RETIRED_OFFER,
      start,
      endExclusive,
    ]
  );

  const row = result.rows[0] || {};
  return {
    lifetime: {
      totalSignups: Number(row.total_signups || 0),
      activeSubscribers: Number(row.active_subscribers || 0),
      cancelledBeforeFullPrice: Number(row.cancelled_before_full_price || 0),
      cancelledSubscribers: Number(row.cancelled_subscribers || 0),
      convertedToPaid: Number(row.converted_to_paid || 0),
      endedWithoutPaidConversion: Number(row.ended_without_paid_conversion || 0),
    },
    selected: {
      totalSignups: Number(row.range_total_signups || 0),
      activeSubscribers: Number(row.range_active_subscribers || 0),
      cancelledBeforeFullPrice: Number(row.range_cancelled_before_full_price || 0),
      cancelledSubscribers: Number(row.range_cancelled_subscribers || 0),
      convertedToPaid: Number(row.range_converted_to_paid || 0),
      endedWithoutPaidConversion: Number(row.range_ended_without_paid_conversion || 0),
    },
    latestActivityAt: iso(row.latest_activity_at),
  };
}

async function scopePartnerDashboard(pool, payload) {
  if (!payload?.success || !payload?.data?.affiliate?.customCode) return payload;

  const data = payload.data;
  const affiliate = await loadCurrentOfferAffiliate(pool, data.affiliate.customCode);
  if (!affiliate?.normalized_apple_offer_identifier) return payload;

  const [snapshot, historicalOffer] = await Promise.all([
    currentOfferSnapshot(pool, affiliate, data.range),
    historicalRetiredOfferSnapshot(pool, affiliate, data.range),
  ]);
  const l = snapshot.lifetime;
  const r = snapshot.selected;

  data.affiliate.appleOfferIdentifier = affiliate.apple_offer_identifier;
  Object.assign(data.overview, {
    totalReferrals:
      l.totalReferrals + historicalOffer.lifetime.totalSignups,
    cancelledSubscribers:
      l.cancelledSubscribers + historicalOffer.lifetime.cancelledSubscribers,
    activeSubscribers:
      l.activeSubscribers + historicalOffer.lifetime.activeSubscribers,
    currentSubscribers:
      l.currentSubscribers + historicalOffer.lifetime.activeSubscribers,
    promoSubscribers: l.promoSubscribers,
    promoActiveSubscribers: l.promoActiveSubscribers,
    trialCancelingSubscribers: l.trialCancelingSubscribers,
    commissionEarningSubscribers: l.commissionEarningSubscribers,
    paidRenewingSubscribers: l.paidRenewingSubscribers,
    paidCancelingSubscribers: l.paidCancelingSubscribers,
    billingRetry: l.billingRetry,
    expired: l.expired,
    pendingStateSubscribers: l.pendingStateSubscribers,
    promoNonRenewals: l.promoNonRenewals,
    canceling: l.canceling,
    promoRenewalRate: l.promoRenewalRate,
    paidConversionRate: l.paidConversionRate,
    activeRetention: l.activeRetention,
    cancellationRate: l.cancellationRate,
    activePaidSubscribers: l.commissionEarningSubscribers,
  });

  if (data.breakdown?.subscriberMetrics) {
    Object.assign(data.breakdown.subscriberMetrics, {
      totalReferrals: l.totalReferrals,
      newReferrals: r.totalReferrals,
      activeSubscribers: r.activeSubscribers,
      currentSubscribers: r.currentSubscribers,
      promoSubscribers: r.promoSubscribers,
      promoActiveSubscribers: r.promoActiveSubscribers,
      trialCancelingSubscribers: r.trialCancelingSubscribers,
      commissionEarningSubscribers: r.commissionEarningSubscribers,
      paidRenewingSubscribers: r.paidRenewingSubscribers,
      paidCancelingSubscribers: r.paidCancelingSubscribers,
      billingRetry: r.billingRetry,
      expired: r.expired,
      pendingStateSubscribers: r.pendingStateSubscribers,
      promoNonRenewals: r.promoNonRenewals,
      canceling: r.canceling,
      activePaidSubscribers: r.commissionEarningSubscribers,
    });
  }

  if (data.breakdown?.performance) {
    Object.assign(data.breakdown.performance, {
      promoRenewalRate: r.promoRenewalRate,
      promoNonRenewalRate: r.promoNonRenewalRate,
      paidConversionRate: r.paidConversionRate,
      activeRetention: r.activeRetention,
      cancellationRate: r.cancellationRate,
    });
  }

  if (data.breakdown) {
    const detailedActivity = Array.isArray(
      data.breakdown.anonymousSubscriberActivity
    )
      ? data.breakdown.anonymousSubscriberActivity
      : [];

    data.breakdown.anonymousSubscriberActivity =
      detailedActivity.length > 0
        ? detailedActivity
        : snapshot.activity;
  }

  data.historicalOffer = {
    label: 'Previous Offer History',
    retiredOffer: 'Affiliate First Month $0.99',
    ...historicalOffer.lifetime,
    selected: historicalOffer.selected,
    latestActivityAt: historicalOffer.latestActivityAt,
  };

  if (data.breakdown) {
    data.breakdown.previousOfferHistory = historicalOffer.selected;
  }

  data.subscriberPricing = {
    source: 'verified_current_offer_transactions',
    exactCountsAvailable: true,
    activePaidPriceTiers: snapshot.activePaidPriceTiers,
  };

  data.dataFreshness = {
    ...(data.dataFreshness || {}),
    latestAppleStateDate: snapshot.latestActivityAt,
    latestVerifiedSubscriptionAt: snapshot.latestActivityAt,
    status: snapshot.latestActivityAt ? 'apple_data_available' : 'awaiting_apple_data',
    subscriberDataSource: 'verified_current_offer_chains',
  };

  if (data.reconciliation) {
    data.reconciliation.appleOfferRedemptions = null;
    data.reconciliation.paidOfferStarts = null;
    data.reconciliation.attributedSubscriptionChains = l.totalReferrals;
  }

  return payload;
}

async function scopeAdminAffiliateList(pool, payload) {
  if (!payload?.success || !Array.isArray(payload.affiliates) || !payload.affiliates.length) {
    return payload;
  }

  const ids = payload.affiliates.map(item => item.id).filter(Boolean);
  if (!ids.length) return payload;

  const result = await pool.query(
    `
    SELECT
      affiliate.id AS affiliate_id,
      COUNT(attr.original_transaction_id)::int AS total_referrals,
      COUNT(attr.original_transaction_id) FILTER (
        WHERE
          (ent.status IN ('active', 'trial') AND ent.expires_date > NOW())
          OR (
            ent.status = 'grace_period'
            AND ent.grace_period_expires_date > NOW()
          )
      )::int AS current_subscribers
    FROM affiliates affiliate
    LEFT JOIN affiliate_subscription_attributions attr
      ON attr.affiliate_id = affiliate.id
     AND attr.environment = CASE WHEN affiliate.is_test THEN 'Sandbox' ELSE 'Production' END
     AND attr.normalized_offer_identifier = affiliate.normalized_apple_offer_identifier
    LEFT JOIN subscription_entitlements ent
      ON ent.original_transaction_id = attr.original_transaction_id
     AND ent.environment = attr.environment
    WHERE affiliate.id = ANY($1::uuid[])
    GROUP BY affiliate.id
    `,
    [ids]
  );

  const byId = new Map(result.rows.map(row => [row.affiliate_id, row]));
  payload.affiliates = payload.affiliates.map(item => {
    const current = byId.get(item.id);
    if (!current) return item;

    // Retired $0.99 partners stay queryable for historical audit purposes, but
    // their retired campaign is not part of the live creator-program totals.
    if (
      item.status !== 'active' &&
      String(item.normalized_apple_offer_identifier || '').toUpperCase() === RETIRED_OFFER
    ) {
      return { ...item, total_referrals: 0, current_subscribers: 0 };
    }

    return {
      ...item,
      total_referrals: Number(current.total_referrals || 0),
      current_subscribers: Number(current.current_subscribers || 0),
    };
  });

  return payload;
}

export function createAffiliateCurrentOfferDashboardMiddleware(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('Affiliate current-offer middleware requires a Postgres pool.');
  }

  return (req, res, next) => {
    const path = String(req.path || '');
    const host = String(req.hostname || '').toLowerCase();
    const partnerHtml =
      /^\/partners\/[^/]+$/.test(path) ||
      (host.startsWith('partners.') && /^\/[^/]+$/.test(path));

    if (partnerHtml) {
      const originalSend = res.send.bind(res);
      res.send = body => originalSend(currentOfferCopy(body));
    }

    const partnerApi = /^\/api\/partner\/[^/]+\/dashboard$/.test(path);
    const adminAffiliateApi = path === '/api/admin/affiliates';

    if (partnerApi || adminAffiliateApi) {
      const originalJson = res.json.bind(res);
      res.json = payload => {
        const transform = partnerApi
          ? scopePartnerDashboard(pool, payload)
          : scopeAdminAffiliateList(pool, payload);

        Promise.resolve(transform)
          .then(result => originalJson(result))
          .catch(error => {
            console.error('[affiliate-current-offer] metric scoping failed:', error);
            res.status(500);
            originalJson({
              success: false,
              error: {
                code: 'affiliate_current_offer_metrics_failed',
                message: 'Affiliate metrics are temporarily unavailable.',
              },
            });
          });

        return res;
      };
    }

    return next();
  };
}
