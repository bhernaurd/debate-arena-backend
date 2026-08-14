-- 018_affiliate_program.sql
-- The Agora affiliate program foundation.
--
-- This migration is intentionally additive. It does not modify or replace the
-- existing StoreKit/App Store entitlement tables. Apple remains authoritative
-- for subscription access; this layer stores aggregate custom-code analytics,
-- affiliate compensation, dashboard access, and payout accounting.

CREATE TABLE affiliates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    custom_code TEXT NOT NULL,
    normalized_code TEXT NOT NULL,
    affiliate_since DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'terminated_for_cause', 'archived')),
    code_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (code_status IN ('active', 'disabled', 'unverified', 'mismatch')),
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    payout_currency CHAR(3) NOT NULL DEFAULT 'USD',
    payout_method TEXT,
    contact_email TEXT,
    internal_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ,
    CONSTRAINT affiliates_normalized_code_unique UNIQUE (normalized_code),
    CONSTRAINT affiliates_normalized_code_uppercase CHECK (normalized_code = UPPER(normalized_code)),
    CONSTRAINT affiliates_custom_code_nonempty CHECK (length(trim(custom_code)) > 0)
);

CREATE INDEX affiliates_status_idx ON affiliates (status, affiliate_since DESC);

CREATE TABLE affiliate_compensation_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    commission_basis TEXT NOT NULL CHECK (commission_basis IN ('base_price', 'net_proceeds')),
    commission_rate NUMERIC(9, 6) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 1),
    promo_commissionable BOOLEAN NOT NULL DEFAULT FALSE,
    effective_from DATE NOT NULL,
    effective_through DATE,
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_compensation_terms_valid_range
        CHECK (effective_through IS NULL OR effective_through >= effective_from)
);

CREATE INDEX affiliate_compensation_terms_affiliate_idx
    ON affiliate_compensation_terms (affiliate_id, effective_from DESC);

CREATE OR REPLACE FUNCTION reject_overlapping_affiliate_compensation_terms()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM affiliate_compensation_terms existing
        WHERE existing.affiliate_id = NEW.affiliate_id
          AND existing.id <> NEW.id
          AND daterange(
                existing.effective_from,
                COALESCE(existing.effective_through + 1, 'infinity'::date),
                '[)'
              ) &&
              daterange(
                NEW.effective_from,
                COALESCE(NEW.effective_through + 1, 'infinity'::date),
                '[)'
              )
    ) THEN
        RAISE EXCEPTION 'affiliate compensation terms may not overlap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER affiliate_compensation_terms_no_overlap
BEFORE INSERT OR UPDATE ON affiliate_compensation_terms
FOR EACH ROW EXECUTE FUNCTION reject_overlapping_affiliate_compensation_terms();

-- Effective-dated U.S. base prices used only for base_price compensation.
-- NULL subscription_adam_id means the rule applies to any matching duration.
CREATE TABLE affiliate_base_price_schedule (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_adam_id TEXT,
    subscription_duration TEXT NOT NULL,
    subscription_pricing TEXT NOT NULL
        CHECK (subscription_pricing IN ('Full Price', 'Preserved Price', 'Contingent Price')),
    effective_from DATE NOT NULL,
    effective_through DATE,
    base_price_usd NUMERIC(18, 6) NOT NULL CHECK (base_price_usd >= 0),
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_base_price_schedule_valid_range
        CHECK (effective_through IS NULL OR effective_through >= effective_from)
);

CREATE INDEX affiliate_base_price_schedule_lookup_idx
    ON affiliate_base_price_schedule (
        COALESCE(subscription_adam_id, ''),
        lower(subscription_duration),
        subscription_pricing,
        effective_from DESC
    );

CREATE OR REPLACE FUNCTION reject_overlapping_affiliate_base_price_schedule()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM affiliate_base_price_schedule existing
        WHERE existing.id <> NEW.id
          AND COALESCE(existing.subscription_adam_id, '') = COALESCE(NEW.subscription_adam_id, '')
          AND lower(existing.subscription_duration) = lower(NEW.subscription_duration)
          AND existing.subscription_pricing = NEW.subscription_pricing
          AND daterange(
                existing.effective_from,
                COALESCE(existing.effective_through + 1, 'infinity'::date),
                '[)'
              ) &&
              daterange(
                NEW.effective_from,
                COALESCE(NEW.effective_through + 1, 'infinity'::date),
                '[)'
              )
    ) THEN
        RAISE EXCEPTION 'affiliate base price schedule rows may not overlap';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER affiliate_base_price_schedule_no_overlap
BEFORE INSERT OR UPDATE ON affiliate_base_price_schedule
FOR EACH ROW EXECUTE FUNCTION reject_overlapping_affiliate_base_price_schedule();

-- The known U.S. monthly pricing schedule for The Agora at affiliate launch.
-- Annual pricing is deliberately NOT seeded: monthly->annual attribution policy
-- remains review-only until a later build explicitly supports it.
INSERT INTO affiliate_base_price_schedule (
    subscription_adam_id,
    subscription_duration,
    subscription_pricing,
    effective_from,
    effective_through,
    base_price_usd,
    label
)
VALUES
    (NULL, '1 month', 'Full Price', '2026-08-01', '2026-08-31', 4.990000, 'Founding monthly full price'),
    (NULL, '1 month', 'Full Price', '2026-09-01', NULL, 7.990000, 'Standard monthly full price'),
    (NULL, '1 month', 'Preserved Price', '2026-08-01', NULL, 4.990000, 'Founding monthly preserved price');

-- Marketing analytics only. Referral clicks never determine commission.
CREATE TABLE affiliate_referral_clicks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    normalized_code TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'sandbox', 'test')),
    referrer_host TEXT,
    clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX affiliate_referral_clicks_affiliate_time_idx
    ON affiliate_referral_clicks (affiliate_id, clicked_at DESC);

CREATE TABLE affiliate_dashboard_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE,
    token_ciphertext TEXT,
    token_iv TEXT,
    token_auth_tag TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'disabled')),
    created_by TEXT NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX affiliate_dashboard_tokens_one_active_idx
    ON affiliate_dashboard_tokens (affiliate_id) WHERE status = 'active';

-- One row per import attempt. source_fingerprint makes replaying the same Apple
-- instance/segment idempotent without relying on mutable metric rows.
CREATE TABLE affiliate_apple_report_imports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type TEXT NOT NULL
        CHECK (source_type IN ('analytics_state', 'analytics_event', 'offer_redemption', 'sales', 'manual_normalized')),
    source_report_name TEXT,
    source_request_id TEXT,
    source_instance_id TEXT,
    source_segment_id TEXT,
    source_processing_date DATE,
    source_fingerprint TEXT NOT NULL UNIQUE,
    environment TEXT NOT NULL DEFAULT 'production'
        CHECK (environment IN ('production', 'sandbox', 'test')),
    complete_instance BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed', 'duplicate')),
    row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
    updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
    stale_count INTEGER NOT NULL DEFAULT 0 CHECK (stale_count >= 0),
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX affiliate_apple_report_imports_started_idx
    ON affiliate_apple_report_imports (started_at DESC);

-- Current projection: one latest Apple value per complete logical row.
CREATE TABLE affiliate_apple_metric_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID REFERENCES affiliates(id) ON DELETE RESTRICT,
    import_id UUID REFERENCES affiliate_apple_report_imports(id) ON DELETE RESTRICT,
    custom_code TEXT NOT NULL,
    normalized_code TEXT NOT NULL,
    report_kind TEXT NOT NULL CHECK (report_kind IN ('state', 'event', 'redemption', 'sales')),
    metric_key TEXT NOT NULL,
    metric_value NUMERIC(20, 6) NOT NULL,
    report_period_start DATE NOT NULL,
    report_period_end DATE NOT NULL,
    granularity TEXT NOT NULL DEFAULT 'daily' CHECK (granularity IN ('daily', 'weekly', 'monthly', 'period')),
    subscription_name TEXT,
    subscription_adam_id TEXT,
    subscription_duration TEXT,
    subscription_pricing TEXT,
    offer_type TEXT,
    offer_pricing TEXT,
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox', 'test')),
    source_report_name TEXT,
    source_request_id TEXT,
    source_instance_id TEXT,
    source_segment_id TEXT,
    source_processing_date DATE,
    logical_key TEXT NOT NULL UNIQUE,
    source_row_key TEXT NOT NULL,
    raw_dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_apple_metric_snapshots_valid_period CHECK (report_period_end >= report_period_start),
    CONSTRAINT affiliate_apple_metric_snapshots_code_uppercase CHECK (normalized_code = UPPER(normalized_code))
);

-- Immutable source-row receipt registry. Once an Apple row has been processed,
-- replaying the same source row cannot change accounting a second time.
CREATE TABLE affiliate_apple_metric_source_rows (
    source_row_key TEXT PRIMARY KEY,
    import_id UUID NOT NULL REFERENCES affiliate_apple_report_imports(id) ON DELETE RESTRICT,
    logical_key TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only history of current rows that were superseded or removed by a
-- newer Apple processingDate. Apple documents that newer instances overwrite
-- older records for the same Date; this table preserves the audit trail.
CREATE TABLE affiliate_apple_metric_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL,
    affiliate_id UUID REFERENCES affiliates(id) ON DELETE RESTRICT,
    prior_import_id UUID REFERENCES affiliate_apple_report_imports(id) ON DELETE RESTRICT,
    replacement_import_id UUID REFERENCES affiliate_apple_report_imports(id) ON DELETE RESTRICT,
    custom_code TEXT NOT NULL,
    normalized_code TEXT NOT NULL,
    report_kind TEXT NOT NULL,
    metric_key TEXT NOT NULL,
    metric_value NUMERIC(20, 6) NOT NULL,
    report_period_start DATE NOT NULL,
    report_period_end DATE NOT NULL,
    granularity TEXT NOT NULL,
    subscription_name TEXT,
    subscription_adam_id TEXT,
    subscription_duration TEXT,
    subscription_pricing TEXT,
    offer_type TEXT,
    offer_pricing TEXT,
    environment TEXT NOT NULL,
    source_report_name TEXT,
    source_request_id TEXT,
    source_instance_id TEXT,
    source_segment_id TEXT,
    source_processing_date DATE,
    logical_key TEXT NOT NULL,
    source_row_key TEXT NOT NULL,
    raw_dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
    prior_imported_at TIMESTAMPTZ NOT NULL,
    revision_reason TEXT NOT NULL CHECK (revision_reason IN ('superseded', 'removed_by_newer_instance')),
    revised_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX affiliate_apple_metric_revisions_logical_idx
    ON affiliate_apple_metric_revisions (logical_key, revised_at DESC);

CREATE INDEX affiliate_apple_metric_affiliate_metric_period_idx
    ON affiliate_apple_metric_snapshots (affiliate_id, metric_key, report_period_end DESC);
CREATE INDEX affiliate_apple_metric_code_period_idx
    ON affiliate_apple_metric_snapshots (normalized_code, report_kind, report_period_end DESC);
CREATE INDEX affiliate_apple_metric_monthly_events_idx
    ON affiliate_apple_metric_snapshots (affiliate_id, report_period_start, metric_key)
    WHERE report_kind = 'event';

CREATE TABLE affiliate_monthly_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    compensation_term_id UUID REFERENCES affiliate_compensation_terms(id) ON DELETE RESTRICT,
    payout_period DATE NOT NULL,
    environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'sandbox', 'test')),
    commission_basis TEXT NOT NULL CHECK (commission_basis IN ('base_price', 'net_proceeds')),
    commission_rate NUMERIC(9, 6) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 1),
    eligible_revenue NUMERIC(18, 6) NOT NULL DEFAULT 0,
    commission_earned_exact NUMERIC(18, 6) NOT NULL DEFAULT 0,
    adjustments_total NUMERIC(18, 6) NOT NULL DEFAULT 0,
    amount_due NUMERIC(18, 2) NOT NULL DEFAULT 0,
    amount_paid NUMERIC(18, 2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ready_to_pay', 'partially_paid', 'paid')),
    data_status TEXT NOT NULL DEFAULT 'awaiting_apple_data'
        CHECK (data_status IN ('awaiting_apple_data', 'provisional', 'reconciled', 'needs_review')),
    calculation_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    period_started_at TIMESTAMPTZ,
    period_closed_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_monthly_payouts_period_first_day CHECK (EXTRACT(DAY FROM payout_period) = 1),
    CONSTRAINT affiliate_monthly_payouts_nonnegative_paid CHECK (amount_paid >= 0),
    CONSTRAINT affiliate_monthly_payouts_unique UNIQUE (affiliate_id, payout_period, environment)
);

CREATE INDEX affiliate_monthly_payouts_status_period_idx
    ON affiliate_monthly_payouts (status, payout_period DESC);

CREATE TABLE affiliate_payout_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    monthly_payout_id UUID NOT NULL REFERENCES affiliate_monthly_payouts(id) ON DELETE RESTRICT,
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    entry_type TEXT NOT NULL DEFAULT 'payment' CHECK (entry_type IN ('payment', 'correction')),
    amount NUMERIC(18, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    payment_date DATE NOT NULL,
    payment_method TEXT,
    payment_reference TEXT,
    note TEXT,
    idempotency_key TEXT NOT NULL,
    correction_of_payment_id UUID REFERENCES affiliate_payout_payments(id) ON DELETE RESTRICT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_payout_payments_valid_amount CHECK (
        (entry_type = 'payment' AND amount > 0 AND correction_of_payment_id IS NULL)
        OR
        (entry_type = 'correction' AND amount <> 0 AND correction_of_payment_id IS NOT NULL)
    ),
    CONSTRAINT affiliate_payout_payments_idempotent UNIQUE (monthly_payout_id, idempotency_key)
);

CREATE INDEX affiliate_payout_payments_payout_idx
    ON affiliate_payout_payments (monthly_payout_id, created_at);
CREATE INDEX affiliate_payout_payments_affiliate_idx
    ON affiliate_payout_payments (affiliate_id, payment_date DESC);

CREATE TABLE affiliate_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
    monthly_payout_id UUID REFERENCES affiliate_monthly_payouts(id) ON DELETE RESTRICT,
    adjustment_type TEXT NOT NULL,
    amount NUMERIC(18, 6) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    source_period DATE,
    target_period DATE NOT NULL,
    reason TEXT NOT NULL,
    related_source_key TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT affiliate_adjustments_nonzero CHECK (amount <> 0),
    CONSTRAINT affiliate_adjustments_target_first_day CHECK (EXTRACT(DAY FROM target_period) = 1)
);

CREATE INDEX affiliate_adjustments_affiliate_idx
    ON affiliate_adjustments (affiliate_id, created_at DESC);
CREATE INDEX affiliate_adjustments_target_idx
    ON affiliate_adjustments (affiliate_id, target_period);
CREATE UNIQUE INDEX affiliate_adjustments_source_unique_idx
    ON affiliate_adjustments (affiliate_id, related_source_key)
    WHERE related_source_key IS NOT NULL;

CREATE TABLE affiliate_admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_actor TEXT NOT NULL,
    action_type TEXT NOT NULL,
    affiliate_id UUID REFERENCES affiliates(id) ON DELETE RESTRICT,
    related_record_type TEXT,
    related_record_id TEXT,
    before_value JSONB,
    after_value JSONB,
    reason TEXT,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX affiliate_admin_audit_log_affiliate_idx
    ON affiliate_admin_audit_log (affiliate_id, occurred_at DESC);
CREATE INDEX affiliate_admin_audit_log_action_idx
    ON affiliate_admin_audit_log (action_type, occurred_at DESC);

CREATE TABLE affiliate_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    affiliate_id UUID REFERENCES affiliates(id) ON DELETE RESTRICT,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    dedupe_key TEXT,
    related_record_type TEXT,
    related_record_id TEXT,
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    resolution_note TEXT
);

CREATE UNIQUE INDEX affiliate_alerts_open_dedupe_idx
    ON affiliate_alerts (dedupe_key)
    WHERE status = 'open' AND dedupe_key IS NOT NULL;
CREATE INDEX affiliate_alerts_open_idx
    ON affiliate_alerts (status, severity, triggered_at DESC);

COMMENT ON TABLE affiliate_apple_metric_snapshots IS
'Latest aggregate Apple subscription analytics keyed by Custom Code / Vanity Code. This table deliberately does not manufacture per-user custom-code attribution.';
COMMENT ON TABLE affiliate_apple_metric_revisions IS
'Immutable history of Apple aggregate metric rows superseded by newer Analytics Reports instances.';
COMMENT ON TABLE affiliate_referral_clicks IS
'Affiliate referral-link click analytics only. Clicks are not authoritative for commission attribution.';
