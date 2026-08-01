import {
    listRankedPhilosopherPrompts,
} from './rankedPhilosopherPrompts.js';

const PHILOSOPHER_ID_RE = /^[a-z0-9-]{1,100}$/;

export class RankedPhilosopherCatalogError extends Error {
    constructor(
        code,
        message,
        {
            status = 500,
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

const RANKED_PHILOSOPHERS = Object.freeze(
    Object.fromEntries(
        listRankedPhilosopherPrompts()
            .map((prompt) => {
                const id =
                    typeof prompt?.id === 'string'
                        ? prompt.id.trim().toLowerCase()
                        : '';

                const name =
                    typeof prompt?.name === 'string'
                        ? prompt.name.trim()
                        : '';

                if (
                    !PHILOSOPHER_ID_RE.test(id) ||
                    !name
                ) {
                    throw new Error(
                        'rankedPhilosopherPrompts.js contains an invalid philosopher identity.'
                    );
                }

                return [
                    id,
                    Object.freeze({
                        id,
                        name,
                    }),
                ];
            })
    )
);

const CANONICAL_IDS = Object.freeze(
    Object.keys(RANKED_PHILOSOPHERS)
);

// Safe launch default. Every currently released Ranked philosopher is
// available for new starts unless the Railway allowlist narrows the pool.
const DEFAULT_ELIGIBLE_IDS = Object.freeze([
    'socrates',
    'plato',
    'aristotle',
    'nietzsche',
    'aurelius',
    'jung',
    'camus',
    'dostoevsky',
]);

function cleanIdentifier(value) {
    return typeof value === 'string'
        ? value.trim().toLowerCase()
        : '';
}

function configuredEligibleIDs() {
    const rawValue =
        process.env.RANKED_ELIGIBLE_PHILOSOPHER_IDS;

    if (
        typeof rawValue !== 'string' ||
        !rawValue.trim()
    ) {
        return DEFAULT_ELIGIBLE_IDS.filter(
            (id) =>
                Object.prototype.hasOwnProperty.call(
                    RANKED_PHILOSOPHERS,
                    id
                )
        );
    }

    const canonicalSet = new Set(CANONICAL_IDS);
    const seen = new Set();
    const result = [];

    for (
        const rawID of rawValue.split(',')
    ) {
        const id = cleanIdentifier(rawID);

        if (
            !PHILOSOPHER_ID_RE.test(id) ||
            !canonicalSet.has(id) ||
            seen.has(id)
        ) {
            continue;
        }

        seen.add(id);
        result.push(id);
    }

    if (result.length === 0) {
        console.error(
            '[RankedPhilosophers] RANKED_ELIGIBLE_PHILOSOPHER_IDS contains no canonical Ranked philosopher IDs. New Ranked starts will have no eligible philosophers.'
        );
    }

    return Object.freeze(result);
}

const ELIGIBLE_IDS = configuredEligibleIDs();
const ELIGIBLE_ID_SET = new Set(ELIGIBLE_IDS);

// Used by Ranked start flows. This intentionally reflects the server-side
// eligibility allowlist, so a philosopher can be removed from new selection
// without invalidating an already-saved debate that still needs to resume.
export function isRankedPhilosopherID(value) {
    const id = cleanIdentifier(value);

    return Boolean(
        id &&
        ELIGIBLE_ID_SET.has(id)
    );
}

// Canonical lookup remains broader than new-start eligibility. Existing
// debates can still resolve their philosopher after that philosopher is
// removed from the new-start allowlist.
export function findRankedPhilosopher(value) {
    const id = cleanIdentifier(value);

    if (!id) {
        return null;
    }

    return RANKED_PHILOSOPHERS[id] ?? null;
}

export function requireRankedPhilosopher(value) {
    const philosopher =
        findRankedPhilosopher(value);

    if (!philosopher) {
        throw new RankedPhilosopherCatalogError(
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

export function listRankedPhilosophers() {
    return Object.freeze(
        Object.values(RANKED_PHILOSOPHERS)
    );
}

export function listEligibleRankedPhilosophers() {
    return Object.freeze(
        ELIGIBLE_IDS.map(
            (id) => RANKED_PHILOSOPHERS[id]
        )
    );
}

export const rankedPhilosopherCatalogConstants =
    Object.freeze({
        canonicalIDs: CANONICAL_IDS,
        eligibleIDs: ELIGIBLE_IDS,
        count: CANONICAL_IDS.length,
        eligibleCount: ELIGIBLE_IDS.length,
    });
