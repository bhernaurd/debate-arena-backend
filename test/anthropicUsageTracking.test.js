import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAnthropicEstimatedCost,
  normalizeAnthropicUsage,
  pricingForAnthropicModel,
} from '../lib/anthropicUsageTracking.js';
import { keyMatchesHint } from '../lib/anthropicCostReconciliation.js';

test('Sonnet 4.5 standard token pricing is calculated correctly', () => {
  const result = calculateAnthropicEstimatedCost('claude-sonnet-4-5-20250929', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(result.estimatedCostUsd, 18);
});

test('Haiku 4.5 standard token pricing is calculated correctly', () => {
  const result = calculateAnthropicEstimatedCost('claude-haiku-4-5-20251001', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(result.estimatedCostUsd, 6);
});

test('cache write and read pricing uses the correct duration rates', () => {
  const result = calculateAnthropicEstimatedCost('claude-sonnet-4-5-20250929', {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 1_000_000,
      ephemeral_1h_input_tokens: 1_000_000,
    },
    cache_read_input_tokens: 1_000_000,
  });
  assert.equal(result.estimatedCostUsd, 10.05);
});

test('aggregate cache creation falls back to 5 minute pricing', () => {
  const usage = normalizeAnthropicUsage({ cache_creation_input_tokens: 123 });
  assert.equal(usage.cacheCreation5mInputTokens, 123);
  assert.equal(usage.cacheCreation1hInputTokens, 0);
  assert.equal(usage.cacheCreationPricingAssumption, 'aggregate_cache_creation_priced_as_5m');
});

test('unknown models do not silently invent a price', () => {
  assert.equal(pricingForAnthropicModel('claude-future-unknown'), null);
  assert.equal(
    calculateAnthropicEstimatedCost('claude-future-unknown', { input_tokens: 10 }).estimatedCostUsd,
    null
  );
});

test('API key partial hint matching requires both prefix and suffix', () => {
  assert.equal(keyMatchesHint('sk-ant-api03-ABC123xyz9', 'sk-ant-api03-ABC...xyz9'), true);
  assert.equal(keyMatchesHint('sk-ant-api03-ABC123wrong', 'sk-ant-api03-ABC...xyz9'), false);
});
