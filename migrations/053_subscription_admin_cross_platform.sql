-- 053_subscription_admin_cross_platform.sql
-- Cross-platform owner subscription dashboard support for App Store + Google Play.
--
-- Goals:
--   * Preserve the existing Apple admin projections unchanged.
--   * Add Google Play customers, trials, paid states, churn signals, and affiliate
--     attribution to owner-facing dashboard projections.
--   * Record Google subscription state transitions so lifecycle history remains
--     auditable after launch instead of depending only on the latest entitlement row.
--
-- Google Play revenue is intentionally not estimated here. The dashboard can count
-- Android subscribers and lifecycle states exactly while financial reporting remains
-- sourced from verified store-specific financial data.

CREATE TABLE IF NOT EXISTS google_play_subscription_state_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    purchase_token_sha256 TEXT NOT NULL
        REFERENCES google_play_subscription_entitlements(purchase_token_sha256)
        ON DELETE RESTRICT,

    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE RESTRICT,

    change_kind TEXT NOT NULL
        CHECK (change_kind IN ('snapshot', 'state_change')),

    previous_normalized_status TEXT,
    normalized_status TEXT NOT NULL,

    previous_is_trial BOOLEAN,
    is_trial BOOLEAN NOT NULL,

    previous_auto_renew_enabled BOOLEAN,
    auto_renew_enabled BOOLEAN,

    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,

    previous_latest_order_id TEXT,
    latest_order_id TEXT,

    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,
    start_time TIMESTAMPTZ,
    expires_date TIMESTAMPTZ,
    region_code TEXT,

    event_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
    google_play_subscription_state_events_account_time_idx
ON google_play_subscription_state_events (
    account_id,
    event_at DESC,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    google_play_subscription_state_events_token_time_idx
ON google_play_subscription_state_events (
    purchase_token_sha256,
    event_at DESC,
    created_at DESC
);

-- Preserve a baseline for entitlements that existed before this migration.
INSERT INTO google_play_subscription_state_events (
    purchase_token_sha256,
    account_id,
    change_kind,
    previous_normalized_status,
    normalized_status,
    previous_is_trial,
    is_trial,
    previous_auto_renew_enabled,
    auto_renew_enabled,
    product_id,
    base_plan_id,
    offer_id,
    previous_latest_order_id,
    latest_order_id,
    test_purchase,
    start_time,
    expires_date,
    region_code,
    event_at
)
SELECT
    entitlement.purchase_token_sha256,
    entitlement.account_id,
    'snapshot',
    NULL,
    entitlement.normalized_status,
    NULL,
    entitlement.is_trial,
    NULL,
    entitlement.auto_renew_enabled,
    entitlement.product_id,
    entitlement.base_plan_id,
    entitlement.offer_id,
    NULL,
    entitlement.latest_order_id,
    entitlement.test_purchase,
    entitlement.start_time,
    entitlement.expires_date,
    entitlement.region_code,
    COALESCE(
        entitlement.last_verified_at,
        entitlement.updated_at,
        entitlement.created_at,
        NOW()
    )
FROM google_play_subscription_entitlements entitlement
WHERE NOT EXISTS (
    SELECT 1
    FROM google_play_subscription_state_events existing
    WHERE existing.purchase_token_sha256 = entitlement.purchase_token_sha256
);

CREATE OR REPLACE FUNCTION record_google_play_subscription_state_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO google_play_subscription_state_events (
            purchase_token_sha256,
            account_id,
            change_kind,
            previous_normalized_status,
            normalized_status,
            previous_is_trial,
            is_trial,
            previous_auto_renew_enabled,
            auto_renew_enabled,
            product_id,
            base_plan_id,
            offer_id,
            previous_latest_order_id,
            latest_order_id,
            test_purchase,
            start_time,
            expires_date,
            region_code,
            event_at
        )
        VALUES (
            NEW.purchase_token_sha256,
            NEW.account_id,
            'snapshot',
            NULL,
            NEW.normalized_status,
            NULL,
            NEW.is_trial,
            NULL,
            NEW.auto_renew_enabled,
            NEW.product_id,
            NEW.base_plan_id,
            NEW.offer_id,
            NULL,
            NEW.latest_order_id,
            NEW.test_purchase,
            NEW.start_time,
            NEW.expires_date,
            NEW.region_code,
            COALESCE(NEW.last_verified_at, NEW.updated_at, NEW.created_at, NOW())
        );
        RETURN NEW;
    END IF;

    IF
        OLD.normalized_status IS DISTINCT FROM NEW.normalized_status
        OR OLD.is_trial IS DISTINCT FROM NEW.is_trial
        OR OLD.auto_renew_enabled IS DISTINCT FROM NEW.auto_renew_enabled
        OR OLD.product_id IS DISTINCT FROM NEW.product_id
        OR OLD.base_plan_id IS DISTINCT FROM NEW.base_plan_id
        OR OLD.offer_id IS DISTINCT FROM NEW.offer_id
        OR OLD.latest_order_id IS DISTINCT FROM NEW.latest_order_id
        OR OLD.expires_date IS DISTINCT FROM NEW.expires_date
        OR OLD.test_purchase IS DISTINCT FROM NEW.test_purchase
    THEN
        INSERT INTO google_play_subscription_state_events (
            purchase_token_sha256,
            account_id,
            change_kind,
            previous_normalized_status,
            normalized_status,
            previous_is_trial,
            is_trial,
            previous_auto_renew_enabled,
            auto_renew_enabled,
            product_id,
            base_plan_id,
            offer_id,
            previous_latest_order_id,
            latest_order_id,
            test_purchase,
            start_time,
            expires_date,
            region_code,
            event_at
        )
        VALUES (
            NEW.purchase_token_sha256,
            NEW.account_id,
            'state_change',
            OLD.normalized_status,
            NEW.normalized_status,
            OLD.is_trial,
            NEW.is_trial,
            OLD.auto_renew_enabled,
            NEW.auto_renew_enabled,
            NEW.product_id,
            NEW.base_plan_id,
            NEW.offer_id,
            OLD.latest_order_id,
            NEW.latest_order_id,
            NEW.test_purchase,
            NEW.start_time,
            NEW.expires_date,
            NEW.region_code,
            COALESCE(NEW.last_verified_at, NEW.updated_at, NOW())
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
    google_play_subscription_state_event_trigger
ON google_play_subscription_entitlements;

CREATE TRIGGER google_play_subscription_state_event_trigger
AFTER INSERT OR UPDATE
ON google_play_subscription_entitlements
FOR EACH ROW
EXECUTE FUNCTION record_google_play_subscription_state_event();

CREATE OR REPLACE VIEW subscription_admin_cross_platform_customers_v1 AS
WITH latest_google_identity AS (
    SELECT DISTINCT ON (account_id)
        account_id,
        email,
        display_name,
        last_authenticated_at
    FROM account_google_identities
    ORDER BY
        account_id,
        last_authenticated_at DESC NULLS LAST,
        created_at DESC
),
google_rows AS (
    SELECT
        entitlement.*,
        CASE
            WHEN entitlement.normalized_status = 'on_hold'
                THEN 'billing_retry'
            WHEN entitlement.normalized_status IN ('paused', 'expired', 'replaced')
                THEN 'expired'
            WHEN entitlement.normalized_status = 'pending'
                THEN 'unknown'
            ELSE entitlement.normalized_status
        END AS dashboard_status,
        (
            entitlement.normalized_status IN ('trial', 'active', 'grace_period')
            AND (
                entitlement.expires_date IS NULL
                OR entitlement.expires_date > NOW()
            )
        ) AS has_pro_access
    FROM google_play_subscription_entitlements entitlement
)
SELECT
    customer.original_transaction_id,
    customer.environment,
    customer.product_id,
    customer.pro_access_source,
    customer.is_recurring_pro,
    customer.is_lifetime_pro,
    customer.status,
    customer.is_trial,
    customer.auto_renew_enabled,
    customer.purchase_date,
    customer.original_purchase_date,
    customer.expires_date,
    customer.grace_period_expires_date,
    customer.revocation_date,
    customer.expiration_intent,
    customer.last_transaction_id,
    customer.last_notification_type,
    customer.last_notification_subtype,
    customer.source,
    customer.last_signed_date,
    customer.pricing_cohort,
    customer.pricing_cohort_source,
    customer.pricing_cohort_assigned_at,
    customer.installation_user_id,
    customer.app_account_token,
    customer.created_at,
    customer.updated_at,
    customer.account_id,
    customer.ownership_status,
    customer.claim_source,
    customer.claimed_at,
    customer.last_verified_at,
    customer.account_status,
    customer.account_display_name,
    customer.apple_email,
    customer.apple_private_email,
    customer.google_email,
    customer.account_email,
    customer.identity_source,
    customer.affiliate_id,
    customer.affiliate_display_name,
    customer.affiliate_code,
    customer.affiliate_attribution_source,
    customer.affiliate_attributed_at,
    customer.latest_transaction_id,
    customer.latest_transaction_reason,
    customer.latest_transaction_type,
    customer.latest_offer_type,
    customer.latest_offer_identifier,
    customer.latest_offer_discount_type,
    customer.latest_purchase_date,
    customer.latest_transaction_signed_date,
    customer.storefront,
    customer.storefront_id,
    customer.currency,
    customer.price_milliunits,
    customer.quantity,
    customer.has_pro_access,
    customer.recurring_revenue_active,
    customer.trial_active,
    customer.canceling,
    customer.access_ends_at,
    customer.recurring_business_metrics_eligible,
    customer.estimated_mrr_usd,
    customer.customer_key,
    'app_store'::text AS store_platform
FROM subscription_admin_customers_v1 customer

UNION ALL

SELECT
    ('gp:' || google.purchase_token_sha256)::text AS original_transaction_id,
    CASE
        WHEN google.test_purchase THEN 'Sandbox'
        ELSE 'Production'
    END::text AS environment,
    google.product_id,
    CASE google.product_id
        WHEN 'agora_pro_monthly' THEN 'monthly'
        WHEN 'agora_pro_yearly' THEN 'annual'
        ELSE 'unknown'
    END::text AS pro_access_source,
    TRUE AS is_recurring_pro,
    FALSE AS is_lifetime_pro,
    google.dashboard_status::text AS status,
    google.is_trial,
    google.auto_renew_enabled,
    COALESCE(google.start_time, google.created_at) AS purchase_date,
    COALESCE(google.start_time, google.created_at) AS original_purchase_date,
    google.expires_date,
    CASE
        WHEN google.normalized_status = 'grace_period'
            THEN google.expires_date
        ELSE NULL
    END::timestamptz AS grace_period_expires_date,
    NULL::timestamptz AS revocation_date,
    NULL::text AS expiration_intent,
    google.latest_order_id::text AS last_transaction_id,
    NULL::text AS last_notification_type,
    NULL::text AS last_notification_subtype,
    'google_play'::text AS source,
    google.last_verified_at AS last_signed_date,
    google.pricing_cohort::text,
    google.pricing_cohort_source::text,
    NULL::timestamptz AS pricing_cohort_assigned_at,
    NULL::text AS installation_user_id,
    NULL::uuid AS app_account_token,
    google.created_at,
    google.updated_at,
    google.account_id,
    'active'::text AS ownership_status,
    'google_play_verified'::text AS claim_source,
    google.created_at AS claimed_at,
    google.last_verified_at,
    account.status::text AS account_status,
    COALESCE(
        NULLIF(BTRIM(account.display_name), ''),
        NULLIF(BTRIM(identity.display_name), '')
    )::text AS account_display_name,
    NULL::text AS apple_email,
    NULL::boolean AS apple_private_email,
    identity.email::text AS google_email,
    identity.email::text AS account_email,
    'google'::text AS identity_source,
    attribution.affiliate_id,
    affiliate.display_name::text AS affiliate_display_name,
    COALESCE(
        attribution.normalized_creator_code,
        affiliate.custom_code
    )::text AS affiliate_code,
    attribution.attribution_source::text AS affiliate_attribution_source,
    attribution.attributed_at AS affiliate_attributed_at,
    google.latest_order_id::text AS latest_transaction_id,
    CASE
        WHEN google.is_trial THEN 'trial_start'
        WHEN google.latest_order_id IS NOT NULL THEN 'purchase'
        ELSE 'subscription_state'
    END::text AS latest_transaction_reason,
    'GOOGLE_PLAY'::text AS latest_transaction_type,
    CASE
        WHEN google.offer_id IS NOT NULL THEN 'OFFER'
        ELSE NULL
    END::text AS latest_offer_type,
    google.offer_id::text AS latest_offer_identifier,
    CASE
        WHEN google.is_trial THEN 'FREE_TRIAL'
        ELSE NULL
    END::text AS latest_offer_discount_type,
    COALESCE(google.start_time, google.created_at) AS latest_purchase_date,
    google.last_verified_at AS latest_transaction_signed_date,
    google.region_code::text AS storefront,
    NULL::text AS storefront_id,
    NULL::text AS currency,
    NULL::bigint AS price_milliunits,
    1::integer AS quantity,
    google.has_pro_access,
    (
        NOT google.test_purchase
        AND google.is_trial = FALSE
        AND google.has_pro_access
    ) AS recurring_revenue_active,
    (
        NOT google.test_purchase
        AND google.is_trial = TRUE
        AND google.has_pro_access
    ) AS trial_active,
    (
        google.auto_renew_enabled = FALSE
        AND google.has_pro_access
    ) AS canceling,
    google.expires_date AS access_ends_at,
    (
        NOT google.test_purchase
        AND google.is_trial = FALSE
    ) AS recurring_business_metrics_eligible,
    0::numeric AS estimated_mrr_usd,
    google.account_id::text AS customer_key,
    'google_play'::text AS store_platform
FROM google_rows google
LEFT JOIN accounts account
    ON account.id = google.account_id
LEFT JOIN latest_google_identity identity
    ON identity.account_id = google.account_id
LEFT JOIN affiliate_google_play_subscription_attributions attribution
    ON attribution.purchase_token_sha256 = google.purchase_token_sha256
LEFT JOIN affiliates affiliate
    ON affiliate.id = attribution.affiliate_id;

CREATE OR REPLACE VIEW subscription_admin_cross_platform_current_customers_v1 AS
WITH ranked AS (
    SELECT
        customer.*,
        COUNT(*) OVER (
            PARTITION BY customer.customer_key, customer.environment
        )::int AS customer_chain_count,
        ROW_NUMBER() OVER (
            PARTITION BY customer.customer_key, customer.environment
            ORDER BY
                CASE
                    WHEN customer.is_lifetime_pro
                      AND customer.has_pro_access
                        THEN 0
                    WHEN customer.recurring_revenue_active
                      AND customer.auto_renew_enabled = TRUE
                        THEN 1
                    WHEN customer.recurring_revenue_active
                      AND customer.auto_renew_enabled = FALSE
                        THEN 2
                    WHEN customer.recurring_revenue_active
                        THEN 3
                    WHEN customer.trial_active
                      AND customer.auto_renew_enabled = TRUE
                        THEN 4
                    WHEN customer.trial_active
                      AND customer.auto_renew_enabled = FALSE
                        THEN 5
                    WHEN customer.trial_active
                        THEN 6
                    WHEN customer.has_pro_access
                        THEN 7
                    WHEN customer.status = 'billing_retry'
                        THEN 8
                    WHEN customer.status IN ('active', 'trial', 'grace_period')
                        THEN 9
                    WHEN customer.status = 'expired'
                        THEN 10
                    WHEN customer.status = 'revoked'
                        THEN 11
                    ELSE 12
                END,
                COALESCE(
                    customer.latest_transaction_signed_date,
                    customer.updated_at,
                    customer.created_at
                ) DESC NULLS LAST,
                customer.original_transaction_id DESC
        )::int AS current_state_rank
    FROM subscription_admin_cross_platform_customers_v1 customer
)
SELECT *
FROM ranked
WHERE current_state_rank = 1;

CREATE OR REPLACE VIEW subscription_admin_cross_platform_business_metrics_v1 AS
SELECT
    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND has_pro_access
    ) AS active_pro_entitlements,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND recurring_revenue_active
    ) AS active_paid_subscribers,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND trial_active
    ) AS active_trials,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND is_lifetime_pro
          AND has_pro_access
    ) AS active_lifetime_pro,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND product_id = 'agora_pro_monthly'
          AND recurring_revenue_active
    ) AS paid_monthly,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND product_id = 'agora_pro_yearly'
          AND recurring_revenue_active
    ) AS paid_annual,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND canceling
    ) AS canceling_subscriptions,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND status = 'billing_retry'
    ) AS billing_retry_subscriptions,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND status = 'revoked'
    ) AS revoked_entitlements,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND affiliate_id IS NOT NULL
          AND is_recurring_pro
    ) AS affiliate_attributed_recurring_chains,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'app_store'
          AND has_pro_access
    ) AS app_store_active_pro_entitlements,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'google_play'
          AND has_pro_access
    ) AS google_play_active_pro_entitlements,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'app_store'
          AND recurring_revenue_active
    ) AS app_store_active_paid_subscribers,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'google_play'
          AND recurring_revenue_active
    ) AS google_play_active_paid_subscribers,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'app_store'
          AND trial_active
    ) AS app_store_active_trials,

    COUNT(*) FILTER (
        WHERE environment = 'Production'
          AND store_platform = 'google_play'
          AND trial_active
    ) AS google_play_active_trials,

    ROUND(
        COALESCE(
            SUM(estimated_mrr_usd) FILTER (
                WHERE environment = 'Production'
                  AND recurring_revenue_active
            ),
            0
        ),
        2
    ) AS estimated_mrr_usd,

    COUNT(*) FILTER (
        WHERE environment = 'Sandbox'
          AND has_pro_access
    ) AS sandbox_active_pro_entitlements
FROM subscription_admin_cross_platform_current_customers_v1;

CREATE OR REPLACE VIEW subscription_admin_cross_platform_transaction_timeline_v1 AS
SELECT
    timeline.original_transaction_id::text,
    timeline.environment::text,
    timeline.transaction_id::text,
    timeline.product_id::text,
    timeline.pro_access_source::text,
    timeline.transaction_reason::text,
    timeline.transaction_type::text,
    timeline.offer_type::text,
    timeline.offer_identifier::text,
    timeline.offer_discount_type::text,
    timeline.is_trial,
    timeline.purchase_date,
    timeline.original_purchase_date,
    timeline.expires_date,
    timeline.revocation_date,
    timeline.signed_date,
    timeline.storefront::text,
    timeline.currency::text,
    timeline.price_milliunits::bigint,
    timeline.quantity::integer,
    timeline.created_at,
    timeline.updated_at,
    'app_store'::text AS store_platform
FROM subscription_admin_transaction_timeline_v1 timeline

UNION ALL

SELECT
    ('gp:' || event.purchase_token_sha256)::text AS original_transaction_id,
    CASE
        WHEN event.test_purchase THEN 'Sandbox'
        ELSE 'Production'
    END::text AS environment,
    COALESCE(
        event.latest_order_id,
        'gp-event:' || event.id::text
    )::text AS transaction_id,
    event.product_id::text,
    CASE event.product_id
        WHEN 'agora_pro_monthly' THEN 'monthly'
        WHEN 'agora_pro_yearly' THEN 'annual'
        ELSE 'unknown'
    END::text AS pro_access_source,
    CASE
        WHEN event.previous_is_trial = TRUE
          AND event.is_trial = FALSE
            THEN 'trial_conversion'
        WHEN event.previous_latest_order_id IS NOT NULL
          AND event.previous_latest_order_id IS DISTINCT FROM event.latest_order_id
            THEN 'renewal'
        WHEN event.is_trial
            THEN 'trial_start'
        ELSE 'purchase'
    END::text AS transaction_reason,
    'GOOGLE_PLAY'::text AS transaction_type,
    CASE
        WHEN event.offer_id IS NOT NULL THEN 'OFFER'
        ELSE NULL
    END::text AS offer_type,
    event.offer_id::text AS offer_identifier,
    CASE
        WHEN event.is_trial THEN 'FREE_TRIAL'
        ELSE NULL
    END::text AS offer_discount_type,
    event.is_trial,
    CASE
        WHEN event.change_kind = 'snapshot'
            THEN COALESCE(event.start_time, event.event_at)
        ELSE event.event_at
    END AS purchase_date,
    event.start_time AS original_purchase_date,
    event.expires_date,
    NULL::timestamptz AS revocation_date,
    event.event_at AS signed_date,
    event.region_code::text AS storefront,
    NULL::text AS currency,
    NULL::bigint AS price_milliunits,
    1::integer AS quantity,
    event.created_at,
    event.created_at AS updated_at,
    'google_play'::text AS store_platform
FROM google_play_subscription_state_events event
WHERE
    (
        event.change_kind = 'snapshot'
        AND event.normalized_status <> 'pending'
    )
    OR (
        event.previous_latest_order_id IS NOT NULL
        AND event.previous_latest_order_id IS DISTINCT FROM event.latest_order_id
    )
    OR (
        event.previous_is_trial = TRUE
        AND event.is_trial = FALSE
    );

CREATE OR REPLACE VIEW subscription_admin_cross_platform_events_v1 AS
SELECT
    event.event_key::text,
    event.notification_uuid::text,
    event.source::text,
    event.user_id::text,
    event.original_transaction_id::text,
    event.transaction_id::text,
    event.event_type::text,
    event.subtype::text,
    event.environment::text,
    event.product_id::text,
    event.status_after::text,
    event.is_trial,
    event.auto_renew_enabled,
    event.expires_date,
    event.event_at,
    event.metadata,
    'app_store'::text AS store_platform
FROM subscription_events event

UNION ALL

SELECT
    ('google-play:' || event.id::text)::text AS event_key,
    NULL::text AS notification_uuid,
    'google_play'::text AS source,
    event.account_id::text AS user_id,
    ('gp:' || event.purchase_token_sha256)::text AS original_transaction_id,
    event.latest_order_id::text AS transaction_id,
    CASE
        WHEN event.previous_auto_renew_enabled = TRUE
          AND event.auto_renew_enabled = FALSE
            THEN 'DID_CHANGE_RENEWAL_STATUS'
        WHEN event.previous_auto_renew_enabled = FALSE
          AND event.auto_renew_enabled = TRUE
            THEN 'DID_CHANGE_RENEWAL_STATUS'
        WHEN event.normalized_status = 'expired'
          AND event.previous_normalized_status IS DISTINCT FROM 'expired'
            THEN 'EXPIRED'
        WHEN event.normalized_status IN ('grace_period', 'on_hold')
          AND event.previous_normalized_status IS DISTINCT FROM event.normalized_status
            THEN 'DID_FAIL_TO_RENEW'
        WHEN event.previous_is_trial = TRUE
          AND event.is_trial = FALSE
          AND event.normalized_status = 'active'
            THEN 'DID_RENEW'
        WHEN event.previous_latest_order_id IS NOT NULL
          AND event.previous_latest_order_id IS DISTINCT FROM event.latest_order_id
            THEN 'DID_RENEW'
        WHEN event.change_kind = 'snapshot'
            THEN 'SUBSCRIBED'
        ELSE 'SUBSCRIPTION_UPDATED'
    END::text AS event_type,
    CASE
        WHEN event.previous_auto_renew_enabled = TRUE
          AND event.auto_renew_enabled = FALSE
            THEN 'AUTO_RENEW_DISABLED'
        WHEN event.previous_auto_renew_enabled = FALSE
          AND event.auto_renew_enabled = TRUE
            THEN 'AUTO_RENEW_ENABLED'
        WHEN event.previous_is_trial = TRUE
          AND event.is_trial = FALSE
            THEN 'TRIAL_CONVERTED'
        WHEN event.normalized_status = 'grace_period'
            THEN 'BILLING_GRACE_PERIOD'
        WHEN event.normalized_status = 'on_hold'
            THEN 'ACCOUNT_HOLD'
        WHEN event.normalized_status = 'paused'
            THEN 'PAUSED'
        WHEN event.normalized_status = 'replaced'
            THEN 'REPLACED'
        ELSE NULL
    END::text AS subtype,
    CASE
        WHEN event.test_purchase THEN 'Sandbox'
        ELSE 'Production'
    END::text AS environment,
    event.product_id::text,
    CASE
        WHEN event.normalized_status = 'on_hold'
            THEN 'billing_retry'
        WHEN event.normalized_status IN ('paused', 'expired', 'replaced')
            THEN 'expired'
        WHEN event.normalized_status = 'pending'
            THEN 'unknown'
        ELSE event.normalized_status
    END::text AS status_after,
    event.is_trial,
    event.auto_renew_enabled,
    event.expires_date,
    event.event_at,
    jsonb_build_object(
        'storePlatform', 'google_play',
        'changeKind', event.change_kind,
        'previousStatus', event.previous_normalized_status,
        'previousIsTrial', event.previous_is_trial,
        'previousAutoRenewEnabled', event.previous_auto_renew_enabled,
        'offerId', event.offer_id,
        'basePlanId', event.base_plan_id
    ) AS metadata,
    'google_play'::text AS store_platform
FROM google_play_subscription_state_events event;

COMMENT ON TABLE google_play_subscription_state_events IS
'Google Play subscription state history captured from the server-authoritative entitlement row. Used by the owner dashboard for Android lifecycle and churn history.';

COMMENT ON VIEW subscription_admin_cross_platform_customers_v1 IS
'Owner-facing subscription-chain projection combining App Store and Google Play customers while preserving store-specific source fields.';

COMMENT ON VIEW subscription_admin_cross_platform_current_customers_v1 IS
'One current owner-facing subscription state per Agora customer/environment across App Store and Google Play.';

COMMENT ON VIEW subscription_admin_cross_platform_business_metrics_v1 IS
'Cross-platform owner subscription KPIs. Google Play customer counts are included; estimated MRR remains limited to rows with verified monetary values.';

COMMENT ON VIEW subscription_admin_cross_platform_transaction_timeline_v1 IS
'Cross-platform subscription transaction timeline. Google Play rows are derived from verified entitlement/order state changes; monetary values remain null when Google has not supplied a verified amount.';

COMMENT ON VIEW subscription_admin_cross_platform_events_v1 IS
'Cross-platform subscription lifecycle events combining persisted Apple events with server-authoritative Google Play state transitions.';
