-- 030_subscription_monthly_sales_metrics.sql
-- Replace normalized MRR as the primary cash-flow-style dashboard metric with
-- actual customer charges recorded during the current calendar month.
--
-- Important distinction:
--   * These sales figures are CUSTOMER BILLINGS from verified Apple
--     transactions, not final Apple developer proceeds or bank deposits.
--   * Annual subscriptions are counted in full in the month Apple charges the
--     customer; they are not divided by 12.
--   * Refunds/revocations occurring in the current month are shown separately
--     and subtracted from net sales.
--   * USD is reported here because App Store transaction payloads store the
--     customer's transaction currency and this view does not perform FX.

CREATE OR REPLACE VIEW subscription_admin_business_metrics_v1 AS
WITH customer_metrics AS (
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
    FROM subscription_admin_current_customers_v1
),
monthly_sales AS (
    SELECT
        COUNT(*) FILTER (
            WHERE purchase_date >= date_trunc('month', NOW())
              AND purchase_date < date_trunc('month', NOW()) + INTERVAL '1 month'
        ) AS paid_transactions_this_month,

        ROUND(
            COALESCE(
                SUM(price_milliunits::numeric / 1000.0) FILTER (
                    WHERE purchase_date >= date_trunc('month', NOW())
                      AND purchase_date < date_trunc('month', NOW()) + INTERVAL '1 month'
                ),
                0
            ),
            2
        ) AS gross_sales_this_month_usd,

        ROUND(
            COALESCE(
                SUM(price_milliunits::numeric / 1000.0) FILTER (
                    WHERE revocation_date >= date_trunc('month', NOW())
                      AND revocation_date < date_trunc('month', NOW()) + INTERVAL '1 month'
                ),
                0
            ),
            2
        ) AS refunds_this_month_usd
    FROM app_store_transactions
    WHERE environment = 'Production'
      AND product_id IN (
          'agora_pro_monthly',
          'agora_pro_yearly',
          'agora_pro_lifetime'
      )
      AND currency = 'USD'
      AND price_milliunits IS NOT NULL
      AND price_milliunits > 0
      AND is_trial = FALSE
)
SELECT
    customer_metrics.*,
    monthly_sales.paid_transactions_this_month,
    monthly_sales.gross_sales_this_month_usd,
    monthly_sales.refunds_this_month_usd,
    ROUND(
        monthly_sales.gross_sales_this_month_usd
        - monthly_sales.refunds_this_month_usd,
        2
    ) AS net_sales_this_month_usd
FROM customer_metrics
CROSS JOIN monthly_sales;

COMMENT ON VIEW subscription_admin_business_metrics_v1 IS
    'Customer-level current subscription KPIs plus current-calendar-month USD customer billings. Annual charges are recognized in full when charged; monthly sales are not Apple final proceeds or bank payout amounts.';
