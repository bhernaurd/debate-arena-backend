import test from 'node:test';
import assert from 'node:assert/strict';
import { percent, stageLine, summarizeNormalFlowEvents } from '../scripts/analyticsReportV2Shared.js';

test('backing out of two philosophers produces three flows but one debate', () => {
  const accountId = 'account-1';
  const events = [
    { accountId, flowId: 'jung', eventName: 'philosopher_selected' },
    { accountId, flowId: 'nietzsche', eventName: 'philosopher_selected' },
    { accountId, flowId: 'aristotle', eventName: 'philosopher_selected' },
    { accountId, flowId: 'aristotle', eventName: 'topic_selected' },
    { accountId, flowId: 'aristotle', eventName: 'difficulty_selected' },
    { accountId, flowId: 'aristotle', debateId: 'debate-1', eventName: 'debate_started', isDailyChallenge: false },
  ];
  const result = summarizeNormalFlowEvents(events);
  assert.equal(result.philosopherTimes, 3);
  assert.equal(result.philosopherUsers, 1);
  assert.equal(result.topicTimes, 1);
  assert.equal(result.modeTimes, 1);
  assert.equal(result.debateStarts, 1);
  assert.equal(result.debateUsers, 1);
  assert.equal(result.matchedFlows, 1);
  assert.equal(percent(result.matchedFlows, result.philosopherTimes), '33.3%');
});

test('changing topic stays in one flow while both topic confirmations count', () => {
  const accountId = 'account-1';
  const flowId = 'aristotle';
  const events = [
    { accountId, flowId, eventName: 'philosopher_selected' },
    { accountId, flowId, eventName: 'topic_selected' },
    { accountId, flowId, eventName: 'topic_selected' },
    { accountId, flowId, eventName: 'difficulty_selected' },
    { accountId, flowId, debateId: 'debate-1', eventName: 'debate_started', isDailyChallenge: false },
  ];
  const result = summarizeNormalFlowEvents(events);
  assert.equal(result.philosopherTimes, 1);
  assert.equal(result.topicTimes, 2);
  assert.equal(result.modeTimes, 1);
  assert.equal(result.debateStarts, 1);
  assert.equal(result.matchedFlows, 1);
});

test('repeated mode event for one flow is deduplicated in the funnel', () => {
  const events = [
    { accountId: 'a', flowId: 'f', eventName: 'philosopher_selected' },
    { accountId: 'a', flowId: 'f', eventName: 'difficulty_selected' },
    { accountId: 'a', flowId: 'f', eventName: 'difficulty_selected' },
  ];
  assert.equal(summarizeNormalFlowEvents(events).modeTimes, 1);
});

test('different devices for the same account remain one user', () => {
  const events = [
    { accountId: 'same-account', flowId: 'f1', eventName: 'philosopher_selected', installationId: 'device-1' },
    { accountId: 'same-account', flowId: 'f2', eventName: 'philosopher_selected', installationId: 'device-2' },
  ];
  const result = summarizeNormalFlowEvents(events);
  assert.equal(result.philosopherTimes, 2);
  assert.equal(result.philosopherUsers, 1);
});

test('report line keeps times and unique users visually simple', () => {
  assert.equal(stageLine('Philosopher selected', 12, 5), 'Philosopher selected: 12 times • 5 users');
});
