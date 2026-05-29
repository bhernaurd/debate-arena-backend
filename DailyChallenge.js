// dailyChallenge.js
// Mount in your main server file: app.use(require('./dailyChallenge'))
//
// GET /api/daily-challenge
// Returns the shared Daily Challenge for the current 5:00 AM – 4:59 AM America/Chicago window.
// Generates via Claude if one doesn't exist yet. Falls back to hardcoded challenges if Claude fails.
//
// Requires: npm install luxon @anthropic-ai/sdk
// (luxon is already a common dependency — add it if not present)
 
const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { DateTime } = require('luxon');
 
const router = express.Router();
const client = new Anthropic(); // uses ANTHROPIC_API_KEY from env
 
// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_PATH = path.join(__dirname, 'daily_challenge_cache.json');
 
function readCache() {
    try {
        if (!fs.existsSync(STORAGE_PATH)) return null;
        return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
    } catch {
        return null;
    }
}
 
function writeCache(data) {
    try {
        fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error('[DailyChallenge] Cache write error:', err);
    }
}
 
// ─── Time helpers (luxon / America/Chicago) ───────────────────────────────────
// The Daily Challenge window runs from 5:00 AM Chicago to 4:59 AM Chicago the next day.
// luxon handles DST transitions correctly with no manual offset math.
 
function getCurrentWindow() {
    const ZONE = 'America/Chicago';
    const now = DateTime.now().setZone(ZONE);
 
    // Determine which calendar day "owns" the current moment.
    // Before 5 AM → still in yesterday's window.
    const windowStartToday = now.startOf('day').set({ hour: 5 });
 
    let windowStart;
    if (now < windowStartToday) {
        // We're before 5 AM — use yesterday's 5 AM as window start.
        windowStart = windowStartToday.minus({ days: 1 });
    } else {
        windowStart = windowStartToday;
    }
 
    // Window end is 4:59 AM (one minute before 5 AM) the next day.
    const windowEnd = windowStart.plus({ days: 1 }).minus({ minutes: 1 });
 
    // The challenge date label is the calendar date of windowStart.
    const date = windowStart.toISODate(); // "YYYY-MM-DD"
 
    return {
        date,
        windowStart,
        windowEnd,
        expiresAt: windowEnd.toISO(),
    };
}
 
// ─── Philosopher Rotation ─────────────────────────────────────────────────────
// philosopherId values MUST match the Swift Philosopher.id strings exactly.
// Swift values: "aristotle", "plato", "nietzsche", "socrates", "jung", "aurelius"
// Note: Marcus Aurelius uses id "aurelius" (not "marcus_aurelius" or "marcus-aurelius").
 
const PHILOSOPHERS = {
    socrates:  { id: 'socrates',  name: 'Socrates',        era: '470–399 BC',  discipline: 'Socratic Method'  },
    nietzsche: { id: 'nietzsche', name: 'Nietzsche',       era: '1844–1900',   discipline: 'Will to Power'    },
    aurelius:  { id: 'aurelius',  name: 'Marcus Aurelius', era: '121–180 AD',  discipline: 'Stoic Emperor'    },
    jung:      { id: 'jung',      name: 'Carl Jung',       era: '1875–1961',   discipline: 'Psyche & Shadow'  },
    plato:     { id: 'plato',     name: 'Plato',           era: '428–348 BC',  discipline: 'Forms & Dialectic'},
    aristotle: { id: 'aristotle', name: 'Aristotle',       era: '384–322 BC',  discipline: 'Logic & Virtue'   },
};
 
// luxon weekday: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
// Extend this map when new philosophers are added — one line per day.
const ROTATION = {
    1: 'socrates',   // Monday
    2: 'nietzsche',  // Tuesday
    3: 'aurelius',   // Wednesday
    4: 'jung',       // Thursday
    5: 'plato',      // Friday
    6: 'aristotle',  // Saturday
    7: 'nietzsche',  // Sunday wildcard — change freely
};
 
function getPhilosopherForDate(dateString) {
    const dt = DateTime.fromISO(dateString, { zone: 'America/Chicago' });
    const dow = dt.weekday; // 1–7, Monday–Sunday
    return PHILOSOPHERS[ROTATION[dow]] || PHILOSOPHERS.socrates;
}
 
// ─── Modern themes per philosopher ───────────────────────────────────────────
 
const THEMES = {
    socrates:  ['self-knowledge', 'democracy and mob opinion', 'the examined life', 'what counts as wisdom today'],
    nietzsche: ['social media and herd mentality', 'comfort culture', 'modern morality', 'the pursuit of greatness'],
    aurelius:  ['anxiety in modern life', 'productivity culture', 'the dichotomy of control', 'stoicism vs hustle culture'],
    jung:      ['identity in the age of social media', 'the shadow in cancel culture', 'modern loneliness', 'the collective unconscious today'],
    plato:     ['algorithmic reality', 'truth vs viral content', 'education and the cave', 'justice in modern democracy'],
    aristotle: ['habit and character in the smartphone era', 'the good life today', 'virtue vs success', 'friendship in digital age'],
};
 
function pickTheme(philosopherId) {
    const list = THEMES[philosopherId] || ['the nature of modern life'];
    return list[Math.floor(Math.random() * list.length)];
}
 
// ─── Claude Generation ────────────────────────────────────────────────────────
// Uses the same model string as the existing /debate endpoint on this backend.
// Check your existing debate route for the exact model name and mirror it here.
 
async function generateChallenge(philosopher, theme, dateString) {
    const systemPrompt = `You are the editorial team for The Agora, an iOS app where users debate historical philosophers as if they were alive today. Your tagline is: "For centuries, you could only read the philosophers. Now you can debate them."
 
You create the shared Daily Challenge — one official debate question for all users. It must feel like this philosopher has entered the modern world to challenge a real belief.
 
Rules:
- The question must be modern, personal, and genuinely debatable.
- Do not ask generic academic questions. Ask questions users feel in their daily lives.
- Do not mention AI, ChatGPT, or technology unless it is the explicit theme.
- Do not assume the user's position or belief. Invite them to explain their own side.
- Notification copy must sound like the philosopher's voice — sharp, characteristic, inviting tension.
- Notifications must NOT sound like generic motivational quotes.
- The invitation in each notification should end with the philosopher's characteristic phrasing.
- Vary the phrasing across morning, afternoon, and evening notifications.
- Return ONLY valid JSON. No preamble, no markdown, no backticks.`;
 
    const userPrompt = `Generate one Daily Challenge for The Agora.
 
Philosopher: ${philosopher.name} (${philosopher.era}, ${philosopher.discipline})
Theme: ${theme}
Date: ${dateString}
 
The challenge must feel like ${philosopher.name} has entered the modern world specifically to challenge the user on this theme.
 
Return this exact JSON shape with no other text:
{
  "title": "Short evocative title (max 6 words)",
  "challengeQuestion": "The full debate question (1-2 sentences, no assumed position)",
  "userPositionPrompt": "One sentence inviting the user to state their view before entering the debate",
  "opposingAngle": "The position ${philosopher.name} will argue (1 sentence)",
  "theme": "${theme}",
  "difficulty": "one of: Accessible, Challenging, Demanding",
  "shareHook": "A one-sentence hook for sharing the result on social media",
  "morningNotification": "${philosopher.name}'s voice — morning, sharp tension, philosopher-styled invitation (max 2 sentences)",
  "afternoonNotification": "${philosopher.name}'s voice — afternoon, different angle, characteristic phrasing (max 2 sentences)",
  "eveningNotification": "${philosopher.name}'s voice — evening, reflective, philosopher-styled close (max 2 sentences)"
}`;
 
    const message = await client.messages.create({
        // IMPORTANT: This must match the model your existing /debate endpoint uses.
        // Check your debate route and use the same model string here.
        // Current working model in this backend: update this to match.
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });
 
    const raw = message.content[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
}
 
// ─── Fallback Challenges ──────────────────────────────────────────────────────
// philosopherId values match Swift Philosopher.id exactly.
 
const FALLBACKS = {
    socrates: {
        title: 'The Unexamined Opinion',
        challengeQuestion: 'You hold opinions about politics, morality, and how life should be lived — but when did you last examine where those opinions came from?',
        userPositionPrompt: 'Tell me one belief you hold with confidence, and why you hold it.',
        opposingAngle: 'Socrates will question whether any belief held without examination deserves to be called knowledge.',
        theme: 'self-knowledge',
        difficulty: 'Accessible',
        shareHook: 'I just had my beliefs cross-examined by Socrates. It did not go how I expected.',
        morningNotification: 'Is an unexamined belief worth keeping? Come to the Agora and test one.',
        afternoonNotification: 'You know many things — but do you know how you came to know them? Shall we look?',
        eveningNotification: 'The day is ending. Was any of it examined? Enter the Agora and consider it.',
    },
    nietzsche: {
        title: 'The Comfort Trap',
        challengeQuestion: 'Modern life offers comfort, safety, and endless distraction — and yet many feel that something essential is missing. Is the pursuit of comfort making you weaker?',
        userPositionPrompt: 'Tell me honestly — do you believe your comfortable routines are making you stronger, or are they softening you?',
        opposingAngle: 'Nietzsche will argue that the will to comfort is the will to mediocrity, and that only struggle creates genuine power.',
        theme: 'comfort culture',
        difficulty: 'Challenging',
        shareHook: 'Nietzsche just called my comfortable life into question. I had to answer.',
        morningNotification: 'Does comfort strengthen the soul, or weaken it? Bring your answer, if it has teeth.',
        afternoonNotification: 'The last man seeks warmth and safety above all else — are you certain you are not him?',
        eveningNotification: 'What did you overcome today? Or did you only endure? Enter and answer plainly.',
    },
    aurelius: {
        title: 'Peace or Distraction',
        challengeQuestion: 'Most people chase peace of mind through changing their circumstances — a better job, a different city, more money. But is peace found by changing your life, or by changing your judgment of it?',
        userPositionPrompt: 'Tell me what you believe is the real source of peace in a person\'s life.',
        opposingAngle: 'Marcus Aurelius will argue that peace is a matter of internal discipline, never external circumstance.',
        theme: 'anxiety in modern life',
        difficulty: 'Accessible',
        shareHook: 'Marcus Aurelius asked me where I actually find peace. The answer surprised me.',
        morningNotification: 'Return always to this — is peace found by changing life, or mastering judgment? Enter the Agora and answer plainly.',
        afternoonNotification: 'You have been disturbed today by things outside your control. Was that necessary? Come and consider it.',
        eveningNotification: 'What is it to you if circumstances were imperfect? You still had your reason. Did you use it?',
    },
    jung: {
        title: 'What Others Reveal',
        challengeQuestion: 'The people who irritate, disturb, or provoke you the most — have you ever considered that your reaction reveals something about yourself rather than about them?',
        userPositionPrompt: 'Tell me about something that genuinely disturbs you, and what you believe it says about the world.',
        opposingAngle: 'Jung will argue that what disturbs us most is almost always a projection of the unacknowledged parts of ourselves — the shadow.',
        theme: 'the shadow in cancel culture',
        difficulty: 'Demanding',
        shareHook: 'Carl Jung suggested that what bothers me most about others is actually about me. I had to sit with that.',
        morningNotification: 'Do the people who disturb us reveal something hidden within us? Bring the shadow into the light.',
        afternoonNotification: 'One observes that the strongest reactions are rarely about the other person. Are you prepared to look inward?',
        eveningNotification: 'What disturbed you today? Before you sleep, consider whether the world showed you something — or you showed it to yourself.',
    },
    plato: {
        title: 'Reality or Algorithm',
        challengeQuestion: 'The information you consume, the opinions you form, the reality you believe in — how much of it is shaped by systems designed to keep you looking, rather than thinking?',
        userPositionPrompt: 'Tell me how confident you are that what you believe about the world reflects reality, rather than the feed you have been given.',
        opposingAngle: 'Plato will argue that the algorithmically curated world is the new cave — and most people have mistaken its shadows for truth.',
        theme: 'algorithmic reality',
        difficulty: 'Challenging',
        shareHook: 'Plato compared my social media feed to a cave. He wasn\'t entirely wrong.',
        morningNotification: 'Is modern life reality, or a cave of shadows? Turn toward the question and answer.',
        afternoonNotification: 'Consider, if you will — the images you have consumed today. How many pointed toward truth, and how many merely entertained?',
        eveningNotification: 'Is it not the case that the prisoner who escapes the cave finds the light painful at first? Come and consider what you have been looking at.',
    },
    aristotle: {
        title: 'Habit and Character',
        challengeQuestion: 'You are not simply what you intend to become — you are what you repeatedly do. Looking at your daily habits honestly, what kind of person are they actually building?',
        userPositionPrompt: 'Tell me what your daily habits say about who you are becoming — not who you intend to be.',
        opposingAngle: 'Aristotle will argue that character is built entirely through repeated action, and that who you are is inseparable from what you habitually do.',
        theme: 'habit and character in the smartphone era',
        difficulty: 'Accessible',
        shareHook: 'Aristotle made me look at my daily habits and ask what kind of person they are building. Uncomfortable question.',
        morningNotification: 'Is the good life built by desire, or by habit? Reason through your answer in the Agora.',
        afternoonNotification: 'One must observe — excellence is not an act but a habit. What habits did this morning build? Let us examine the matter.',
        eveningNotification: 'It follows necessarily that we become what we repeatedly do. What did today\'s repetitions say about you? Come and consider it.',
    },
};
 
function getFallback(philosopher, dateString, expiresAt) {
    const f = FALLBACKS[philosopher.id] || FALLBACKS.socrates;
    return {
        id: `fallback-${philosopher.id}-${dateString}`,
        date: dateString,
        philosopherId: philosopher.id,
        ...f,
        expiresAt,
    };
}
 
// ─── Route ────────────────────────────────────────────────────────────────────
 
router.get('/api/daily-challenge', async (req, res) => {
    try {
        const window = getCurrentWindow();
        const { date, expiresAt } = window;
 
        // 1. Serve from cache if today's challenge already exists
        const cached = readCache();
        if (cached && cached.date === date) {
            console.log(`[DailyChallenge] Serving cached challenge for ${date}`);
            return res.json(cached);
        }
 
        // 2. Generate a new challenge
        console.log(`[DailyChallenge] Generating new challenge for ${date}`);
        const philosopher = getPhilosopherForDate(date);
        const theme = pickTheme(philosopher.id);
 
        let challengeData;
        try {
            const generated = await generateChallenge(philosopher, theme, date);
            challengeData = {
                id: `daily-${philosopher.id}-${date}`,
                date,
                philosopherId: philosopher.id,
                ...generated,
                expiresAt,
            };
            console.log(`[DailyChallenge] Generated: "${challengeData.title}" with ${philosopher.name}`);
        } catch (genErr) {
            console.error('[DailyChallenge] Claude generation failed, using fallback:', genErr.message);
            challengeData = getFallback(philosopher, date, expiresAt);
        }
 
        writeCache(challengeData);
        return res.json(challengeData);
 
    } catch (err) {
        console.error('[DailyChallenge] Endpoint error:', err);
        // Last-resort: always return something, never a 500 to the client
        const window = getCurrentWindow();
        const philosopher = getPhilosopherForDate(window.date);
        return res.json(getFallback(philosopher, window.date, window.expiresAt));
    }
});
 
module.exports = router;
