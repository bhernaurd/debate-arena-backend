-- 028_subscription_customer_current_state.sql
-- Customer-level current-state projection for the subscription dashboard.
--
-- A single Agora customer can have multiple App Store subscription chains over
-- time (trial, failed billing, expiration, resubscribe, product change, etc.).
-- Historical chains remain available for audit/detail views, but owner-facing
-- KPIs must describe the customer's CURRENT subscription state rather than
-- counting stale chains as separate canceling/cancelled customers.

CREATE OR REPLACE VIEW subscription_admin_current_customers_v1 AS
WITH ranked AS (
    SELECT
        customer.*,
        COUNT(*) OVER (
            PARTITION BY customer.customer_key, customer.environment
        )::int AS customer_chain_count,
        ROW_NUMBER() OVER (
            PARTITION BY customer.customer_key, customer.environment
            ORDER BY
                -- Permanent Lifetime Pro is the strongest current entitlement.
                CASE
                    WHEN customer.is_lifetime_pro
                      AND customer.has_pro_access
                        THEN 0

                    -- A paid recurring subscription that is actively renewing
                    -- supersedes an older canceling/trial/expired chain.
                    WHEN customer.recurring_revenue_active
                      AND customer.auto_renew_enabled = TRUE
                        THEN 1

                    -- If no renewing paid chain exists, an active paid chain
                    -- with auto-renew disabled is legitimately canceling.
                    WHEN customer.recurring_revenue_active
                      AND customer.auto_renew_enabled = FALSE
                        THEN 2

                    WHEN customer.recurring_revenue_active
                        THEN 3

                    -- Trials are current only when there is no paid/lifetime
                    -- entitlement for this customer.
                    WHEN customer.trial_active
                      AND customer.auto_renew_enabled = TRUE
                        THEN 4
                    WHEN customer.trial_active
                      AND customer.auto_renew_enabled = FALSE
                        THEN 5
                    WHEN customer.trial_active
                        THEN 6

                    -- Grace-period Pro access that was not classified above.
                    WHEN customer.has_pro_access
                        THEN 7

                    -- Recovery states are more current than historical expiry.
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
    FROM subscription_admin_customers_v1 customer
)
SELECT *
FROM ranked
WHERE current_state_rank = 1;

-- Business metrics now count one CURRENT state per customer/environment rather
-- than one row per historical subscription chain.
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
FROM subscription_admin_current_customers_v1;

COMMENT ON VIEW subscription_admin_current_customers_v1 IS
    'One current owner-facing subscription state per Agora customer/environment. Historical canceling, expired, trial, and failed-billing chains are superseded when the same customer has a newer active paid or Lifetime entitlement.';

COMMENT ON VIEW subscription_admin_business_metrics_v1 IS
    'Customer-level current subscription KPIs. Historical chains remain available in subscription_admin_customers_v1 but do not inflate canceling, churn, subscriber, trial, or MRR metrics.';
