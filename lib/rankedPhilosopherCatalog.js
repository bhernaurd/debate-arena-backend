const PHILOSOPHERS = Object.freeze([
    Object.freeze({
        id: 'aristotle',
        name: 'Aristotle',
        themes:
            'virtue, habit, excellence, eudaimonia, friendship, purpose, moderation, practical wisdom, character built through action',
    }),
    Object.freeze({
        id: 'plato',
        name: 'Plato',
        themes:
            'truth versus illusion, the soul, justice, the Forms, education, appearance versus reality, the ideal society, who should rule',
    }),
    Object.freeze({
        id: 'nietzsche',
        name: 'Nietzsche',
        themes:
            'values, suffering, herd morality, self-overcoming, nihilism, comfort versus greatness, resentment, creating meaning',
    }),
    Object.freeze({
        id: 'socrates',
        name: 'Socrates',
        themes:
            'self-examination, virtue, knowledge versus ignorance, truth, justice, questioning assumptions, admitting what is not known',
    }),
    Object.freeze({
        id: 'jung',
        name: 'Carl Jung',
        themes:
            'the shadow, individuation, dreams, projection, archetypes, the unconscious, identity, persona versus the true self',
    }),
    Object.freeze({
        id: 'aurelius',
        name: 'Marcus Aurelius',
        themes:
            'control, discipline, duty, mortality, adversity, emotional restraint, acceptance, responsibility, fate, the opinions of others',
    }),
    Object.freeze({
        id: 'camus',
        name: 'Albert Camus',
        themes:
            'the absurd, lucidity, revolt, false consolation, happiness without illusion, freedom, dignity, solidarity, suffering, justice, limits',
    }),
    Object.freeze({
        id: 'dostoevsky',
        name: 'Fyodor Dostoevsky',
        themes:
            'faith, suffering, guilt, freedom, conscience, moral responsibility, redemption, evil, spiritual crisis, innocent suffering, rebellion, love',
    }),
]);

const BY_ID = new Map(
    PHILOSOPHERS.map((philosopher) => [
        philosopher.id,
        philosopher,
    ])
);

const BY_NAME = new Map(
    PHILOSOPHERS.map((philosopher) => [
        philosopher.name.toLowerCase(),
        philosopher,
    ])
);

const ALIASES = Object.freeze({
    aristotle: 'aristotle',
    plato: 'plato',

    nietzsche: 'nietzsche',
    'friedrich nietzsche': 'nietzsche',

    socrates: 'socrates',

    jung: 'jung',
    'carl jung': 'jung',

    aurelius: 'aurelius',
    marcus: 'aurelius',
    'marcus aurelius': 'aurelius',

    camus: 'camus',
    'albert camus': 'camus',

    dostoevsky: 'dostoevsky',
    'fyodor dostoevsky': 'dostoevsky',
});

export class RankedPhilosopherCatalogError extends Error {
    constructor(
        code,
        message,
        {
            status = 400,
            retryable = false,
        } = {}
    ) {
        super(message);
        this.name = 'RankedPhilosopherCatalogError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

function fail(code, message, options) {
    throw new RankedPhilosopherCatalogError(
        code,
        message,
        options
    );
}

function cleanIdentifier(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .trim()
        .toLowerCase();
}

export function listRankedPhilosophers() {
    return PHILOSOPHERS;
}

export function findRankedPhilosopher(value) {
    const cleaned = cleanIdentifier(value);

    if (!cleaned) {
        return null;
    }

    const direct = BY_ID.get(cleaned);

    if (direct) {
        return direct;
    }

    const byName = BY_NAME.get(cleaned);

    if (byName) {
        return byName;
    }

    const canonicalID = ALIASES[cleaned];

    if (!canonicalID) {
        return null;
    }

    return BY_ID.get(canonicalID) ?? null;
}

export function requireRankedPhilosopher(value) {
    const philosopher =
        findRankedPhilosopher(value);

    if (!philosopher) {
        fail(
            'invalid_ranked_philosopher',
            'The selected philosopher is not available for Ranked.',
            {
                status: 400,
                retryable: false,
            }
        );
    }

    return philosopher;
}

export function isRankedPhilosopherID(value) {
    const cleaned = cleanIdentifier(value);

    return (
        cleaned.length > 0 &&
        BY_ID.has(cleaned)
    );
}

export const rankedPhilosopherCatalogConstants =
    Object.freeze({
        canonicalIDs: Object.freeze(
            PHILOSOPHERS.map(
                (philosopher) =>
                    philosopher.id
            )
        ),
        count: PHILOSOPHERS.length,
    });
