import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MIRROR_ARCHETYPE_SWITCH_LEAD,
    MIRROR_DIMENSIONS,
    MIRROR_QUESTION_IDS,
    buildMirrorExplorationTargets,
    calculateDebateAdjustments,
    finalMirrorScores,
    matchMirrorArchetypes,
    questionnaireScores,
} from '../lib/mirrorScoring.js';

test('neutral questionnaire produces 50 on all six dimensions', () => {
    const answers = MIRROR_QUESTION_IDS.map((questionId) => ({ questionId, answerValue: 3 }));
    const scores = questionnaireScores(answers);
    for (const dimension of MIRROR_DIMENSIONS) assert.equal(scores[dimension], 50);
});

test('repetition has diminishing influence and adjustment never exceeds eight points', () => {
    const signals = Array.from({ length: 20 }, (_, index) => ({
        dimension: 'autonomy_obligation',
        pole: 'autonomy',
        stanceStrength: 1,
        confidence: 1,
        contextBucket: 'authority_and_society',
        validated: true,
        occurredAt: `2026-09-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
        sourceId: String(index),
    }));
    const result = calculateDebateAdjustments(signals, []);
    assert.ok(result.autonomy_obligation.adjustment > 0);
    assert.ok(result.autonomy_obligation.adjustment <= 8);
    assert.ok(result.autonomy_obligation.effectiveWeight < 2.01);
});

test('varied contexts produce more effective evidence than repeated identical context', () => {
    const repeated = calculateDebateAdjustments([
        { dimension:'autonomy_obligation', pole:'autonomy', stanceStrength:1, confidence:1, contextBucket:'authority_and_society', validated:true, sourceId:'1' },
        { dimension:'autonomy_obligation', pole:'autonomy', stanceStrength:1, confidence:1, contextBucket:'authority_and_society', validated:true, sourceId:'2' },
    ], []);
    const varied = calculateDebateAdjustments([
        { dimension:'autonomy_obligation', pole:'autonomy', stanceStrength:1, confidence:1, contextBucket:'authority_and_society', validated:true, sourceId:'1' },
        { dimension:'autonomy_obligation', pole:'autonomy', stanceStrength:1, confidence:1, contextBucket:'family_and_relationships', validated:true, sourceId:'2' },
    ], []);
    assert.ok(varied.autonomy_obligation.adjustment > repeated.autonomy_obligation.adjustment);
    assert.equal(varied.autonomy_obligation.breadth, 2);
});

test('contradictory evidence naturally reduces the adjustment', () => {
    const result = calculateDebateAdjustments([
        { dimension:'determinism_agency', pole:'agency', stanceStrength:1, confidence:1, contextBucket:'free_will_and_responsibility', validated:true, sourceId:'1' },
        { dimension:'determinism_agency', pole:'determinism', stanceStrength:1, confidence:1, contextBucket:'circumstance_and_causation', validated:true, sourceId:'2' },
    ], []);
    assert.equal(result.determinism_agency.adjustment, 0);
    assert.equal(result.determinism_agency.consistency, 0);
});

test('revision events contribute toward revisability', () => {
    const result = calculateDebateAdjustments([], [{
        revisionStrength: 0.9,
        confidence: 0.95,
        validated: true,
        sourceId: 'r1',
    }]);
    assert.ok(result.certainty_revisability.adjustment > 0);
});

test('low-confidence signals are rejected by the math engine', () => {
    const result = calculateDebateAdjustments([
        { dimension:'autonomy_obligation', pole:'autonomy', stanceStrength:1, confidence:0.79, contextBucket:'authority_and_society', validated:true, sourceId:'1' },
    ], []);
    assert.equal(result.autonomy_obligation.adjustment, 0);
});

test('final scores clamp to 0...100', () => {
    const q = Object.fromEntries(MIRROR_DIMENSIONS.map((dimension) => [dimension, 99]));
    const adjustments = Object.fromEntries(MIRROR_DIMENSIONS.map((dimension) => [dimension, { adjustment: 8 }]));
    const final = finalMirrorScores(q, adjustments);
    for (const dimension of MIRROR_DIMENSIONS) assert.equal(final[dimension], 100);
});

test('archetype matching is deterministic', () => {
    const scores = {
        autonomy_obligation: 90,
        principles_consequences: 50,
        meaning_discovered_created: 52,
        universalism_contextualism: 50,
        determinism_agency: 55,
        certainty_revisability: 52,
    };
    const first = matchMirrorArchetypes(scores);
    const second = matchMirrorArchetypes(scores);
    assert.deepEqual(first, second);
    assert.equal(first.primary.id, 'sovereign');
});


test('recurring Mirror retains the incumbent archetype when a challenger only narrowly leads', () => {
    const scores = {
        autonomy_obligation: 79,
        principles_consequences: 25,
        meaning_discovered_created: 64,
        universalism_contextualism: 74,
        determinism_agency: 46,
        certainty_revisability: 51,
    };

    const raw = matchMirrorArchetypes(scores);
    assert.equal(raw.primary.id, 'sovereign');

    const stabilized = matchMirrorArchetypes(scores, {
        previousPrimaryArchetypeId: 'pragmatist',
    });

    assert.equal(MIRROR_ARCHETYPE_SWITCH_LEAD, 3);
    assert.equal(stabilized.primary.id, 'pragmatist');
    assert.equal(stabilized.secondary.id, 'sovereign');
    assert.equal(stabilized.blendStatus, 'blended');
    assert.equal(stabilized.stability.hysteresisApplied, true);
    assert.ok(stabilized.stability.challengerLead > 0);
    assert.ok(
        stabilized.stability.challengerLead <
        stabilized.stability.switchLeadThreshold
    );
});

test('recurring Mirror switches archetype once the challenger establishes a meaningful lead', () => {
    const scores = {
        autonomy_obligation: 85,
        principles_consequences: 40,
        meaning_discovered_created: 60,
        universalism_contextualism: 65,
        determinism_agency: 50,
        certainty_revisability: 50,
    };

    const result = matchMirrorArchetypes(scores, {
        previousPrimaryArchetypeId: 'pragmatist',
    });

    assert.equal(result.primary.id, 'sovereign');
    assert.equal(result.stability.hysteresisApplied, false);
    assert.ok(
        result.stability.challengerLead >=
        result.stability.switchLeadThreshold
    );
});

test('starting Mirror archetype selection never applies hysteresis', () => {
    const scores = {
        autonomy_obligation: 79,
        principles_consequences: 25,
        meaning_discovered_created: 64,
        universalism_contextualism: 74,
        determinism_agency: 46,
        certainty_revisability: 51,
    };

    const result = matchMirrorArchetypes(scores);

    assert.equal(result.primary.id, 'sovereign');
    assert.equal(result.stability.previousPrimaryArchetypeId, null);
    assert.equal(result.stability.hysteresisApplied, false);
});


test('exploration targets prioritize underexplored dimensions and real tensions', () => {
    const questionnaire = {
        autonomy_obligation: 78,
        principles_consequences: 70,
        meaning_discovered_created: 55,
        universalism_contextualism: 50,
        determinism_agency: 62,
        certainty_revisability: 67,
    };
    const adjustments = calculateDebateAdjustments([
        {
            dimension: 'autonomy_obligation',
            pole: 'obligation',
            stanceStrength: 1,
            confidence: 1,
            contextBucket: 'family_and_relationships',
            validated: true,
            sourceId: 'a1',
        },
        {
            dimension: 'autonomy_obligation',
            pole: 'obligation',
            stanceStrength: 0.9,
            confidence: 0.95,
            contextBucket: 'morality_and_duty',
            validated: true,
            sourceId: 'a2',
        },
        {
            dimension: 'principles_consequences',
            pole: 'principles',
            stanceStrength: 0.8,
            confidence: 0.95,
            contextBucket: 'morality_and_duty',
            validated: true,
            sourceId: 'p1',
        },
    ], []);
    const finalScores = finalMirrorScores(questionnaire, adjustments);
    const targets = buildMirrorExplorationTargets({
        questionnaireScoreMap: questionnaire,
        finalScoreMap: finalScores,
        adjustmentMap: adjustments,
        signals: [
            {
                dimension: 'autonomy_obligation',
                contextBucket: 'family_and_relationships',
            },
            {
                dimension: 'autonomy_obligation',
                contextBucket: 'morality_and_duty',
            },
            {
                dimension: 'principles_consequences',
                contextBucket: 'morality_and_duty',
            },
        ],
    });

    assert.ok(targets.length >= 2);
    assert.equal(targets[0].kind, 'underexplored_dimension');
    assert.ok(
        targets.some((target) =>
            target.kind === 'questionnaire_debate_tension' &&
            target.dimension === 'autonomy_obligation'
        )
    );
});

test('exploration targets never exceed three recommendations', () => {
    const questionnaire = Object.fromEntries(
        MIRROR_DIMENSIONS.map((dimension) => [dimension, 80])
    );
    const adjustments = calculateDebateAdjustments([], []);
    const finalScores = finalMirrorScores(questionnaire, adjustments);
    const targets = buildMirrorExplorationTargets({
        questionnaireScoreMap: questionnaire,
        finalScoreMap: finalScores,
        adjustmentMap: adjustments,
        signals: [],
    });

    assert.ok(targets.length <= 3);
    assert.equal(targets[0].kind, 'underexplored_dimension');
});
