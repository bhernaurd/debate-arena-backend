-- Minimal production-shaped prerequisites for migration 053.
-- This is intentionally limited to relations migration 053 reads from. Types mirror
-- the current production migration contracts so PostgreSQL validates UNION column
-- counts/types, foreign keys, trigger targets, and view dependencies.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'active',
    display_name TEXT
);

CREATE TABLE account_google_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id),
    email TEXT,
    display_name TEXT,
    last_authenticated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE affiliates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT,
    custom_code TEXT
);

CREATE TABLE google_play_subscription_entitlements (
    purchase_token_sha256 TEXT PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id),
    product_id TEXT NOT NULL,
    base_plan_id TEXT,
    offer_id TEXT,
    normalized_status TEXT NOT NULL,
    is_trial BOOLEAN NOT NULL DEFAULT FALSE,
    auto_renew_enabled BOOLEAN,
    test_purchase BOOLEAN NOT NULL DEFAULT FALSE,
    latest_order_id TEXT,
    region_code TEXT,
    start_time TIMESTAMPTZ,
    expires_date TIMESTAMPTZ,
    pricing_cohort TEXT NOT NULL DEFAULT 'unknown',
    pricing_cohort_source TEXT,
    last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE affiliate_google_play_subscription_attributions (
    purchase_token_sha256 TEXT PRIMARY KEY
        REFERENCES google_play_subscription_entitlements(purchase_token_sha256),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id),
    normalized_creator_code TEXT NOT NULL,
    attribution_source TEXT NOT NULL,
    attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscription_admin_customers_v1 (
    original_transaction_id TEXT,
    environment TEXT,
    product_id TEXT,
    pro_access_source TEXT,
    is_recurring_pro BOOLEAN,
    is_lifetime_pro BOOLEAN,
    status TEXT,
    is_trial BOOLEAN,
    auto_renew_enabled BOOLEAN,
    purchase_date TIMESTAMPTZ,
    original_purchase_date TIMESTAMPTZ,
    expires_date TIMESTAMPTZ,
    grace_period_expires_date TIMESTAMPTZ,
    revocation_date TIMESTAMPTZ,
    expiration_intent TEXT,
    last_transaction_id TEXT,
    last_notification_type TEXT,
    last_notification_subtype TEXT,
    source TEXT,
    last_signed_date TIMESTAMPTZ,
    pricing_cohort TEXT,
    pricing_cohort_source TEXT,
    pricing_cohort_assigned_at TIMESTAMPTZ,
    installation_user_id TEXT,
    app_account_token UUID,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    account_id UUID,
    ownership_status TEXT,
    claim_source TEXT,
    claimed_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    account_status TEXT,
    account_display_name TEXT,
    apple_email TEXT,
    apple_private_email BOOLEAN,
    google_email TEXT,
    account_email TEXT,
    identity_source TEXT,
    affiliate_id UUID,
    affiliate_display_name TEXT,
    affiliate_code TEXT,
    affiliate_attribution_source TEXT,
    affiliate_attributed_at TIMESTAMPTZ,
    latest_transaction_id TEXT,
    latest_transaction_reason TEXT,
    latest_transaction_type TEXT,
    latest_offer_type TEXT,
    latest_offer_identifier TEXT,
    latest_offer_discount_type TEXT,
    latest_purchase_date TIMESTAMPTZ,
    latest_transaction_signed_date TIMESTAMPTZ,
    storefront TEXT,
    storefront_id TEXT,
    currency TEXT,
    price_milliunits BIGINT,
    quantity INTEGER,
    has_pro_access BOOLEAN,
    recurring_revenue_active BOOLEAN,
    trial_active BOOLEAN,
    canceling BOOLEAN,
    access_ends_at TIMESTAMPTZ,
    recurring_business_metrics_eligible BOOLEAN,
    estimated_mrr_usd NUMERIC,
    customer_key TEXT
);

CREATE TABLE subscription_admin_transaction_timeline_v1 (
    original_transaction_id TEXT,
    environment TEXT,
    transaction_id TEXT,
    product_id TEXT,
    pro_access_source TEXT,
    transaction_reason TEXT,
    transaction_type TEXT,
    offer_type TEXT,
    offer_identifier TEXT,
    offer_discount_type TEXT,
    is_trial BOOLEAN,
    purchase_date TIMESTAMPTZ,
    original_purchase_date TIMESTAMPTZ,
    expires_date TIMESTAMPTZ,
    revocation_date TIMESTAMPTZ,
    signed_date TIMESTAMPTZ,
    storefront TEXT,
    currency TEXT,
    price_milliunits BIGINT,
    quantity INTEGER,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);

CREATE TABLE subscription_events (
    event_key TEXT PRIMARY KEY,
    notification_uuid UUID,
    source TEXT,
    user_id TEXT,
    original_transaction_id TEXT,
    transaction_id TEXT,
    event_type TEXT,
    subtype TEXT,
    environment TEXT,
    product_id TEXT,
    status_after TEXT,
    is_trial BOOLEAN,
    auto_renew_enabled BOOLEAN,
    expires_date TIMESTAMPTZ,
    event_at TIMESTAMPTZ,
    metadata JSONB
);


-- Empty Apple reporting tables let the cross-platform history service execute in
-- PostgreSQL CI without inventing Android financial values.
CREATE TABLE app_store_sales_report_rows (
    report_date DATE,
    product_id TEXT,
    customer_currency TEXT,
    proceeds_currency TEXT,
    gross_customer_amount NUMERIC,
    developer_proceeds_amount NUMERIC
);

CREATE TABLE app_store_sales_report_imports (
    report_date DATE,
    report_type TEXT,
    report_subtype TEXT,
    frequency TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE app_store_finance_report_rows (
    report_date DATE,
    region_code TEXT,
    period_start DATE,
    period_end DATE,
    partner_share_currency TEXT,
    extended_partner_share NUMERIC,
    product_id TEXT
);

CREATE TABLE app_store_finance_report_imports (
    imported_at TIMESTAMPTZ DEFAULT NOW()
);
