const RANK_SEQUENCE = Object.freeze([
    Object.freeze({ rankKey: 'initiate', division: 3 }),
    Object.freeze({ rankKey: 'initiate', division: 2 }),
    Object.freeze({ rankKey: 'initiate', division: 1 }),
    Object.freeze({ rankKey: 'student', division: 3 }),
    Object.freeze({ rankKey: 'student', division: 2 }),
    Object.freeze({ rankKey: 'student', division: 1 }),
    Object.freeze({ rankKey: 'dialectician', division: 3 }),
    Object.freeze({ rankKey: 'dialectician', division: 2 }),
    Object.freeze({ rankKey: 'dialectician', division: 1 }),
    Object.freeze({ rankKey: 'logician', division: 3 }),
    Object.freeze({ rankKey: 'logician', division: 2 }),
    Object.freeze({ rankKey: 'logician', division: 1 }),
    Object.freeze({ rankKey: 'scholar', division: 3 }),
    Object.freeze({ rankKey: 'scholar', division: 2 }),
    Object.freeze({ rankKey: 'scholar', division: 1 }),
    Object.freeze({ rankKey: 'sage', division: 3 }),
    Object.freeze({ rankKey: 'sage', division: 2 }),
    Object.freeze({ rankKey: 'sage', division: 1 }),
    Object.freeze({ rankKey: 'philosopher', division: 3 }),
    Object.freeze({ rankKey: 'philosopher', division: 2 }),
    Object.freeze({ rankKey: 'philosopher', division: 1 }),
    Object.freeze({ rankKey: 'alchemist', division: null }),
]);

const RANK_ORDER = Object.freeze({
    initiate: 1,
    student: 2,
    dialectician: 3,
    logician: 4,
    scholar: 5,
    sage: 6,
    philosopher: 7,
    alchemist: 8,
});

const SUPPORTED_MODES = new Set([
    'guided',
    'balanced',
    'relentless',
]);

const MODE_MULTIPLIERS = Object.freeze({
    guided: 0.85,
    balanced: 1.0,
    relentless: 1.25,
});

const MAX_VALID_GAIN = 35;
const MAX_VALID_LOSS = 35;
const INVALID_RESPONSE_LOSS = 40;

export class RankedRatingError extends Error {
    constructor(code, message, options = {}) {
        super(message, options.cause ? { cause: options.cause } : undefined);
        this.name = 'RankedRatingError';
        this.code = code;
        this.status = options.status ?? 500;
        this.retryable = options.retryable ?? false;
    }
}

function fail(code, message, options) {
    throw new RankedRatingError(code, message, options);
}

function requireFiniteNumber(value, fieldName, minimum, maximum) {
    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'invalid_ranked_rating_input',
            `${fieldName} must be between ${minimum} and ${maximum}.`,
            { status: 400 }
        );
    }

    return parsed;
}

function requireInteger(value, fieldName, minimum, maximum) {
    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail(
            'invalid_ranked_rating_input',
            `${fieldName} must be an integer between ${minimum} and ${maximum}.`,
            { status: 400 }
        );
    }

    return parsed;
}

function normalizeMode(value) {
    if (typeof value !== 'string' || !SUPPORTED_MODES.has(value)) {
        fail(
            'invalid_ranked_rating_input',
            'debateMode must be guided, balanced, or relentless.',
            { status: 400 }
        );
    }

    return value;
}

function normalizePosition({ rankKey, division, rp }) {
    if (typeof rankKey !== 'string' || !(rankKey in RANK_ORDER)) {
        fail(
            'invalid_ranked_rating_input',
            'rankKey is invalid.',
            { status: 400 }
        );
    }

    const normalizedDivision = rankKey === 'alchemist'
        ? null
        : requireInteger(division, 'division', 1, 3);

    if (rankKey === 'alchemist' && division != null) {
        fail(
            'invalid_ranked_rating_input',
            'The Alchemist cannot have a division.',
            { status: 400 }
        );
    }

    return Object.freeze({
        rankKey,
        division: normalizedDivision,
        rp: requireInteger(rp, 'rp', 0, 99),
    });
}

function stageIndex(position) {
    const index = RANK_SEQUENCE.findIndex(
        (candidate) =>
            candidate.rankKey === position.rankKey &&
            candidate.division === position.division
    );

    if (index < 0) {
        fail(
            'invalid_ranked_rating_input',
            'The Ranked position is not part of the canonical ladder.',
            { status: 400 }
        );
    }

    return index;
}

function comparePositions(left, right) {
    const stageDifference = stageIndex(left) - stageIndex(right);

    if (stageDifference !== 0) return stageDifference;
    return left.rp - right.rp;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function signedNonZero(value, positiveWhenZero) {
    const rounded = Math.round(value);

    if (rounded !== 0) return rounded;
    return positiveWhenZero ? 1 : -1;
}

function performanceDelta(score, debateMode, rankKey) {
    // A 6/10 represents a small positive result. The midpoint is deliberately
    // 5.5 so exact-standard performance never produces a neutral 0 RP event.
    const centeredBase = (score - 5.5) * 6;
    const modeAdjusted = centeredBase * MODE_MULTIPLIERS[debateMode];
    const rankOrder = RANK_ORDER[rankKey];

    let rankAdjusted = modeAdjusted;

    if (rankOrder >= RANK_ORDER.dialectician && rankOrder <= RANK_ORDER.sage) {
        if (debateMode === 'guided' && modeAdjusted > 0) {
            rankAdjusted *= 0.85;
        } else if (debateMode === 'relentless') {
            rankAdjusted *= 1.10;
        }
    }

    if (rankOrder >= RANK_ORDER.philosopher) {
        if (debateMode === 'guided' && modeAdjusted > 0) {
            rankAdjusted *= 0.50;
        } else if (debateMode === 'balanced' && modeAdjusted > 0) {
            rankAdjusted *= 0.65;
        } else if (debateMode === 'relentless') {
            rankAdjusted *= 1.15;
        }
    }

    let delta = signedNonZero(rankAdjusted, score >= 5.5);
    delta = clamp(delta, -MAX_VALID_LOSS, MAX_VALID_GAIN);

    // At the top two ranks, Guided and Balanced can still move the account,
    // but cannot provide meaningful positive advancement compared with
    // Relentless Mode.
    if (rankOrder >= RANK_ORDER.philosopher && delta > 0) {
        if (debateMode === 'guided') delta = Math.min(delta, 2);
        if (debateMode === 'balanced') delta = Math.min(delta, 3);
    }

    return delta;
}

function forfeitLossForRank(rankKey) {
    const order = RANK_ORDER[rankKey];

    if (order <= RANK_ORDER.student) return 25;
    if (order <= RANK_ORDER.logician) return 30;
    if (order <= RANK_ORDER.sage) return 35;
    return 40;
}

function applyPositiveDelta(position, delta) {
    let index = stageIndex(position);
    let rp = position.rp + delta;

    while (rp >= 100 && index < RANK_SEQUENCE.length - 1) {
        rp -= 100;
        index += 1;
    }

    if (index === RANK_SEQUENCE.length - 1) {
        rp = Math.min(rp, 99);
    }

    return Object.freeze({
        ...RANK_SEQUENCE[index],
        rp,
    });
}

function applyNegativeDelta(position, delta) {
    let index = stageIndex(position);
    let rp = position.rp + delta;

    while (rp < 0 && index > 0) {
        index -= 1;
        rp += 100;
    }

    if (index === 0 && rp < 0) {
        rp = 0;
    }

    return Object.freeze({
        ...RANK_SEQUENCE[index],
        rp,
    });
}

function applyDelta(position, delta) {
    return delta > 0
        ? applyPositiveDelta(position, delta)
        : applyNegativeDelta(position, delta);
}

function isMajorPromotion(before, after) {
    return RANK_ORDER[after.rankKey] > RANK_ORDER[before.rankKey];
}

function isMajorDemotion(before, after) {
    return RANK_ORDER[after.rankKey] < RANK_ORDER[before.rankKey];
}

function applyPeak(beforePeak, afterPosition) {
    if (!beforePeak) return afterPosition;
    return comparePositions(afterPosition, beforePeak) > 0
        ? afterPosition
        : beforePeak;
}

function buildResult({
    before,
    requestedDelta,
    protectionBefore,
    peakBefore,
    consumeProtection,
    bypassProtection,
}) {
    const unprotectedAfter = applyDelta(before, requestedDelta);
    const wouldMajorDemote = isMajorDemotion(before, unprotectedAfter);

    let after = unprotectedAfter;
    let protectionApplied = false;
    let protectionConsumed = false;

    if (
        !bypassProtection &&
        protectionBefore === 1 &&
        wouldMajorDemote
    ) {
        after = Object.freeze({
            rankKey: before.rankKey,
            division: before.division,
            rp: 0,
        });
        protectionApplied = true;
    }

    if (!bypassProtection && protectionBefore === 1 && consumeProtection) {
        protectionConsumed = true;
    }

    const positionComparison = comparePositions(after, before);
    const promoted = positionComparison > 0;
    const demoted = positionComparison < 0;
    const majorPromotion = isMajorPromotion(before, after);
    const majorDemotion = isMajorDemotion(before, after);

    let protectionAfter = protectionBefore;
    let protectionReasonAfter = null;

    if (protectionConsumed) {
        protectionAfter = 0;
    }

    if (majorPromotion) {
        protectionAfter = 1;
        protectionReasonAfter = 'major_promotion';
    }

    const peakAfter = applyPeak(peakBefore, after);

    return Object.freeze({
        rpDelta: requestedDelta,
        before,
        after,
        promoted,
        demoted,
        majorPromotion,
        majorDemotion,
        protectionBefore,
        protectionAfter,
        protectionApplied,
        protectionConsumed,
        protectionReasonAfter,
        peakAfter,
    });
}

function normalizePeak({ peakRankKey, peakDivision, peakRP = 0 } = {}) {
    if (peakRankKey == null) return null;

    return normalizePosition({
        rankKey: peakRankKey,
        division: peakDivision,
        rp: peakRP,
    });
}

export function createRankedRatingService() {
    function calculateCompletedDebate({
        finalScoreValue,
        debateMode,
        currentRankKey,
        currentDivision,
        currentRP,
        peakRankKey = null,
        peakDivision = null,
        protectionDebatesRemaining = 0,
    }) {
        const score = requireFiniteNumber(
            finalScoreValue,
            'finalScoreValue',
            0,
            10
        );
        const mode = normalizeMode(debateMode);
        const before = normalizePosition({
            rankKey: currentRankKey,
            division: currentDivision,
            rp: currentRP,
        });
        const peakBefore = normalizePeak({
            peakRankKey,
            peakDivision,
        });
        const protectionBefore = requireInteger(
            protectionDebatesRemaining,
            'protectionDebatesRemaining',
            0,
            1
        );
        const rpDelta = performanceDelta(score, mode, before.rankKey);

        return Object.freeze({
            ...buildResult({
                before,
                requestedDelta: rpDelta,
                protectionBefore,
                peakBefore,
                consumeProtection: true,
                bypassProtection: false,
            }),
            outcome: 'completed',
            finalScoreValue: score,
            debateMode: mode,
            formulaComponents: Object.freeze({
                formula: 'ranked_rp_v1',
                scoreCenter: 5.5,
                rpPerScorePoint: 6,
                modeMultiplier: MODE_MULTIPLIERS[mode],
                validGainCap: MAX_VALID_GAIN,
                validLossCap: MAX_VALID_LOSS,
                topRankPositiveCaps: Object.freeze({
                    guided: 2,
                    balanced: 3,
                }),
            }),
        });
    }

    function previewForfeit({
        currentRankKey,
        currentDivision,
        currentRP,
    }) {
        const before = normalizePosition({
            rankKey: currentRankKey,
            division: currentDivision,
            rp: currentRP,
        });
        const loss = forfeitLossForRank(before.rankKey);

        return Object.freeze({
            rpLoss: loss,
            rpDelta: -loss,
            before,
            after: applyDelta(before, -loss),
        });
    }

    function calculateForfeit({
        currentRankKey,
        currentDivision,
        currentRP,
        peakRankKey = null,
        peakDivision = null,
        protectionDebatesRemaining = 0,
    }) {
        const preview = previewForfeit({
            currentRankKey,
            currentDivision,
            currentRP,
        });
        const peakBefore = normalizePeak({
            peakRankKey,
            peakDivision,
        });
        const protectionBefore = requireInteger(
            protectionDebatesRemaining,
            'protectionDebatesRemaining',
            0,
            1
        );

        return Object.freeze({
            ...buildResult({
                before: preview.before,
                requestedDelta: preview.rpDelta,
                protectionBefore,
                peakBefore,
                consumeProtection: false,
                bypassProtection: true,
            }),
            outcome: 'forfeited',
            finalScoreValue: 0,
            formulaComponents: Object.freeze({
                formula: 'ranked_forfeit_v1',
                lossByRankBand: Object.freeze({
                    initiateStudent: 25,
                    dialecticianLogician: 30,
                    scholarSage: 35,
                    philosopherAlchemist: 40,
                }),
                protectionBypassed: true,
                protectionConsumed: false,
            }),
        });
    }

    function calculateInvalidResponse({
        currentRankKey,
        currentDivision,
        currentRP,
        peakRankKey = null,
        peakDivision = null,
        protectionDebatesRemaining = 0,
    }) {
        const before = normalizePosition({
            rankKey: currentRankKey,
            division: currentDivision,
            rp: currentRP,
        });
        const peakBefore = normalizePeak({
            peakRankKey,
            peakDivision,
        });
        const protectionBefore = requireInteger(
            protectionDebatesRemaining,
            'protectionDebatesRemaining',
            0,
            1
        );

        return Object.freeze({
            ...buildResult({
                before,
                requestedDelta: -INVALID_RESPONSE_LOSS,
                protectionBefore,
                peakBefore,
                consumeProtection: true,
                bypassProtection: true,
            }),
            outcome: 'invalid',
            finalScoreValue: 0,
            formulaComponents: Object.freeze({
                formula: 'ranked_invalid_response_v1',
                maximumLoss: INVALID_RESPONSE_LOSS,
                protectionBypassed: true,
            }),
        });
    }

    return Object.freeze({
        calculateCompletedDebate,
        previewForfeit,
        calculateForfeit,
        calculateInvalidResponse,
        comparePositions,
    });
}

export const rankedRatingConstants = Object.freeze({
    rankSequence: RANK_SEQUENCE,
    rankOrder: RANK_ORDER,
    modeMultipliers: MODE_MULTIPLIERS,
    maximumValidGain: MAX_VALID_GAIN,
    maximumValidLoss: MAX_VALID_LOSS,
    invalidResponseLoss: INVALID_RESPONSE_LOSS,
});
