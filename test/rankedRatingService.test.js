import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createRankedRatingService,
} from '../lib/rankedRatingService.js';

const service = createRankedRatingService();

test('placement protection prevents a division demotion at 0 RP', () => {
    const result = service.calculateCompletedDebate({
        finalScoreValue: 4,
        debateMode: 'guided',
        currentRankKey: 'student',
        currentDivision: 2,
        currentRP: 0,
        peakRankKey: 'student',
        peakDivision: 2,
        protectionDebatesRemaining: 1,
    });

    assert.equal(result.rpDelta, -8);
    assert.deepEqual(result.before, {
        rankKey: 'student',
        division: 2,
        rp: 0,
    });
    assert.deepEqual(result.after, {
        rankKey: 'student',
        division: 2,
        rp: 0,
    });
    assert.equal(result.demoted, false);
    assert.equal(result.majorDemotion, false);
    assert.equal(result.protectionApplied, true);
    assert.equal(result.protectionConsumed, true);
    assert.equal(result.protectionAfter, 0);
    assert.equal(
        result.formulaComponents.protectionPolicy,
        'one_completed_debate_all_divisions_v2'
    );
});

test('protected debate still loses RP inside the current division', () => {
    const result = service.calculateCompletedDebate({
        finalScoreValue: 4,
        debateMode: 'guided',
        currentRankKey: 'student',
        currentDivision: 2,
        currentRP: 40,
        peakRankKey: 'student',
        peakDivision: 2,
        protectionDebatesRemaining: 1,
    });

    assert.equal(result.rpDelta, -8);
    assert.deepEqual(result.after, {
        rankKey: 'student',
        division: 2,
        rp: 32,
    });
    assert.equal(result.protectionApplied, false);
    assert.equal(result.protectionConsumed, true);
    assert.equal(result.protectionAfter, 0);
});

test('protected debate stops at 0 RP when a loss crosses a division', () => {
    const result = service.calculateCompletedDebate({
        finalScoreValue: 0,
        debateMode: 'relentless',
        currentRankKey: 'student',
        currentDivision: 2,
        currentRP: 10,
        peakRankKey: 'student',
        peakDivision: 2,
        protectionDebatesRemaining: 1,
    });

    assert.equal(result.rpDelta < 0, true);
    assert.deepEqual(result.after, {
        rankKey: 'student',
        division: 2,
        rp: 0,
    });
    assert.equal(result.demoted, false);
    assert.equal(result.protectionApplied, true);
    assert.equal(result.protectionConsumed, true);
});

test('deliberate forfeit bypasses protection', () => {
    const result = service.calculateForfeit({
        currentRankKey: 'student',
        currentDivision: 2,
        currentRP: 0,
        peakRankKey: 'student',
        peakDivision: 2,
        protectionDebatesRemaining: 1,
    });

    assert.equal(result.rpDelta, -25);
    assert.deepEqual(result.after, {
        rankKey: 'student',
        division: 3,
        rp: 75,
    });
    assert.equal(result.demoted, true);
    assert.equal(result.protectionApplied, false);
    assert.equal(result.protectionConsumed, false);
    assert.equal(result.protectionAfter, 1);
});
