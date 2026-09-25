import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildImmutableMirrorSnapshotEvidence,
} from '../lib/accountMirrorService.js';

test('buildImmutableMirrorSnapshotEvidence freezes the exact evidence payload used by a Mirror', () => {
    const evidence = {
        signals: [
            {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                dimension: 'meaning_discovered_created',
                pole: 'created_meaning',
                confidence: 0.91,
                stanceStrength: 0.8,
                contextBucket: 'meaning_and_purpose',
                occurredAt: new Date('2026-09-01T15:30:00.000Z'),
                evidenceExcerpt: 'Meaning is something we build through commitment.',
                positionSummary: 'The user defended created meaning.',
                sourceType: 'normal',
                savedDebateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                philosopherName: 'Albert Camus',
                topic: 'Is meaning discovered or created?',
            },
        ],
        revisions: [
            {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                dimension: 'certainty_revisability',
                beforePole: 'certainty',
                afterPole: 'revisability',
                confidence: 0.94,
                revisionStrength: 0.7,
                occurredAt: new Date('2026-09-02T16:00:00.000Z'),
                beforeExcerpt: 'I was sure before.',
                afterExcerpt: 'I think I would revise that.',
                revisionSummary: 'The user explicitly revised the belief.',
                sourceType: 'ranked',
                savedDebateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                philosopherName: 'Socrates',
                topic: 'When should a belief be revised?',
            },
        ],
    };

    const frozen = buildImmutableMirrorSnapshotEvidence(evidence);

    assert.deepEqual(frozen, {
        signals: [
            {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                dimension: 'meaning_discovered_created',
                pole: 'created_meaning',
                confidence: 0.91,
                stanceStrength: 0.8,
                contextBucket: 'meaning_and_purpose',
                excerpt: 'Meaning is something we build through commitment.',
                positionSummary: 'The user defended created meaning.',
                sourceType: 'normal',
                savedDebateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                philosopherName: 'Albert Camus',
                topic: 'Is meaning discovered or created?',
                debateCompletedAt: '2026-09-01T15:30:00.000Z',
                excludedFromFuture: false,
                excludedAt: null,
            },
        ],
        revisions: [
            {
                id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                dimension: 'certainty_revisability',
                beforePole: 'certainty',
                afterPole: 'revisability',
                confidence: 0.94,
                revisionStrength: 0.7,
                beforeExcerpt: 'I was sure before.',
                afterExcerpt: 'I think I would revise that.',
                revisionSummary: 'The user explicitly revised the belief.',
                sourceType: 'ranked',
                savedDebateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                philosopherName: 'Socrates',
                topic: 'When should a belief be revised?',
                debateCompletedAt: '2026-09-02T16:00:00.000Z',
                excludedFromFuture: false,
                excludedAt: null,
            },
        ],
    });

    evidence.signals[0].positionSummary = 'Changed later';
    evidence.revisions[0].revisionSummary = 'Changed later';

    assert.equal(
        frozen.signals[0].positionSummary,
        'The user defended created meaning.'
    );
    assert.equal(
        frozen.revisions[0].revisionSummary,
        'The user explicitly revised the belief.'
    );
});

test('buildImmutableMirrorSnapshotEvidence emits empty arrays for a Starting Mirror', () => {
    assert.deepEqual(
        buildImmutableMirrorSnapshotEvidence({
            signals: [],
            revisions: [],
        }),
        {
            signals: [],
            revisions: [],
        }
    );
});
