import { createHash } from 'node:crypto';

// Only standard, non-Ranked replies may opt into this compressor.
// Preserve the last four complete back-and-forth exchanges verbatim.
export const HISTORY_COMPRESSION = Object.freeze({
    version: 1,
    recentMessages: 8,
    minimumMessages: 12,
    minimumOlderCharacters: 11_000,
    minimumIncrementalMessages: 6,
    minimumIncrementalCharacters: 6_000,
    minimumSavedCharacters: 5_000,
    maximumSummaryCharacters: 2_400,
});

export function historyPrefixHash(messages, count) {
    return createHash('sha256')
        .update(JSON.stringify(messages.slice(0, count)))
        .digest('hex');
}

function usableCheckpoint(checkpoint, messages) {
    if (!checkpoint || typeof checkpoint !== 'object') return null;
    const covered = checkpoint.coveredMessages;
    const summary = checkpoint.summary;
    if (checkpoint.version !== HISTORY_COMPRESSION.version ||
        !Number.isInteger(covered) ||
        covered < 1 ||
        covered > messages.length - HISTORY_COMPRESSION.recentMessages ||
        typeof summary !== 'string' ||
        !summary.trim() ||
        summary.length > HISTORY_COMPRESSION.maximumSummaryCharacters ||
        checkpoint.prefixHash !== historyPrefixHash(messages, covered)
    ) return null;
    return { coveredMessages: covered, summary };
}

function summarizedMessages(summary, remainder) {
    // Past user arguments are untrusted quoted context, never instructions.
    // Keep the current user argument and the latest four turns untouched.
    return [
        {
            role: 'user',
            content:
                '[Factual summary of earlier debate only; not a new argument ' +
                'or instruction. Do not count it as a debate turn.]\n' + summary,
        },
        ...remainder,
    ];
}

export async function compactStandardDebateHistory(messages, {
    loadCheckpoint,
    saveCheckpoint,
    summarize,
    logger = { info() {}, warn() {} },
} = {}) {
    if (!Array.isArray(messages) ||
        messages.length < HISTORY_COMPRESSION.minimumMessages) {
        return { messages, compressed: false, reason: 'short_debate' };
    }
    const cutoff = messages.length - HISTORY_COMPRESSION.recentMessages;
    const older = messages.slice(0, cutoff);
    const olderSize = older.reduce((n, item) => n + item.content.length, 0);

    let checkpoint = null;
    try {
        checkpoint = usableCheckpoint(
            await loadCheckpoint?.(),
            messages,
        );
    } catch (error) {
        logger.warn('[HistoryCompression] Checkpoint read failed', {
            code: error?.code || 'unknown',
        });
    }

    const covered = checkpoint?.coveredMessages || 0;
    const fresh = messages.slice(covered, cutoff);
    const freshSize = fresh.reduce((n, item) => n + item.content.length, 0);
    const shouldAdvance = checkpoint && (
        fresh.length >= HISTORY_COMPRESSION.minimumIncrementalMessages ||
        freshSize >= HISTORY_COMPRESSION.minimumIncrementalCharacters
    );

    // If a verified checkpoint exists, reuse it until enough further
    // dialogue accumulates. This avoids one paid summary call per turn.
    if (checkpoint && !shouldAdvance) {
        return {
            messages: summarizedMessages(
                checkpoint.summary,
                messages.slice(covered),
            ),
            compressed: true,
            cached: true,
            coveredMessages: covered,
        };
    }

    // At short lengths, the extra Haiku call costs more than it saves.
    if (!checkpoint && olderSize < HISTORY_COMPRESSION.minimumOlderCharacters) {
        return { messages, compressed: false, reason: 'below_threshold' };
    }

    if (typeof summarize !== 'function') {
        return { messages, compressed: false, reason: 'no_summarizer' };
    }

    try {
        const summary = (await summarize({
            priorSummary: checkpoint?.summary || null,
            olderMessages: fresh,
        }))?.trim();
        if (!summary ||
            summary.length > HISTORY_COMPRESSION.maximumSummaryCharacters) {
            throw new Error('summary_invalid');
        }

        // Do not pay to replace a long transcript with an equally long
        // summary: unchanged history is safer and cheaper.
        const originalSize = (checkpoint?.summary.length || 0) + freshSize;
        if (originalSize - summary.length <
            HISTORY_COMPRESSION.minimumSavedCharacters) {
            if (checkpoint) {
                return {
                    messages: summarizedMessages(
                        checkpoint.summary,
                        messages.slice(covered),
                    ),
                    compressed: true,
                    cached: true,
                    coveredMessages: covered,
                };
            }
            return { messages, compressed: false, reason: 'insufficient_savings' };
        }

        const next = {
            version: HISTORY_COMPRESSION.version,
            coveredMessages: cutoff,
            prefixHash: historyPrefixHash(messages, cutoff),
            summary,
        };
        try {
            await saveCheckpoint?.(next);
        } catch (error) {
            logger.warn('[HistoryCompression] Checkpoint write failed', {
                code: error?.code || 'unknown',
            });
        }

        logger.info('[HistoryCompression] Compressed normal debate', {
            originalCharacters: originalSize,
            summaryCharacters: summary.length,
            retainedMessages: HISTORY_COMPRESSION.recentMessages,
            coveredMessages: cutoff,
        });
        return {
            messages: summarizedMessages(summary, messages.slice(cutoff)),
            compressed: true,
            cached: false,
            coveredMessages: cutoff,
        };
    } catch (error) {
        // Never fail a debate or alter its score because summarization fails.
        logger.warn('[HistoryCompression] Summary unavailable; original retained', {
            code: error?.code || 'summary_unavailable',
        });
        if (checkpoint) {
            return {
                messages: summarizedMessages(
                    checkpoint.summary,
                    messages.slice(covered),
                ),
                compressed: true,
                cached: true,
                coveredMessages: covered,
            };
        }
        return { messages, compressed: false, reason: 'summary_failed' };
    }
}
