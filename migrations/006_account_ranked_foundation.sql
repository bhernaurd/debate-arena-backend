-- 006_account_ranked_foundation.sql
-- Account-owned Ranked profiles, placements, resumable debates, and immutable
-- rating history.
--
-- Ranked is disabled by default after this migration. The backend must
-- explicitly enable it after the Ranked services, tests, and iOS flow are live.

CREATE TABLE ranked_system_configuration (
    configuration_key TEXT PRIMARY KEY
        CHECK (configuration_key = 'global'),

    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    allow_new_debates BOOLEAN NOT NULL DEFAULT FALSE,
    allow_resume_active_debates BOOLEAN NOT NULL DEFAULT TRUE,
    placements_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    leaderboard_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    population_limits_enabled BOOLEAN NOT NULL DEFAULT FALSE,

    ranked_rules_version TEXT,
    philosopher_prompt_version TEXT,
    scoring_prompt_version TEXT,
    report_prompt_version TEXT,
    topic_generator_version TEXT,
    rp_formula_version TEXT,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        ranked_rules_version IS NULL
        OR CHAR_LENGTH(BTRIM(ranked_rules_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        philosopher_prompt_version IS NULL
        OR CHAR_LENGTH(BTRIM(philosopher_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        scoring_prompt_version IS NULL
        OR CHAR_LENGTH(BTRIM(scoring_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        report_prompt_version IS NULL
        OR CHAR_LENGTH(BTRIM(report_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        topic_generator_version IS NULL
        OR CHAR_LENGTH(BTRIM(topic_generator_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        rp_formula_version IS NULL
        OR CHAR_LENGTH(BTRIM(rp_formula_version)) BETWEEN 1 AND 100
    )
);

INSERT INTO ranked_system_configuration (
    configuration_key
)
VALUES (
    'global'
);

CREATE TABLE ranked_rank_tiers (
    rank_key TEXT PRIMARY KEY,
    rank_order SMALLINT NOT NULL UNIQUE,
    display_name TEXT NOT NULL UNIQUE,

    supports_divisions BOOLEAN NOT NULL,
    population_limited_capable BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        rank_key IN (
            'initiate',
            'student',
            'dialectician',
            'logician',
            'scholar',
            'sage',
            'philosopher',
            'alchemist'
        )
    ),

    CHECK (rank_order BETWEEN 1 AND 8),

    CHECK (
        CHAR_LENGTH(BTRIM(display_name)) BETWEEN 1 AND 50
    ),

    CHECK (
        (rank_key = 'alchemist' AND supports_divisions = FALSE)
        OR
        (rank_key <> 'alchemist' AND supports_divisions = TRUE)
    )
);

INSERT INTO ranked_rank_tiers (
    rank_key,
    rank_order,
    display_name,
    supports_divisions,
    population_limited_capable
)
VALUES
    ('initiate', 1, 'Initiate', TRUE, FALSE),
    ('student', 2, 'Student', TRUE, FALSE),
    ('dialectician', 3, 'Dialectician', TRUE, FALSE),
    ('logician', 4, 'Logician', TRUE, FALSE),
    ('scholar', 5, 'Scholar', TRUE, FALSE),
    ('sage', 6, 'Sage', TRUE, FALSE),
    ('philosopher', 7, 'Philosopher', TRUE, TRUE),
    ('alchemist', 8, 'The Alchemist', FALSE, TRUE);

CREATE TABLE account_ranked_profiles (
    account_id UUID PRIMARY KEY
        REFERENCES accounts(id)
        ON DELETE CASCADE,

    placement_status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (
            placement_status IN (
                'not_started',
                'in_progress',
                'completed'
            )
        ),

    placement_trials_completed SMALLINT NOT NULL DEFAULT 0,
    placement_weighted_score NUMERIC(6, 4),

    current_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    current_division SMALLINT,
    current_rp INTEGER,

    peak_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    peak_division SMALLINT,
    peak_reached_at TIMESTAMPTZ,

    demotion_protection_debates_remaining SMALLINT NOT NULL DEFAULT 0,
    demotion_protection_reason TEXT,
    demotion_protection_granted_at TIMESTAMPTZ,

    ranked_debates_completed INTEGER NOT NULL DEFAULT 0,
    ranked_forfeits INTEGER NOT NULL DEFAULT 0,
    ranked_invalid_results INTEGER NOT NULL DEFAULT 0,

    last_ranked_debate_completed_at TIMESTAMPTZ,

    state_version INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (placement_trials_completed BETWEEN 0 AND 5),

    CHECK (
        placement_weighted_score IS NULL
        OR (
            placement_weighted_score >= 0
            AND placement_weighted_score <= 10
        )
    ),

    CHECK (
        current_rp IS NULL
        OR current_rp BETWEEN 0 AND 99
    ),

    CHECK (
        current_division IS NULL
        OR current_division BETWEEN 1 AND 3
    ),

    CHECK (
        peak_division IS NULL
        OR peak_division BETWEEN 1 AND 3
    ),

    CHECK (
        (
            current_rank_key IS NULL
            AND current_division IS NULL
            AND current_rp IS NULL
        )
        OR
        (
            current_rank_key = 'alchemist'
            AND current_division IS NULL
            AND current_rp IS NOT NULL
        )
        OR
        (
            current_rank_key <> 'alchemist'
            AND current_division BETWEEN 1 AND 3
            AND current_rp IS NOT NULL
        )
    ),

    CHECK (
        (
            peak_rank_key IS NULL
            AND peak_division IS NULL
            AND peak_reached_at IS NULL
        )
        OR
        (
            peak_rank_key = 'alchemist'
            AND peak_division IS NULL
            AND peak_reached_at IS NOT NULL
        )
        OR
        (
            peak_rank_key <> 'alchemist'
            AND peak_division BETWEEN 1 AND 3
            AND peak_reached_at IS NOT NULL
        )
    ),

    CHECK (
        (
            placement_status = 'not_started'
            AND placement_trials_completed = 0
            AND placement_weighted_score IS NULL
            AND current_rank_key IS NULL
        )
        OR
        (
            placement_status = 'in_progress'
            AND placement_trials_completed BETWEEN 0 AND 4
            AND placement_weighted_score IS NULL
            AND current_rank_key IS NULL
        )
        OR
        (
            placement_status = 'completed'
            AND placement_trials_completed = 5
            AND placement_weighted_score IS NOT NULL
            AND current_rank_key IS NOT NULL
            AND current_rp IS NOT NULL
        )
    ),

    CHECK (
        demotion_protection_debates_remaining BETWEEN 0 AND 1
    ),

    CHECK (
        (
            demotion_protection_debates_remaining = 0
            AND demotion_protection_reason IS NULL
            AND demotion_protection_granted_at IS NULL
        )
        OR
        (
            demotion_protection_debates_remaining = 1
            AND demotion_protection_reason IN (
                'placement',
                'major_promotion'
            )
            AND demotion_protection_granted_at IS NOT NULL
        )
    ),

    CHECK (ranked_debates_completed >= 0),
    CHECK (ranked_forfeits >= 0),
    CHECK (ranked_invalid_results >= 0),
    CHECK (state_version > 0)
);

CREATE TABLE account_ranked_debates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES account_ranked_profiles(account_id)
        ON DELETE CASCADE,

    debate_kind TEXT NOT NULL
        CHECK (debate_kind IN ('placement', 'ladder')),

    placement_trial_number SMALLINT,

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            status IN (
                'active',
                'completed',
                'forfeited',
                'invalid',
                'voided'
            )
        ),

    philosopher_id TEXT NOT NULL,
    philosopher_name TEXT NOT NULL,

    debate_mode TEXT NOT NULL
        CHECK (
            debate_mode IN (
                'guided',
                'balanced',
                'relentless'
            )
        ),

    topic TEXT NOT NULL,
    topic_source TEXT NOT NULL DEFAULT 'system_generated'
        CHECK (topic_source = 'system_generated'),
    topic_fingerprint TEXT NOT NULL,

    analytics_debate_id TEXT,
    saved_debate_id UUID,

    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_score_text TEXT,
    current_score_value NUMERIC(4, 2),
    round_count INTEGER NOT NULL DEFAULT 0,

    starting_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    starting_division SMALLINT,
    starting_rp INTEGER,

    forfeit_rp_loss_preview INTEGER,

    final_score_text TEXT,
    final_score_value NUMERIC(4, 2),
    rp_delta INTEGER,

    ending_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    ending_division SMALLINT,
    ending_rp INTEGER,

    promoted BOOLEAN NOT NULL DEFAULT FALSE,
    demoted BOOLEAN NOT NULL DEFAULT FALSE,

    protection_applied BOOLEAN NOT NULL DEFAULT FALSE,
    protection_consumed BOOLEAN NOT NULL DEFAULT FALSE,

    ranked_rules_version TEXT NOT NULL,
    philosopher_prompt_version TEXT NOT NULL,
    scoring_prompt_version TEXT NOT NULL,
    report_prompt_version TEXT NOT NULL,
    topic_generator_version TEXT NOT NULL,
    rp_formula_version TEXT NOT NULL,

    model_provider TEXT NOT NULL,
    model_name TEXT NOT NULL,

    origin_installation_id TEXT NOT NULL,
    last_synced_from_installation_id TEXT NOT NULL,

    state_version INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        placement_trial_number IS NULL
        OR placement_trial_number BETWEEN 1 AND 5
    ),

    CHECK (
        (
            debate_kind = 'placement'
            AND placement_trial_number BETWEEN 1 AND 5
        )
        OR
        (
            debate_kind = 'ladder'
            AND placement_trial_number IS NULL
        )
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_id)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_name)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(topic)) BETWEEN 1 AND 4000
    ),

    CHECK (
        topic_fingerprint ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        analytics_debate_id IS NULL
        OR CHAR_LENGTH(BTRIM(analytics_debate_id)) BETWEEN 1 AND 128
    ),

    CHECK (jsonb_typeof(messages) = 'array'),

    CHECK (
        current_score_value IS NULL
        OR (
            current_score_value >= 0
            AND current_score_value <= 10
        )
    ),

    CHECK (
        final_score_value IS NULL
        OR (
            final_score_value >= 0
            AND final_score_value <= 10
        )
    ),

    CHECK (round_count BETWEEN 0 AND 1000),

    CHECK (
        starting_division IS NULL
        OR starting_division BETWEEN 1 AND 3
    ),

    CHECK (
        starting_rp IS NULL
        OR starting_rp BETWEEN 0 AND 99
    ),

    CHECK (
        ending_division IS NULL
        OR ending_division BETWEEN 1 AND 3
    ),

    CHECK (
        ending_rp IS NULL
        OR ending_rp BETWEEN 0 AND 99
    ),

    CHECK (
        forfeit_rp_loss_preview IS NULL
        OR forfeit_rp_loss_preview BETWEEN 1 AND 500
    ),

    CHECK (
        rp_delta IS NULL
        OR rp_delta BETWEEN -500 AND 500
    ),

    CHECK (NOT (promoted AND demoted)),

    CHECK (
        (
            debate_kind = 'placement'
            AND starting_rank_key IS NULL
            AND starting_division IS NULL
            AND starting_rp IS NULL
            AND forfeit_rp_loss_preview IS NULL
        )
        OR
        (
            debate_kind = 'ladder'
            AND starting_rank_key IS NOT NULL
            AND starting_rp IS NOT NULL
            AND forfeit_rp_loss_preview IS NOT NULL
        )
    ),

    CHECK (
        (
            starting_rank_key IS NULL
            AND starting_division IS NULL
        )
        OR
        (
            starting_rank_key = 'alchemist'
            AND starting_division IS NULL
        )
        OR
        (
            starting_rank_key <> 'alchemist'
            AND starting_division BETWEEN 1 AND 3
        )
    ),

    CHECK (
        (
            ending_rank_key IS NULL
            AND ending_division IS NULL
            AND ending_rp IS NULL
        )
        OR
        (
            ending_rank_key = 'alchemist'
            AND ending_division IS NULL
            AND ending_rp IS NOT NULL
        )
        OR
        (
            ending_rank_key <> 'alchemist'
            AND ending_division BETWEEN 1 AND 3
            AND ending_rp IS NOT NULL
        )
    ),

    CHECK (
        (
            status = 'active'
            AND completed_at IS NULL
            AND final_score_value IS NULL
            AND rp_delta IS NULL
            AND ending_rank_key IS NULL
        )
        OR
        (
            status <> 'active'
            AND completed_at IS NOT NULL
        )
    ),

    CHECK (
        status <> 'completed'
        OR (
            final_score_value IS NOT NULL
            AND (
                debate_kind = 'placement'
                OR (
                    rp_delta <> 0
                    AND ending_rank_key IS NOT NULL
                )
            )
        )
    ),

    CHECK (
        status <> 'forfeited'
        OR (
            final_score_value = 0
            AND (
                (
                    debate_kind = 'placement'
                    AND rp_delta IS NULL
                )
                OR
                (
                    debate_kind = 'ladder'
                    AND rp_delta < 0
                    AND ending_rank_key IS NOT NULL
                )
            )
        )
    ),

    CHECK (
        status <> 'invalid'
        OR (
            final_score_value = 0
            AND (
                (
                    debate_kind = 'placement'
                    AND rp_delta IS NULL
                )
                OR
                (
                    debate_kind = 'ladder'
                    AND rp_delta < 0
                    AND ending_rank_key IS NOT NULL
                )
            )
        )
    ),

    CHECK (
        status <> 'voided'
        OR rp_delta IS NULL
    ),

    CHECK (
        origin_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        last_synced_from_installation_id ~ '^[A-Za-z0-9-]{8,128}$'
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(ranked_rules_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(scoring_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(report_prompt_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(topic_generator_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(rp_formula_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(model_provider)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(model_name)) BETWEEN 1 AND 150
    ),

    CHECK (state_version > 0),
    CHECK (last_activity_at >= started_at),
    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX account_ranked_debates_one_active_per_account_idx
    ON account_ranked_debates (account_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX account_ranked_debates_one_placement_trial_idx
    ON account_ranked_debates (
        account_id,
        placement_trial_number
    )
    WHERE placement_trial_number IS NOT NULL;

CREATE UNIQUE INDEX account_ranked_debates_saved_debate_idx
    ON account_ranked_debates (
        account_id,
        saved_debate_id
    )
    WHERE saved_debate_id IS NOT NULL;

CREATE INDEX account_ranked_debates_history_idx
    ON account_ranked_debates (
        account_id,
        completed_at DESC,
        id
    );

CREATE INDEX account_ranked_debates_active_activity_idx
    ON account_ranked_debates (
        account_id,
        last_activity_at DESC
    )
    WHERE status = 'active';

CREATE TABLE account_ranked_placement_trials (
    account_id UUID NOT NULL
        REFERENCES account_ranked_profiles(account_id)
        ON DELETE CASCADE,

    trial_number SMALLINT NOT NULL,
    required_mode TEXT NOT NULL,
    weight_basis_points SMALLINT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'active',
                'completed',
                'forfeited',
                'invalid'
            )
        ),

    ranked_debate_id UUID UNIQUE
        REFERENCES account_ranked_debates(id)
        ON DELETE CASCADE,

    philosopher_id TEXT,
    philosopher_name TEXT,
    topic_fingerprint TEXT,

    final_score_value NUMERIC(4, 2),
    weighted_score_contribution NUMERIC(7, 4),

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (account_id, trial_number),

    CHECK (trial_number BETWEEN 1 AND 5),

    CHECK (
        (
            trial_number = 1
            AND required_mode = 'guided'
            AND weight_basis_points = 1500
        )
        OR
        (
            trial_number IN (2, 3)
            AND required_mode = 'balanced'
            AND weight_basis_points = 2000
        )
        OR
        (
            trial_number = 4
            AND required_mode = 'relentless'
            AND weight_basis_points = 2000
        )
        OR
        (
            trial_number = 5
            AND required_mode = 'relentless'
            AND weight_basis_points = 2500
        )
    ),

    CHECK (
        philosopher_id IS NULL
        OR CHAR_LENGTH(BTRIM(philosopher_id)) BETWEEN 1 AND 100
    ),

    CHECK (
        philosopher_name IS NULL
        OR CHAR_LENGTH(BTRIM(philosopher_name)) BETWEEN 1 AND 100
    ),

    CHECK (
        topic_fingerprint IS NULL
        OR topic_fingerprint ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        final_score_value IS NULL
        OR (
            final_score_value >= 0
            AND final_score_value <= 10
        )
    ),

    CHECK (
        weighted_score_contribution IS NULL
        OR (
            weighted_score_contribution >= 0
            AND weighted_score_contribution <= 2.5
        )
    ),

    CHECK (
        (
            status = 'pending'
            AND ranked_debate_id IS NULL
            AND final_score_value IS NULL
            AND weighted_score_contribution IS NULL
            AND started_at IS NULL
            AND completed_at IS NULL
        )
        OR
        (
            status = 'active'
            AND ranked_debate_id IS NOT NULL
            AND final_score_value IS NULL
            AND weighted_score_contribution IS NULL
            AND started_at IS NOT NULL
            AND completed_at IS NULL
        )
        OR
        (
            status IN (
                'completed',
                'forfeited',
                'invalid'
            )
            AND ranked_debate_id IS NOT NULL
            AND final_score_value IS NOT NULL
            AND weighted_score_contribution IS NOT NULL
            AND started_at IS NOT NULL
            AND completed_at IS NOT NULL
        )
    ),

    CHECK (
        status NOT IN ('forfeited', 'invalid')
        OR final_score_value = 0
    ),

    CHECK (
        completed_at IS NULL
        OR completed_at >= started_at
    ),

    CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX account_ranked_placement_trials_no_repeat_philosopher_idx
    ON account_ranked_placement_trials (
        account_id,
        philosopher_id
    )
    WHERE philosopher_id IS NOT NULL;

CREATE INDEX account_ranked_placement_trials_status_idx
    ON account_ranked_placement_trials (
        account_id,
        status,
        trial_number
    );

CREATE TABLE account_ranked_rating_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    account_id UUID NOT NULL
        REFERENCES account_ranked_profiles(account_id)
        ON DELETE CASCADE,

    ranked_debate_id UUID
        REFERENCES account_ranked_debates(id)
        ON DELETE CASCADE,

    event_type TEXT NOT NULL
        CHECK (
            event_type IN (
                'placement_trial',
                'placement_completed',
                'ladder_result',
                'forfeit',
                'invalid_response',
                'voided',
                'admin_adjustment',
                'test_reset'
            )
        ),

    placement_trial_number SMALLINT,

    philosopher_id TEXT,
    philosopher_name TEXT,
    debate_mode TEXT,
    topic_fingerprint TEXT,

    final_score_value NUMERIC(4, 2),
    rp_delta INTEGER,

    before_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    before_division SMALLINT,
    before_rp INTEGER,

    after_rank_key TEXT
        REFERENCES ranked_rank_tiers(rank_key),
    after_division SMALLINT,
    after_rp INTEGER,

    promoted BOOLEAN NOT NULL DEFAULT FALSE,
    demoted BOOLEAN NOT NULL DEFAULT FALSE,

    protection_before SMALLINT NOT NULL DEFAULT 0,
    protection_after SMALLINT NOT NULL DEFAULT 0,
    protection_applied BOOLEAN NOT NULL DEFAULT FALSE,
    protection_consumed BOOLEAN NOT NULL DEFAULT FALSE,

    ranked_rules_version TEXT NOT NULL,
    philosopher_prompt_version TEXT,
    scoring_prompt_version TEXT,
    report_prompt_version TEXT,
    topic_generator_version TEXT,
    rp_formula_version TEXT NOT NULL,

    model_provider TEXT,
    model_name TEXT,

    formula_components JSONB NOT NULL DEFAULT '{}'::jsonb,

    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CHECK (
        placement_trial_number IS NULL
        OR placement_trial_number BETWEEN 1 AND 5
    ),

    CHECK (
        debate_mode IS NULL
        OR debate_mode IN (
            'guided',
            'balanced',
            'relentless'
        )
    ),

    CHECK (
        topic_fingerprint IS NULL
        OR topic_fingerprint ~ '^[0-9a-f]{64}$'
    ),

    CHECK (
        final_score_value IS NULL
        OR (
            final_score_value >= 0
            AND final_score_value <= 10
        )
    ),

    CHECK (
        rp_delta IS NULL
        OR rp_delta BETWEEN -500 AND 500
    ),

    CHECK (
        before_division IS NULL
        OR before_division BETWEEN 1 AND 3
    ),

    CHECK (
        after_division IS NULL
        OR after_division BETWEEN 1 AND 3
    ),

    CHECK (
        before_rp IS NULL
        OR before_rp BETWEEN 0 AND 99
    ),

    CHECK (
        after_rp IS NULL
        OR after_rp BETWEEN 0 AND 99
    ),

    CHECK (
        (
            before_rank_key IS NULL
            AND before_division IS NULL
            AND before_rp IS NULL
        )
        OR
        (
            before_rank_key = 'alchemist'
            AND before_division IS NULL
            AND before_rp IS NOT NULL
        )
        OR
        (
            before_rank_key <> 'alchemist'
            AND before_division BETWEEN 1 AND 3
            AND before_rp IS NOT NULL
        )
    ),

    CHECK (
        (
            after_rank_key IS NULL
            AND after_division IS NULL
            AND after_rp IS NULL
        )
        OR
        (
            after_rank_key = 'alchemist'
            AND after_division IS NULL
            AND after_rp IS NOT NULL
        )
        OR
        (
            after_rank_key <> 'alchemist'
            AND after_division BETWEEN 1 AND 3
            AND after_rp IS NOT NULL
        )
    ),

    CHECK (NOT (promoted AND demoted)),

    CHECK (
        protection_before BETWEEN 0 AND 1
        AND protection_after BETWEEN 0 AND 1
    ),

    CHECK (
        event_type <> 'ladder_result'
        OR (
            ranked_debate_id IS NOT NULL
            AND final_score_value IS NOT NULL
            AND rp_delta IS NOT NULL
            AND rp_delta <> 0
            AND before_rank_key IS NOT NULL
            AND after_rank_key IS NOT NULL
        )
    ),

    CHECK (
        event_type <> 'forfeit'
        OR (
            ranked_debate_id IS NOT NULL
            AND final_score_value = 0
            AND rp_delta < 0
        )
    ),

    CHECK (
        event_type <> 'invalid_response'
        OR (
            ranked_debate_id IS NOT NULL
            AND final_score_value = 0
            AND rp_delta < 0
        )
    ),

    CHECK (
        event_type <> 'placement_trial'
        OR (
            ranked_debate_id IS NOT NULL
            AND placement_trial_number BETWEEN 1 AND 5
            AND final_score_value IS NOT NULL
        )
    ),

    CHECK (
        event_type <> 'placement_completed'
        OR (
            after_rank_key IS NOT NULL
            AND after_rp = 0
        )
    ),

    CHECK (
        event_type <> 'voided'
        OR rp_delta IS NULL
    ),

    CHECK (jsonb_typeof(formula_components) = 'object'),

    CHECK (
        CHAR_LENGTH(BTRIM(ranked_rules_version)) BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(rp_formula_version)) BETWEEN 1 AND 100
    )
);

CREATE UNIQUE INDEX account_ranked_rating_events_debate_type_idx
    ON account_ranked_rating_events (
        ranked_debate_id,
        event_type
    )
    WHERE ranked_debate_id IS NOT NULL;

CREATE INDEX account_ranked_rating_events_account_time_idx
    ON account_ranked_rating_events (
        account_id,
        occurred_at DESC,
        id
    );

CREATE INDEX account_ranked_rating_events_rank_change_idx
    ON account_ranked_rating_events (
        account_id,
        occurred_at DESC
    )
    WHERE promoted = TRUE OR demoted = TRUE;

COMMENT ON TABLE ranked_system_configuration IS
    'Global Ranked rollout controls and current version identifiers. Ranked is disabled by default after migration 006.';

COMMENT ON TABLE ranked_rank_tiers IS
    'Canonical Ranked tier ordering. All tiers except The Alchemist use divisions III, II, and I.';

COMMENT ON TABLE account_ranked_profiles IS
    'Account-owned placement state, current rank, peak rank, RP, and one-debate demotion protection.';

COMMENT ON TABLE account_ranked_debates IS
    'Versioned, account-owned Ranked debate sessions. A partial unique index enforces one active Ranked debate per account.';

COMMENT ON TABLE account_ranked_placement_trials IS
    'The fixed five-trial placement sequence: Guided, Balanced, Balanced, Relentless, Relentless with 15/20/20/20/25 percent weights.';

COMMENT ON TABLE account_ranked_rating_events IS
    'Immutable-style audit history for placement outcomes, RP changes, promotions, demotions, forfeits, invalid responses, and controlled test resets.';
