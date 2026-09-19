import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    getExpandedAgoraAccessSnapshot,
} from '../expandedAgoraAccess.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '..');

function iso(date) {
    return date.toISOString();
}

function releaseRowForFreeEvent(now) {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    return {
        philosopher_id: 'schopenhauer',
        display_name: 'Arthur Schopenhauer',
        pro_launch_at: iso(new Date(now.getTime() - 20 * day)),
        free_event_starts_at: iso(new Date(now.getTime() - 12 * hour)),
        free_event_ends_at: iso(new Date(now.getTime() + 60 * hour)),
        grace_starts_at: iso(new Date(now.getTime() + 60 * hour)),
        grace_ends_at: iso(new Date(now.getTime() + 60 * hour + 7 * day)),
        grace_eligibility_cutoff_at: iso(new Date(now.getTime() - 12 * hour)),
        free_event_duration_hours: 72,
        grace_duration_days: 7,
        preview_debate_limit: 3,
        official_time_zone: 'America/New_York',
        minimum_ios_build: null,
        required_minimum_ios_version: '4.5',
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
                return { rows: [release] };
            }

            if (
                statement.includes(
                    'SELECT MIN(first_seen_at) AS first_seen_at'
                )
            ) {
                return {
                    rows: [{
                        first_seen_at: '2026-01-01T00:00:00.000Z',
                    }],
                };
            }

            if (
                statement.includes(
                    'FROM expanded_debate_authorizations'
                )
            ) {
                return { rows: [] };
            }

            throw new Error(`Unexpected test query: ${statement}`);
        },
    };
}

test(
    'Schopenhauer becomes unlimited free access during the October open weekend',
    async () => {
        const now = new Date();
        const release = releaseRowForFreeEvent(now);
        const snapshot = await getExpandedAgoraAccessSnapshot(
            releaseSnapshotDatabase(release),
            {
                userId: 'Schopenhauer-Release-Test-01',
                iosVersion: '4.5',
                iosBuild: 3,
            }
        );

        assert.equal(
            snapshot.specialEventPhilosopherId,
            'schopenhauer'
        );
        assert.deepEqual(snapshot.previewPhilosopherIds, []);
        assert.equal(snapshot.philosophers.length, 1);
        assert.equal(snapshot.philosophers[0].phase, 'free_event');
        assert.equal(snapshot.philosophers[0].freeAccess, 'event');
        assert.equal(snapshot.philosophers[0].accessReason, 'free_event');
    }
);

test('Schopenhauer migration uses the intended October 16-19 rollout', () => {
    const migration = fs.readFileSync(
        path.join(
            repositoryRoot,
            'migrations',
            '043_schopenhauer_release.sql'
        ),
        'utf8'
    );

    assert.match(migration, /philosopher_id = 'schopenhauer'/);
    assert.match(migration, /'Arthur Schopenhauer'/);
    assert.match(migration, /2026-10-16 10:00:00\+00/);
    assert.match(migration, /free_event_duration_hours = 72/);
    assert.match(migration, /grace_duration_days = 7/);
    assert.match(migration, /preview_debate_limit = 3/);
    assert.match(migration, /minimum_ios_version = '4\.5'/);
});

test('question generation recognizes Schopenhauer and his core themes', () => {
    const questions = fs.readFileSync(
        path.join(repositoryRoot, 'questions.js'),
        'utf8'
    );

    assert.match(
        questions,
        /'schopenhauer': 'Arthur Schopenhauer'/
    );
    assert.match(
        questions,
        /'Arthur Schopenhauer':\s*\n\s*'world as representation, will as blind striving/
    );
});
