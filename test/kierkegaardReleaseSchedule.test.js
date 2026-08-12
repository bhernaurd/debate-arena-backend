import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    rankedTopicGeneratorConstants,
} from '../lib/rankedTopicGeneratorService.js';

const baseMigration = readFileSync(
    new URL('../migrations/016_kierkegaard_release.sql', import.meta.url),
    'utf8'
);

const unlockMigration = readFileSync(
    new URL('../migrations/017_kierkegaard_unlock_now.sql', import.meta.url),
    'utf8'
);

test(
    'Kierkegaard release migrations unlock Pro access on August 12 while preserving the September Open Access Weekend',
    () => {
        assert.match(
            baseMigration,
            /'kierkegaard'/
        );

        assert.match(
            baseMigration,
            /2026-08-21 04:00:00\+00/
        );

        assert.match(
            unlockMigration,
            /2026-08-12 04:00:00\+00/
        );

        assert.match(
            unlockMigration,
            /WHERE philosopher_id = 'kierkegaard'/
        );

        assert.match(
            baseMigration,
            /2026-09-11 04:00:00\+00/
        );

        assert.match(
            baseMigration,
            /\n\s*72,\n\s*7,\n\s*3,/
        );

        assert.match(
            baseMigration,
            /'America\/New_York'/
        );

        assert.match(
            baseMigration,
            /'3\.8'/
        );

        assert.match(
            baseMigration,
            /philosopher-prompts-v2-kierkegaard/
        );

        assert.match(
            baseMigration,
            /ranked-topic-v2-kierkegaard/
        );


        assert.match(
            baseMigration,
            new RegExp(
                rankedTopicGeneratorConstants.defaultGeneratorVersion
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            )
        );


        assert.match(
            baseMigration,
            /account_ranked_start_requests_voiced_topic_version_chk/
        );

        assert.match(
            baseMigration,
            /account_ranked_debates_voiced_topic_version_chk/
        );

        assert.match(
            baseMigration,
            /ranked-topic-v2-philosopher-voiced/
        );

        assert.doesNotMatch(
            baseMigration,
            /^\s*BEGIN\s*;/im
        );

        assert.doesNotMatch(
            baseMigration,
            /^\s*COMMIT\s*;/im
        );


        assert.doesNotMatch(
            unlockMigration,
            /^\s*BEGIN\s*;/im
        );

        assert.doesNotMatch(
            unlockMigration,
            /^\s*COMMIT\s*;/im
        );
    }
);
