import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MIRROR_DIMENSIONS,
    MIRROR_QUESTION_IDS,
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
