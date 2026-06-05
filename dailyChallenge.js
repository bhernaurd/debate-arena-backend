// dailyChallenge.js
// ES module — matches the import/export style of server.js
//
// Daily Challenge window: 5:00 AM Chicago → 4:59 AM Chicago next day.
//
// ensureTodaysChallenge() is the single shared function used by:
//   - the 5 AM cron job
//   - the startup cache safety check
//   - GET /api/daily-challenge
//
// pushScheduler.js reads daily_challenge_cache.json at 9/2/8 PM and sends
// the pre-generated notification copy verbatim — it never calls Claude.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import cron from 'node-cron';

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Storage ──────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'daily_challenge_cache.json');

function readCache() {
    try {
        if (!fs.existsSync(CACHE_PATH)) return null;
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (err) {
        console.error('[DailyChallenge] Cache read error:', err.message);
        return null;
    }
}

function writeCache(data) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error('[DailyChallenge] Cache write error:', err.message);
        return false;
    }
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function getCurrentWindow() {
    const ZONE = 'America/Chicago';
    const now = DateTime.now().setZone(ZONE);
    const windowStartToday = now.startOf('day').set({ hour: 5 });

    const windowStart = now < windowStartToday
        ? windowStartToday.minus({ days: 1 })
        : windowStartToday;

    const windowEnd = windowStart.plus({ days: 1 }).minus({ minutes: 1 });

    return {
        date: windowStart.toISODate(),
        expiresAt: windowEnd.toISO(),
    };
}

// ─── Philosopher rotation ─────────────────────────────────────────────────────
// IDs must match Swift Philosopher.id exactly.
// Marcus Aurelius = "aurelius".
// luxon weekday: 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat 7=Sun

const PHILOSOPHERS = {
    socrates: {
        id: 'socrates',
        name: 'Socrates',
        era: '470–399 BC',
        discipline: 'Socratic Method',
    },
    nietzsche: {
        id: 'nietzsche',
        name: 'Nietzsche',
        era: '1844–1900',
        discipline: 'Will to Power',
    },
    aurelius: {
        id: 'aurelius',
        name: 'Marcus Aurelius',
        era: '121–180 AD',
        discipline: 'Stoic Emperor',
    },
    jung: {
        id: 'jung',
        name: 'Carl Jung',
        era: '1875–1961',
        discipline: 'Psyche & Shadow',
    },
    plato: {
        id: 'plato',
        name: 'Plato',
        era: '428–348 BC',
        discipline: 'Forms & Dialectic',
    },
    aristotle: {
        id: 'aristotle',
        name: 'Aristotle',
        era: '384–322 BC',
        discipline: 'Logic & Virtue',
    },
};

const ROTATION = {
    1: 'socrates',
    2: 'nietzsche',
    3: 'aurelius',
    4: 'jung',
    5: 'plato',
    6: 'aristotle',
    // Sunday is randomized deterministically below.
};

const ALL_PHILOSOPHER_IDS = [
    'socrates',
    'nietzsche',
    'aurelius',
    'jung',
    'plato',
    'aristotle',
];

function stableHashString(value) {
    let hash = 0;

    for (let i = 0; i < value.length; i++) {
        hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
    }

    return hash;
}

function getPhilosopherForDate(dateString) {
    const dow = DateTime.fromISO(dateString, { zone: 'America/Chicago' }).weekday;

    if (dow === 7) {
        // Sunday: deterministic random based on date.
        // All users get the same Sunday philosopher, but it varies week to week.
        const hash = stableHashString(dateString);
        const id = ALL_PHILOSOPHER_IDS[hash % ALL_PHILOSOPHER_IDS.length];

        return PHILOSOPHERS[id] ?? PHILOSOPHERS.socrates;
    }

    return PHILOSOPHERS[ROTATION[dow]] ?? PHILOSOPHERS.socrates;
}

// ─── Themes ───────────────────────────────────────────────────────────────────

const THEMES = {
    socrates: [
        'self-knowledge',
        'democracy and mob opinion',
        'the examined life',
        'what counts as wisdom today',
    ],
    nietzsche: [
        'social media and herd mentality',
        'comfort culture',
        'modern morality',
        'the pursuit of greatness',
    ],
    aurelius: [
        'anxiety in modern life',
        'productivity culture',
        'the dichotomy of control',
        'stoicism vs hustle culture',
    ],
    jung: [
        'identity in the age of social media',
        'the shadow in cancel culture',
        'modern loneliness',
        'the collective unconscious today',
    ],
    plato: [
        'algorithmic reality',
        'truth vs viral content',
        'education and the cave',
        'justice in modern democracy',
    ],
    aristotle: [
        'habit and character in the smartphone era',
        'the good life today',
        'virtue vs success',
        'friendship in the digital age',
    ],
};

function pickTheme(philosopherId) {
    const list = THEMES[philosopherId] ?? ['the nature of modern life'];
    return list[Math.floor(Math.random() * list.length)];
}

// ─── Philosopher ID normalizer ────────────────────────────────────────────────

function normalizePhilosopherId(raw) {
    if (!raw) return null;

    const s = String(raw).toLowerCase().trim();

    if (s === 'marcus aurelius' || s === 'marcus_aurelius' || s === 'marcus') {
        return 'aurelius';
    }

    if (s === 'carl jung') {
        return 'jung';
    }

    return s;
}

// ─── Validation ───────────────────────────────────────────────────────────────
// Confirms all required fields exist and that notification copy does not
// mention any philosopher other than the one assigned today.

function validateChallenge(challenge) {
    const required = [
        'id',
        'date',
        'philosopherId',
        'philosopherName',
        'challengeQuestion',
        'morningNotification',
        'afternoonNotification',
        'eveningNotification',
    ];

    for (const field of required) {
        if (!challenge[field] || String(challenge[field]).trim() === '') {
            throw new Error(`Missing required field: ${field}`);
        }
    }

    const philosopherId = normalizePhilosopherId(challenge.philosopherId);

    const philosopherNames = {
        aristotle: ['aristotle'],
        plato: ['plato'],
        nietzsche: ['nietzsche', 'friedrich nietzsche'],
        socrates: ['socrates'],
        jung: ['jung', 'carl jung'],
        aurelius: ['marcus aurelius', 'aurelius'],
    };

    if (!philosopherNames[philosopherId]) {
        throw new Error(`Invalid philosopherId: ${challenge.philosopherId}`);
    }

    const allOtherNames = Object.entries(philosopherNames)
        .filter(([id]) => id !== philosopherId)
        .flatMap(([, names]) => names);

    const notificationText = [
        challenge.morningNotification,
        challenge.afternoonNotification,
        challenge.eveningNotification,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    for (const name of allOtherNames) {
        if (notificationText.includes(name)) {
            throw new Error(
                `Notification mismatch: philosopher is ${philosopherId} but notification mentions "${name}"`
            );
        }
    }

    return true;
}

// ─── Claude generation ────────────────────────────────────────────────────────

async function generateChallenge(philosopher, theme, dateString) {
    const systemPrompt = `You are the editorial team for The Agora, an iOS app where users debate historical philosophers as if they were alive today. Tagline: "For centuries, you could only read the philosophers. Now you can debate them."

You create the shared Daily Challenge — one official debate question for all users. It must feel like this philosopher has entered the modern world to challenge a real belief.

Rules:
- Modern, personal, genuinely debatable. Not generic academic questions.
- Do not mention AI or ChatGPT unless it is the explicit theme.
- Do not assume the user's position. Invite them to explain their own side.
- The Daily Challenge question is the center of the experience.
- The notification copy must directly revolve around the generated challengeQuestion.
- Each notification should tease, challenge, pressure, or reframe the exact Daily Challenge question.
- Do not write generic philosopher-themed notifications.
- The user should be able to read the notification and immediately understand it belongs to today's specific question.
- The notifications must connect to BOTH the selected philosopher and the specific debate question.
- Notification copy must sound like the philosopher's voice — sharp, characteristic, inviting tension. Not motivational quotes.
- The notification copy must be written in the voice and style of ${philosopher.name} ONLY.
- The notifications must NOT mention, reference, or allude to any other philosopher by name.
- Vary phrasing across morning, afternoon, and evening.
- Return ONLY valid JSON. No preamble, no markdown, no backticks.`;

    const userPrompt = `Generate one Daily Challenge for The Agora.

Philosopher: ${philosopher.name} (${philosopher.era}, ${philosopher.discipline})
Theme: ${theme}
Date: ${dateString}

CRITICAL:
The morningNotification, afternoonNotification, and eveningNotification must be written ONLY in the voice of ${philosopher.name}.
They must directly relate to the exact challengeQuestion you generate.
Do not write generic ${philosopher.name} notifications.
Do not name, reference, or allude to any other philosopher in the notifications.
The notification should make sense as a reminder to answer today's specific Daily Challenge.
Each notification should feel like it belongs to the exact debate question, not just the general theme.

Return this exact JSON with no other text:
{
  "title": "Short evocative title (max 6 words)",
  "challengeQuestion": "The full debate question (1-2 sentences, no assumed position)",
  "userPositionPrompt": "One sentence inviting the user to state their view",
  "opposingAngle": "The position ${philosopher.name} will argue (1 sentence)",
  "theme": "${theme}",
  "difficulty": "Accessible or Challenging or Demanding",
  "shareHook": "One-sentence hook for sharing on social media",
  "morningNotification": "${philosopher.name}'s voice — morning reminder tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "afternoonNotification": "${philosopher.name}'s voice — afternoon reminder that reframes or pressures the exact challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "eveningNotification": "${philosopher.name}'s voice — evening final call tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)"
}`;

    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();

    return JSON.parse(clean);
}

// ─── Fallbacks ────────────────────────────────────────────────────────────────
// Fallbacks are tied to their exact fallback challenge question.

const FALLBACKS = {
    socrates: {
        title: 'The Unexamined Opinion',
        challengeQuestion: 'You hold opinions about politics, morality, and how life should be lived — but when did you last examine where those opinions came from?',
        userPositionPrompt: 'Tell me one belief you hold with confidence, and why you hold it.',
        opposingAngle: 'Socrates will question whether any belief held without examination deserves to be called knowledge.',
        theme: 'self-knowledge',
        difficulty: 'Accessible',
        shareHook: 'I just had my beliefs cross-examined by Socrates. It did not go how I expected.',
        morningNotification: 'You hold beliefs with confidence — but have you examined where they came from? Bring one to the Agora.',
        afternoonNotification: 'The question remains: is your belief knowledge, or only habit wearing the mask of certainty?',
        eveningNotification: 'The day is ending. Before it passes, examine one belief you have carried without question.',
    },

    nietzsche: {
        title: 'The Comfort Trap',
        challengeQuestion: 'Modern life offers comfort, safety, and endless distraction — and yet many feel something essential is missing. Is the pursuit of comfort making you weaker?',
        userPositionPrompt: 'Tell me honestly — do you believe your comfortable routines are making you stronger, or softening you?',
        opposingAngle: 'Nietzsche will argue that the will to comfort is the will to mediocrity.',
        theme: 'comfort culture',
        difficulty: 'Challenging',
        shareHook: 'Nietzsche just called my comfortable life into question. I had to answer.',
        morningNotification: 'Does comfort strengthen you, or slowly tame you? Bring your answer, if it has teeth.',
        afternoonNotification: 'You have had hours of comfort already. Has it made you stronger, or merely easier to manage?',
        eveningNotification: 'The day is almost over. Did you overcome anything, or only preserve your comfort?',
    },

    aurelius: {
        title: 'Peace or Distraction',
        challengeQuestion: 'Most people chase peace of mind by changing their circumstances. But is peace found by changing your life, or by changing your judgment of it?',
        userPositionPrompt: 'Tell me what you believe is the real source of peace in a person\'s life.',
        opposingAngle: 'Marcus Aurelius will argue that peace is a matter of internal discipline, never external circumstance.',
        theme: 'anxiety in modern life',
        difficulty: 'Accessible',
        shareHook: 'Marcus Aurelius asked me where I actually find peace. The answer surprised me.',
        morningNotification: 'Is peace found by changing the world around you, or by mastering your judgment of it?',
        afternoonNotification: 'You have met circumstances today. Did they disturb you, or did your judgment give them power?',
        eveningNotification: 'Before the day ends, ask plainly: was peace absent, or did you surrender it?',
    },

    jung: {
        title: 'What Others Reveal',
        challengeQuestion: 'The people who irritate or disturb you most — have you considered that your reaction reveals something about yourself rather than about them?',
        userPositionPrompt: 'Tell me about something that genuinely disturbs you, and what you believe it says about the world.',
        opposingAngle: 'Jung will argue that what disturbs us most is almost always a projection of the unacknowledged parts of ourselves.',
        theme: 'the shadow',
        difficulty: 'Demanding',
        shareHook: 'Carl Jung suggested that what bothers me most about others is actually about me.',
        morningNotification: 'What disturbed you today may not be outside you. Are you willing to look at what it reveals?',
        afternoonNotification: 'The strongest irritation often points inward. What does your reaction expose?',
        eveningNotification: 'Before the day sinks back into shadow, name what disturbed you — and ask why.',
    },

    plato: {
        title: 'Reality or Algorithm',
        challengeQuestion: 'The information you consume, the opinions you form, the reality you believe in — how much is shaped by systems designed to keep you looking rather than thinking?',
        userPositionPrompt: 'Tell me how confident you are that what you believe reflects reality, rather than the feed you have been given.',
        opposingAngle: 'Plato will argue that the algorithmically curated world is the new cave.',
        theme: 'algorithmic reality',
        difficulty: 'Challenging',
        shareHook: 'Plato compared my social media feed to a cave. He wasn\'t entirely wrong.',
        morningNotification: 'You have been shown images all day. Are they leading you toward truth, or keeping you in the cave?',
        afternoonNotification: 'The feed has shaped your attention. Has it also shaped your reality?',
        eveningNotification: 'Before the shadows close, ask whether what you believed today was reality — or only what was shown to you.',
    },

    aristotle: {
        title: 'Habit and Character',
        challengeQuestion: 'You are not simply what you intend to become — you are what you repeatedly do. Looking at your daily habits honestly, what kind of person are they building?',
        userPositionPrompt: 'Tell me what your daily habits say about who you are becoming — not who you intend to be.',
        opposingAngle: 'Aristotle will argue that character is built entirely through repeated action.',
        theme: 'habit and character',
        difficulty: 'Accessible',
        shareHook: 'Aristotle made me look at my daily habits and ask what kind of person they are building.',
        morningNotification: 'Your habits are already building someone. Are they building the person you claim to seek?',
        afternoonNotification: 'Look at what you have repeated today. What kind of character is being formed?',
        eveningNotification: 'The day has cast its vote through your actions. What did your habits say you are becoming?',
    },
};

function getFallback(philosopher, dateString, expiresAt) {
    const f = FALLBACKS[philosopher.id] ?? FALLBACKS.socrates;

    return {
        id: `fallback-${philosopher.id}-${dateString}`,
        date: dateString,
        philosopherId: philosopher.id,
        philosopherName: philosopher.name,
        ...f,
        expiresAt,
    };
}

// ─── ensureTodaysChallenge ────────────────────────────────────────────────────
// Shared function used by the 5 AM cron, startup check, and HTTP route.
// Returns the current window's challenge, generating it if the cache is stale.

export async function ensureTodaysChallenge() {
    const { date, expiresAt } = getCurrentWindow();

    const cached = readCache();

    if (cached && cached.date === date) {
        return cached;
    }

    const philosopher = getPhilosopherForDate(date);
    const theme = pickTheme(philosopher.id);

    let challengeData;

    try {
        const generated = await generateChallenge(philosopher, theme, date);

        challengeData = {
            id: `daily-${philosopher.id}-${date}`,
            date,
            philosopherId: philosopher.id,
            philosopherName: philosopher.name,
            ...generated,
            expiresAt,
        };

        challengeData.philosopherId =
            normalizePhilosopherId(challengeData.philosopherId) || philosopher.id;

        // Force authoritative backend values.
        // Claude should not be allowed to override these.
        challengeData.id = `daily-${philosopher.id}-${date}`;
        challengeData.date = date;
        challengeData.philosopherId = philosopher.id;
        challengeData.philosopherName = philosopher.name;
        challengeData.expiresAt = expiresAt;

        validateChallenge(challengeData);

        console.log(`[DailyChallenge] Generated challenge for ${date}`);
        console.log(`[DailyChallenge] philosopherId: ${challengeData.philosopherId}`);
        console.log(`[DailyChallenge] philosopherName: ${challengeData.philosopherName}`);
        console.log(`[DailyChallenge] challengeQuestion: ${challengeData.challengeQuestion}`);
        console.log(`[DailyChallenge] morningNotification: ${challengeData.morningNotification}`);
        console.log(`[DailyChallenge] afternoonNotification: ${challengeData.afternoonNotification}`);
        console.log(`[DailyChallenge] eveningNotification: ${challengeData.eveningNotification}`);
        console.log('[DailyChallenge] Validation: PASSED');

    } catch (genErr) {
        console.error('[DailyChallenge] Generation or validation failed:', genErr.message);
        console.log('[DailyChallenge] Validation: FAILED — using fallback');

        challengeData = getFallback(philosopher, date, expiresAt);

        try {
            validateChallenge(challengeData);
        } catch (fallbackErr) {
            console.error('[DailyChallenge] Fallback validation failed:', fallbackErr.message);
        }
    }

    const saved = writeCache(challengeData);
    console.log(`[DailyChallenge] Cache write: ${saved ? 'SUCCESS' : 'FAILED'}`);

    return challengeData;
}

// ─── 5 AM proactive generation cron ──────────────────────────────────────────
// Runs at 5:00 AM Chicago every day.
// Guarantees the cache is fresh before pushScheduler.js reads it.

cron.schedule(
    '0 5 * * *',
    async () => {
        console.log('[DailyChallengeScheduler] 5 AM generation triggered');

        try {
            const challenge = await ensureTodaysChallenge();

            console.log(`[DailyChallengeScheduler] date: ${challenge.date}`);
            console.log(`[DailyChallengeScheduler] philosopherId: ${challenge.philosopherId}`);
            console.log(`[DailyChallengeScheduler] philosopherName: ${challenge.philosopherName}`);
            console.log(`[DailyChallengeScheduler] challengeQuestion: ${challenge.challengeQuestion}`);
            console.log(`[DailyChallengeScheduler] morningNotification: ${challenge.morningNotification}`);
            console.log(`[DailyChallengeScheduler] afternoonNotification: ${challenge.afternoonNotification}`);
            console.log(`[DailyChallengeScheduler] eveningNotification: ${challenge.eveningNotification}`);
            console.log('[DailyChallengeScheduler] Cache ready for push scheduler');

        } catch (err) {
            console.error('[DailyChallengeScheduler] 5 AM generation error:', err.message);
        }
    },
    { timezone: 'America/Chicago' }
);

console.log('[DailyChallengeScheduler] 5 AM cron registered (America/Chicago)');

// ─── Startup cache safety check ──────────────────────────────────────────────
// If Railway restarts after 5 AM, this ensures today's challenge is still
// generated before the first push job reads the cache.

ensureTodaysChallenge()
    .then((challenge) => {
        console.log('[DailyChallengeStartup] Cache checked on startup');
        console.log(`[DailyChallengeStartup] date: ${challenge.date}`);
        console.log(`[DailyChallengeStartup] philosopherId: ${challenge.philosopherId}`);
        console.log(`[DailyChallengeStartup] philosopherName: ${challenge.philosopherName}`);
        console.log(`[DailyChallengeStartup] challengeQuestion: ${challenge.challengeQuestion}`);
    })
    .catch((err) => {
        console.error('[DailyChallengeStartup] Cache check failed:', err.message);
    });

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/api/daily-challenge', async (req, res) => {
    try {
        const challenge = await ensureTodaysChallenge();
        return res.json(challenge);
    } catch (err) {
        console.error('[DailyChallenge] Endpoint error:', err.message);

        const { date, expiresAt } = getCurrentWindow();
        const philosopher = getPhilosopherForDate(date);

        return res.json(getFallback(philosopher, date, expiresAt));
    }
});

export default router;
