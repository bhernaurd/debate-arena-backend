-- 027_subscription_admin_dashboard_views.sql
-- Read-only projections for the owner subscription dashboard.
--
-- Design rules:
--   * Apple remains authoritative for entitlement state.
--   * Lifetime Pro is Pro access, but never recurring revenue/MRR/churn.
--   * Monthly/annual are the only recurring Agora Pro products.
--   * Production and Sandbox stay visible and distinguishable.
--   * Existing entitlement/affiliate/account tables are not rewritten.

CREATE OR REPLACE VIEW subscription_admin_customers_v1 AS
WITH latest_apple_identity AS (
    SELECT DISTINCT ON (account_id)
        account_id,
        email,
        is_private_email,
        last_authenticated_at
    FROM account_apple_identities
    ORDER BY account_id, last_authenticated_at DESC, created_at DESC
),
latest_google_identity AS (
    SELECT DISTINCT ON (account_id)
        account_id,
        email,
        display_name,
        last_authenticated_at
    FROM account_google_identities
    ORDER BY account_id, last_authenticated_at DESC, created_at DESC
),
latest_transaction AS (
    SELECT DISTINCT ON (original_transaction_id, environment)
        original_transaction_id,
        environment,
        transaction_id,
        transaction_reason,
        transaction_type,
        offer_type,
        offer_identifier,
        offer_discount_type,
        purchase_date,
        original_purchase_date,
        expires_date,
        revocation_date,
        signed_date,
        storefront,
        storefront_id,
        currency,
        price_milliunits,
        quantity
    FROM app_store_transactions
    ORDER BY
        original_transaction_id,
        environment,
        signed_date DESC NULLS LAST,
        purchase_date DESC NULLS LAST,
        updated_at DESC
)
SELECT
    se.original_transaction_id,
    se.environment,
    se.product_id,
    se.pro_access_source,
    se.is_recurring_pro,
    se.is_lifetime_pro,
    se.status,
    se.is_trial,
    se.auto_renew_enabled,
    se.purchase_date,
    se.original_purchase_date,
    se.expires_date,
    se.grace_period_expires_date,
    se.revocation_date,
    se.expiration_intent,
    se.last_transaction_id,
    se.last_notification_type,
    se.last_notification_subtype,
    se.source,
    se.last_signed_date,
    se.pricing_cohort,
    se.pricing_cohort_source,
    se.pricing_cohort_assigned_at,
    se.user_id AS installation_user_id,
    se.app_account_token,
    se.created_at,
    se.updated_at,

    aso.account_id,
    aso.ownership_status,
    aso.claim_source,
    aso.claimed_at,
    aso.last_verified_at,

    a.status AS account_status,
    COALESCE(
        NULLIF(BTRIM(a.display_name), ''),
        NULLIF(BTRIM(gi.display_name), '')
    ) AS account_display_name,
    ai.email AS apple_email,
    ai.is_private_email AS apple_private_email,
    gi.email AS google_email,
    COALESCE(ai.email, gi.email) AS account_email,
    CASE
        WHEN ai.email IS NOT NULL THEN 'apple'
        WHEN gi.email IS NOT NULL THEN 'google'
        WHEN aso.account_id IS NOT NULL THEN 'account'
        ELSE 'unlinked'
    END AS identity_source,

    asa.affiliate_id,
    aff.display_name AS affiliate_display_name,
    aff.custom_code AS affiliate_code,
    asa.attribution_source AS affiliate_attribution_source,
    asa.attributed_at AS affiliate_attributed_at,

    tx.transaction_id AS latest_transaction_id,
    tx.transaction_reason AS latest_transaction_reason,
    tx.transaction_type AS latest_transaction_type,
    tx.offer_type AS latest_offer_type,
    tx.offer_identifier AS latest_offer_identifier,
    tx.offer_discount_type AS latest_offer_discount_type,
    tx.purchase_date AS latest_purchase_date,
    tx.signed_date AS latest_transaction_signed_date,
    tx.storefront,
    tx.storefront_id,
    tx.currency,
    tx.price_milliunits,
    tx.quantity,

    CASE
        WHEN se.is_lifetime_pro
          AND se.status = 'active'
          AND se.revocation_date IS NULL
            THEN TRUE
        WHEN se.is_recurring_pro
          AND se.status IN ('trial', 'active')
          AND se.expires_date > NOW()
            THEN TRUE
        WHEN se.is_recurring_pro
          AND se.status = 'grace_period'
          AND se.grace_period_expires_date > NOW()
            THEN TRUE
        ELSE FALSE
    END AS has_pro_access,

    CASE
        WHEN se.environment = 'Production'
          AND se.is_recurring_pro
          AND se.is_trial = FALSE
          AND (
            (se.status = 'active' AND se.expires_date > NOW())
            OR
            (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())
          )
            THEN TRUE
        ELSE FALSE
    END AS recurring_revenue_active,

    CASE
        WHEN se.environment = 'Production'
          AND se.is_recurring_pro
          AND se.is_trial = TRUE
          AND (
            (se.status = 'trial' AND se.expires_date > NOW())
            OR
            (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())
          )
            THEN TRUE
        ELSE FALSE
    END AS trial_active,

    CASE
        WHEN se.is_recurring_pro
          AND se.auto_renew_enabled = FALSE
          AND (
            (se.status IN ('trial', 'active') AND se.expires_date > NOW())
            OR
            (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())
          )
            THEN TRUE
        ELSE FALSE
    END AS canceling,

    CASE
        WHEN se.is_lifetime_pro THEN NULL
        WHEN se.status = 'grace_period' THEN se.grace_period_expires_date
        ELSE se.expires_date
    END AS access_ends_at,

    CASE
        WHEN se.environment <> 'Production' THEN FALSE
        WHEN se.is_lifetime_pro THEN FALSE
        WHEN se.is_trial THEN FALSE
        WHEN NOT se.is_recurring_pro THEN FALSE
        ELSE TRUE
    END AS recurring_business_metrics_eligible,

    CASE
        WHEN se.environment = 'Production'
          AND se.is_recurring_pro
          AND se.is_trial = FALSE
          AND tx.currency = 'USD'
          AND tx.price_milliunits IS NOT NULL
          AND tx.price_milliunits >= 0
          AND (
            (se.status = 'active' AND se.expires_date > NOW())
            OR
            (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())
          )
          AND se.product_id = 'agora_pro_monthly'
            THEN tx.price_milliunits::numeric / 1000.0
        WHEN se.environment = 'Production'
          AND se.is_recurring_pro
          AND se.is_trial = FALSE
          AND tx.currency = 'USD'
          AND tx.price_milliunits IS NOT NULL
          AND tx.price_milliunits >= 0
          AND (
            (se.status = 'active' AND se.expires_date > NOW())
            OR
            (se.status = 'grace_period' AND se.grace_period_expires_date > NOW())
          )
          AND se.product_id = 'agora_pro_yearly'
            THEN (tx.price_milliunits::numeric / 1000.0) / 12.0
        ELSE 0::numeric
    END AS estimated_mrr_usd,

    COALESCE(
        aso.account_id::text,
        se.app_account_token::text,
        NULLIF(se.user_id, ''),
        se.original_transaction_id
    ) AS customer_key
FROM subscription_entitlements se
LEFT JOIN account_subscription_ownership aso
    ON aso.original_transaction_id = se.original_transaction_id
   AND aso.environment = se.environment
   AND aso.ownership_status = 'active'
LEFT JOIN accounts a
    ON a.id = aso.account_id
LEFT JOIN latest_apple_identity ai
    ON ai.account_id = aso.account_id
LEFT JOIN latest_google_identity gi
    ON gi.account_id = aso.account_id
LEFT JOIN affiliate_subscription_attributions asa
    ON asa.original_transaction_id = se.original_transaction_id
   AND asa.environment = se.environment
LEFT JOIN affiliates aff
    ON aff.id = asa.affiliate_id
LEFT JOIN latest_transaction tx
    ON tx.original_transaction_id = se.original_transaction_id
   AND tx.environment = se.environment;

CREATE OR REPLACE VIEW subscription_admin_business_metrics_v1 AS
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
          AND is_recurring_pro
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
FROM subscription_admin_customers_v1;

CREATE OR REPLACE VIEW subscription_admin_transaction_timeline_v1 AS
SELECT
    tx.original_transaction_id,
    tx.environment,
    tx.transaction_id,
    tx.product_id,
    CASE tx.product_id
        WHEN 'agora_pro_monthly' THEN 'monthly'
        WHEN 'agora_pro_yearly' THEN 'annual'
        WHEN 'agora_pro_lifetime' THEN 'lifetime'
        ELSE 'unknown'
    END AS pro_access_source,
    tx.transaction_reason,
    tx.transaction_type,
    tx.offer_type,
    tx.offer_identifier,
    tx.offer_discount_type,
    tx.is_trial,
    tx.purchase_date,
    tx.original_purchase_date,
    tx.expires_date,
    tx.revocation_date,
    tx.signed_date,
    tx.storefront,
    tx.currency,
    tx.price_milliunits,
    tx.quantity,
    tx.created_at,
    tx.updated_at
FROM app_store_transactions tx
WHERE tx.product_id IN (
    'agora_pro_monthly',
    'agora_pro_yearly',
    'agora_pro_lifetime'
);

COMMENT ON VIEW subscription_admin_customers_v1 IS
    'Owner-facing current Agora Pro customer projection. Lifetime grants Pro but is explicitly excluded from recurring business metrics.';

COMMENT ON VIEW subscription_admin_business_metrics_v1 IS
    'Owner-facing subscription KPIs with Lifetime Pro separated from recurring subscribers and MRR.';

COMMENT ON VIEW subscription_admin_transaction_timeline_v1 IS
    'Verified Apple Agora Pro transaction history for customer detail/timeline views.';
