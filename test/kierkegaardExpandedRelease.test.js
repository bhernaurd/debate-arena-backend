import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    getExpandedAgoraAccessSnapshot,
} from '../expandedAgoraAccess.js';

const testDirectory = path.dirname(
    fileURLToPath(import.meta.url)
);
const repositoryRoot = path.resolve(
    testDirectory,
    '..'
);

function iso(date) {
    return date.toISOString();
}

function executableSql(source) {
    return source
        .split('\n')
        .filter(
            (line) =>
                !line
                    .trimStart()
                    .startsWith('--')
        )
        .join('\n')
        .trim();
}

function releaseRowForFreeEvent(now) {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    return {
        philosopher_id: 'kierkegaard',
        display_name: 'Søren Kierkegaard',
        pro_launch_at: iso(
            new Date(now.getTime() - 14 * day)
        ),
        free_event_starts_at: iso(
            new Date(now.getTime() - 12 * hour)
        ),
        free_event_ends_at: iso(
            new Date(now.getTime() + 60 * hour)
        ),
        grace_starts_at: iso(
            new Date(now.getTime() + 60 * hour)
        ),
        grace_ends_at: iso(
            new Date(now.getTime() + 60 * hour + 7 * day)
        ),
        grace_eligibility_cutoff_at: iso(
            new Date(now.getTime() - 12 * hour)
        ),
        free_event_duration_hours: 72,
        grace_duration_days: 7,
        preview_debate_limit: 3,
        official_time_zone: 'America/New_York',
        minimum_ios_build: null,
        required_minimum_ios_version: '3.8',
        required_minimum_legacy_ios_build: null,
        is_enabled: true,
    };
}

function releaseSnapshotDatabase(release) {
    return {
        async query(sql) {
            const statement = String(sql);

            if (
                statement.includes(
                    'FROM expanded_philosopher_release_schedule AS schedule'
                )
            ) {
                return {
                    rows: [release],
                };
            }

            if (
                statement.includes(
                    'SELECT MIN(first_seen_at) AS first_seen_at'
                )
            ) {
                return {
                    rows: [
                        {
                            first_seen_at:
                                '2026-01-01T00:00:00.000Z',
                        },
                    ],
                };
            }

            if (
                statement.includes(
                    'FROM expanded_debate_authorizations'
                )
            ) {
                return {
                    rows: [],
                };
            }

            throw new Error(
                `Unexpected test query: ${statement}`
            );
        },
    };
}

test(
    'Kierkegaard becomes unlimited free access during the open weekend',
    async () => {
        const now = new Date();
        const release =
            releaseRowForFreeEvent(now);
        const snapshot =
            await getExpandedAgoraAccessSnapshot(
                releaseSnapshotDatabase(
                    release
                ),
                {
                    userId:
                        'Kierkegaard-Release-Test-01',
                    iosVersion: '3.8',
                    iosBuild: 1,
                }
            );

        assert.equal(
            snapshot.specialEventPhilosopherId,
            'kierkegaard'
        );
        assert.deepEqual(
            snapshot.previewPhilosopherIds,
            []
        );
        assert.equal(
            snapshot.philosophers.length,
            1
        );
        assert.equal(
            snapshot.philosophers[0].phase,
            'free_event'
        );
        assert.equal(
            snapshot.philosophers[0].freeAccess,
            'event'
        );
        assert.equal(
            snapshot.philosophers[0].accessReason,
            'free_event'
        );
    }
);

test(
    'migration 016 is retired and cannot mutate release or Ranked state',
    () => {
        const migration =
            fs.readFileSync(
                path.join(
                    repositoryRoot,
                    'migrations',
                    '016_kierkegaard_release.sql'
                ),
                'utf8'
            );

        const sql = executableSql(migration);

        assert.equal(
            sql,
            'SELECT 1 AS retired_migration_016;'
        );

        assert.doesNotMatch(
            sql,
            /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i
        );

        assert.doesNotMatch(
            migration,
            /2026-08-(12|21)/
        );

        assert.match(
            migration,
            /September 11-13, 2026/
        );

        assert.match(
            migration,
            /NEW\s+forward migration/i
        );

        assert.doesNotMatch(
            migration,
            /^\s*(BEGIN|COMMIT)\s*;/mi
        );
    }
);

test(
    'the release activation query fails closed until dates and final build are configured',
    () => {
        const activation =
            fs.readFileSync(
                path.join(
                    repositoryRoot,
                    'ops',
                    'configure_kierkegaard_release.sql'
                ),
                'utf8'
            );

        assert.match(
            activation,
            /v_pro_launch_at TIMESTAMPTZ := NULL/
        );
        assert.match(
            activation,
            /v_free_event_starts_at TIMESTAMPTZ := NULL/
        );
        assert.match(
            activation,
            /v_minimum_ios_build INTEGER := NULL/
        );
        assert.match(
            activation,
            /free_event_duration_hours = 72/
        );
        assert.match(
            activation,
            /grace_duration_days = 7/
        );
        assert.match(
            activation,
            /preview_debate_limit = 3/
        );
    }
);
