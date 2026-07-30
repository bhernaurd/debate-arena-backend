-- 008_ranked_version_and_model_configuration.sql
-- Seeds the first immutable Ranked version identifiers and configures the
-- backend-controlled model used to conduct Ranked debates.
--
-- Ranked remains disabled after this migration. The rollout flags are not
-- changed here.
--
-- Sonnet 4.5 is the selected launch model:
-- claude-sonnet-4-5-20250929

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM account_ranked_debates
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'Migration 008 requires account_ranked_debates to be empty.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM ranked_system_configuration
        WHERE configuration_key = 'global'
    ) THEN
        RAISE EXCEPTION
            'Migration 008 requires the global Ranked configuration row.';
    END IF;
END
$$;

ALTER TABLE ranked_system_configuration
    ADD COLUMN debate_model_provider TEXT,

    ADD COLUMN debate_model_name TEXT,

    ADD CONSTRAINT ranked_configuration_debate_model_provider_check
        CHECK (
            debate_model_provider IS NULL
            OR CHAR_LENGTH(BTRIM(debate_model_provider))
                BETWEEN 1 AND 100
        ),

    ADD CONSTRAINT ranked_configuration_debate_model_name_check
        CHECK (
            debate_model_name IS NULL
            OR CHAR_LENGTH(BTRIM(debate_model_name))
                BETWEEN 1 AND 150
        );

UPDATE ranked_system_configuration
SET
    ranked_rules_version =
        'ranked-rules-v1',

    philosopher_prompt_version =
        'philosopher-prompts-v1',

    scoring_prompt_version =
        'ranked-scoring-v1',

    report_prompt_version =
        'ranked-report-v1',

    topic_generator_version =
        'ranked-topic-v1',

    rp_formula_version =
        'ranked-rp-v1',

    debate_model_provider =
        'anthropic',

    debate_model_name =
        'claude-sonnet-4-5-20250929',

    updated_at =
        NOW()

WHERE configuration_key = 'global';

ALTER TABLE ranked_system_configuration
    ALTER COLUMN ranked_rules_version
        SET NOT NULL,

    ALTER COLUMN philosopher_prompt_version
        SET NOT NULL,

    ALTER COLUMN scoring_prompt_version
        SET NOT NULL,

    ALTER COLUMN report_prompt_version
        SET NOT NULL,

    ALTER COLUMN topic_generator_version
        SET NOT NULL,

    ALTER COLUMN rp_formula_version
        SET NOT NULL,

    ALTER COLUMN debate_model_provider
        SET NOT NULL,

    ALTER COLUMN debate_model_name
        SET NOT NULL;

COMMENT ON COLUMN ranked_system_configuration.ranked_rules_version IS
    'Immutable identifier for the Ranked rules applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.philosopher_prompt_version IS
    'Immutable identifier for the philosopher prompt set applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.scoring_prompt_version IS
    'Immutable identifier for the Ranked scoring prompt applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.report_prompt_version IS
    'Immutable identifier for the Ranked report prompt applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.topic_generator_version IS
    'Immutable identifier for the system-assigned Ranked topic generator applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.rp_formula_version IS
    'Immutable identifier for the RP formula applied to newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.debate_model_provider IS
    'Backend-controlled provider of the AI model that conducts newly created Ranked debates.';

COMMENT ON COLUMN ranked_system_configuration.debate_model_name IS
    'Backend-controlled model identifier used to conduct newly created Ranked debates.';
