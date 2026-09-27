const RETIRED_OFFER = 'AFFILIATE FIRST MONTH $0.99';

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function loadAffiliateSubscriberLedger(pool, affiliate, range) {
  const start = String(range?.start || '2000-01-01').slice(0, 10);
  const endExclusive = String(range?.endExclusive || '2999-01-01').slice(0, 10);

  const result = await pool.query(
    `
    WITH ranked AS (
      SELECT
        a.*,
        ROW_NUMBER() OVER (
          ORDER BY a.attributed_at ASC, a.original_transaction_id ASC
        )::int AS subscriber_number
      FROM affiliate_subscription_attributions a
      WHERE a.affiliate_id = $1
        AND a.environment = $2
    )
    SELECT
      ranked.subscriber_number,
      ranked.attributed_at,
      ranked.normalized_offer_identifier,
      COALESCE(e.product_id, ranked.product_id) AS product_id,
      e.status,
      e.auto_renew_enabled,
      e.expires_date,
      e.grace_period_expires_date,
      paid.first_standard_paid_at,
      cancellation.auto_renew_disabled_at,
      COALESCE(
        GREATEST(
          ranked.last_observed_at,
          e.updated_at,
          paid.first_standard_paid_at,
          cancellation.auto_renew_disabled_at
        ),
        ranked.attributed_at
      ) AS latest_activity_at
    FROM ranked
    LEFT JOIN subscription_entitlements e
      ON e.original_transaction_id = ranked.original_transaction_id
     AND e.environment = ranked.environment
    LEFT JOIN LATERAL (
      SELECT MIN(
        COALESCE(t.purchase_date, t.signed_date, t.created_at)
      ) AS first_standard_paid_at
      FROM app_store_transactions t
      WHERE t.original_transaction_id = ranked.original_transaction_id
        AND t.environment = ranked.environment
        AND t.transaction_id IS DISTINCT FROM ranked.attribution_transaction_id
        AND t.revocation_date IS NULL
        AND COALESCE(t.price_milliunits, 0) > 0
        AND COALESCE(UPPER(t.offer_type::text), '') NOT IN ('3', 'OFFER_CODE')
    ) paid ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(event.event_at) AS auto_renew_disabled_at
      FROM subscription_events event
      WHERE event.original_transaction_id = ranked.original_transaction_id
        AND event.environment = ranked.environment
        AND UPPER(event.event_type) = 'DID_CHANGE_RENEWAL_STATUS'
        AND UPPER(COALESCE(event.subtype, '')) = 'AUTO_RENEW_DISABLED'
    ) cancellation ON TRUE
    WHERE ranked.normalized_offer_identifier IN ($3, $4)
      AND timezone('America/Chicago', ranked.attributed_at)::date >= $5::date
      AND timezone('America/Chicago', ranked.attributed_at)::date < $6::date
    ORDER BY ranked.attributed_at DESC, ranked.subscriber_number DESC
    LIMIT 100
    `,
    [
      affiliate.id,
      affiliate.apple_environment,
      affiliate.normalized_apple_offer_identifier,
      RETIRED_OFFER,
      start,
      endExclusive,
    ]
  );

  const now = Date.now();

  return result.rows.map((item) => {
    const normalizedOffer = String(item.normalized_offer_identifier || '')
      .trim()
      .toUpperCase();
    const isCurrentOffer =
      normalizedOffer === affiliate.normalized_apple_offer_identifier;
    const hasPaid = Boolean(item.first_standard_paid_at);
    const status = String(item.status || '').toLowerCase();
    const expiresAt = item.expires_date ? new Date(item.expires_date).getTime() : 0;
    const graceAt = item.grace_period_expires_date
      ? new Date(item.grace_period_expires_date).getTime()
      : 0;
    const active =
      (['active', 'trial'].includes(status) && expiresAt > now) ||
      (status === 'grace_period' && graceAt > now);

    let currentState = 'pending';

    if (!isCurrentOffer) {
      if (hasPaid) currentState = 'previous_offer_converted';
      else if (item.auto_renew_disabled_at || item.auto_renew_enabled === false) {
        currentState = 'previous_offer_cancelled';
      } else if (['expired', 'revoked'].includes(status)) {
        currentState = 'previous_offer_ended';
      } else {
        currentState = 'previous_offer_active';
      }
    } else if (status === 'billing_retry') {
      currentState = 'billing_retry';
    } else if (['expired', 'revoked'].includes(status)) {
      currentState = hasPaid ? 'expired' : 'trial_expired_without_conversion';
    } else if (active && hasPaid && item.auto_renew_enabled === false) {
      currentState = 'paid_canceling';
    } else if (active && hasPaid) {
      currentState = 'paid_renewing';
    } else if (active && !hasPaid && item.auto_renew_enabled === false) {
      currentState = 'trial_canceling';
    } else if (active && !hasPaid) {
      currentState = 'promo_active';
    }

    return {
      subscriberLabel: 'Subscriber #' + Number(item.subscriber_number || 0),
      joinedAt: iso(item.attributed_at),
      offerLabel: isCurrentOffer ? '7-Day Free Trial' : 'Previous Offer',
      plan: item.product_id || null,
      currentState,
      autoRenewEnabled:
        item.auto_renew_enabled == null ? null : Boolean(item.auto_renew_enabled),
      autoRenewDisabledAt: iso(item.auto_renew_disabled_at),
      firstStandardPaidAt: iso(item.first_standard_paid_at),
      expiresAt: iso(item.expires_date),
      lastActivityAt: iso(item.latest_activity_at),
    };
  });
}
