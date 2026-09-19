import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    ensureExpandedPhilosopherSystemPrompt,
    findExpandedPhilosopherPrompt,
} from '../lib/expandedPhilosopherPrompts.js';

test('backend exposes a canonical Schopenhauer debate prompt', () => {
    const prompt = findExpandedPhilosopherPrompt('schopenhauer');

    assert.equal(prompt?.id, 'schopenhauer');
    assert.equal(prompt?.name, 'Arthur Schopenhauer');
    assert.match(prompt?.systemPrompt ?? '', /The World as Will and Representation/);
    assert.match(prompt?.systemPrompt ?? '', /compassion is the basis of genuine morality/i);
    assert.match(prompt?.systemPrompt ?? '', /SCHOPENHAUER SCORING LENS:/);
    assert.match(prompt?.systemPrompt ?? '', /suicide is not the denial of the will-to-live/i);
});

test('canonical Schopenhauer prompt preserves mode and scoring instructions from the client', () => {
    const clientPrompt = [
        'DEBATE MODE: Balanced',
        'Score Timing:',
        'Beginning with the user\'s 2nd visible debate response, every philosopher reply must include a score.',
    ].join('\n\n');

    const effective = ensureExpandedPhilosopherSystemPrompt({
        philosopherId: 'schopenhauer',
        systemPrompt: clientPrompt,
    });

    assert.match(effective, /^You are Arthur Schopenhauer\./);
    assert.match(effective, /SCHOPENHAUER SCORING LENS:/);
    assert.match(effective, /DEBATE MODE: Balanced/);
    assert.match(effective, /Beginning with the user's 2nd visible debate response/);
});

test('a complete Schopenhauer client prompt is not duplicated', () => {
    const complete = [
        'UNIVERSAL RULES FOR ALL PHILOSOPHERS:',
        'You are Arthur Schopenhauer.',
        'SCHOPENHAUER SCORING LENS:',
        'DEBATE MODE: Relentless',
    ].join('\n\n');

    assert.equal(
        ensureExpandedPhilosopherSystemPrompt({
            philosopherId: 'schopenhauer',
            systemPrompt: complete,
        }),
        complete
    );
});

test('unknown philosophers remain untouched by the fallback', () => {
    const prompt = 'Existing philosopher prompt';

    assert.equal(
        ensureExpandedPhilosopherSystemPrompt({
            philosopherId: 'socrates',
            systemPrompt: prompt,
        }),
        prompt
    );
});

test('AI jobs apply the Expanded Agora canonical prompt before persisting payload', () => {
    const source = fs.readFileSync(
        new URL('../aiJobs.js', import.meta.url),
        'utf8'
    );

    assert.match(
        source,
        /ensureExpandedPhilosopherSystemPrompt\(\{[\s\S]*philosopherId: safeMetadata\.philosopherId[\s\S]*systemPrompt: cleanSystemPrompt/
    );
    assert.match(
        source,
        /systemPrompt: effectiveSystemPrompt/
    );
    assert.match(
        source,
        /canonicalExpandedPromptApplied/
    );
});
