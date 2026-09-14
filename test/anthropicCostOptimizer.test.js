import test from 'node:test';
import assert from 'node:assert/strict';

import {
  optimizeAnthropicPayloadForStack,
  anthropicCostOptimizerInternals,
} from '../lib/anthropicCostOptimizer.js';

function systemText(system) {
  if (typeof system === 'string') return system;
  return (system || []).map((block) => block?.text || '').join('');
}

function summaryPayload(transcript) {
  return {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: 'Summarize only debate content.',
    messages: [{
      role: 'user',
      content: `Summarize this philosophical debate exchange in under 200 words.\nPreserve the core arguments, positions taken, key philosophical concepts,\nand any important points of agreement or disagreement. This will be used\nto maintain debate continuity:\n\n${JSON.stringify(transcript)}`,
    }],
  };
}

function transcript(count, prefix = 'A') {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix}-${index}`,
  }));
}

test('conversation replies use automatic caching without changing model or output limit', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 900,
    temperature: 0.7,
    system: 'Stable philosopher instructions.\n\nSCORE TIMING:\nThe user has now sent 4 visible debate responses.\nInclude a score.',
    messages: [
      { role: 'user', content: 'First claim' },
      { role: 'assistant', content: 'First reply' },
      { role: 'user', content: 'Second claim' },
    ],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at callClaudeForJob (file:///app/aiJobs.js:100:1)'
  );

  assert.deepEqual(optimized.cache_control, { type: 'ephemeral' });
  assert.ok(Array.isArray(optimized.system));
  assert.deepEqual(optimized.system[0].cache_control, { type: 'ephemeral' });
  assert.match(systemText(optimized.system), /at least 2 visible debate responses/i);
  assert.deepEqual(optimized.messages, payload.messages);
  assert.equal(optimized.model, payload.model);
  assert.equal(optimized.max_tokens, payload.max_tokens);
});

test('openings avoid top-level automatic cache writes while stable system prefix can be cached', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 240,
    temperature: 0.7,
    system: 'Stable philosopher instructions.\n\nSCORE TIMING:\nThis is the opening statement. Do not score.',
    messages: [{ role: 'user', content: 'Official topic context.' }],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at callClaudeForJob (file:///app/aiJobs.js:100:1)'
  );

  assert.equal(optimized.cache_control, undefined);
  assert.ok(Array.isArray(optimized.system));
  assert.deepEqual(optimized.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(optimized.model, payload.model);
  assert.equal(optimized.max_tokens, payload.max_tokens);
});

test('one-off AI reports are not prompt cached', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2200,
    temperature: 0.25,
    system: 'Generate a debate report.',
    messages: [{ role: 'user', content: 'Transcript' }],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at callClaudeForJob (file:///app/aiJobs.js:100:1)'
  );

  assert.strictEqual(optimized, payload);
  assert.equal(optimized.cache_control, undefined);
});

test('ranked opening caches stable system prefix but does not automatically cache the opening transcript', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 240,
    temperature: 0.65,
    system: [
      'Stable Ranked authority and philosopher instructions.',
      '',
      'SCORE TIMING:',
      'This is the philosopher opening statement.',
      '',
      'SERVER PROMPT VERSIONS:',
      'Ranked rules: ranked-v3',
    ].join('\n'),
    messages: [{ role: 'user', content: 'Official Ranked debate context.' }],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at generateValidated (file:///app/lib/rankedDebateEngineCoreService.js:2100:1)'
  );

  assert.equal(optimized.cache_control, undefined);
  assert.ok(Array.isArray(optimized.system));
  assert.deepEqual(optimized.system[0].cache_control, { type: 'ephemeral' });
});

test('ranked replies cache stable prefix and growing transcript', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 280,
    temperature: 0.55,
    system: [
      'Stable Ranked authority and philosopher instructions.',
      '',
      'SCORE TIMING:',
      'The user has now sent 5 visible debate responses.',
      'Beginning with the user\'s 2nd visible debate response, every philosopher reply must include a score.',
      '',
      'SERVER PROMPT VERSIONS:',
      'Ranked rules: ranked-v3',
    ].join('\n'),
    messages: [
      { role: 'user', content: 'Official context.' },
      { role: 'assistant', content: 'Earlier philosopher reply.' },
      { role: 'user', content: 'Continue the debate.' },
    ],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at generateValidated (file:///app/lib/rankedDebateEngineCoreService.js:2100:1)'
  );

  assert.deepEqual(optimized.cache_control, { type: 'ephemeral' });
  assert.ok(Array.isArray(optimized.system));
  assert.equal(optimized.system.length, 2);
  assert.deepEqual(optimized.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(optimized.system[1].cache_control, undefined);

  const text = systemText(optimized.system);
  assert.match(text, /Stable Ranked authority/);
  assert.match(text, /SCORE TIMING:/);
  assert.match(text, /Beginning with the user's 2nd visible debate response/);
  assert.match(text, /SERVER PROMPT VERSIONS:/);
  assert.match(text, /at least 2 visible debate responses/i);
  assert.doesNotMatch(text, /sent 5 visible debate responses/i);
});

test('score-count normalization only applies once scoring is due', () => {
  const normalize = anthropicCostOptimizerInternals.normalizedScoreTimingText;

  assert.equal(
    normalize('The user has now sent 1 visible debate responses.'),
    'The user has now sent 1 visible debate responses.'
  );
  assert.equal(
    normalize('The user has now sent 2 visible debate responses.'),
    'The user has now sent at least 2 visible debate responses.'
  );
  assert.equal(
    normalize('The user has now sent 9 visible debate responses.'),
    'The user has now sent at least 2 visible debate responses.'
  );
});

test('questions, localization, and Ranked topic generation remain unchanged', () => {
  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: 'Generate content.' }],
  };

  for (const stack of [
    'Error\n at generateQuestions (file:///app/questions.js:500:1)',
    'Error\n at generateTranslation (file:///app/lib/dailyChallengeLocalizationService.js:100:1)',
    'Error\n at generateRankedTopic (file:///app/lib/rankedTopicGeneratorService.js:100:1)',
  ]) {
    assert.strictEqual(optimizeAnthropicPayloadForStack(payload, stack), payload);
  }
});

test('legacy summary exact repeats are served from the rolling summary cache', () => {
  const internals = anthropicCostOptimizerInternals;
  internals.resetLegacySummaryCache();
  const stack = 'Error\n at summarizeMessages (file:///app/server.js:900:1)';
  const source = transcript(11);
  const payload = summaryPayload(source);

  const first = internals.prepareLegacySummaryRequest(payload, stack, 1000);
  assert.equal(first.mode, 'initial');
  internals.recordLegacySummary(first, 'Existing compact summary.', 1000);

  const repeated = internals.prepareLegacySummaryRequest(payload, stack, 1100);
  assert.equal(repeated.mode, 'cache_hit');
  assert.equal(repeated.summary, 'Existing compact summary.');
});

test('legacy summary refresh sends only prior summary plus newly added older messages', () => {
  const internals = anthropicCostOptimizerInternals;
  internals.resetLegacySummaryCache();
  const stack = 'Error\n at summarizeMessages (file:///app/server.js:900:1)';

  const firstTranscript = transcript(11);
  const first = internals.prepareLegacySummaryRequest(summaryPayload(firstTranscript), stack, 1000);
  internals.recordLegacySummary(first, 'Existing compact summary.', 1000);

  const extended = transcript(13);
  const refresh = internals.prepareLegacySummaryRequest(summaryPayload(extended), stack, 1200);

  assert.equal(refresh.mode, 'rolling_refresh');
  assert.equal(refresh.delta.length, 2);
  const prompt = refresh.payload.messages[0].content;
  assert.match(prompt, /Existing compact summary/);
  assert.match(prompt, /A-11/);
  assert.match(prompt, /A-12/);
  assert.doesNotMatch(prompt, /A-0/);
});

test('unrelated legacy debates never share summary state', () => {
  const internals = anthropicCostOptimizerInternals;
  internals.resetLegacySummaryCache();
  const stack = 'Error\n at summarizeMessages (file:///app/server.js:900:1)';

  const first = internals.prepareLegacySummaryRequest(summaryPayload(transcript(11, 'A')), stack, 1000);
  internals.recordLegacySummary(first, 'A summary', 1000);

  const unrelated = internals.prepareLegacySummaryRequest(summaryPayload(transcript(11, 'B')), stack, 1100);
  assert.equal(unrelated.mode, 'initial');
});

test('legacy summary cache expires and is bounded', () => {
  const internals = anthropicCostOptimizerInternals;
  internals.resetLegacySummaryCache();
  const stack = 'Error\n at summarizeMessages (file:///app/server.js:900:1)';

  const first = internals.prepareLegacySummaryRequest(summaryPayload(transcript(11, 'TTL')), stack, 1000);
  internals.recordLegacySummary(first, 'TTL summary', 1000);

  const expired = internals.prepareLegacySummaryRequest(
    summaryPayload(transcript(11, 'TTL')),
    stack,
    1000 + internals.LEGACY_SUMMARY_CACHE_TTL_MS + 1
  );
  assert.equal(expired.mode, 'initial');

  internals.resetLegacySummaryCache();
  for (let index = 0; index < internals.LEGACY_SUMMARY_CACHE_MAX_ENTRIES + 10; index += 1) {
    const plan = internals.prepareLegacySummaryRequest(
      summaryPayload(transcript(11, `K${index}`)),
      stack,
      2000 + index
    );
    internals.recordLegacySummary(plan, `Summary ${index}`, 2000 + index);
  }

  assert.ok(
    internals.legacySummaryCacheSize() <= internals.LEGACY_SUMMARY_CACHE_MAX_ENTRIES
  );
});

test('invalid legacy summary input fails open', () => {
  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: 'Not a legacy summary request.' }],
  };

  assert.equal(
    anthropicCostOptimizerInternals.prepareLegacySummaryRequest(
      payload,
      'Error\n at server.js:1:1',
      1000
    ),
    null
  );
});
