CREATE TABLE IF NOT EXISTS app_store_sales_report_imports (
    report_date DATE NOT NULL,
    vendor_number TEXT NOT NULL,
    report_type TEXT NOT NULL DEFAULT 'SALES',
    report_subtype TEXT NOT NULL DEFAULT 'SUMMARY',
    frequency TEXT NOT NULL DEFAULT 'DAILY',
    source_sha256 TEXT,
    row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (
        report_date,
        vendor_number,
        report_type,
        report_subtype,
        frequency
    )
);

CREATE TABLE IF NOT EXISTS app_store_sales_report_rows (
    report_date DATE NOT NULL,
    vendor_number TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    product_id TEXT,
    sku TEXT,
    title TEXT,
    product_type_identifier TEXT,
    units NUMERIC(18, 2),
    customer_currency TEXT,
    customer_price NUMERIC(18, 6),
    gross_customer_amount NUMERIC(20, 6),
    country_code TEXT,
    proceeds_currency TEXT,
    developer_proceeds_per_unit NUMERIC(18, 6),
    developer_proceeds_amount NUMERIC(20, 6),
    subscription TEXT,
    period TEXT,
    promo_code TEXT,
    order_type TEXT,
    proceeds_reason TEXT,
    preserved_pricing TEXT,
    apple_identifier TEXT,
    raw_row JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (report_date, vendor_number, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_app_store_sales_report_rows_product_date
    ON app_store_sales_report_rows (product_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_app_store_sales_report_rows_date
    ON app_store_sales_report_rows (report_date DESC);

CREATE TABLE IF NOT EXISTS app_store_finance_report_imports (
    report_date TEXT NOT NULL,
    vendor_number TEXT NOT NULL,
    region_code TEXT NOT NULL,
    report_type TEXT NOT NULL,
    source_sha256 TEXT,
    row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (report_date, vendor_number, region_code, report_type)
);

CREATE TABLE IF NOT EXISTS app_store_finance_report_rows (
    report_date TEXT NOT NULL,
    vendor_number TEXT NOT NULL,
    region_code TEXT NOT NULL,
    report_type TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    period_start DATE,
    period_end DATE,
    product_id TEXT,
    title TEXT,
    product_type_identifier TEXT,
    country_of_sale TEXT,
    quantity NUMERIC(18, 2),
    customer_currency TEXT,
    customer_price NUMERIC(18, 6),
    partner_share_currency TEXT,
    partner_share_per_unit NUMERIC(18, 6),
    extended_partner_share NUMERIC(20, 6),
    sale_or_return TEXT,
    promo_code TEXT,
    order_type TEXT,
    raw_row JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (
        report_date,
        vendor_number,
        region_code,
        report_type,
        row_hash
    )
);

CREATE INDEX IF NOT EXISTS idx_app_store_finance_report_rows_product_period
    ON app_store_finance_report_rows (product_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_app_store_finance_report_rows_period
    ON app_store_finance_report_rows (report_date DESC, region_code);
