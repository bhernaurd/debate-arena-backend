// pushScheduler.js
// Scheduled APNs push jobs for Daily Challenge retention.
// Registered as side-effect import in server.js: import './pushScheduler.js';
//
// Schedule (America/Chicago):
//   9:00 AM  — morning push
//   2:00 PM  — afternoon push
//   8:00 PM  — evening push
//
// Each job:
//   1. Reads today's cached Daily Challenge (daily_challenge_cache.json)
//   2. Reads all registered device tokens (push_tokens.json)
//   3. Skips devices where lastCompletedChallengeId == today's challenge.id
//   4. Skips devices where notificationsEnabled == false
//   5. Sends the appropriate notification copy to the rest

import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendPush } from './apnsService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGE_PATH = path.join(__dirname, 'daily_challenge_cache.json');
const TOKENS_PATH    = path.join(__dirname, 'push_tokens.json');

// ─── FIX 4: Cache shape normalizer ───────────────────────────────────────────
// dailyChallenge.js writes the cache as a flat object (id, philosopherId, etc.)
// at the top level — confirmed by inspecting writeCache(challengeData).
// normalizeChallenge handles both flat and accidentally-wrapped shapes safely.

function normalizeChallenge(raw) {
    if (!raw) return null;
    if (raw.challenge && typeof raw.challenge === 'object') return raw.challenge;
    return raw;
}

// ─── FIX 5: Defensive readChallenge ──────────────────────────────────────────

function readChallenge() {
    try {
        if (!fs.existsSync(CHALLENGE_PATH)) return null;
        const raw = JSON.parse(fs.readFileSync(CHALLENGE_PATH, 'utf8'));
        return normalizeChallenge(raw);
    } catch {
        return null;
    }
}

function readTokens() {
    try {
        if (!fs.existsSync(TOKENS_PATH)) return {};
        return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    } catch {
        return {};
    }
}

// ─── FIX 3: Philosopher display name map ─────────────────────────────────────
// Marcus Aurelius id is "aurelius" — capitalize() would produce "Aurelius".
// This map returns the full display name for every philosopher.

function philosopherDisplayName(id) {
    const names = {
        aristotle: 'Aristotle',
        plato:     'Plato',
        nietzsche: 'Nietzsche',
        socrates:  'Socrates',
        jung:      'Jung',
        aurelius:  'Marcus Aurelius',
    };
    return names[id] || 'The philosopher';
}

// ─── Core send function ───────────────────────────────────────────────────────

async function sendDailyPush({ titleFn, bodyKey, fallbackBody }) {
    // FIX 5: Verify challenge exists and has an id before proceeding
    const challenge = readChallenge();
    if (!challenge || !challenge.id) {
        console.log('[PushScheduler] No valid cached challenge — skipping push job');
        return;
    }

    const title = typeof titleFn === 'function' ? titleFn(challenge) : titleFn;
    const body  = challenge[bodyKey]?.trim() || fallbackBody;

    const tokens  = readTokens();
    const entries = Object.values(tokens);

    if (entries.length === 0) {
        console.log('[PushScheduler] No registered tokens — nothing to send');
        return;
    }

    let sent = 0, skipped = 0;

    for (const record of entries) {
        if (!record.notificationsEnabled) { skipped++; continue; }
        if (record.lastCompletedChallengeId === challenge.id) { skipped++; continue; }

        const ok = await sendPush(record.deviceToken, title, body);
        if (ok) sent++; else skipped++;
    }

    console.log(`[PushScheduler] "${title}" — sent: ${sent}, skipped: ${skipped}`);
}

// ─── Cron jobs (America/Chicago) ─────────────────────────────────────────────

// 9:00 AM — Morning
cron.schedule('0 9 * * *', () => {
    console.log('[PushScheduler] Firing morning push job');
    sendDailyPush({
        titleFn: () => 'A question enters the Agora',
        bodyKey: 'morningNotification',
        fallbackBody: "Today's question has entered the Agora. Bring your answer.",
    });
}, { timezone: 'America/Chicago' });

// 2:00 PM — Afternoon (FIX 3: philosopher display name, not raw id)
cron.schedule('0 14 * * *', () => {
    console.log('[PushScheduler] Firing afternoon push job');
    sendDailyPush({
        titleFn: (challenge) => `${philosopherDisplayName(challenge.philosopherId)} is waiting.`,
        bodyKey: 'afternoonNotification',
        fallbackBody: 'The question is still waiting. Return before the day passes.',
    });
}, { timezone: 'America/Chicago' });

// 8:00 PM — Evening
cron.schedule('0 20 * * *', () => {
    console.log('[PushScheduler] Firing evening push job');
    sendDailyPush({
        titleFn: (challenge) => `${philosopherDisplayName(challenge.philosopherId)} has a final question.`,
        bodyKey: 'eveningNotification',
        fallbackBody: 'The Agora closes soon. Bring your answer before the question disappears.',
    });
}, { timezone: 'America/Chicago' });

console.log('[PushScheduler] Cron jobs registered — 9 AM / 2 PM / 8 PM America/Chicago');
