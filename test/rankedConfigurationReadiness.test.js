import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertRankedTopicGeneratorConfiguration,
} from '../lib/rankedConfigurationReadiness.js';

function poolReturning(version) {
    return {
        async query() {
            return {
                rows: version == null
                    ? []
                    : [
                        {
                            topic_generator_version: version,
                        },
                    ],
            };
        },
    };
}

test(
    'accepts a matching Ranked topic generator version',
    async () => {
        const result =
            await assertRankedTopicGeneratorConfiguration({
                pool:
                    poolReturning(
                        'ranked-topic-v2-kierkegaard'
                    ),
                runtimeTopicGeneratorVersion:
                    'ranked-topic-v2-kierkegaard',
            });

        assert.equal(
            result.databaseTopicGeneratorVersion,
            'ranked-topic-v2-kierkegaard'
        );
    }
);

test(
    'rejects version drift before the server can start',
    async () => {
        await assert.rejects(
            assertRankedTopicGeneratorConfiguration({
                pool:
                    poolReturning(
                        'ranked-topic-v2-philosopher-voiced'
                    ),
                runtimeTopicGeneratorVersion:
                    'ranked-topic-v2-kierkegaard',
            }),
            (error) => {
                assert.match(
                    error.message,
                    /Refusing to start/
                );
                assert.match(
                    error.message,
                    /Runtime: ranked-topic-v2-kierkegaard/
                );
                assert.match(
                    error.message,
                    /Database: ranked-topic-v2-philosopher-voiced/
                );
                return true;
            }
        );
    }
);

test(
    'rejects a missing Ranked configuration row',
    async () => {
        await assert.rejects(
            assertRankedTopicGeneratorConfiguration({
                pool: poolReturning(null),
                runtimeTopicGeneratorVersion:
                    'ranked-topic-v2-kierkegaard',
            }),
            /ranked_system_configuration\.topic_generator_version/
        );
    }
);
