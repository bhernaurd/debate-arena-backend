-- 029_subscription_canceling_this_month.sql
-- Refine the owner-facing Canceling KPI.
--
-- Canceling should represent paid subscribers whose current paid entitlement
-- is scheduled to end during the CURRENT calendar month because auto-renew is
-- off. Trials with auto-renew disabled are not counted as canceling, and a paid
-- subscriber who turns auto-renew off months in advance is counted only in the
-- month their paid access actually ends.

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
          AND recurring_revenue_active
          AND is_trial = FALSE
          AND auto_renew_enabled = FALSE
          AND access_ends_at >= date_trunc('month', NOW())
          AND access_ends_at < date_trunc('month', NOW()) + INTERVAL '1 month'
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

COMMENT ON VIEW subscription_admin_business_metrics_v1 IS
    'Customer-level current subscription KPIs. Canceling counts only paid Production subscriptions with auto-renew off whose paid access ends during the current calendar month; trials are excluded.';
