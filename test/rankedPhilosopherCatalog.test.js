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
    ['kierkegaard', 'Søren Kierkegaard'],
];

test(
    'contains the nine canonical Ranked philosophers',
    () => {
        const philosophers =
            listRankedPhilosophers();

        assert.equal(
            philosophers.length,
            9
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
            9
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
    'keeps Kierkegaard canonical while release-gating new Ranked starts until August 12',
    () => {
        assert.equal(
            findRankedPhilosopher(
                'kierkegaard'
            )?.name,
            'Søren Kierkegaard'
        );

        assert.equal(
            isRankedPhilosopherID(
                'kierkegaard',
                new Date('2026-08-11T23:59:59-04:00')
            ),
            false
        );

        assert.equal(
            isRankedPhilosopherID(
                'kierkegaard',
                new Date('2026-08-12T00:00:00-04:00')
            ),
            true
        );

        assert.equal(
            listEligibleRankedPhilosophers(
                new Date('2026-08-12T00:00:00-04:00')
            ).some(
                (philosopher) =>
                    philosopher.id === 'kierkegaard'
            ),
            true
        );
    }
);

test(
    'Kierkegaard carries a server-owned identity and scoring lens',
    async () => {
        const {
            findRankedPhilosopherPrompt,
        } = await import(
            '../lib/rankedPhilosopherPrompts.js'
        );

        const prompt =
            findRankedPhilosopherPrompt(
                'kierkegaard'
            );

        assert.equal(
            prompt?.name,
            'Søren Kierkegaard'
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /single individual/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /dizziness of freedom/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /not relativism/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /Religiousness A and Religiousness B/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /Johannes de Silentio.*outside faith/is
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /formal logical contradiction/i
        );


        assert.match(
            prompt?.systemPrompt ?? '',
            /teleological suspension of the ethical/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /Score argumentative quality, not agreement/i
        );

        assert.match(
            prompt?.systemPrompt ?? '',
            /KIERKEGAARD SCORING LENS/
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
