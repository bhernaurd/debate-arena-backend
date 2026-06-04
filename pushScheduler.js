// pushScheduler.js
// Scheduled APNs push jobs for Daily Challenge retention.
// Registered as side-effect import in server.js: import './pushScheduler.js';
//
// Schedule (America/Chicago):
//   9:00 AM  — morning push
//   2:00 PM  — afternoon push
//   8:00 PM  — evening push

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendPush } from './apnsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGE_PATH = path.join(__dirname, 'daily_challenge_cache.json');
const TOKENS_PATH = path.join(__dirname, 'push_tokens.json');

// ─── Cache helpers ───────────────────────────────────────────────────────────

function normalizeChallenge(raw) {
    if (!raw) return null;
    if (raw.challenge && typeof raw.challenge === 'object') return raw.challenge;
    return raw;
}

function readChallenge() {
    try {
        if (!fs.existsSync(CHALLENGE_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(CHALLENGE_PATH, 'utf8'));
        return normalizeChallenge(raw);
    } catch (err) {
        console.error('[PushScheduler] Challenge read error:', err);
        return null;
    }
}

function readTokens() {
    try {
        if (!fs.existsSync(TOKENS_PATH)) return {};
        return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch (err) {
        console.error('[PushScheduler] Token read error:', err);
        return {};
    }
}

// ─── Philosopher helpers ─────────────────────────────────────────────────────

function philosopherDisplayName(id) {
    const names = {
        aristotle: 'Aristotle',
        plato: 'Plato',
        nietzsche: 'Nietzsche',
        socrates: 'Socrates',
        jung: 'Jung',
        aurelius: 'Marcus Aurelius',
    };

    return names[id] || 'The philosopher';
}

function philosopherInitials(id) {
    const initials = {
        aristotle: 'AR',
        plato: 'PL',
        nietzsche: 'NZ',
        socrates: 'SC',
        jung: 'J',
        aurelius: 'MA',
    };

    return initials[id] || 'AG';
}

// ─── Notification copy locked to actual philosopher ──────────────────────────

function getNotificationCopyForChallenge(challenge, timeOfDay) {
    const philosopherId = challenge.philosopherId;
    const philosopher = philosopherDisplayName(philosopherId);
    const question = challenge.challengeQuestion || challenge.question || 'Today’s question is waiting.';

    const copy = {
        socrates: {
            morning: {
                title: 'A question enters the Agora',
                body: `You say you know what you believe. Socrates is waiting to ask whether you can define it.`,
            },
            afternoon: {
                title: 'Socrates is waiting.',
                body: `You have not answered yet. Perhaps the real question is why.`,
            },
            evening: {
                title: 'Socrates has a final question.',
                body: `The day is almost over. Will your belief survive examination?`,
            },
        },

        plato: {
            morning: {
                title: 'A question enters the Agora',
                body: `Plato is waiting. Step beyond opinion and defend what you think is true.`,
            },
            afternoon: {
                title: 'Plato is waiting.',
                body: `The question remains. Are you defending truth, or only the shadow of it?`,
            },
            evening: {
                title: 'Plato has a final question.',
                body: `The Agora closes soon. Bring your answer before the day fades into shadows.`,
            },
        },

        aristotle: {
            morning: {
                title: 'A question enters the Agora',
                body: `Aristotle is waiting. Bring reason, clarity, and a practical defense of your view.`,
            },
            afternoon: {
                title: 'Aristotle is waiting.',
                body: `Your argument is still unfinished. Can your position stand under reason?`,
            },
            evening: {
                title: 'Aristotle has a final question.',
                body: `The day is nearly done. Complete the argument before the moment passes.`,
            },
        },

        nietzsche: {
            morning: {
                title: 'A question enters the Agora',
                body: `Nietzsche is waiting. Bring your answer, but do not bring borrowed beliefs.`,
            },
            afternoon: {
                title: 'Nietzsche is waiting.',
                body: `The question still stands. Are you avoiding it, or merely obeying comfort?`,
            },
            evening: {
                title: 'Nietzsche has a final question.',
                body: `The day is almost over. Will you answer with strength, or disappear into the herd?`,
            },
        },

        jung: {
            morning: {
                title: 'A question enters the Agora',
                body: `Jung is waiting. Your answer may reveal more than your argument.`,
            },
            afternoon: {
                title: 'Jung is waiting.',
                body: `The question remains. What part of yourself is resisting the answer?`,
            },
            evening: {
                title: 'Jung has a final question.',
                body: `The day is ending. Enter the question before it sinks back into the unconscious.`,
            },
        },

        aurelius: {
            morning: {
                title: 'A question enters the Agora',
                body: `Marcus Aurelius is waiting. Meet today’s question with discipline and clarity.`,
            },
            afternoon: {
                title: 'Marcus Aurelius is waiting.',
                body: `The question remains. Do not delay what reason asks of you today.`,
            },
            evening: {
                title: 'Marcus Aurelius has a final question.',
                body: `The day is nearly over. Answer with virtue before the opportunity passes.`,
            },
        },
    };

    const selected =
        copy[philosopherId]?.[timeOfDay] || {
            title: `${philosopher} is waiting.`,
            body: `${question} Bring your answer to the Agora.`,
        };

    return {
        ...selected,
        philosopher,
        philosopherId,
        philosopherInitials: philosopherInitials(philosopherId),
    };
}

// ─── Core send function ──────────────────────────────────────────────────────

async function sendDailyPush(timeOfDay) {
    const challenge = readChallenge();

    if (!challenge || !challenge.id) {
        console.log('[PushScheduler] No valid cached challenge — skipping push job');
        return;
    }

    if (!challenge.philosopherId) {
        console.log('[PushScheduler] Challenge missing philosopherId — skipping push job:', challenge.id);
        return;
    }

    const notification = getNotificationCopyForChallenge(challenge, timeOfDay);

    const tokens = readTokens();
    const entries = Object.values(tokens);

    if (entries.length === 0) {
        console.log('[PushScheduler] No registered tokens — nothing to send');
        return;
    }

    const challengePayload = {
        challengeId: challenge.id,
        challengeDate: challenge.date || '',
        philosopherId: challenge.philosopherId,
        philosopher: notification.philosopher,
        source: 'daily_challenge',
    };

    console.log('[PushScheduler] Firing', timeOfDay, 'push');
    console.log('[PushScheduler] Challenge ID:', challenge.id);
    console.log('[PushScheduler] Philosopher ID:', challenge.philosopherId);
    console.log('[PushScheduler] Philosopher:', notification.philosopher);
    console.log('[PushScheduler] Title:', notification.title);
    console.log('[PushScheduler] Body:', notification.body);

    let sent = 0;
    let skipped = 0;

    for (const record of entries) {
        if (!record.deviceToken) {
            skipped++;
            continue;
        }

        if (!record.notificationsEnabled) {
            skipped++;
            continue;
        }

        if (record.lastCompletedChallengeId === challenge.id) {
            skipped++;
            continue;
        }

        const ok = await sendPush(
            record.deviceToken,
            notification.title,
            notification.body,
            challengePayload
        );

        if (ok) {
            sent++;
        } else {
            skipped++;
        }
    }

    console.log(
        `[PushScheduler] ${timeOfDay} push complete — philosopher: ${notification.philosopher}, sent: ${sent}, skipped: ${skipped}`
    );
}

// ─── Cron jobs America/Chicago ───────────────────────────────────────────────

// 9:00 AM
cron.schedule('0 9 * * *', () => {
    sendDailyPush('morning');
}, { timezone: 'America/Chicago' });

// 2:00 PM
cron.schedule('0 14 * * *', () => {
    sendDailyPush('afternoon');
}, { timezone: 'America/Chicago' });

// 8:00 PM
cron.schedule('0 20 * * *', () => {
    sendDailyPush('evening');
}, { timezone: 'America/Chicago' });

console.log('[PushScheduler] Cron jobs registered — 9 AM / 2 PM / 8 PM America/Chicago');
