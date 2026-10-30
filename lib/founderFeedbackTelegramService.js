import { sendTelegramMessage } from '../scripts/analyticsReportV2Shared.js';

const MAX_NOTIFICATION_ATTEMPTS = 25;
const NOTIFICATION_LEASE_SECONDS = 90;

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function platformLabel(value) {
    switch (String(value || '').toLowerCase()) {
        case 'android': return 'Android';
        case 'ios': return 'iOS';
        default: return 'Unknown';
    }
}

function categoryLabel(value) {
    switch (value) {
        case 'bug': return 'Bug';
        case 'feature_idea': return 'Feature idea';
        case 'other': return 'Other';
        default: return 'General';
    }
}

export function formatFounderFeedbackTelegram(row) {
    const platform = platformLabel(row.client_platform);
    const appVersion = row.app_version
        ? ` ${escapeHtml(row.app_version)}` : '';
    const appBuild = row.app_build
        ? ` (${escapeHtml(row.app_build)})` : '';
    const displayName = row.display_name ||
        'Signed-in Agora user';

    return [
        '💬 <b>NEW APP FEEDBACK</b>',
        '',
        `<b>Type:</b> ${escapeHtml(categoryLabel(row.category))}`,
        `<b>User:</b> ${escapeHtml(displayName)}`,
        `<b>Feedback ID:</b> ${escapeHtml(row.id)}`,
        `<b>App:</b> ${platform}${appVersion}${appBuild}`,
        `<b>Submitted:</b> ${escapeHtml(
            row.created_at instanceof Date
                ? row.created_at.toISOString()
                : (row.created_at || 'Unknown')
        )}`,
        '',
        escapeHtml(row.message),
    ].join('\n');
}

export function createFounderFeedbackTelegramService({
    pool,
    sender = sendTelegramMessage,
    logger = console,
} = {}) {
    if (!pool?.query) throw new Error('Feedback Telegram service requires a pool.');

    async function claimOne(id = null) {
        const claimed = await pool.query(
            `WITH candidate AS (
                SELECT id
                  FROM founder_feedback
                 WHERE telegram_sent_at IS NULL
                   AND telegram_attempts < $2
                   AND (telegram_next_attempt_at IS NULL
                        OR telegram_next_attempt_at <= NOW())
                   AND (telegram_lease_until IS NULL
                        OR telegram_lease_until <= NOW())
                   AND ($1::BIGINT IS NULL OR id = $1)
                 ORDER BY created_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
              )
              UPDATE founder_feedback f
                 SET telegram_lease_until =
                         NOW() + ($3::INTEGER * INTERVAL '1 second'),
                     telegram_attempts = f.telegram_attempts + 1
                FROM candidate c
               WHERE f.id = c.id
           RETURNING f.*,
              (SELECT display_name
                 FROM accounts
                WHERE id = f.account_id) AS display_name`,
            [id, MAX_NOTIFICATION_ATTEMPTS, NOTIFICATION_LEASE_SECONDS]
        );
        return claimed.rows[0] || null;
    }

    async function deliverClaimed(row) {
        try {
            // Missing configuration throws instead of silently marking sent.
            // Telegram errors are stored safely by type, never full response
            // bodies, tokens, or the private feedback message.
            await sender(formatFounderFeedbackTelegram(row));
            await pool.query(
                `UPDATE founder_feedback
                    SET telegram_sent_at = NOW(),
                        telegram_lease_until = NULL,
                        telegram_next_attempt_at = NULL,
                        telegram_last_error = NULL
                  WHERE id = $1 AND telegram_sent_at IS NULL`,
                [row.id]
            );
            logger.info?.('[FounderFeedback] Telegram delivered.', {
                feedbackId: String(row.id),
                platform: platformLabel(row.client_platform),
            });
            return { notificationStatus: 'sent', feedbackId: String(row.id) };
        } catch (error) {
            // 10s, 20s, 40s ... capped at 1 hour; retry survives restarts.
            const seconds = Math.min(
                3600,
                10 * (2 ** Math.min(Number(row.telegram_attempts) - 1, 8))
            );
            try {
                await pool.query(
                    `UPDATE founder_feedback
                        SET telegram_lease_until = NULL,
                            telegram_next_attempt_at =
                                NOW() + ($2::INTEGER * INTERVAL '1 second'),
                            telegram_last_error = $3
                      WHERE id = $1 AND telegram_sent_at IS NULL`,
                    [row.id, seconds, String(error?.name || 'Error').slice(0, 80)]
                );
            } catch (persistError) {
                logger.error?.('[FounderFeedback] Retry schedule failed.', {
                    feedbackId: String(row.id),
                    errorName: persistError?.name || 'Error',
                });
            }
            logger.warn?.('[FounderFeedback] Telegram queued for retry.', {
                feedbackId: String(row.id),
                platform: platformLabel(row.client_platform),
                attempt: row.telegram_attempts,
                errorName: error?.name || 'Error',
            });
            return { notificationStatus: 'queued', feedbackId: String(row.id) };
        }
    }

    async function deliverId(id) {
        const row = await claimOne(id);
        if (!row) {
            return { notificationStatus: 'queued', feedbackId: String(id) };
        }
        return deliverClaimed(row);
    }

    async function processPending(limit = 10) {
        let processed = 0;
        for (let i = 0; i < Math.min(Math.max(limit, 0), 20); i++) {
            const row = await claimOne();
            if (!row) break;
            await deliverClaimed(row);
            processed += 1;
        }
        return processed;
    }

    return { deliverId, processPending };
}
