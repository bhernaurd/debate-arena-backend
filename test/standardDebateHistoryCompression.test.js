import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HISTORY_COMPRESSION,
    compactStandardDebateHistory,
    historyPrefixHash,
} from '../lib/standardDebateHistoryCompression.js';

function dialogue(turnCount, charactersPerMessage = 3200) {
    const result = [];
    for (let i = 0; i < turnCount; i += 1) {
        result.push({
            role: i % 2 ? 'user' : 'assistant',
            content: ('argument ' + i + ' ').padEnd(charactersPerMessage, String(i % 10)),
        });
    }
    return result;
}
const summary = 'The user argued that freedom depends upon careful examination, while the philosopher challenged whether reason alone can justify those commitments. The question of inherited values remains unresolved.';

test('short regular debates preserve every message and spend no summary calls', async () => {
    let calls = 0;
    const original = dialogue(10);
    const answer = await compactStandardDebateHistory(original, {
        summarize: async () => { calls++; return summary; },
    });
    assert.equal(answer.compressed, false);
    assert.strictEqual(answer.messages, original);
    assert.equal(calls, 0);
});

test('long debates compress older messages, never the eight latest messages', async () => {
    const original = dialogue(12);
    let saved;
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => null,
        saveCheckpoint: async (checkpoint) => { saved = checkpoint; },
        summarize: async ({priorSummary, olderMessages}) => {
            assert.equal(priorSummary, null);
            assert.equal(olderMessages.length, 4);
            return summary;
        },
    });
    assert.equal(answer.compressed, true);
    assert.equal(answer.cached, false);
    assert.equal(answer.messages.length, 9);
    assert.deepEqual(answer.messages.slice(1), original.slice(-8));
    assert.match(answer.messages[0].content, /Factual summary of earlier debate/);
    assert.equal(saved.coveredMessages, 4);
    assert.equal(saved.prefixHash, historyPrefixHash(original, 4));
    assert.equal(saved.version, HISTORY_COMPRESSION.version);
    assert.equal(original.length, 12);
});

test('verified checkpoints reuse older summary for new turns with no summary charges', async () => {
    const original = dialogue(14);
    const checkpoint = {
        version: HISTORY_COMPRESSION.version,
        coveredMessages: 4,
        prefixHash: historyPrefixHash(original, 4),
        summary,
    };
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => checkpoint,
        summarize: async () => {
            assert.fail('the checkpoint must be reused, not summarized again');
        },
    });
    assert.equal(answer.cached, true);
    assert.deepEqual(answer.messages.slice(1), original.slice(4));
    assert.equal(answer.messages.at(-1).content, original.at(-1).content);
});

test('incremental checkpoint includes earlier summary and only new old history', async () => {
    const original = dialogue(18);
    const prior = {
        version: HISTORY_COMPRESSION.version,
        coveredMessages: 4,
        prefixHash: historyPrefixHash(original, 4),
        summary,
    };
    let next;
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => prior,
        saveCheckpoint: async (value) => { next = value; },
        summarize: async ({ priorSummary, olderMessages }) => {
            assert.equal(priorSummary, summary);
            assert.deepEqual(olderMessages, original.slice(4, 10));
            return summary + ' The player added a new objection about moral responsibility.';
        },
    });
    assert.equal(answer.compressed, true);
    assert.equal(answer.cached, false);
    assert.equal(next.coveredMessages, 10);
    assert.deepEqual(answer.messages.slice(1), original.slice(-8));
});

test('tampered or unrelated checkpoints never leak into a different transcript', async () => {
    const original = dialogue(12);
    let usedStale = false;
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => ({
            version: HISTORY_COMPRESSION.version,
            coveredMessages: 4,
            prefixHash: 'wrong-debate-hash',
            summary: 'Unrelated private data from another debate.',
        }),
        summarize: async ({ priorSummary }) => {
            usedStale = Boolean(priorSummary);
            return summary;
        },
    });
    assert.equal(usedStale, false);
    assert.doesNotMatch(answer.messages[0].content, /Unrelated private data/);
});

test('summary failure keeps the original debate and scoring context intact', async () => {
    const original = dialogue(12);
    original[original.length - 1].content = 'Current user argument, important for scoring and reply.';
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => null,
        summarize: async () => { throw new Error('provider_outage'); },
    });
    assert.equal(answer.compressed, false);
    assert.strictEqual(answer.messages, original);
    assert.equal(answer.messages.at(-1).content, original.at(-1).content);
});

test('checkpoint read and save failures never abort the debate', async () => {
    const original = dialogue(12);
    const answer = await compactStandardDebateHistory(original, {
        loadCheckpoint: async () => { throw new Error('db temporarily unavailable'); },
        saveCheckpoint: async () => { throw new Error('db unavailable'); },
        summarize: async () => summary,
    });
    assert.equal(answer.compressed, true);
    assert.deepEqual(answer.messages.slice(1), original.slice(-8));
});

test('tiny summaries cannot replace transcripts without meaningful cost savings', async () => {
    const original = dialogue(12, 2800);
    const answer = await compactStandardDebateHistory(original, {
        summarize: async () => 'a'.repeat(8000),
    });
    assert.equal(answer.compressed, false);
});

test('only standard debate jobs invoke compressor, not Ranked, Daily or reports', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../aiJobs.js', import.meta.url), 'utf8');
    assert.match(source, /job\.job_type !== 'debate_reply'/);
    assert.match(source, /const generationMessages = await prepareStandardReplyMessages\(job, messages\)/);
    assert.match(source, /messages: generationMessages/);
    assert.match(source, /model: 'claude-haiku-5-5'/);
    assert.match(source, /metadata\s*=\s*jsonb_set/);
});
