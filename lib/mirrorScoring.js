export const MIRROR_QUESTIONNAIRE_VERSION = 'mirror-questionnaire-v1';
export const MIRROR_ARCHETYPE_VERSION = 'mirror-archetypes-v2';
export const MIRROR_EVIDENCE_ENGINE_VERSION = 'mirror-evidence-engine-v1';
export const MIRROR_EXTRACTOR_VERSION = 'mirror-debate-evidence-v1';
export const MIRROR_ANALYSIS_PROMPT_VERSION = 'mirror-analysis-v7';
export const MIRROR_ARCHETYPE_SWITCH_LEAD = 3;

export const MIRROR_RECOMMENDATION_PHILOSOPHERS = Object.freeze({
    autonomy_obligation: Object.freeze([
        'Marcus Aurelius',
        'Nietzsche',
        'Aristotle',
        'Socrates',
    ]),
    principles_consequences: Object.freeze([
        'Aristotle',
        'Socrates',
        'Marcus Aurelius',
        'Plato',
    ]),
    meaning_discovered_created: Object.freeze([
        'Albert Camus',
        'Nietzsche',
        'Søren Kierkegaard',
        'Plato',
    ]),
    universalism_contextualism: Object.freeze([
        'Plato',
        'Aristotle',
        'Nietzsche',
        'Socrates',
    ]),
    determinism_agency: Object.freeze([
        'Arthur Schopenhauer',
        'Søren Kierkegaard',
        'Nietzsche',
        'Fyodor Dostoevsky',
    ]),
    certainty_revisability: Object.freeze([
        'Socrates',
        'Søren Kierkegaard',
        'Plato',
        'Carl Jung',
    ]),
});

export const MIRROR_DIMENSIONS = Object.freeze([
    'autonomy_obligation',
    'principles_consequences',
    'meaning_discovered_created',
    'universalism_contextualism',
    'determinism_agency',
    'certainty_revisability',
]);

export const MIRROR_POLES = Object.freeze({
    autonomy_obligation: Object.freeze({ left: 'obligation', right: 'autonomy' }),
    principles_consequences: Object.freeze({ left: 'consequences', right: 'principles' }),
    meaning_discovered_created: Object.freeze({ left: 'discovered_meaning', right: 'created_meaning' }),
    universalism_contextualism: Object.freeze({ left: 'universalism', right: 'contextualism' }),
    determinism_agency: Object.freeze({ left: 'determinism', right: 'agency' }),
    certainty_revisability: Object.freeze({ left: 'certainty', right: 'revisability' }),
});

export const MIRROR_CONTEXT_BUCKETS = Object.freeze([
    'family_and_relationships',
    'authority_and_society',
    'morality_and_duty',
    'consequences_and_harm',
    'justice_and_fairness',
    'meaning_and_purpose',
    'religion_and_transcendence',
    'free_will_and_responsibility',
    'circumstance_and_causation',
    'truth_and_knowledge',
    'certainty_and_doubt',
    'culture_and_context',
    'identity_and_self',
    'suffering_and_absurdity',
    'work_and_ambition',
    'other',
]);

const QUESTION_ROWS = [
    ['autonomy_1', 'autonomy_obligation', 1],
    ['moral_1', 'principles_consequences', 1],
    ['meaning_1', 'meaning_discovered_created', 1],
    ['context_1', 'universalism_contextualism', -1],
    ['freedom_1', 'determinism_agency', 1],
    ['certainty_1', 'certainty_revisability', 1],
    ['autonomy_2', 'autonomy_obligation', -1],
    ['moral_2', 'principles_consequences', -1],
    ['meaning_2', 'meaning_discovered_created', -1],
    ['context_2', 'universalism_contextualism', 1],
    ['freedom_2', 'determinism_agency', -1],
    ['certainty_2', 'certainty_revisability', -1],
    ['autonomy_3', 'autonomy_obligation', 1],
    ['moral_3', 'principles_consequences', 1],
    ['meaning_3', 'meaning_discovered_created', 1],
    ['context_3', 'universalism_contextualism', -1],
    ['freedom_3', 'determinism_agency', 1],
    ['certainty_3', 'certainty_revisability', 1],
    ['autonomy_4', 'autonomy_obligation', -1],
    ['moral_4', 'principles_consequences', -1],
    ['meaning_4', 'meaning_discovered_created', -1],
    ['context_4', 'universalism_contextualism', 1],
    ['freedom_4', 'determinism_agency', -1],
    ['certainty_4', 'certainty_revisability', -1],
    ['autonomy_5', 'autonomy_obligation', -1],
    ['moral_5', 'principles_consequences', 1],
    ['meaning_5', 'meaning_discovered_created', 1],
    ['context_5', 'universalism_contextualism', -1],
    ['freedom_5', 'determinism_agency', 1],
    ['certainty_5', 'certainty_revisability', 1],
    ['autonomy_6', 'autonomy_obligation', 1],
    ['moral_6', 'principles_consequences', -1],
    ['meaning_6', 'meaning_discovered_created', -1],
    ['context_6', 'universalism_contextualism', 1],
    ['freedom_6', 'determinism_agency', -1],
    ['certainty_6', 'certainty_revisability', -1],
];

export const MIRROR_QUESTION_TEXT = Object.freeze({
    "autonomy_1": "Competent adults should be free to make choices others consider unwise, provided they are not violating another person's rights.",
    "moral_1": "Some actions remain wrong even if doing them would produce the best overall outcome.",
    "meaning_1": "Life does not come with a built-in purpose; people create meaning through the commitments they choose.",
    "context_1": "At least some moral truths should apply to everyone, regardless of culture or circumstance.",
    "freedom_1": "People can be genuine authors of their choices even though biology and circumstance influence them.",
    "certainty_1": "Even my deepest beliefs should remain open to revision if the reasons against them become strong enough.",
    "autonomy_2": "Family obligations can legitimately require sacrifices a person would not freely choose for themselves.",
    "moral_2": "If breaking a moral rule clearly prevents much greater harm, breaking it can be the right thing to do.",
    "meaning_2": "A meaningful life depends on aligning yourself with a purpose or value that exists independently of your personal choices.",
    "context_2": "Whether an action is right can depend substantially on the relationships and circumstances surrounding it.",
    "freedom_2": "Given exactly the same past and conditions, a person could not truly choose differently than they did.",
    "certainty_2": "Some beliefs can become settled enough that reopening them without new evidence is unnecessary.",
    "autonomy_3": "A person may reject a community's expectations even when doing so seriously disappoints people who value that tradition.",
    "moral_3": "A person's rights should not be violated solely because doing so would benefit a greater number of people.",
    "meaning_3": "A life can be deeply meaningful even if the universe itself has no purpose.",
    "context_3": "If two cultures have opposite moral rules, it is still possible that one of them is mistaken about what is right.",
    "freedom_3": "A difficult upbringing can explain a person's choice without completely removing their responsibility for it.",
    "certainty_3": "Thoughtful disagreement is a reason to examine my own view again, even when I remain confident in it.",
    "autonomy_4": "Belonging to a community creates duties that can sometimes outweigh personal preference.",
    "moral_4": "When a moral rule and the welfare of everyone affected clearly conflict, the better outcome should usually take priority.",
    "meaning_4": "If meaning were entirely something we invented for ourselves, something important about real meaning would be missing.",
    "context_4": "The same outward action can be morally reasonable in one situation and unreasonable in another.",
    "freedom_4": "Much of what feels like free choice is the result of causes operating before we become aware of deciding.",
    "certainty_4": "At some point, continued doubt can become less rational than standing firmly behind a well-justified belief.",
    "autonomy_5": "Promises and commitments should constrain our freedom even when keeping them becomes personally costly.",
    "moral_5": "A moral principle matters most when we are willing to follow it even when doing so is costly.",
    "meaning_5": "Choosing to devote yourself to something can make it meaningful even if no objective purpose singles it out.",
    "context_5": "Some things would remain morally wrong even if an entire society sincerely approved of them.",
    "freedom_5": "Deliberation can genuinely change which action a person takes rather than merely reveal what prior causes already determined.",
    "certainty_5": "Changing my mind because an argument exposes a weakness is a sign of stronger reasoning, not weaker conviction.",
    "autonomy_6": "A life chosen for oneself is usually more legitimate than one accepted mainly because other people expect it.",
    "moral_6": "The rightness of a decision should depend mainly on what actually happens because of it, not on whether it followed a rule.",
    "meaning_6": "Our deepest purposes are better understood as something we discover about what is worth living for than something we invent.",
    "context_6": "The same obligation can reasonably carry different weight depending on a person's role or relationship to those involved.",
    "freedom_6": "If we understood every relevant cause behind a decision, there would be no need to treat the choice as something independently authored.",
    "certainty_6": "A worldview needs some convictions that function as stable foundations rather than questions kept permanently open."
});

export const MIRROR_QUESTIONS = Object.freeze(
    QUESTION_ROWS.map(([id, dimension, keying]) => Object.freeze({ id, dimension, keying, text: MIRROR_QUESTION_TEXT[id] }))
);

export const MIRROR_QUESTION_IDS = Object.freeze(MIRROR_QUESTIONS.map((q) => q.id));

const ARCHETYPES = [
    ['sovereign', 'The Sovereign', 'autonomy_obligation', [88, 51, 53, 52, 55, 52]],
    ['steward', 'The Steward', 'autonomy_obligation', [16, 53, 48, 48, 51, 48]],
    ['guardian', 'The Guardian', 'principles_consequences', [48, 92, 48, 46, 52, 47]],
    ['pragmatist', 'The Pragmatist', 'principles_consequences', [51, 12, 52, 55, 52, 55]],
    ['author', 'The Author', 'meaning_discovered_created', [54, 50, 94, 53, 55, 53]],
    ['seeker', 'The Seeker', 'meaning_discovered_created', [49, 51, 6, 47, 51, 51]],
    ['compass', 'The Compass', 'universalism_contextualism', [49, 54, 47, 5, 52, 48]],
    ['interpreter', 'The Interpreter', 'universalism_contextualism', [51, 47, 52, 95, 52, 55]],
    ['shaper', 'The Shaper', 'determinism_agency', [53, 50, 53, 52, 95, 53]],
    ['causalist', 'The Causalist', 'determinism_agency', [49, 50, 49, 51, 5, 53]],
    ['examiner', 'The Examiner', 'certainty_revisability', [51, 49, 52, 53, 52, 96]],
    ['anchor', 'The Anchor', 'certainty_revisability', [48, 54, 47, 46, 51, 5]],
];

export const MIRROR_ARCHETYPES = Object.freeze(
    ARCHETYPES.map(([id, name, anchor, values]) => {
        const prototype = {};
        MIRROR_DIMENSIONS.forEach((dimension, index) => {
            prototype[dimension] = values[index];
        });
        return Object.freeze({ id, name, anchor, prototype: Object.freeze(prototype) });
    })
);

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function round(value, places = 3) {
    const multiplier = 10 ** places;
    return Math.round(value * multiplier) / multiplier;
}

export function validateQuestionnaireAnswers(answerEntries) {
    const map = new Map();

    for (const entry of answerEntries || []) {
        const questionId = String(entry?.questionId || '').trim();
        const answerValue = Number(entry?.answerValue);

        if (!MIRROR_QUESTION_IDS.includes(questionId)) {
            throw new Error(`Unknown Mirror question: ${questionId || '(empty)'}`);
        }
        if (!Number.isInteger(answerValue) || answerValue < 1 || answerValue > 5) {
            throw new Error(`Invalid answer for ${questionId}.`);
        }
        map.set(questionId, answerValue);
    }

    return map;
}

export function questionnaireScores(answerEntries, { requireComplete = true } = {}) {
    const answers = validateQuestionnaireAnswers(answerEntries);

    if (requireComplete && answers.size !== MIRROR_QUESTIONS.length) {
        throw new Error(`Mirror questionnaire requires exactly ${MIRROR_QUESTIONS.length} answers.`);
    }

    const results = {};

    for (const dimension of MIRROR_DIMENSIONS) {
        const questions = MIRROR_QUESTIONS.filter((q) => q.dimension === dimension);
        let actual = 0;
        let answered = 0;

        for (const question of questions) {
            if (!answers.has(question.id)) continue;
            const directional = answers.get(question.id) - 3;
            actual += directional * question.keying;
            answered += 1;
        }

        if (answered === 0) {
            results[dimension] = 50;
            continue;
        }

        const maximumMagnitude = answered * 2;
        results[dimension] = round(
            ((actual + maximumMagnitude) / (maximumMagnitude * 2)) * 100,
            3
        );
    }

    return Object.freeze(results);
}

export function poleDirection(dimension, pole) {
    const poles = MIRROR_POLES[dimension];
    if (!poles) return null;
    if (pole === poles.right) return 1;
    if (pole === poles.left) return -1;
    return null;
}

function normalizedSignal(signal) {
    const dimension = String(signal.dimension || '');
    const pole = String(signal.pole || '');
    const direction = poleDirection(dimension, pole);
    if (direction == null) return null;

    const stanceStrength = Number(signal.stanceStrength ?? signal.stance_strength);
    const confidence = Number(signal.confidence);
    const contextBucket = String(signal.contextBucket ?? signal.context_bucket ?? 'other');

    if (!Number.isFinite(stanceStrength) || stanceStrength < 0 || stanceStrength > 1) return null;
    if (!Number.isFinite(confidence) || confidence < 0.8 || confidence > 1) return null;
    if (!MIRROR_CONTEXT_BUCKETS.includes(contextBucket)) return null;
    if (signal.excludedByUser === true || signal.excluded_by_user === true) return null;
    if (signal.validated === false) return null;

    return {
        dimension,
        pole,
        direction,
        stanceStrength,
        confidence,
        contextBucket,
        occurredAt: signal.occurredAt ?? signal.debate_completed_at ?? signal.createdAt ?? null,
        sourceId: signal.sourceId ?? signal.evidence_id ?? signal.id ?? '',
    };
}

function normalizedRevision(revision) {
    if (!revision) return null;
    if (revision.excludedByUser === true || revision.excluded_by_user === true) return null;
    if (revision.validated === false) return null;

    const confidence = Number(revision.confidence);
    const strength = Number(revision.revisionStrength ?? revision.revision_strength);
    if (!Number.isFinite(confidence) || confidence < 0.8 || confidence > 1) return null;
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) return null;

    return {
        dimension: 'certainty_revisability',
        pole: 'revisability',
        direction: 1,
        stanceStrength: strength,
        confidence,
        contextBucket: 'belief_revision',
        occurredAt: revision.occurredAt ?? revision.debate_completed_at ?? revision.createdAt ?? null,
        sourceId: revision.sourceId ?? revision.evidence_id ?? revision.id ?? '',
    };
}

function stableSignalSort(left, right) {
    const leftTime = left.occurredAt ? new Date(left.occurredAt).getTime() : 0;
    const rightTime = right.occurredAt ? new Date(right.occurredAt).getTime() : 0;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return String(left.sourceId).localeCompare(String(right.sourceId));
}

export function calculateDebateAdjustments(signals = [], revisions = []) {
    const normalized = signals.map(normalizedSignal).filter(Boolean);
    for (const revision of revisions) {
        const converted = normalizedRevision(revision);
        if (converted) normalized.push(converted);
    }
    normalized.sort(stableSignalSort);

    const results = {};

    for (const dimension of MIRROR_DIMENSIONS) {
        const dimensionSignals = normalized.filter((signal) => signal.dimension === dimension);
        const repetitionCounts = new Map();
        const contexts = new Set();
        let signedWeight = 0;
        let totalWeight = 0;

        for (const signal of dimensionSignals) {
            const repetitionKey = `${signal.dimension}|${signal.direction}|${signal.contextBucket}`;
            const repetitionIndex = repetitionCounts.get(repetitionKey) || 0;
            repetitionCounts.set(repetitionKey, repetitionIndex + 1);

            const repetitionDiscount = 0.5 ** repetitionIndex;
            const weight = signal.stanceStrength * signal.confidence * repetitionDiscount;
            if (weight <= 0) continue;

            signedWeight += signal.direction * weight;
            totalWeight += weight;
            contexts.add(signal.contextBucket);
        }

        if (totalWeight <= 0) {
            results[dimension] = Object.freeze({
                adjustment: 0,
                direction: 0,
                evidenceStrength: 0,
                consistency: 0,
                breadth: 0,
                effectiveWeight: 0,
                acceptedSignalCount: dimensionSignals.length,
            });
            continue;
        }

        const evidenceDirection = clamp(signedWeight / totalWeight, -1, 1);
        const evidenceStrength = 1 - Math.exp(-totalWeight / 3);
        const adjustment = clamp(8 * evidenceDirection * evidenceStrength, -8, 8);

        results[dimension] = Object.freeze({
            adjustment: round(adjustment, 3),
            direction: round(evidenceDirection, 5),
            evidenceStrength: round(evidenceStrength, 5),
            consistency: round(Math.abs(evidenceDirection), 5),
            breadth: contexts.size,
            effectiveWeight: round(totalWeight, 5),
            acceptedSignalCount: dimensionSignals.length,
        });
    }

    return Object.freeze(results);
}

export function finalMirrorScores(questionnaireScoreMap, adjustmentMap) {
    const result = {};
    for (const dimension of MIRROR_DIMENSIONS) {
        const questionnaire = Number(questionnaireScoreMap?.[dimension] ?? 50);
        const adjustment = Number(adjustmentMap?.[dimension]?.adjustment ?? 0);
        result[dimension] = round(clamp(questionnaire + adjustment, 0, 100), 3);
    }
    return Object.freeze(result);
}

function archetypeFit(scoreMap, archetype) {
    let dot = 0;
    let userMagnitude = 0;
    let prototypeMagnitude = 0;

    for (const dimension of MIRROR_DIMENSIONS) {
        const user = Number(scoreMap?.[dimension] ?? 50) - 50;
        const prototype = Number(archetype.prototype[dimension] ?? 50) - 50;
        const weight = dimension === archetype.anchor ? 1.30 : 1.0;

        dot += user * prototype * weight;
        userMagnitude += user * user * weight;
        prototypeMagnitude += prototype * prototype * weight;
    }

    if (userMagnitude <= 0.0001 || prototypeMagnitude <= 0.0001) return 50;

    const cosine = clamp(dot / (Math.sqrt(userMagnitude) * Math.sqrt(prototypeMagnitude)), -1, 1);
    const directionalFit = ((cosine + 1) / 2) * 100;
    const strengthDenominator = Math.sqrt(MIRROR_DIMENSIONS.length) * 30;
    const strength = Math.min(1, Math.sqrt(userMagnitude) / strengthDenominator);
    return clamp(directionalFit * (0.75 + (0.25 * strength)), 0, 100);
}

export function matchMirrorArchetypes(
    scoreMap,
    {
        previousPrimaryArchetypeId = null,
        switchLeadThreshold = MIRROR_ARCHETYPE_SWITCH_LEAD,
    } = {}
) {
    const ranked = MIRROR_ARCHETYPES
        .map((archetype) => ({ archetype, fit: archetypeFit(scoreMap, archetype) }))
        .sort((left, right) => {
            if (Math.abs(left.fit - right.fit) < 1e-9) {
                return left.archetype.name.localeCompare(right.archetype.name);
            }
            return right.fit - left.fit;
        });

    const rawPrimary = ranked[0];
    const rawSecondary = ranked[1] || rawPrimary;

    let primary = rawPrimary;
    let secondary = rawSecondary;
    let hysteresisApplied = false;
    let incumbent = null;
    let challengerLead = null;

    const normalizedThreshold = Math.max(
        0,
        Number.isFinite(Number(switchLeadThreshold))
            ? Number(switchLeadThreshold)
            : MIRROR_ARCHETYPE_SWITCH_LEAD
    );

    if (previousPrimaryArchetypeId) {
        incumbent = ranked.find(
            (entry) => entry.archetype.id === previousPrimaryArchetypeId
        ) || null;
    }

    if (incumbent && incumbent.archetype.id !== rawPrimary.archetype.id) {
        challengerLead = rawPrimary.fit - incumbent.fit;

        if (challengerLead < normalizedThreshold) {
            primary = incumbent;
            secondary = rawPrimary;
            hysteresisApplied = true;
        }
    }

    if (!hysteresisApplied) {
        secondary =
            ranked.find((entry) => entry.archetype.id !== primary.archetype.id)
            || primary;
    }

    const selectedSeparation = Math.abs(primary.fit - secondary.fit);
    const isBlended =
        hysteresisApplied ||
        selectedSeparation < 3 ||
        primary.fit < 70;
    const blendStatus = isBlended
        ? 'blended'
        : (primary.fit >= 86 && selectedSeparation >= 8 ? 'strong' : 'closest');

    return Object.freeze({
        primary: Object.freeze({
            id: primary.archetype.id,
            name: primary.archetype.name,
            fit: round(primary.fit, 4),
        }),
        secondary: Object.freeze({
            id: secondary.archetype.id,
            name: secondary.archetype.name,
            fit: round(secondary.fit, 4),
        }),
        separation: round(selectedSeparation, 4),
        blendStatus,
        isBlended,
        stability: Object.freeze({
            previousPrimaryArchetypeId: previousPrimaryArchetypeId || null,
            rawPrimaryArchetypeId: rawPrimary.archetype.id,
            rawPrimaryFit: round(rawPrimary.fit, 4),
            rawSecondaryArchetypeId: rawSecondary.archetype.id,
            rawSecondaryFit: round(rawSecondary.fit, 4),
            incumbentFit: incumbent ? round(incumbent.fit, 4) : null,
            challengerLead:
                challengerLead == null ? null : round(challengerLead, 4),
            switchLeadThreshold: round(normalizedThreshold, 4),
            hysteresisApplied,
        }),
    });
}

export function evidenceBreadthSummary(adjustmentMap) {
    const explored = MIRROR_DIMENSIONS.filter((dimension) => {
        const item = adjustmentMap?.[dimension];
        return Number(item?.acceptedSignalCount || 0) > 0;
    });
    return Object.freeze({
        exploredDimensions: explored,
        exploredCount: explored.length,
        totalDimensions: MIRROR_DIMENSIONS.length,
    });
}

export function meaningfulChangeBand(delta) {
    const magnitude = Math.abs(Number(delta) || 0);
    if (magnitude >= 8) return 'meaningful_shift';
    if (magnitude >= 4) return 'noticeable_movement';
    return 'stable';
}


export function buildMirrorExplorationTargets({
    questionnaireScoreMap = {},
    finalScoreMap = {},
    adjustmentMap = {},
    signals = [],
    cycleNumber = 2,
} = {}) {
    const targets = [];

    const stats = MIRROR_DIMENSIONS.map((dimension) => {
        const adjustment = adjustmentMap?.[dimension] || {};
        const finalScore = Number(finalScoreMap?.[dimension] ?? 50);
        const questionnaireScore = Number(questionnaireScoreMap?.[dimension] ?? 50);
        const debateDirection = Number(adjustment.direction || 0);
        const evidenceStrength = Number(adjustment.evidenceStrength || 0);
        const breadth = Number(adjustment.breadth || 0);
        const count = Number(adjustment.acceptedSignalCount || 0);
        return {
            dimension,
            finalScore,
            questionnaireScore,
            debateDirection,
            evidenceStrength,
            breadth,
            count,
            distanceFromCenter: Math.abs(finalScore - 50),
        };
    });

    const underexplored = [...stats].sort((left, right) => {
        if (left.count !== right.count) return left.count - right.count;
        if (left.breadth !== right.breadth) return left.breadth - right.breadth;
        if (left.evidenceStrength !== right.evidenceStrength) {
            return left.evidenceStrength - right.evidenceStrength;
        }
        return left.dimension.localeCompare(right.dimension);
    })[0];

    if (underexplored) {
        targets.push(Object.freeze({
            id: 'underexplored',
            kind: 'underexplored_dimension',
            dimension: underexplored.dimension,
            reasonCode: underexplored.count === 0
                ? 'no_debate_evidence'
                : 'limited_debate_breadth',
            currentScore: round(underexplored.finalScore, 3),
            acceptedSignalCount: underexplored.count,
            evidenceBreadth: underexplored.breadth,
        }));
    }

    const tensionCandidates = stats
        .map((item) => {
            const questionnaireDirection =
                Math.abs(item.questionnaireScore - 50) < 6
                    ? 0
                    : Math.sign(item.questionnaireScore - 50);
            const debateDirection =
                Math.abs(item.debateDirection) < 0.25
                    ? 0
                    : Math.sign(item.debateDirection);
            const isOpposed =
                questionnaireDirection !== 0 &&
                debateDirection !== 0 &&
                questionnaireDirection !== debateDirection;
            const strength =
                Math.abs(item.questionnaireScore - 50) *
                Math.abs(item.debateDirection) *
                Math.max(item.evidenceStrength, 0.01);
            return { ...item, isOpposed, strength };
        })
        .filter((item) => item.isOpposed)
        .sort((left, right) => {
            if (left.strength !== right.strength) return right.strength - left.strength;
            return left.dimension.localeCompare(right.dimension);
        });

    const tension = tensionCandidates[0];

    if (tension) {
        targets.push(Object.freeze({
            id: 'tension',
            kind: 'questionnaire_debate_tension',
            dimension: tension.dimension,
            reasonCode: 'questionnaire_and_debates_point_differently',
            questionnaireScore: round(tension.questionnaireScore, 3),
            currentScore: round(tension.finalScore, 3),
            debateDirection: round(tension.debateDirection, 5),
            evidenceStrength: round(tension.evidenceStrength, 5),
        }));
    }

    const concentrated = [...stats]
        .filter((item) => item.count >= 2 && item.breadth <= 1)
        .sort((left, right) => {
            if (left.count !== right.count) return right.count - left.count;
            if (left.distanceFromCenter !== right.distanceFromCenter) {
                return right.distanceFromCenter - left.distanceFromCenter;
            }
            return left.dimension.localeCompare(right.dimension);
        })[0];

    if (concentrated && targets.length < 3) {
        const usedContexts = Array.from(new Set(
            (signals || [])
                .filter((signal) => signal.dimension === concentrated.dimension)
                .map((signal) => signal.contextBucket)
                .filter(Boolean)
        ));

        targets.push(Object.freeze({
            id: 'breadth',
            kind: 'context_breadth',
            dimension: concentrated.dimension,
            reasonCode: 'evidence_concentrated_in_one_context',
            currentScore: round(concentrated.finalScore, 3),
            acceptedSignalCount: concentrated.count,
            evidenceBreadth: concentrated.breadth,
            usedContexts,
        }));
    }

    if (targets.length < 3) {
        const alreadyUsed = new Set(targets.map((target) => target.dimension));
        const challenge = [...stats]
            .filter((item) => !alreadyUsed.has(item.dimension))
            .sort((left, right) => {
                if (left.distanceFromCenter !== right.distanceFromCenter) {
                    return right.distanceFromCenter - left.distanceFromCenter;
                }
                return left.dimension.localeCompare(right.dimension);
            })[0];

        if (challenge) {
            const poles = MIRROR_POLES[challenge.dimension];
            const currentPole =
                challenge.finalScore >= 50 ? poles.right : poles.left;
            const oppositePole =
                challenge.finalScore >= 50 ? poles.left : poles.right;

            targets.push(Object.freeze({
                id: 'challenge',
                kind: 'opposite_pole_challenge',
                dimension: challenge.dimension,
                reasonCode: 'pressure_test_strong_orientation',
                currentScore: round(challenge.finalScore, 3),
                currentPole,
                targetPole: oppositePole,
            }));
        }
    }

    const selectedTargets = targets.slice(0, 3);
    const usedPhilosophers = new Set();
    const cycleOffset = Math.max(0, Number(cycleNumber || 2) - 2);

    const withPhilosophers = selectedTargets.map((target, targetIndex) => {
        const candidates =
            MIRROR_RECOMMENDATION_PHILOSOPHERS[target.dimension] ||
            MIRROR_RECOMMENDATION_PHILOSOPHERS.certainty_revisability;

        let suggestedPhilosopher = null;

        for (let offset = 0; offset < candidates.length; offset += 1) {
            const index =
                (cycleOffset + targetIndex + offset) %
                candidates.length;
            const candidate = candidates[index];

            if (!usedPhilosophers.has(candidate)) {
                suggestedPhilosopher = candidate;
                usedPhilosophers.add(candidate);
                break;
            }
        }

        if (!suggestedPhilosopher) {
            suggestedPhilosopher =
                candidates[
                    (cycleOffset + targetIndex) %
                    candidates.length
                ];
        }

        return Object.freeze({
            ...target,
            suggestedPhilosopher,
        });
    });

    return Object.freeze(withPhilosophers);
}
