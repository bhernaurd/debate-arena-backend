-- 045_mirror_analysis_translations.sql
-- Preserve immutable canonical Mirror snapshots while caching on-demand
-- translations of user-visible analysis prose for supported app languages.

ALTER TABLE account_mirror_snapshots
    ADD COLUMN IF NOT EXISTS analysis_language_code TEXT NOT NULL DEFAULT 'en';

UPDATE account_mirror_snapshots s
SET analysis_language_code = source.language_code
FROM (
    SELECT DISTINCT ON (entity_id)
        entity_id,
        CASE LOWER(REPLACE(COALESCE(metadata->>'languageCode', 'en'), '_', '-'))
            WHEN 'es' THEN 'es'
            WHEN 'pt-br' THEN 'pt-BR'
            WHEN 'fr' THEN 'fr'
            WHEN 'de' THEN 'de'
            WHEN 'ja' THEN 'ja'
            WHEN 'ko' THEN 'ko'
            WHEN 'zh-hans' THEN 'zh-Hans'
            ELSE 'en'
        END AS language_code
    FROM api_usage_logs
    WHERE entity_type = 'mirror_cycle'
      AND feature IN ('mirror_starting_analysis', 'mirror_recurring_analysis')
      AND success = TRUE
      AND metadata ? 'languageCode'
    ORDER BY entity_id, occurred_at DESC
) source
WHERE source.entity_id = s.cycle_id::text;

CREATE TABLE IF NOT EXISTS account_mirror_analysis_translations (
    snapshot_id UUID NOT NULL
        REFERENCES account_mirror_snapshots(id)
        ON DELETE CASCADE,
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    source_language_code TEXT NOT NULL,
    language_code TEXT NOT NULL,
    translation_version TEXT NOT NULL,
    analysis_json JSONB NOT NULL,
    model_name TEXT NOT NULL,
    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    estimated_cost_usd NUMERIC(16, 8),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (snapshot_id, language_code, translation_version)
);

CREATE INDEX IF NOT EXISTS account_mirror_analysis_translations_account_idx
    ON account_mirror_analysis_translations (account_id, snapshot_id);

COMMENT ON TABLE account_mirror_analysis_translations IS
    'On-demand cached translations of immutable Mirror analysis prose. Canonical snapshots remain unchanged.';
