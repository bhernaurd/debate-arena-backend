-- 032_multilingual_experience.sql
-- Adds additive storage needed for The Agora's 8-language experience.
-- English remains the canonical machine/scoring language where appropriate.

ALTER TABLE generated_questions
    ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';

CREATE INDEX IF NOT EXISTS generated_questions_user_philosopher_language_time_idx
    ON generated_questions (user_id, philosopher, language_code, generated_at DESC);

ALTER TABLE daily_challenges
    ADD COLUMN IF NOT EXISTS translations JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE push_tokens
    ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';

ALTER TABLE push_tokens
    ADD COLUMN IF NOT EXISTS language_preference TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS push_tokens_language_enabled_idx
    ON push_tokens (language_code, notifications_enabled);

ALTER TABLE account_ranked_start_requests
    ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';

ALTER TABLE account_ranked_start_requests
    ADD COLUMN IF NOT EXISTS display_topic TEXT;

UPDATE account_ranked_start_requests
SET display_topic = topic
WHERE display_topic IS NULL
  AND topic IS NOT NULL;

ALTER TABLE account_ranked_debates
    ADD COLUMN IF NOT EXISTS language_code TEXT NOT NULL DEFAULT 'en';

ALTER TABLE account_ranked_debates
    ADD COLUMN IF NOT EXISTS display_topic TEXT;

UPDATE account_ranked_debates
SET display_topic = topic
WHERE display_topic IS NULL;

ALTER TABLE account_ranked_debates
    ALTER COLUMN display_topic SET NOT NULL;

COMMENT ON COLUMN generated_questions.language_code IS
    'BCP-47-ish app language code used for the visible generated question.';

COMMENT ON COLUMN daily_challenges.translations IS
    'Cached user-visible translations keyed by supported app language code; canonical challenge semantics remain in the base columns.';

COMMENT ON COLUMN account_ranked_debates.topic IS
    'Canonical English Ranked topic used for scoring, duplicate detection, and analytics.';

COMMENT ON COLUMN account_ranked_debates.display_topic IS
    'Localized user-visible rendering of the canonical Ranked topic.';
