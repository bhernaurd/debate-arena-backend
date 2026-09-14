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

test('conversational AI jobs enable automatic prompt caching', () => {
  const payload = {
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 900,
    temperature: 0.7,
    system: 'Stable philosopher instructions.\n\nScore Timing:\nThe user has now sent 4 visible debate responses.\nInclude a score.',
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
  assert.doesNotMatch(systemText(optimized.system), /sent 4 visible debate responses/i);
  assert.deepEqual(optimized.messages, payload.messages);
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

test('ranked debates cache stable system prefix while retaining score timing text', () => {
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
    messages: [{ role: 'user', content: 'Continue the debate.' }],
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

test('question generation is left unchanged', () => {
  const payload = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: 'Generate three questions.' }],
  };

  const optimized = optimizeAnthropicPayloadForStack(
    payload,
    'Error\n at generateQuestions (file:///app/questions.js:500:1)'
  );

  assert.strictEqual(optimized, payload);
});

test('score count normalization preserves the scoring threshold meaning', () => {
  const input = 'The user has now sent 9 visible debate responses. Beginning with the user\'s 2nd visible debate response, every philosopher reply must include a score.';
  const output = anthropicCostOptimizerInternals.normalizedScoreTimingText(input);

  assert.equal(
    output,
    'The user has now sent at least 2 visible debate responses. Beginning with the user\'s 2nd visible debate response, every philosopher reply must include a score.'
  );
});
