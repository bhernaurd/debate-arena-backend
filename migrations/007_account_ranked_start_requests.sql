-- 007_account_ranked_start_requests.sql
-- Durable idempotency and topic-generation audit metadata for every future
-- Ranked debate start.
--
-- Migration 006 created the Ranked foundation while Ranked remained disabled.
-- At the time this migration was prepared, account_ranked_debates was verified
-- to contain zero rows. This migration intentionally fails rather than adding
-- required metadata to an unexpected pre-existing Ranked debate.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM account_ranked_debates
        LIMIT 1
    ) THEN
        RAISE EXCEPTION
            'Migration 007 requires account_ranked_debates to be empty.';
    END IF;
END
$$;

ALTER TABLE account_ranked_debates
    ADD COLUMN start_request_id UUID NOT NULL,

    ADD COLUMN topic_theme TEXT NOT NULL,

    ADD COLUMN topic_model_provider TEXT NOT NULL,

    ADD COLUMN topic_model_name TEXT NOT NULL,

    ADD COLUMN topic_generated_at TIMESTAMPTZ NOT NULL,

    ADD CONSTRAINT account_ranked_debates_topic_theme_check
        CHECK (
            CHAR_LENGTH(BTRIM(topic_theme))
                BETWEEN 2 AND 120
        ),

    ADD CONSTRAINT account_ranked_debates_topic_model_provider_check
        CHECK (
            CHAR_LENGTH(BTRIM(topic_model_provider))
                BETWEEN 1 AND 100
        ),

    ADD CONSTRAINT account_ranked_debates_topic_model_name_check
        CHECK (
            CHAR_LENGTH(BTRIM(topic_model_name))
                BETWEEN 1 AND 200
        ),

    ADD CONSTRAINT account_ranked_debates_topic_generated_before_start_check
        CHECK (
            topic_generated_at <= started_at
        );

CREATE TABLE account_ranked_start_requests (
    account_id UUID NOT NULL
        REFERENCES account_ranked_profiles(account_id)
        ON DELETE CASCADE,

    request_id UUID NOT NULL,

    debate_kind TEXT NOT NULL
        CHECK (
            debate_kind IN (
                'placement',
                'ladder'
            )
        ),

    placement_trial_number SMALLINT,

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

    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (
            status IN (
                'reserved',
                'topic_generated',
                'completed',
                'failed'
            )
        ),

    topic TEXT,
    topic_normalized TEXT,
    topic_fingerprint TEXT,
    topic_theme TEXT,

    topic_model_provider TEXT,
    topic_model_name TEXT,
    topic_generator_version TEXT,
    topic_generated_at TIMESTAMPTZ,

    failure_code TEXT,
    failure_retryable BOOLEAN,

    attempt_count INTEGER NOT NULL DEFAULT 1,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    PRIMARY KEY (
        account_id,
        request_id
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
        CHAR_LENGTH(BTRIM(philosopher_id))
            BETWEEN 1 AND 100
    ),

    CHECK (
        CHAR_LENGTH(BTRIM(philosopher_name))
            BETWEEN 1 AND 100
    ),

    CHECK (
        attempt_count BETWEEN 1 AND 100
    ),

    CHECK (
        failure_code IS NULL
        OR CHAR_LENGTH(BTRIM(failure_code))
            BETWEEN 1 AND 100
    ),

    CHECK (
        (
            topic IS NULL
            AND topic_normalized IS NULL
            AND topic_fingerprint IS NULL
            AND topic_theme IS NULL
            AND topic_model_provider IS NULL
            AND topic_model_name IS NULL
            AND topic_generator_version IS NULL
            AND topic_generated_at IS NULL
        )
        OR
        (
            topic IS NOT NULL
            AND topic_normalized IS NOT NULL
            AND topic_fingerprint IS NOT NULL
            AND topic_theme IS NOT NULL
            AND topic_model_provider IS NOT NULL
            AND topic_model_name IS NOT NULL
            AND topic_generator_version IS NOT NULL
            AND topic_generated_at IS NOT NULL

            AND CHAR_LENGTH(BTRIM(topic))
                BETWEEN 30 AND 220

            AND CHAR_LENGTH(BTRIM(topic_normalized))
                BETWEEN 1 AND 220

            AND topic_fingerprint
                ~ '^[0-9a-f]{64}$'

            AND CHAR_LENGTH(BTRIM(topic_theme))
                BETWEEN 2 AND 120

            AND CHAR_LENGTH(BTRIM(topic_model_provider))
                BETWEEN 1 AND 100

            AND CHAR_LENGTH(BTRIM(topic_model_name))
                BETWEEN 1 AND 200

            AND CHAR_LENGTH(BTRIM(topic_generator_version))
                BETWEEN 1 AND 100
        )
    ),

    CHECK (
        (
            status = 'reserved'

            AND topic IS NULL
            AND failure_code IS NULL
            AND failure_retryable IS NULL
            AND completed_at IS NULL
        )
        OR
        (
            status = 'topic_generated'

            AND topic IS NOT NULL
            AND failure_code IS NULL
            AND failure_retryable IS NULL
            AND completed_at IS NULL
        )
        OR
        (
            status = 'completed'

            AND topic IS NOT NULL
            AND failure_code IS NULL
            AND failure_retryable IS NULL
            AND completed_at IS NOT NULL
        )
        OR
        (
            status = 'failed'

            AND failure_code IS NOT NULL
            AND failure_retryable IS NOT NULL
            AND completed_at IS NOT NULL
        )
    ),

    CHECK (
        topic_generated_at IS NULL
        OR topic_generated_at >= created_at
    ),

    CHECK (
        completed_at IS NULL
        OR completed_at >= created_at
    ),

    CHECK (
        updated_at >= created_at
    )
);

ALTER TABLE account_ranked_debates
    ADD CONSTRAINT account_ranked_debates_start_request_fk
        FOREIGN KEY (
            account_id,
            start_request_id
        )
        REFERENCES account_ranked_start_requests (
            account_id,
            request_id
        );

CREATE UNIQUE INDEX account_ranked_debates_start_request_idx
    ON account_ranked_debates (
        account_id,
        start_request_id
    );

CREATE UNIQUE INDEX account_ranked_start_requests_one_in_flight_idx
    ON account_ranked_start_requests (
        account_id
    )
    WHERE status IN (
        'reserved',
        'topic_generated'
    );

CREATE INDEX account_ranked_start_requests_account_time_idx
    ON account_ranked_start_requests (
        account_id,
        created_at DESC,
        request_id
    );

CREATE INDEX account_ranked_start_requests_status_time_idx
    ON account_ranked_start_requests (
        status,
        updated_at ASC
    );

COMMENT ON TABLE account_ranked_start_requests IS
    'Durable account-owned idempotency ledger for Ranked debate starts. It reserves a client request UUID, stores the generated topic before debate creation, and records only sanitized terminal failure metadata.';

COMMENT ON COLUMN account_ranked_debates.start_request_id IS
    'Client-generated UUID identifying the idempotent Ranked start request that created this debate.';

COMMENT ON COLUMN account_ranked_debates.topic_theme IS
    'Short model-generated theme describing the official system-assigned Ranked topic.';

COMMENT ON COLUMN account_ranked_debates.topic_model_provider IS
    'Provider that generated the Ranked topic. This is separate from model_provider, which records the model conducting the debate.';

COMMENT ON COLUMN account_ranked_debates.topic_model_name IS
    'Model that generated the Ranked topic. This is separate from model_name, which records the model conducting the debate.';

COMMENT ON COLUMN account_ranked_debates.topic_generated_at IS
    'Server timestamp when the official Ranked topic was generated.';

COMMENT ON COLUMN account_ranked_debates.model_provider IS
    'Provider of the AI model that conducts the Ranked debate, not the topic generator.';

COMMENT ON COLUMN account_ranked_debates.model_name IS
    'AI model that conducts the Ranked debate, not the topic-generator model.';
