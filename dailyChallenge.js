// dailyChallenge.js
// ES module — matches the import/export style of server.js
//
// Add to server.js:
//   import dailyChallengeRouter from './dailyChallenge.js';
//   app.use(dailyChallengeRouter);
 
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
 
const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
// ─── Storage ──────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
// Window: 5:00 AM Chicago → 4:59 AM Chicago next day
 
function getCurrentWindow() {
    const ZONE = 'America/Chicago';
    const now = DateTime.now().setZone(ZONE);
    const windowStartToday = now.startOf('day').set({ hour: 5 });
 
    const windowStart = now < windowStartToday
        ? windowStartToday.minus({ days: 1 })
        : windowStartToday;
 
    const windowEnd = windowStart.plus({ days: 1 }).minus({ minutes: 1 });
 
    return {
        date: windowStart.toISODate(),       // "YYYY-MM-DD"
        expiresAt: windowEnd.toISO(),
    };
}
 
// ─── Philosopher rotation ─────────────────────────────────────────────────────
// IDs must match Swift Philosopher.id exactly.
// Marcus Aurelius = "aurelius" (not "marcus_aurelius")
 
const PHILOSOPHERS = {
    socrates:  { id: 'socrates',  name: 'Socrates',        era: '470–399 BC',  discipline: 'Socratic Method'  },
    nietzsche: { id: 'nietzsche', name: 'Nietzsche',       era: '1844–1900',   discipline: 'Will to Power'    },
    aurelius:  { id: 'aurelius',  name: 'Marcus Aurelius', era: '121–180 AD',  discipline: 'Stoic Emperor'    },
    jung:      { id: 'jung',      name: 'Carl Jung',       era: '1875–1961',   discipline: 'Psyche & Shadow'  },
    plato:     { id: 'plato',     name: 'Plato',           era: '428–348 BC',  discipline: 'Forms & Dialectic'},
    aristotle: { id: 'aristotle', name: 'Aristotle',       era: '384–322 BC',  discipline: 'Logic & Virtue'   },
};
 
// luxon weekday: 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat 7=Sun
const ROTATION = {
    1: 'socrates',
    2: 'nietzsche',
    3: 'aurelius',
    4: 'jung',
    5: 'plato',
    6: 'aristotle',
    7: 'nietzsche',  // Sunday wildcard
};
 
function getPhilosopherForDate(dateString) {
    const dow = DateTime.fromISO(dateString, { zone: 'America/Chicago' }).weekday;
    return PHILOSOPHERS[ROTATION[dow]] ?? PHILOSOPHERS.socrates;
}
 
// ─── Themes ───────────────────────────────────────────────────────────────────
 
const THEMES = {
    socrates:  ['self-knowledge', 'democracy and mob opinion', 'the examined life', 'what counts as wisdom today'],
    nietzsche: ['social media and herd mentality', 'comfort culture', 'modern morality', 'the pursuit of greatness'],
    aurelius:  ['anxiety in modern life', 'productivity culture', 'the dichotomy of control', 'stoicism vs hustle culture'],
    jung:      ['identity in the age of social media', 'the shadow in cancel culture', 'modern loneliness', 'the collective unconscious today'],
    plato:     ['algorithmic reality', 'truth vs viral content', 'education and the cave', 'justice in modern democracy'],
    aristotle: ['habit and character in the smartphone era', 'the good life today', 'virtue vs success', 'friendship in the digital age'],
};
 
function pickTheme(philosopherId) {
    const list = THEMES[philosopherId] ?? ['the nature of modern life'];
    return list[Math.floor(Math.random() * list.length)];
}
 
// ─── Claude generation ────────────────────────────────────────────────────────
 
async function generateChallenge(philosopher, theme, dateString) {
    const systemPrompt = `You are the editorial team for The Agora, an iOS app where users debate historical philosophers as if they were alive today. Tagline: "For centuries, you could only read the philosophers. Now you can debate them."
 
You create the shared Daily Challenge — one official debate question for all users. It must feel like this philosopher has entered the modern world to challenge a real belief.
 
Rules:
- Modern, personal, genuinely debatable. Not generic academic questions.
- Do not mention AI or ChatGPT unless it is the explicit theme.
- Do not assume the user's position. Invite them to explain their own side.
- Notification copy must sound like the philosopher's voice — sharp, characteristic, inviting tension. Not motivational quotes.
- Vary phrasing across morning, afternoon, and evening.
- Return ONLY valid JSON. No preamble, no markdown, no backticks.`;
 
    const userPrompt = `Generate one Daily Challenge for The Agora.
 
Philosopher: ${philosopher.name} (${philosopher.era}, ${philosopher.discipline})
Theme: ${theme}
Date: ${dateString}
 
Return this exact JSON with no other text:
{
  "title": "Short evocative title (max 6 words)",
  "challengeQuestion": "The full debate question (1-2 sentences, no assumed position)",
  "userPositionPrompt": "One sentence inviting the user to state their view",
  "opposingAngle": "The position ${philosopher.name} will argue (1 sentence)",
  "theme": "${theme}",
  "difficulty": "Accessible or Challenging or Demanding",
  "shareHook": "One-sentence hook for sharing on social media",
  "morningNotification": "${philosopher.name}'s voice — morning, sharp tension (max 2 sentences)",
  "afternoonNotification": "${philosopher.name}'s voice — afternoon, different angle (max 2 sentences)",
  "eveningNotification": "${philosopher.name}'s voice — evening, reflective close (max 2 sentences)"
}`;
 
    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',  // cheap — runs once per day
        max_tokens: 800,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });
 
    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
}
 
// ─── Fallbacks ────────────────────────────────────────────────────────────────
 
const FALLBACKS = {
    socrates: {
        title: 'The Unexamined Opinion',
        challengeQuestion: 'You hold opinions about politics, morality, and how life should be lived — but when did you last examine where those opinions came from?',
        userPositionPrompt: 'Tell me one belief you hold with confidence, and why you hold it.',
        opposingAngle: 'Socrates will question whether any belief held without examination deserves to be called knowledge.',
        theme: 'self-knowledge', difficulty: 'Accessible',
        shareHook: 'I just had my beliefs cross-examined by Socrates. It did not go how I expected.',
        morningNotification: 'Is an unexamined belief worth keeping? Come to the Agora and test one.',
        afternoonNotification: 'You know many things — but do you know how you came to know them? Shall we look?',
        eveningNotification: 'The day is ending. Was any of it examined? Enter the Agora and consider it.',
    },
    nietzsche: {
        title: 'The Comfort Trap',
        challengeQuestion: 'Modern life offers comfort, safety, and endless distraction — and yet many feel something essential is missing. Is the pursuit of comfort making you weaker?',
        userPositionPrompt: 'Tell me honestly — do you believe your comfortable routines are making you stronger, or softening you?',
        opposingAngle: 'Nietzsche will argue that the will to comfort is the will to mediocrity.',
        theme: 'comfort culture', difficulty: 'Challenging',
        shareHook: 'Nietzsche just called my comfortable life into question. I had to answer.',
        morningNotification: 'Does comfort strengthen the soul, or weaken it? Bring your answer, if it has teeth.',
        afternoonNotification: 'The last man seeks warmth and safety above all else — are you certain you are not him?',
        eveningNotification: 'What did you overcome today? Or did you only endure? Enter and answer plainly.',
    },
    aurelius: {
        title: 'Peace or Distraction',
        challengeQuestion: 'Most people chase peace of mind by changing their circumstances. But is peace found by changing your life, or by changing your judgment of it?',
        userPositionPrompt: 'Tell me what you believe is the real source of peace in a person\'s life.',
        opposingAngle: 'Marcus Aurelius will argue that peace is a matter of internal discipline, never external circumstance.',
        theme: 'anxiety in modern life', difficulty: 'Accessible',
        shareHook: 'Marcus Aurelius asked me where I actually find peace. The answer surprised me.',
        morningNotification: 'Return always to this — is peace found by changing life, or mastering judgment? Enter the Agora and answer plainly.',
        afternoonNotification: 'You have been disturbed today by things outside your control. Was that necessary? Come and consider it.',
        eveningNotification: 'What is it to you if circumstances were imperfect? You still had your reason. Did you use it?',
    },
    jung: {
        title: 'What Others Reveal',
        challengeQuestion: 'The people who irritate or disturb you most — have you considered that your reaction reveals something about yourself rather than about them?',
        userPositionPrompt: 'Tell me about something that genuinely disturbs you, and what you believe it says about the world.',
        opposingAngle: 'Jung will argue that what disturbs us most is almost always a projection of the unacknowledged parts of ourselves.',
        theme: 'the shadow', difficulty: 'Demanding',
        shareHook: 'Carl Jung suggested that what bothers me most about others is actually about me. I had to sit with that.',
        morningNotification: 'Do the people who disturb us reveal something hidden within us? Bring the shadow into the light.',
        afternoonNotification: 'One observes that the strongest reactions are rarely about the other person. Are you prepared to look inward?',
        eveningNotification: 'What disturbed you today? Consider whether the world showed you something — or you showed it to yourself.',
    },
    plato: {
        title: 'Reality or Algorithm',
        challengeQuestion: 'The information you consume, the opinions you form, the reality you believe in — how much is shaped by systems designed to keep you looking rather than thinking?',
        userPositionPrompt: 'Tell me how confident you are that what you believe reflects reality, rather than the feed you have been given.',
        opposingAngle: 'Plato will argue that the algorithmically curated world is the new cave.',
        theme: 'algorithmic reality', difficulty: 'Challenging',
        shareHook: 'Plato compared my social media feed to a cave. He wasn\'t entirely wrong.',
        morningNotification: 'Is modern life reality, or a cave of shadows? Turn toward the question and answer.',
        afternoonNotification: 'Consider, if you will — the images you have consumed today. How many pointed toward truth?',
        eveningNotification: 'Is it not the case that the prisoner who escapes the cave finds the light painful at first? Come and consider what you have been looking at.',
    },
    aristotle: {
        title: 'Habit and Character',
        challengeQuestion: 'You are not simply what you intend to become — you are what you repeatedly do. Looking at your daily habits honestly, what kind of person are they building?',
        userPositionPrompt: 'Tell me what your daily habits say about who you are becoming — not who you intend to be.',
        opposingAngle: 'Aristotle will argue that character is built entirely through repeated action.',
        theme: 'habit and character', difficulty: 'Accessible',
        shareHook: 'Aristotle made me look at my daily habits and ask what kind of person they are building.',
        morningNotification: 'Is the good life built by desire, or by habit? Reason through your answer in the Agora.',
        afternoonNotification: 'Excellence is not an act but a habit. What habits did this morning build? Let us examine the matter.',
        eveningNotification: 'We become what we repeatedly do. What did today\'s repetitions say about you? Come and consider it.',
    },
};
 
function getFallback(philosopher, dateString, expiresAt) {
    const f = FALLBACKS[philosopher.id] ?? FALLBACKS.socrates;
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
        const { date, expiresAt } = getCurrentWindow();
 
        const cached = readCache();
        if (cached && cached.date === date) {
            console.log(`[DailyChallenge] Serving cached challenge for ${date}`);
            return res.json(cached);
        }
 
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
            console.error('[DailyChallenge] Generation failed, using fallback:', genErr.message);
            challengeData = getFallback(philosopher, date, expiresAt);
        }
 
        writeCache(challengeData);
        return res.json(challengeData);
 
    } catch (err) {
        console.error('[DailyChallenge] Endpoint error:', err);
        const { date, expiresAt } = getCurrentWindow();
        const philosopher = getPhilosopherForDate(date);
        return res.json(getFallback(philosopher, date, expiresAt));
    }
});
 
export default router;
