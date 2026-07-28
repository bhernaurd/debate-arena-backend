ALTER TABLE expanded_philosopher_releases
ADD COLUMN IF NOT EXISTS minimum_ios_version text;

ALTER TABLE expanded_philosopher_releases
ADD COLUMN IF NOT EXISTS minimum_legacy_ios_build integer;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'expanded_philosopher_releases_min_ios_version_format'
    ) THEN
        ALTER TABLE expanded_philosopher_releases
        ADD CONSTRAINT
            expanded_philosopher_releases_min_ios_version_format
        CHECK (
            minimum_ios_version IS NULL
            OR minimum_ios_version ~
                '^[0-9]+(\.[0-9]+){0,3}$'
        );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'expanded_philosopher_releases_min_ios_build_positive'
    ) THEN
        ALTER TABLE expanded_philosopher_releases
        ADD CONSTRAINT
            expanded_philosopher_releases_min_ios_build_positive
        CHECK (
            minimum_ios_build IS NULL
            OR minimum_ios_build > 0
        );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'expanded_philosopher_releases_legacy_build_valid'
    ) THEN
        ALTER TABLE expanded_philosopher_releases
        ADD CONSTRAINT
            expanded_philosopher_releases_legacy_build_valid
        CHECK (
            minimum_legacy_ios_build IS NULL
            OR (
                minimum_legacy_ios_build > 0
                AND minimum_ios_version IS NOT NULL
            )
        );
    END IF;
END
$$;

UPDATE expanded_philosopher_releases
SET
    minimum_ios_version = '3.7',
    minimum_ios_build = 16,
    minimum_legacy_ios_build = 16,
    updated_at = NOW()
WHERE philosopher_id = 'dostoevsky';
