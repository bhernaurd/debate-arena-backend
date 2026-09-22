-- 044_account_mirror.sql
-- Server-authoritative recurring Mirror cycles, evidence, deterministic results,
-- immutable snapshots, and internal test controls.

CREATE TABLE account_mirror_cycles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
    status TEXT NOT NULL DEFAULT 'collecting'
        CHECK (status IN (
            'collecting',
            'questionnaire_in_progress',
            'evidence_finalizing',
            'analysis_generating',
            'completed',
            'failed'
        )),

    previous_cycle_id UUID
        REFERENCES account_mirror_cycles(id)
        ON DELETE SET NULL,

    -- Cycle 1 is the Starting Mirror and has no pre-baseline evidence window.
    -- Later cycles begin exactly when the previous questionnaire was submitted.
    window_started_at TIMESTAMPTZ,
    questionnaire_eligible_at TIMESTAMPTZ NOT NULL,
    questionnaire_started_at TIMESTAMPTZ,
    questionnaire_completed_at TIMESTAMPTZ,

    questionnaire_version TEXT NOT NULL DEFAULT 'mirror-questionnaire-v1',
    archetype_model_version TEXT NOT NULL DEFAULT 'mirror-archetypes-v2',
    evidence_engine_version TEXT NOT NULL DEFAULT 'mirror-evidence-engine-v1',
    extractor_version TEXT NOT NULL DEFAULT 'mirror-debate-evidence-v1',
    analysis_prompt_version TEXT NOT NULL DEFAULT 'mirror-analysis-v1',

    -- Stable per-cycle order so the same 36 questions can be interleaved and
    -- randomized without reshuffling when the user resumes on another device.
    question_order JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Debug/test override. It never changes real completion timestamps or
    -- evidence-window boundaries.
    test_eligible_override BOOLEAN NOT NULL DEFAULT FALSE,
    test_override_at TIMESTAMPTZ,

    failure_code TEXT,
    failure_message TEXT,
    failed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, cycle_number)
);

CREATE UNIQUE INDEX account_mirror_one_open_cycle_uidx
    ON account_mirror_cycles (account_id)
    WHERE status <> 'completed';

CREATE INDEX account_mirror_cycles_account_history_idx
    ON account_mirror_cycles (account_id, cycle_number DESC);

CREATE TABLE account_mirror_questionnaire_answers (
    cycle_id UUID NOT NULL
        REFERENCES account_mirror_cycles(id)
        ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answer_value INTEGER NOT NULL CHECK (answer_value BETWEEN 1 AND 5),
    answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cycle_id, question_id)
);

CREATE TABLE account_mirror_debate_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL
        REFERENCES account_mirror_cycles(id)
        ON DELETE CASCADE,
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    debate_history_id UUID NOT NULL
        REFERENCES account_debate_history(id)
        ON DELETE CASCADE,
    saved_debate_id UUID NOT NULL,
    source_type TEXT NOT NULL
        CHECK (source_type IN ('normal', 'ranked', 'daily_challenge')),
    debate_completed_at TIMESTAMPTZ NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending',
            'processing',
            'accepted',
            'no_evidence',
            'failed'
        )),
    extractor_version TEXT NOT NULL,
    model_name TEXT,
    no_evidence_reason TEXT,
    raw_result JSONB,

    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error TEXT,

    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    estimated_cost_usd NUMERIC(16, 8),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (cycle_id, saved_debate_id)
);

CREATE INDEX account_mirror_evidence_pending_idx
    ON account_mirror_debate_evidence (status, created_at)
    WHERE status IN ('pending', 'processing');

CREATE INDEX account_mirror_evidence_cycle_idx
    ON account_mirror_debate_evidence (cycle_id, debate_completed_at);

CREATE TABLE account_mirror_evidence_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL
        REFERENCES account_mirror_debate_evidence(id)
        ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 2),

    dimension TEXT NOT NULL CHECK (dimension IN (
        'autonomy_obligation',
        'principles_consequences',
        'meaning_discovered_created',
        'universalism_contextualism',
        'determinism_agency',
        'certainty_revisability'
    )),
    pole TEXT NOT NULL,
    stance_strength NUMERIC(5, 4) NOT NULL CHECK (stance_strength BETWEEN 0 AND 1),
    confidence NUMERIC(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    position_status TEXT NOT NULL
        CHECK (position_status IN ('opening', 'maintained', 'final', 'mixed')),
    context_bucket TEXT NOT NULL,

    evidence_message_id UUID NOT NULL,
    evidence_excerpt TEXT NOT NULL,
    position_summary TEXT NOT NULL,
    validated BOOLEAN NOT NULL DEFAULT FALSE,

    excluded_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    excluded_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (evidence_id, ordinal)
);

CREATE INDEX account_mirror_signals_evidence_idx
    ON account_mirror_evidence_signals (evidence_id);

CREATE TABLE account_mirror_revision_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evidence_id UUID NOT NULL UNIQUE
        REFERENCES account_mirror_debate_evidence(id)
        ON DELETE CASCADE,

    dimension TEXT NOT NULL CHECK (dimension IN (
        'autonomy_obligation',
        'principles_consequences',
        'meaning_discovered_created',
        'universalism_contextualism',
        'determinism_agency',
        'certainty_revisability'
    )),
    before_pole TEXT NOT NULL,
    after_pole TEXT NOT NULL,
    revision_strength NUMERIC(5, 4) NOT NULL CHECK (revision_strength BETWEEN 0 AND 1),
    confidence NUMERIC(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),

    before_message_id UUID NOT NULL,
    after_message_id UUID NOT NULL,
    before_excerpt TEXT NOT NULL,
    after_excerpt TEXT NOT NULL,
    revision_summary TEXT NOT NULL,
    validated BOOLEAN NOT NULL DEFAULT FALSE,

    excluded_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    excluded_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE account_mirror_dimension_results (
    cycle_id UUID NOT NULL
        REFERENCES account_mirror_cycles(id)
        ON DELETE CASCADE,
    dimension TEXT NOT NULL CHECK (dimension IN (
        'autonomy_obligation',
        'principles_consequences',
        'meaning_discovered_created',
        'universalism_contextualism',
        'determinism_agency',
        'certainty_revisability'
    )),

    questionnaire_score NUMERIC(6, 3) NOT NULL CHECK (questionnaire_score BETWEEN 0 AND 100),
    debate_adjustment NUMERIC(6, 3) NOT NULL CHECK (debate_adjustment BETWEEN -8 AND 8),
    final_score NUMERIC(6, 3) NOT NULL CHECK (final_score BETWEEN 0 AND 100),

    evidence_strength NUMERIC(6, 5) NOT NULL DEFAULT 0 CHECK (evidence_strength BETWEEN 0 AND 1),
    evidence_consistency NUMERIC(6, 5) NOT NULL DEFAULT 0 CHECK (evidence_consistency BETWEEN 0 AND 1),
    evidence_breadth INTEGER NOT NULL DEFAULT 0 CHECK (evidence_breadth >= 0),
    previous_final_score NUMERIC(6, 3),
    change_from_previous NUMERIC(7, 3),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cycle_id, dimension)
);

CREATE TABLE account_mirror_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id UUID NOT NULL UNIQUE
        REFERENCES account_mirror_cycles(id)
        ON DELETE CASCADE,
    account_id UUID NOT NULL
        REFERENCES accounts(id)
        ON DELETE CASCADE,
    cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),

    primary_archetype_id TEXT NOT NULL,
    primary_archetype_name TEXT NOT NULL,
    primary_fit NUMERIC(7, 4) NOT NULL CHECK (primary_fit BETWEEN 0 AND 100),
    secondary_archetype_id TEXT NOT NULL,
    secondary_archetype_name TEXT NOT NULL,
    secondary_fit NUMERIC(7, 4) NOT NULL CHECK (secondary_fit BETWEEN 0 AND 100),
    blend_status TEXT NOT NULL,

    analysis_json JSONB NOT NULL,

    sonnet_model TEXT NOT NULL,
    input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    estimated_cost_usd NUMERIC(16, 8),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),

    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, cycle_number)
);

CREATE INDEX account_mirror_snapshots_account_idx
    ON account_mirror_snapshots (account_id, cycle_number DESC);

COMMENT ON TABLE account_mirror_snapshots IS
    'Immutable completed Mirror analyses. Historical snapshots are never recalculated when later Mirror versions change.';
