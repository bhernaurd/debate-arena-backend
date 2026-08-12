import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    rankedTopicGeneratorConstants,
} from '../lib/rankedTopicGeneratorService.js';

const migration = readFileSync(
    new URL('../migrations/016_kierkegaard_release.sql', import.meta.url),
    'utf8'
);

test(
    'Kierkegaard release migration matches the approved August and September schedule',
    () => {
        assert.match(
            migration,
            /'kierkegaard'/
        );

        assert.match(
            migration,
            /2026-08-21 04:00:00\+00/
        );

        assert.match(
            migration,
            /2026-09-11 04:00:00\+00/
        );

        assert.match(
            migration,
            /\n\s*72,\n\s*7,\n\s*3,/
        );

        assert.match(
            migration,
            /'America\/New_York'/
        );

        assert.match(
            migration,
            /'3\.8'/
        );

        assert.match(
            migration,
            /philosopher-prompts-v2-kierkegaard/
        );

        assert.match(
            migration,
            /ranked-topic-v2-kierkegaard/
        );


        assert.match(
            migration,
            new RegExp(
                rankedTopicGeneratorConstants.defaultGeneratorVersion
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            )
        );


        assert.match(
            migration,
            /account_ranked_start_requests_voiced_topic_version_chk/
        );

        assert.match(
            migration,
            /account_ranked_debates_voiced_topic_version_chk/
        );

        assert.match(
            migration,
            /ranked-topic-v2-philosopher-voiced/
        );

        assert.doesNotMatch(
            migration,
            /^\s*BEGIN\s*;/im
        );

        assert.doesNotMatch(
            migration,
            /^\s*COMMIT\s*;/im
        );
    }
);
