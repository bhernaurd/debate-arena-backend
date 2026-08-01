-- 015_ranked_history_metadata.sql
--
-- Persists the official Ranked result metadata required to restore placement
-- and ladder reports from the shared account History archive.
--
-- Existing standard debates and Daily Challenges remain valid with every
-- Ranked column NULL. Ranked history uses the server debate UUID as the
-- SavedDebate UUID so repeated completion callbacks remain idempotent.

ALTER TABLE account_debate_history
    ADD COLUMN ranked_debate_id UUID,
    ADD COLUMN ranked_debate_kind TEXT,
    ADD COLUMN ranked_outcome TEXT,
    ADD COLUMN ranked_report_context JSONB;

ALTER TABLE account_debate_history
    ADD CONSTRAINT account_debate_history_ranked_kind_check
        CHECK (
            ranked_debate_kind IS NULL
            OR ranked_debate_kind IN ('placement', 'ladder')
        ),
    ADD CONSTRAINT account_debate_history_ranked_outcome_check
        CHECK (
            ranked_outcome IS NULL
            OR ranked_outcome IN ('completed', 'forfeited')
        ),
    ADD CONSTRAINT account_debate_history_ranked_context_type_check
        CHECK (
            ranked_report_context IS NULL
            OR jsonb_typeof(ranked_report_context) = 'object'
        ),
    ADD CONSTRAINT account_debate_history_ranked_fields_check
        CHECK (
            (
                ranked_debate_id IS NULL
                AND ranked_debate_kind IS NULL
                AND ranked_outcome IS NULL
                AND ranked_report_context IS NULL
            )
            OR
            (
                ranked_debate_id IS NOT NULL
                AND ranked_debate_kind IS NOT NULL
                AND ranked_outcome IS NOT NULL
                AND ranked_report_context IS NOT NULL
            )
        ),
    ADD CONSTRAINT account_debate_history_ranked_identity_check
        CHECK (
            ranked_debate_id IS NULL
            OR ranked_debate_id = saved_debate_id
        ),
    ADD CONSTRAINT account_debate_history_ranked_daily_check
        CHECK (
            ranked_debate_id IS NULL
            OR is_daily_challenge = FALSE
        );

CREATE INDEX account_debate_history_ranked_debate_idx
    ON account_debate_history (
        account_id,
        ranked_debate_id
    )
    WHERE ranked_debate_id IS NOT NULL;
