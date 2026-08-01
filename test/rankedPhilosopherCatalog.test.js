import assert from 'node:assert/strict';
import test from 'node:test';

import {
    RankedPhilosopherCatalogError,
    findRankedPhilosopher,
    isRankedPhilosopherID,
    listEligibleRankedPhilosophers,
    listRankedPhilosophers,
    rankedPhilosopherCatalogConstants,
    requireRankedPhilosopher,
} from '../lib/rankedPhilosopherCatalog.js';

const EXPECTED = [
    ['aristotle', 'Aristotle'],
    ['plato', 'Plato'],
    ['nietzsche', 'Nietzsche'],
    ['socrates', 'Socrates'],
    ['jung', 'Carl Jung'],
    ['aurelius', 'Marcus Aurelius'],
    ['camus', 'Albert Camus'],
    ['dostoevsky', 'Fyodor Dostoevsky'],
];

test(
    'contains the eight iOS-selectable Ranked philosophers',
    () => {
        const philosophers =
            listRankedPhilosophers();

        assert.equal(
            philosophers.length,
            8
        );

        assert.deepEqual(
            philosophers.map(
                (item) => [
                    item.id,
                    item.name,
                ]
            ),
            EXPECTED
        );

        assert.equal(
            rankedPhilosopherCatalogConstants.count,
            8
        );

        assert.deepEqual(
            rankedPhilosopherCatalogConstants
                .canonicalIDs,
            EXPECTED.map(
                ([id]) => id
            )
        );
    }
);

test(
    'resolves canonical IDs without accepting display-name aliases',
    () => {
        assert.equal(
            findRankedPhilosopher(
                'aurelius'
            )?.name,
            'Marcus Aurelius'
        );

        assert.equal(
            findRankedPhilosopher(
                'jung'
            )?.name,
            'Carl Jung'
        );

        assert.equal(
            findRankedPhilosopher(
                'dostoevsky'
            )?.name,
            'Fyodor Dostoevsky'
        );

        assert.equal(
            findRankedPhilosopher(
                'Marcus Aurelius'
            ),
            null
        );

        assert.equal(
            isRankedPhilosopherID(
                'Marcus Aurelius'
            ),
            false
        );
    }
);

test(
    'uses the server eligibility allowlist for new Ranked starts',
    () => {
        assert.deepEqual(
            listEligibleRankedPhilosophers()
                .map((item) => item.id),
            rankedPhilosopherCatalogConstants
                .eligibleIDs
        );

        assert.equal(
            rankedPhilosopherCatalogConstants
                .eligibleCount,
            rankedPhilosopherCatalogConstants
                .eligibleIDs.length
        );
    }
);

test(
    'excludes Coming Soon philosophers',
    () => {
        assert.equal(
            findRankedPhilosopher(
                'kierkegaard'
            ),
            null
        );

        assert.equal(
            isRankedPhilosopherID(
                'kierkegaard'
            ),
            false
        );
    }
);

test(
    'requires a valid Ranked philosopher',
    () => {
        assert.equal(
            requireRankedPhilosopher(
                'camus'
            ).name,
            'Albert Camus'
        );

        assert.throws(
            () =>
                requireRankedPhilosopher(
                    'unknown'
                ),
            (error) =>
                error instanceof
                    RankedPhilosopherCatalogError &&
                error.code ===
                    'invalid_ranked_philosopher' &&
                error.status === 400 &&
                error.retryable === false
        );
    }
);

test(
    'returns immutable catalog entries',
    () => {
        const philosophers =
            listRankedPhilosophers();

        assert.equal(
            Object.isFrozen(
                philosophers
            ),
            true
        );

        assert.equal(
            Object.isFrozen(
                philosophers[0]
            ),
            true
        );
    }
);
