// dailyChallenge.js
// ES module — matches the import/export style of server.js
//
// Daily Challenge system:
//   - Same official challenge for everyone by challenge date.
//   - Challenge unlocks at 5:00 AM in the user's local timezone.
//   - Backend replenishes a rolling calendar at 4:00 AM America/Chicago.
//   - Postgres stores today through the next 7 days.
//   - Notification copy is generated ahead of time with each challenge.
//
// Important behavior preserved:
//   - Backend deploys/restarts will NOT regenerate existing challenge dates.
//   - challenge_date is the source of truth.
//   - Existing dates are skipped.
//   - A Postgres advisory lock prevents duplicate Claude generation during concurrent deploys.
//   - The rolling 7-day calendar remains intact.
//
// Improvements in this version:
//   - Larger source-grounded idea pools.
//   - Question modes to prevent every Daily Challenge from feeling like the same prompt.
//   - Source idea LRU is scoped per philosopher.
//   - Question mode LRU is scoped globally across recent Daily Challenges.
//   - Optional source-level mode allowlists are supported.
//   - One retry happens before fallback if generation or validation fails.
//   - Fallback difficulty follows the scheduled difficulty curve.
//   - Stricter validation for difficulty, source grounding, generic wording, and notification mismatch.
//   - Source grounding is judged from challengeQuestion itself, not rescued by supporting metadata.
//   - A second model-based fidelity gate rejects unsupported inferences and source drift.
//   - Lexical + semantic recent-question checks reject close repeats and paraphrased duplicates.
//   - Optional source guardrails support coreClaim, allowedApplication, and avoidOverclaim.
//   - Sonnet model by default, with Railway env overrides for generation and fidelity review.
//   - question_mode is stored in Postgres.
//   - Daily Challenge questions are exactly one neutral question sentence, max 15 words.
//   - Users always choose which side they want to defend.
//   - userPositionPrompt is forced to one neutral instruction for every challenge.
//   - Backend validation rejects multi-sentence, over-15-word, or side-assigned questions.
//
// Required DB migration before deploying this version:
//   ALTER TABLE daily_challenges
//   ADD COLUMN IF NOT EXISTS question_mode TEXT;
//
// Compatibility:
//   - daily_challenge_cache.json is still written for the current Chicago window
//     so the existing pushScheduler.js does not break yet.

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { DateTime } from 'luxon';
import cron from 'node-cron';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Keep this env-configurable so you can change the Anthropic model in Railway
// without editing code.
const DAILY_CHALLENGE_MODEL =
    process.env.DAILY_CHALLENGE_MODEL || 'claude-sonnet-4-5-20250929';

// A second editorial pass verifies source fidelity and semantic novelty before
// a generated challenge is accepted. By default it uses the same model, but
// Railway can override it independently if desired.
const DAILY_CHALLENGE_FIDELITY_MODEL =
    process.env.DAILY_CHALLENGE_FIDELITY_MODEL || DAILY_CHALLENGE_MODEL;

const DAILY_CHALLENGE_MAX_WORDS = 15;
const DAILY_CHALLENGE_POSITION_PROMPT =
    'Choose your position and make the strongest case you can.';

// ─── Storage compatibility for current pushScheduler.js ───────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CACHE_PATH = path.join(__dirname, 'daily_challenge_cache.json');

const CHICAGO_ZONE = 'America/Chicago';
const DAILY_UNLOCK_HOUR = 5;
const ROLLING_DAYS_AHEAD = 7;

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[DailyChallenge] JSON write error for ${path.basename(filePath)}:`, err.message);
        return false;
    }
}

function writeCache(data) {
    return writeJsonFile(CACHE_PATH, data);
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function safeZone(rawZone) {
    const candidate = String(rawZone || '').trim();

    if (!candidate) return CHICAGO_ZONE;

    const test = DateTime.now().setZone(candidate);
    return test.isValid ? candidate : CHICAGO_ZONE;
}

function getChallengeWindowForZone(rawZone, now = DateTime.now()) {
    const zone = safeZone(rawZone);
    const localNow = now.setZone(zone);

    const localStartToday = localNow.startOf('day').set({
        hour: DAILY_UNLOCK_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
    });

    const windowStart =
        localNow < localStartToday
            ? localStartToday.minus({ days: 1 })
            : localStartToday;

    const windowEnd = windowStart.plus({ days: 1 }).minus({ seconds: 1 });

    return {
        zone,
        date: windowStart.toISODate(),
        startsAt: windowStart.toISO(),
        expiresAt: windowEnd.toISO(),
    };
}

function getChicagoChallengeWindow(now = DateTime.now()) {
    return getChallengeWindowForZone(CHICAGO_ZONE, now);
}

function getRollingCalendarDates(daysAhead = ROLLING_DAYS_AHEAD) {
    const chicagoNow = DateTime.now().setZone(CHICAGO_ZONE);
    const today = chicagoNow.startOf('day');

    const dates = [];

    for (let i = 0; i <= daysAhead; i++) {
        dates.push(today.plus({ days: i }).toISODate());
    }

    return dates;
}

function normalizeDateValue(value) {
    if (!value) return null;

    if (typeof value === 'string') {
        return value.slice(0, 10);
    }

    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }

    return String(value).slice(0, 10);
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
        discipline: 'Genealogy & Value-Critique',
    },
    aurelius: {
        id: 'aurelius',
        name: 'Marcus Aurelius',
        era: '121–180 AD',
        discipline: 'Stoic Discipline',
    },
    jung: {
        id: 'jung',
        name: 'Carl Jung',
        era: '1875–1961',
        discipline: 'Depth Psychology',
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
        discipline: 'Virtue & Practical Reason',
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

function getWeekdayPhilosopherId(dateString) {
    const dow = DateTime.fromISO(dateString, { zone: CHICAGO_ZONE }).weekday;
    return ROTATION[dow] || null;
}

function getPhilosopherForDate(dateString) {
    const date = DateTime.fromISO(dateString, { zone: CHICAGO_ZONE });
    const dow = date.weekday;

    if (dow === 7) {
        const previousDayId = getWeekdayPhilosopherId(date.minus({ days: 1 }).toISODate());
        const nextDayId = getWeekdayPhilosopherId(date.plus({ days: 1 }).toISODate());

        const forbidden = new Set([previousDayId, nextDayId].filter(Boolean));
        const candidates = ALL_PHILOSOPHER_IDS.filter(id => !forbidden.has(id));

        const hash = stableHashString(dateString);
        const id = candidates[hash % candidates.length] || 'socrates';

        return PHILOSOPHERS[id] ?? PHILOSOPHERS.socrates;
    }

    return PHILOSOPHERS[ROTATION[dow]] ?? PHILOSOPHERS.socrates;
}

// ─── Question modes ───────────────────────────────────────────────────────────
// Source ideas rotate per philosopher.
// Question modes rotate globally across recent Daily Challenges.

const QUESTION_MODES = {
    defend_a_definition: {
        id: 'defend_a_definition',
        label: 'Defend a Definition',
        instruction:
            'Frame a neutral philosophical question whose disagreement turns on how a key term should be understood.',
        goodShape:
            'Make the definition itself contestable so the user can choose and defend their own understanding.',
        avoid:
            'Do not tell the user what definition to adopt, what side to defend, or what answer is correct.',
    },
    take_a_side: {
        id: 'take_a_side',
        label: 'Take a Side',
        instruction:
            'Present a clear source-grounded tension between two defensible positions and let the user choose either side.',
        goodShape:
            'Use a concise either-or or yes-no tension where both answers can support a serious argument.',
        avoid:
            'Do not assign the user a side or imply that one answer is the required position.',
    },
    self_audit: {
        id: 'self_audit',
        label: 'Self-Audit',
        instruction:
            'Turn the source idea into a concise personal question that still allows more than one defensible answer.',
        goodShape:
            'Make the question personally relevant without telling the user what their experience means.',
        avoid:
            'Do not become generic journaling, self-help, or a command to confess a predetermined flaw.',
    },
    steelman_the_opposite: {
        id: 'steelman_the_opposite',
        label: 'Steelman the Opposite',
        instruction:
            'Present two strong opposing interpretations of the source tension, but let the user freely choose which one to defend.',
        goodShape:
            'Make both sides intellectually credible enough that choosing either creates a real debate.',
        avoid:
            'Do not tell the user to defend the opposite side, resist their instinct, or take any predetermined position.',
    },
    concrete_case: {
        id: 'concrete_case',
        label: 'Concrete Case',
        instruction:
            'Express the source idea through one concise concrete tension or situation and let the user judge it.',
        goodShape:
            'Ask a short question about a recognizable choice, action, relationship, judgment, or conflict.',
        avoid:
            'Do not require a specific personal disclosure or tell the user what conclusion to defend.',
    },
    moral_trial: {
        id: 'moral_trial',
        label: 'Moral Trial',
        instruction:
            'Put a belief, motive, value, excuse, desire, resentment, ambition, or fear under philosophical pressure without presuming guilt.',
        goodShape:
            'Ask whether the challenged motive or value is justified, corrupting, virtuous, truthful, or defensible.',
        avoid:
            'Do not accuse the user, assign guilt, or force them to defend a predetermined side.',
    },
};

const QUESTION_MODE_IDS = Object.keys(QUESTION_MODES);

const VALID_DIFFICULTIES = new Set([
    'Accessible',
    'Challenging',
    'Demanding',
]);

function getScheduledDifficulty(dateString) {
    const dow = DateTime.fromISO(dateString, { zone: CHICAGO_ZONE }).weekday;

    if (dow >= 1 && dow <= 3) return 'Accessible';
    if (dow >= 4 && dow <= 5) return 'Challenging';
    return 'Demanding';
}

// ─── Source-grounded idea pool ────────────────────────────────────────────────
// These are paraphrased source ideas, not invented modern opinions.
// Modern relevance is application, not foundation.
// Optional modes: [...] can restrict awkward source/mode pairings.

const SOURCE_IDEAS = {
    socrates: [
        {
            key: 'socrates-apology-examined-life',
            work: 'Apology',
            reference: 'Plato, Apology',
            concept: 'The Examined Life',
            sourceIdea: 'Socrates argues that a life without examination is not worthy of a human being.',
            debateAngle: 'whether self-questioning is necessary for a good life',
        },
        {
            key: 'socrates-apology-wisdom-ignorance',
            work: 'Apology',
            reference: 'Plato, Apology',
            concept: 'Wisdom and Ignorance',
            sourceIdea: 'Socrates presents wisdom as recognizing the limits of one’s own knowledge.',
            debateAngle: 'whether admitting ignorance is a form of wisdom',
        },
        {
            key: 'socrates-crito-law-obedience',
            work: 'Crito',
            reference: 'Plato, Crito',
            concept: 'Justice and the Laws',
            sourceIdea: 'Socrates refuses escape because he believes one should not answer injustice with injustice.',
            debateAngle: 'whether moral duty can require accepting an unfair consequence',
        },
        {
            key: 'socrates-euthyphro-piety',
            work: 'Euthyphro',
            reference: 'Plato, Euthyphro',
            concept: 'Piety and Definition',
            sourceIdea: 'Socrates presses Euthyphro to define piety rather than rely on confidence or social approval.',
            debateAngle: 'whether people truly understand the moral words they use',
            modes: ['defend_a_definition', 'take_a_side', 'concrete_case', 'moral_trial'],
        },
        {
            key: 'socrates-meno-virtue-teachable',
            work: 'Meno',
            reference: 'Plato, Meno',
            concept: 'Can Virtue Be Taught?',
            sourceIdea: 'Socrates investigates whether virtue is knowledge, habit, nature, or something else.',
            debateAngle: 'whether good character can actually be taught',
        },
        {
            key: 'socrates-gorgias-rhetoric-truth',
            work: 'Gorgias',
            reference: 'Plato, Gorgias',
            concept: 'Rhetoric and Truth',
            sourceIdea: 'Socrates challenges rhetoric that persuades without knowledge of what is truly good.',
            debateAngle: 'whether persuasion without truth corrupts the soul',
        },
        {
            key: 'socrates-gorgias-suffering-injustice',
            work: 'Gorgias',
            reference: 'Plato, Gorgias',
            concept: 'Doing Wrong vs. Suffering Wrong',
            sourceIdea: 'Socrates argues that doing injustice is worse for the soul than suffering injustice.',
            debateAngle: 'whether harming others damages the wrongdoer more deeply than the victim',
        },
        {
            key: 'socrates-apology-fear-of-death',
            work: 'Apology',
            reference: 'Plato, Apology',
            concept: 'Fear of Death',
            sourceIdea: 'Socrates suggests that fearing death may be pretending to know what one does not know.',
            debateAngle: 'whether fear is often false knowledge disguised as certainty',
        },
        {
            key: 'socrates-laches-courage-definition',
            work: 'Laches',
            reference: 'Plato, Laches',
            concept: 'Courage and Definition',
            sourceIdea: 'Socrates challenges confident claims about courage by asking what courage itself is.',
            debateAngle: 'whether people praise courage without knowing what courage means',
            modes: ['defend_a_definition', 'take_a_side', 'concrete_case', 'moral_trial'],
        },
        {
            key: 'socrates-charmides-temperance',
            work: 'Charmides',
            reference: 'Plato, Charmides',
            concept: 'Temperance and Self-Knowledge',
            sourceIdea: 'Socrates investigates whether temperance involves knowing oneself and the limits of one’s knowledge.',
            debateAngle: 'whether self-control requires self-knowledge',
        },
        {
            key: 'socrates-protagoras-virtue-unity',
            work: 'Protagoras',
            reference: 'Plato, Protagoras',
            concept: 'Unity of Virtue',
            sourceIdea: 'Socrates presses whether virtues such as courage, justice, wisdom, and temperance can truly be separated.',
            debateAngle: 'whether a person can possess one virtue while lacking the others',
        },
        {
            key: 'socrates-protagoras-akrasia-knowledge',
            work: 'Protagoras',
            reference: 'Plato, Protagoras',
            concept: 'Knowledge and Weakness',
            sourceIdea: 'Socrates questions whether people knowingly choose what is bad when they understand the good.',
            debateAngle: 'whether wrongdoing comes from ignorance or from weakness of will',
        },
        {
            key: 'socrates-hippias-major-beauty',
            work: 'Hippias Major',
            reference: 'Plato, Hippias Major',
            concept: 'What Is Beauty?',
            sourceIdea: 'Socrates exposes the difficulty of defining beauty rather than merely naming beautiful things.',
            debateAngle: 'whether people confuse examples with definitions',
            modes: ['defend_a_definition', 'take_a_side', 'concrete_case'],
        },
        {
            key: 'socrates-ion-expertise-inspiration',
            work: 'Ion',
            reference: 'Plato, Ion',
            concept: 'Expertise and Inspiration',
            sourceIdea: 'Socrates questions whether a performer speaks from knowledge or from inspiration without understanding.',
            debateAngle: 'whether eloquence proves understanding',
        },
        {
            key: 'socrates-apology-public-opinion',
            work: 'Apology',
            reference: 'Plato, Apology',
            concept: 'Public Opinion and Integrity',
            sourceIdea: 'Socrates refuses to abandon philosophy merely because the city condemns him.',
            debateAngle: 'whether one should obey conscience when public opinion turns hostile',
        },
        {
            key: 'socrates-crito-social-contract',
            work: 'Crito',
            reference: 'Plato, Crito',
            concept: 'Obligation to the City',
            sourceIdea: 'Socrates argues that benefiting from a city’s laws creates obligations even when those laws harm him.',
            debateAngle: 'whether receiving benefits creates duties one cannot abandon when convenient',
        },
        {
            key: 'socrates-gorgias-flattery-craft',
            work: 'Gorgias',
            reference: 'Plato, Gorgias',
            concept: 'Flattery vs. True Craft',
            sourceIdea: 'Socrates distinguishes genuine crafts that improve the soul from flattering practices that merely please.',
            debateAngle: 'whether pleasure can imitate goodness while corrupting judgment',
        },
        {
            key: 'socrates-gorgias-punishment-medicine',
            work: 'Gorgias',
            reference: 'Plato, Gorgias',
            concept: 'Punishment and the Soul',
            sourceIdea: 'Socrates compares just punishment to medicine for a diseased soul.',
            debateAngle: 'whether being corrected is sometimes better than escaping consequences',
        },
        {
            key: 'socrates-apology-care-of-soul',
            work: 'Apology',
            reference: 'Plato, Apology',
            concept: 'Care of the Soul',
            sourceIdea: 'Socrates urges people to care less for wealth and reputation than for the condition of the soul.',
            debateAngle: 'whether success matters if the soul is neglected',
        },
        {
            key: 'socrates-meno-recollection-inquiry',
            work: 'Meno',
            reference: 'Plato, Meno',
            concept: 'Inquiry and Perplexity',
            sourceIdea: 'Socrates treats perplexity not as failure but as the beginning of real inquiry.',
            debateAngle: 'whether confusion is an obstacle to learning or the doorway into it',
        },
    ],

    plato: [
        {
            key: 'plato-republic-cave',
            work: 'Republic',
            reference: 'Republic, Book VII',
            concept: 'Allegory of the Cave',
            sourceIdea: 'Plato describes people mistaking shadows and appearances for reality.',
            debateAngle: 'whether people prefer comforting appearances over difficult truth',
        },
        {
            key: 'plato-republic-tripartite-soul',
            work: 'Republic',
            reference: 'Republic, Book IV',
            concept: 'Tripartite Soul',
            sourceIdea: 'Plato divides the soul into reason, spirit, and appetite, arguing that justice requires proper order within the soul.',
            debateAngle: 'whether reason should rule desire',
        },
        {
            key: 'plato-republic-philosopher-king',
            work: 'Republic',
            reference: 'Republic, Books V–VII',
            concept: 'Philosopher Ruler',
            sourceIdea: 'Plato argues that political life is disordered when rulers lack wisdom and philosophers lack power.',
            debateAngle: 'whether wisdom or popularity should qualify someone to lead',
        },
        {
            key: 'plato-republic-justice-city-soul',
            work: 'Republic',
            reference: 'Republic, Books II–IV',
            concept: 'Justice in the Soul',
            sourceIdea: 'Plato explores justice by comparing the order of the city to the order of the individual soul.',
            debateAngle: 'whether justice begins inside the person before it appears in society',
        },
        {
            key: 'plato-phaedrus-chariot',
            work: 'Phaedrus',
            reference: 'Phaedrus',
            concept: 'The Charioteer and the Soul',
            sourceIdea: 'Plato portrays the soul as a charioteer struggling to guide noble and unruly forces within itself.',
            debateAngle: 'whether self-mastery requires directing desire rather than destroying it',
        },
        {
            key: 'plato-symposium-love-ladder',
            work: 'Symposium',
            reference: 'Symposium',
            concept: 'The Ladder of Love',
            sourceIdea: 'Plato presents love as a movement from attraction to beautiful bodies toward love of beauty itself.',
            debateAngle: 'whether love should lift people toward truth or trap them in desire',
        },
        {
            key: 'plato-phaedo-body-soul',
            work: 'Phaedo',
            reference: 'Phaedo',
            concept: 'Body and Soul',
            sourceIdea: 'Plato suggests that bodily desires can distract the soul from the pursuit of truth.',
            debateAngle: 'whether desire prevents people from seeing clearly',
        },
        {
            key: 'plato-theaetetus-knowledge',
            work: 'Theaetetus',
            reference: 'Theaetetus',
            concept: 'What Is Knowledge?',
            sourceIdea: 'Plato investigates whether knowledge is perception, true judgment, or something more secure.',
            debateAngle: 'whether seeing and believing are enough to count as knowing',
            modes: ['defend_a_definition', 'take_a_side', 'concrete_case'],
        },
        {
            key: 'plato-republic-noble-lie',
            work: 'Republic',
            reference: 'Republic, Book III',
            concept: 'Noble Lie',
            sourceIdea: 'Plato considers whether a founding myth can preserve civic order.',
            debateAngle: 'whether a useful falsehood can ever serve justice',
        },
        {
            key: 'plato-republic-thrasymachus-justice',
            work: 'Republic',
            reference: 'Republic, Book I',
            concept: 'Justice and Advantage',
            sourceIdea: 'Plato has Thrasymachus claim that justice is the advantage of the stronger, a view Socrates challenges.',
            debateAngle: 'whether justice is real or merely power disguised as morality',
        },
        {
            key: 'plato-republic-gyges-ring',
            work: 'Republic',
            reference: 'Republic, Book II',
            concept: 'Ring of Gyges',
            sourceIdea: 'Plato uses the Ring of Gyges to ask whether people would remain just if they could act without consequence.',
            debateAngle: 'whether morality survives when no one is watching',
        },
        {
            key: 'plato-republic-tyrannical-soul',
            work: 'Republic',
            reference: 'Republic, Book IX',
            concept: 'The Tyrannical Soul',
            sourceIdea: 'Plato portrays tyranny as disorder in the soul ruled by lawless desire.',
            debateAngle: 'whether unchecked desire makes a person powerful or enslaved',
        },
        {
            key: 'plato-republic-education-turning-soul',
            work: 'Republic',
            reference: 'Republic, Book VII',
            concept: 'Education as Turning the Soul',
            sourceIdea: 'Plato describes education not as inserting knowledge but as turning the soul toward what is real.',
            debateAngle: 'whether learning requires conversion of attention more than information',
        },
        {
            key: 'plato-republic-poetry-imitation',
            work: 'Republic',
            reference: 'Republic, Book X',
            concept: 'Poetry and Imitation',
            sourceIdea: 'Plato worries that imitative art can inflame emotion and pull the soul away from reason.',
            debateAngle: 'whether art reveals truth or seduces people into illusion',
        },
        {
            key: 'plato-gorgias-pleasure-good',
            work: 'Gorgias',
            reference: 'Gorgias',
            concept: 'Pleasure and the Good',
            sourceIdea: 'Plato distinguishes what is pleasant from what is genuinely good for the soul.',
            debateAngle: 'whether pleasure is a reliable guide to the good',
        },
        {
            key: 'plato-phaedo-philosophy-death',
            work: 'Phaedo',
            reference: 'Phaedo',
            concept: 'Philosophy as Preparation for Death',
            sourceIdea: 'Plato portrays philosophy as training the soul to loosen its dependence on bodily attachments.',
            debateAngle: 'whether philosophy should detach people from ordinary desires',
        },
        {
            key: 'plato-meno-true-opinion-knowledge',
            work: 'Meno',
            reference: 'Meno',
            concept: 'True Opinion and Knowledge',
            sourceIdea: 'Plato distinguishes true opinion from knowledge that is tied down by an account.',
            debateAngle: 'whether being right is enough if one cannot explain why',
        },
        {
            key: 'plato-timaeus-order-cosmos',
            work: 'Timaeus',
            reference: 'Timaeus',
            concept: 'Order and Cosmos',
            sourceIdea: 'Plato presents reality as intelligibly ordered rather than chaotic accident.',
            debateAngle: 'whether seeing order in life clarifies responsibility or imposes false meaning',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
        {
            key: 'plato-laws-law-character',
            work: 'Laws',
            reference: 'Laws',
            concept: 'Law and Character Formation',
            sourceIdea: 'Plato treats law as a teacher that shapes citizens’ habits and souls.',
            debateAngle: 'whether laws should merely restrain behavior or form character',
        },
        {
            key: 'plato-parmenides-forms-difficulty',
            work: 'Parmenides',
            reference: 'Parmenides',
            concept: 'The Difficulty of Forms',
            sourceIdea: 'Plato tests his own theory of Forms through serious objections.',
            debateAngle: 'whether a philosophy is stronger when it can survive attacks from within',
            modes: ['take_a_side', 'steelman_the_opposite', 'concrete_case'],
        },
    ],

    aristotle: [
        {
            key: 'aristotle-nicomachean-ethics-eudaimonia',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book I',
            concept: 'Eudaimonia',
            sourceIdea: 'Aristotle argues that the highest human good is flourishing through rational activity in accordance with virtue.',
            debateAngle: 'whether happiness is pleasure, success, or a life lived excellently',
        },
        {
            key: 'aristotle-nicomachean-ethics-habit',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book II',
            concept: 'Virtue as Habit',
            sourceIdea: 'Aristotle argues that virtues are formed through repeated action rather than mere intention.',
            debateAngle: 'whether people become good by what they repeatedly do',
        },
        {
            key: 'aristotle-nicomachean-ethics-golden-mean',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book II',
            concept: 'The Golden Mean',
            sourceIdea: 'Aristotle describes virtue as finding the mean between excess and deficiency relative to the situation.',
            debateAngle: 'whether moderation is strength or compromise',
        },
        {
            key: 'aristotle-nicomachean-ethics-friendship',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Books VIII–IX',
            concept: 'Friendship',
            sourceIdea: 'Aristotle distinguishes friendships of utility, pleasure, and virtue.',
            debateAngle: 'whether most relationships are based on usefulness, pleasure, or genuine goodness',
        },
        {
            key: 'aristotle-nicomachean-ethics-akrasia',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book VII',
            concept: 'Weakness of Will',
            sourceIdea: 'Aristotle examines why people sometimes act against what they know is better.',
            debateAngle: 'whether knowledge is enough to overcome desire',
        },
        {
            key: 'aristotle-politics-human-political-animal',
            work: 'Politics',
            reference: 'Politics, Book I',
            concept: 'Human Beings as Political Animals',
            sourceIdea: 'Aristotle argues that human beings naturally live in communities shaped by speech, justice, and shared life.',
            debateAngle: 'whether a person can flourish alone',
        },
        {
            key: 'aristotle-rhetoric-ethos-pathos-logos',
            work: 'Rhetoric',
            reference: 'Rhetoric',
            concept: 'Ethos, Pathos, and Logos',
            sourceIdea: 'Aristotle explains persuasion through character, emotion, and reason.',
            debateAngle: 'whether people are persuaded more by truth, emotion, or trust',
        },
        {
            key: 'aristotle-poetics-catharsis',
            work: 'Poetics',
            reference: 'Poetics',
            concept: 'Tragedy and Catharsis',
            sourceIdea: 'Aristotle presents tragedy as a structured imitation of action that evokes pity and fear.',
            debateAngle: 'whether art helps people understand suffering better than argument does',
        },
        {
            key: 'aristotle-nicomachean-ethics-choice',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book III',
            concept: 'Choice and Responsibility',
            sourceIdea: 'Aristotle treats voluntary action and deliberate choice as central to moral responsibility.',
            debateAngle: 'whether people are responsible for choices shaped by habit and circumstance',
        },
        {
            key: 'aristotle-nicomachean-ethics-practical-wisdom',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book VI',
            concept: 'Practical Wisdom',
            sourceIdea: 'Aristotle distinguishes practical wisdom from cleverness and abstract knowledge.',
            debateAngle: 'whether knowing principles matters without judging the concrete situation well',
        },
        {
            key: 'aristotle-nicomachean-ethics-pleasure',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book X',
            concept: 'Pleasure and the Good Life',
            sourceIdea: 'Aristotle argues that pleasure completes activity but should be judged by the quality of the activity.',
            debateAngle: 'whether pleasure proves that an activity is good',
        },
        {
            key: 'aristotle-nicomachean-ethics-magnanimity',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book IV',
            concept: 'Greatness of Soul',
            sourceIdea: 'Aristotle describes the great-souled person as worthy of great things and rightly aware of that worth.',
            debateAngle: 'whether humility or accurate self-worth is closer to virtue',
        },
        {
            key: 'aristotle-nicomachean-ethics-justice',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book V',
            concept: 'Justice as Complete Virtue',
            sourceIdea: 'Aristotle treats justice as virtue in relation to others, not merely rule-following.',
            debateAngle: 'whether justice is measured by law or by giving others what is due',
        },
        {
            key: 'aristotle-politics-household-city',
            work: 'Politics',
            reference: 'Politics, Book I',
            concept: 'Household and City',
            sourceIdea: 'Aristotle sees the household and city as ordered communities aimed at human life and flourishing.',
            debateAngle: 'whether private life can be separated from public virtue',
        },
        {
            key: 'aristotle-politics-middle-constitution',
            work: 'Politics',
            reference: 'Politics, Book IV',
            concept: 'The Middle Class and Stability',
            sourceIdea: 'Aristotle argues that political stability often depends on a strong middle element rather than extremes.',
            debateAngle: 'whether moderation in civic life is wisdom or weakness',
        },
        {
            key: 'aristotle-metaphysics-four-causes',
            work: 'Metaphysics',
            reference: 'Metaphysics',
            concept: 'Four Causes',
            sourceIdea: 'Aristotle explains things through material, formal, efficient, and final causes.',
            debateAngle: 'whether understanding something requires knowing its purpose',
            coreClaim: 'A complete explanation can include what something is for, its end or final cause.',
            allowedApplication: 'Artifacts such as tools or phones may be used as concrete analogies because their functions help explain what they are.',
            avoidOverclaim: 'Do not reduce Aristotle to the slogan that everything happens for a reason, and do not treat artifact purpose and natural teleology as identical.',
            modes: ['take_a_side', 'concrete_case', 'self_audit'],
        },
        {
            key: 'aristotle-physics-telos-nature',
            work: 'Physics',
            reference: 'Physics',
            concept: 'Nature and Purpose',
            sourceIdea: 'Aristotle often explains natural things by the ends toward which they develop.',
            debateAngle: 'whether human life can be understood without a purpose or end',
            coreClaim: 'Aristotle explains many natural processes partly through the ends toward which natural beings characteristically develop.',
            allowedApplication: 'The question may test whether function, development, or an end helps explain a natural being or a human life.',
            avoidOverclaim: 'Do not claim that every event is destined, that every accident has a purpose, or that Aristotle teaches a modern cosmic everything-happens-for-a-reason doctrine.',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
        {
            key: 'aristotle-rhetoric-character-proof',
            work: 'Rhetoric',
            reference: 'Rhetoric',
            concept: 'Character as Persuasion',
            sourceIdea: 'Aristotle treats the speaker’s character as one of the strongest means of persuasion.',
            debateAngle: 'whether trust in the speaker should affect trust in the argument',
        },
        {
            key: 'aristotle-poetics-recognition-reversal',
            work: 'Poetics',
            reference: 'Poetics',
            concept: 'Recognition and Reversal',
            sourceIdea: 'Aristotle sees recognition and reversal as powerful features of tragic understanding.',
            debateAngle: 'whether painful reversals reveal truths ordinary success hides',
        },
        {
            key: 'aristotle-nicomachean-ethics-contemplation',
            work: 'Nicomachean Ethics',
            reference: 'Nicomachean Ethics, Book X',
            concept: 'Contemplation',
            sourceIdea: 'Aristotle presents contemplation as the highest activity because it most fully exercises reason.',
            debateAngle: 'whether the best life is active achievement, moral virtue, or contemplation',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
    ],

    aurelius: [
        {
            key: 'aurelius-meditations-control',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Control and Judgment',
            sourceIdea: 'Marcus Aurelius repeatedly distinguishes what depends on us from what does not.',
            debateAngle: 'whether suffering comes more from events or from judgments about events',
        },
        {
            key: 'aurelius-meditations-impermanence',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Impermanence',
            sourceIdea: 'Marcus Aurelius reflects often on the passing nature of life, fame, pleasure, and pain.',
            debateAngle: 'whether remembering impermanence makes life clearer or darker',
            modes: ['take_a_side', 'self_audit', 'concrete_case', 'moral_trial'],
        },
        {
            key: 'aurelius-meditations-duty',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Duty',
            sourceIdea: 'Marcus Aurelius frames life as a duty to act according to nature, reason, and one’s role.',
            debateAngle: 'whether duty should outweigh mood, comfort, or personal preference',
        },
        {
            key: 'aurelius-meditations-anger',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Anger and Human Nature',
            sourceIdea: 'Marcus Aurelius reminds himself that people do wrong from ignorance and that anger often worsens the soul.',
            debateAngle: 'whether anger is justified when others act wrongly',
        },
        {
            key: 'aurelius-meditations-fame',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Fame and Reputation',
            sourceIdea: 'Marcus Aurelius treats reputation as unstable because it depends on the judgments of others.',
            debateAngle: 'whether caring about reputation is rational or enslaving',
        },
        {
            key: 'aurelius-meditations-inner-citadel',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'The Inner Citadel',
            sourceIdea: 'Marcus Aurelius returns to the idea that the mind can preserve its integrity even under pressure.',
            debateAngle: 'whether inner freedom can survive external chaos',
        },
        {
            key: 'aurelius-meditations-cosmic-perspective',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Cosmic Perspective',
            sourceIdea: 'Marcus Aurelius often views individual troubles from the scale of nature, time, and the whole cosmos.',
            debateAngle: 'whether stepping back from the self brings wisdom or detachment',
        },
        {
            key: 'aurelius-meditations-action-present',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Present Action',
            sourceIdea: 'Marcus Aurelius urges attention to the present act rather than regret, fantasy, or complaint.',
            debateAngle: 'whether the present action is the only real place to practice virtue',
        },
        {
            key: 'aurelius-meditations-morning-reluctance',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Rising to One’s Work',
            sourceIdea: 'Marcus Aurelius rebukes his reluctance to rise by reminding himself he was made to perform human work.',
            debateAngle: 'whether reluctance excuses neglecting one’s duty',
        },
        {
            key: 'aurelius-meditations-obstacle-action',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'The Obstacle and the Action',
            sourceIdea: 'Marcus Aurelius teaches that impediments to action can become material for action.',
            debateAngle: 'whether obstacles excuse failure or become part of virtue’s work',
        },
        {
            key: 'aurelius-meditations-view-from-above',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'View from Above',
            sourceIdea: 'Marcus Aurelius uses distance and scale to reduce vanity, panic, and self-importance.',
            debateAngle: 'whether seeing oneself from above humbles wisely or detaches coldly',
        },
        {
            key: 'aurelius-meditations-death-at-hand',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Death as Moral Urgency',
            sourceIdea: 'Marcus Aurelius repeatedly uses death to focus attention on present virtue.',
            debateAngle: 'whether remembering death makes a person more serious or more despairing',
        },
        {
            key: 'aurelius-meditations-social-being',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Human Beings as Social',
            sourceIdea: 'Marcus Aurelius sees human beings as made for cooperation like parts of one body.',
            debateAngle: 'whether duty to others remains binding when others are difficult',
        },
        {
            key: 'aurelius-meditations-opinion-harm',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Opinion and Harm',
            sourceIdea: 'Marcus Aurelius insists that the mind’s judgment determines whether an event harms the ruling faculty.',
            debateAngle: 'whether insult, loss, or failure harms us before judgment makes it so',
        },
        {
            key: 'aurelius-meditations-revenge',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Revenge and Likeness',
            sourceIdea: 'Marcus Aurelius suggests the best revenge is not to become like the wrongdoer.',
            debateAngle: 'whether retaliation corrupts the person who seeks justice through it',
        },
        {
            key: 'aurelius-meditations-simplicity',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Simplicity of Action',
            sourceIdea: 'Marcus Aurelius urges himself to act simply, justly, and without theatrical self-display.',
            debateAngle: 'whether virtue loses purity when performed for recognition',
        },
        {
            key: 'aurelius-meditations-nature-change',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Change and Nature',
            sourceIdea: 'Marcus Aurelius treats change as nature’s ordinary work rather than a personal insult.',
            debateAngle: 'whether resisting change is a failure to understand nature',
        },
        {
            key: 'aurelius-meditations-ruling-faculty',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'The Ruling Faculty',
            sourceIdea: 'Marcus Aurelius emphasizes guarding the ruling faculty that judges, chooses, and assents.',
            debateAngle: 'whether protecting attention and judgment is the core of self-command',
        },
        {
            key: 'aurelius-meditations-praise-blame',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Praise and Blame',
            sourceIdea: 'Marcus Aurelius reminds himself that praise and blame come from people who are themselves confused and mortal.',
            debateAngle: 'whether reputation deserves authority over one’s conduct',
        },
        {
            key: 'aurelius-meditations-complaint',
            work: 'Meditations',
            reference: 'Meditations',
            concept: 'Complaint and Discipline',
            sourceIdea: 'Marcus Aurelius repeatedly cuts off complaint by returning to what reason and duty require now.',
            debateAngle: 'whether complaint reveals injustice or failure to govern the self',
        },
    ],

    nietzsche: [
        {
            key: 'nietzsche-zarathustra-overman',
            work: 'Thus Spoke Zarathustra',
            reference: 'Thus Spoke Zarathustra',
            concept: 'Self-Overcoming',
            sourceIdea: 'Nietzsche presents human greatness as something created through overcoming oneself.',
            debateAngle: 'whether a person should seek comfort or transformation',
        },
        {
            key: 'nietzsche-genealogy-ressentiment',
            work: 'On the Genealogy of Morality',
            reference: 'Genealogy of Morality, First Essay',
            concept: 'Ressentiment',
            sourceIdea: 'Nietzsche analyzes how resentment can disguise itself as moral judgment.',
            debateAngle: 'whether moral criticism can hide envy or weakness',
        },
        {
            key: 'nietzsche-genealogy-ascetic-ideal',
            work: 'On the Genealogy of Morality',
            reference: 'Genealogy of Morality, Third Essay',
            concept: 'The Ascetic Ideal',
            sourceIdea: 'Nietzsche examines why people may give meaning to suffering by denying life, desire, and strength.',
            debateAngle: 'whether suffering should be denied, explained, or transformed',
        },
        {
            key: 'nietzsche-gay-science-death-of-god',
            work: 'The Gay Science',
            reference: 'The Gay Science',
            concept: 'The Death of God',
            sourceIdea: 'Nietzsche presents the death of God as a crisis in which inherited values lose their authority.',
            debateAngle: 'whether people can create values after inherited certainty collapses',
        },
        {
            key: 'nietzsche-beyond-good-evil-herd',
            work: 'Beyond Good and Evil',
            reference: 'Beyond Good and Evil',
            concept: 'Herd Morality',
            sourceIdea: 'Nietzsche criticizes morality that rewards conformity and suspicion of excellence.',
            debateAngle: 'whether belonging to the group weakens independent judgment',
        },
        {
            key: 'nietzsche-twilight-idols-self-creation',
            work: 'Twilight of the Idols',
            reference: 'Twilight of the Idols',
            concept: 'Becoming Who You Are',
            sourceIdea: 'Nietzsche emphasizes discipline, style, and self-formation rather than passive acceptance of oneself.',
            debateAngle: 'whether authenticity is discovered or created',
        },
        {
            key: 'nietzsche-gay-science-eternal-recurrence',
            work: 'The Gay Science',
            reference: 'The Gay Science',
            concept: 'Eternal Recurrence',
            sourceIdea: 'Nietzsche asks whether one could affirm life so fully that one would will its repetition.',
            debateAngle: 'whether your current life is one you could honestly choose again',
        },
        {
            key: 'nietzsche-zarathustra-last-man',
            work: 'Thus Spoke Zarathustra',
            reference: 'Thus Spoke Zarathustra',
            concept: 'The Last Man',
            sourceIdea: 'Nietzsche portrays the last man as someone who wants comfort, safety, and small pleasures above greatness.',
            debateAngle: 'whether comfort can become spiritual decline',
        },
        {
            key: 'nietzsche-genealogy-master-slave',
            work: 'On the Genealogy of Morality',
            reference: 'Genealogy of Morality, First Essay',
            concept: 'Master and Slave Moralities',
            sourceIdea: 'Nietzsche contrasts value-creation from strength with value-creation born from reaction against strength.',
            debateAngle: 'whether your values are created from power or reaction',
        },
        {
            key: 'nietzsche-beyond-good-evil-free-spirit',
            work: 'Beyond Good and Evil',
            reference: 'Beyond Good and Evil',
            concept: 'Free Spirit',
            sourceIdea: 'Nietzsche praises spirits willing to question inherited morality and intellectual comfort.',
            debateAngle: 'whether independence of mind requires solitude from common values',
        },
        {
            key: 'nietzsche-beyond-good-evil-will-to-truth',
            work: 'Beyond Good and Evil',
            reference: 'Beyond Good and Evil',
            concept: 'Will to Truth',
            sourceIdea: 'Nietzsche asks why truth is valued over illusion, comfort, or appearance.',
            debateAngle: 'whether people truly want truth or only truths that serve life',
        },
        {
            key: 'nietzsche-gay-science-joyful-wisdom',
            work: 'The Gay Science',
            reference: 'The Gay Science',
            concept: 'Joyful Wisdom',
            sourceIdea: 'Nietzsche links seriousness with dance, laughter, experiment, and intellectual courage.',
            debateAngle: 'whether wisdom must be heavy or can become joyful and dangerous',
        },
        {
            key: 'nietzsche-twilight-idols-idols',
            work: 'Twilight of the Idols',
            reference: 'Twilight of the Idols',
            concept: 'Idols',
            sourceIdea: 'Nietzsche attacks revered ideals that survive because people have stopped questioning them.',
            debateAngle: 'whether your highest ideal is alive or merely an idol you inherited',
        },
        {
            key: 'nietzsche-antichrist-pity',
            work: 'The Antichrist',
            reference: 'The Antichrist',
            concept: 'Pity',
            sourceIdea: 'Nietzsche criticizes pity when it preserves weakness or masks superiority.',
            debateAngle: 'whether compassion can sometimes conceal contempt or love of weakness',
        },
        {
            key: 'nietzsche-genealogy-bad-conscience',
            work: 'On the Genealogy of Morality',
            reference: 'Genealogy of Morality, Second Essay',
            concept: 'Bad Conscience',
            sourceIdea: 'Nietzsche describes bad conscience as instinct turned inward when outward expression is constrained.',
            debateAngle: 'whether guilt can be internalized aggression rather than moral insight',
        },
        {
            key: 'nietzsche-zarathustra-three-metamorphoses',
            work: 'Thus Spoke Zarathustra',
            reference: 'Thus Spoke Zarathustra',
            concept: 'Three Metamorphoses',
            sourceIdea: 'Nietzsche describes the spirit becoming camel, lion, and child in the movement from burden to freedom to creation.',
            debateAngle: 'whether you are still carrying inherited burdens, merely rebelling, or creating',
        },
        {
            key: 'nietzsche-ecce-homo-amor-fati',
            work: 'Ecce Homo',
            reference: 'Ecce Homo',
            concept: 'Amor Fati',
            sourceIdea: 'Nietzsche presents amor fati as loving one’s fate rather than merely enduring it.',
            debateAngle: 'whether you can affirm the necessary parts of your life without resentment',
        },
        {
            key: 'nietzsche-gay-science-live-dangerously',
            work: 'The Gay Science',
            reference: 'The Gay Science',
            concept: 'Living Dangerously',
            sourceIdea: 'Nietzsche praises risk, experiment, and exposure over protected comfort.',
            debateAngle: 'whether safety has become an excuse for spiritual smallness',
        },
        {
            key: 'nietzsche-beyond-good-evil-rank',
            work: 'Beyond Good and Evil',
            reference: 'Beyond Good and Evil',
            concept: 'Order of Rank',
            sourceIdea: 'Nietzsche argues that souls, values, and ways of life may differ in rank rather than equal worth.',
            debateAngle: 'whether all values deserve equal respect or some reveal higher strength',
        },
        {
            key: 'nietzsche-zarathustra-contemptible-comfort',
            work: 'Thus Spoke Zarathustra',
            reference: 'Thus Spoke Zarathustra',
            concept: 'Contempt and Aspiration',
            sourceIdea: 'Nietzsche uses contempt for one’s present smallness as a spur toward overcoming.',
            debateAngle: 'whether dissatisfaction with oneself is sickness or the beginning of growth',
        },
    ],

    jung: [
        {
            key: 'jung-archetypes-shadow',
            work: 'Aion',
            reference: 'Aion',
            concept: 'The Shadow',
            sourceIdea: 'Jung describes the shadow as the rejected or unconscious side of the personality.',
            debateAngle: 'whether what people condemn in others often reveals what they refuse to face in themselves',
        },
        {
            key: 'jung-psychological-types-persona',
            work: 'Psychological Types',
            reference: 'Psychological Types',
            concept: 'Persona',
            sourceIdea: 'Jung uses persona to describe the social mask through which a person adapts to the world.',
            debateAngle: 'whether the identity people show publicly can become a prison',
        },
        {
            key: 'jung-archetypes-collective-unconscious',
            work: 'The Archetypes and the Collective Unconscious',
            reference: 'The Archetypes and the Collective Unconscious',
            concept: 'Collective Unconscious',
            sourceIdea: 'Jung argues that the psyche contains inherited patterns and images deeper than personal experience.',
            debateAngle: 'whether human beings are shaped by patterns they did not personally choose',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
        {
            key: 'jung-memories-dreams-individuation',
            work: 'Memories, Dreams, Reflections',
            reference: 'Memories, Dreams, Reflections',
            concept: 'Individuation',
            sourceIdea: 'Jung presents individuation as the difficult process of becoming a more whole and integrated self.',
            debateAngle: 'whether becoming yourself requires confronting what you fear within yourself',
        },
        {
            key: 'jung-modern-man-search-soul',
            work: 'Modern Man in Search of a Soul',
            reference: 'Modern Man in Search of a Soul',
            concept: 'Modern Spiritual Emptiness',
            sourceIdea: 'Jung explores the psychological cost of modern people losing contact with meaning, symbol, and the depths of the psyche.',
            debateAngle: 'whether modern life makes people more rational or more spiritually fragmented',
        },
        {
            key: 'jung-two-essays-projection',
            work: 'Two Essays on Analytical Psychology',
            reference: 'Two Essays on Analytical Psychology',
            concept: 'Projection',
            sourceIdea: 'Jung describes projection as seeing unconscious contents in other people rather than recognizing them in oneself.',
            debateAngle: 'whether strong reactions to others often reveal hidden parts of the self',
        },
        {
            key: 'jung-undiscovered-self-mass-society',
            work: 'The Undiscovered Self',
            reference: 'The Undiscovered Self',
            concept: 'The Individual and Mass Society',
            sourceIdea: 'Jung warns that the individual can be swallowed by collective forces when inner life is neglected.',
            debateAngle: 'whether society becomes dangerous when individuals lose their inner grounding',
        },
        {
            key: 'jung-symbols-transformation',
            work: 'Symbols of Transformation',
            reference: 'Symbols of Transformation',
            concept: 'Symbol and Transformation',
            sourceIdea: 'Jung treats symbols as expressions of unconscious transformation rather than decorative images.',
            debateAngle: 'whether symbols reveal truths that ordinary rational language cannot reach',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
        {
            key: 'jung-aion-self',
            work: 'Aion',
            reference: 'Aion',
            concept: 'The Self',
            sourceIdea: 'Jung distinguishes the ego from the Self as a deeper organizing center of psychic wholeness.',
            debateAngle: 'whether the conscious identity is only a partial view of who one is',
            modes: ['take_a_side', 'self_audit', 'concrete_case', 'moral_trial'],
        },
        {
            key: 'jung-psychology-religion-symbol',
            work: 'Psychology and Religion',
            reference: 'Psychology and Religion',
            concept: 'Religious Symbolism',
            sourceIdea: 'Jung studies religious symbols as expressions of psychic realities rather than merely dogmatic claims.',
            debateAngle: 'whether symbols can carry truths the ego does not fully understand',
        },
        {
            key: 'jung-two-essays-neurosis',
            work: 'Two Essays on Analytical Psychology',
            reference: 'Two Essays on Analytical Psychology',
            concept: 'Neurosis and Meaning',
            sourceIdea: 'Jung often treats neurosis as connected to unresolved psychic conflict and blocked development.',
            debateAngle: 'whether symptoms can contain meaning rather than only malfunction',
        },
        {
            key: 'jung-archetypes-anima-animus',
            work: 'The Archetypes and the Collective Unconscious',
            reference: 'The Archetypes and the Collective Unconscious',
            concept: 'Anima and Animus',
            sourceIdea: 'Jung describes inner contrasexual figures as mediators between consciousness and the unconscious.',
            debateAngle: 'whether rejected inner qualities distort relationships with others',
        },
        {
            key: 'jung-modern-man-dreams',
            work: 'Modern Man in Search of a Soul',
            reference: 'Modern Man in Search of a Soul',
            concept: 'Dreams',
            sourceIdea: 'Jung treats dreams as meaningful expressions of unconscious processes rather than random noise.',
            debateAngle: 'whether the unconscious may know what the conscious mind avoids',
        },
        {
            key: 'jung-memories-inner-voice',
            work: 'Memories, Dreams, Reflections',
            reference: 'Memories, Dreams, Reflections',
            concept: 'The Inner Voice',
            sourceIdea: 'Jung presents inner experience as something that must be listened to carefully, not dismissed as irrationality.',
            debateAngle: 'whether inner voices are guidance, danger, fantasy, or ignored truth',
        },
        {
            key: 'jung-undiscovered-self-state',
            work: 'The Undiscovered Self',
            reference: 'The Undiscovered Self',
            concept: 'The State and the Individual',
            sourceIdea: 'Jung warns that collective systems can erase individual conscience and inner responsibility.',
            debateAngle: 'whether belonging to a mass movement weakens self-knowledge',
        },
        {
            key: 'jung-archetypes-mother',
            work: 'The Archetypes and the Collective Unconscious',
            reference: 'The Archetypes and the Collective Unconscious',
            concept: 'The Mother Archetype',
            sourceIdea: 'Jung explores the mother archetype as a deep pattern of origin, protection, dependency, and danger.',
            debateAngle: 'whether early symbolic patterns shape adult expectations of care and safety',
        },
        {
            key: 'jung-psychological-types-one-sidedness',
            work: 'Psychological Types',
            reference: 'Psychological Types',
            concept: 'One-Sidedness',
            sourceIdea: 'Jung argues that overidentifying with one psychological attitude or function can deform the personality.',
            debateAngle: 'whether your greatest strength has become your imbalance',
        },
        {
            key: 'jung-aion-christ-shadow',
            work: 'Aion',
            reference: 'Aion',
            concept: 'Wholeness and Shadow',
            sourceIdea: 'Jung associates psychic wholeness with confronting darkness rather than identifying only with goodness.',
            debateAngle: 'whether trying to be only good can make the shadow more dangerous',
        },
        {
            key: 'jung-symbols-hero',
            work: 'Symbols of Transformation',
            reference: 'Symbols of Transformation',
            concept: 'Hero Pattern',
            sourceIdea: 'Jung analyzes heroic imagery as symbolic of psychic struggle, separation, and transformation.',
            debateAngle: 'whether growth requires a symbolic descent before renewal',
        },
        {
            key: 'jung-memories-mandala',
            work: 'Memories, Dreams, Reflections',
            reference: 'Memories, Dreams, Reflections',
            concept: 'Mandala and Psychic Order',
            sourceIdea: 'Jung sees mandala imagery as expressing the psyche’s movement toward order and wholeness.',
            debateAngle: 'whether the psyche seeks order even when the ego feels fragmented',
            modes: ['take_a_side', 'self_audit', 'concrete_case'],
        },
    ],
};

// ─── Source and mode selection helpers ────────────────────────────────────────

function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function latestUseMap(history, keyName) {
    const map = new Map();

    for (const item of history) {
        const value = item[keyName];

        if (!value) continue;

        const date = normalizeDateValue(item.date || item.challengeDate);

        if (!map.has(value)) {
            map.set(value, date || '0000-00-00');
        }
    }

    return map;
}

function pickLeastRecentlyUsed({
    allItems,
    getId,
    history,
    historyKey,
}) {
    const latest = latestUseMap(history, historyKey);

    const neverUsed = allItems.filter(item => !latest.has(getId(item)));

    if (neverUsed.length > 0) {
        return randomItem(neverUsed);
    }

    const ranked = [...allItems].sort((a, b) => {
        const aDate = latest.get(getId(a)) || '0000-00-00';
        const bDate = latest.get(getId(b)) || '0000-00-00';
        return aDate.localeCompare(bDate);
    });

    const oldestDate = latest.get(getId(ranked[0])) || '0000-00-00';
    const oldestGroup = ranked.filter(item => {
        return (latest.get(getId(item)) || '0000-00-00') === oldestDate;
    });

    return randomItem(oldestGroup);
}

function pickSourceIdea(philosopherId, history) {
    const list = SOURCE_IDEAS[philosopherId] ?? SOURCE_IDEAS.socrates;

    return pickLeastRecentlyUsed({
        allItems: list,
        getId: item => item.key,
        history,
        historyKey: 'sourceKey',
    });
}

function pickQuestionMode(globalHistory, source = null) {
    const allowedModeIds =
        Array.isArray(source?.modes) && source.modes.length > 0
            ? source.modes.filter(id => QUESTION_MODES[id])
            : QUESTION_MODE_IDS;

    const modeObjects = allowedModeIds.map(id => QUESTION_MODES[id]);

    return pickLeastRecentlyUsed({
        allItems: modeObjects,
        getId: item => item.id,
        history: globalHistory,
        historyKey: 'questionMode',
    });
}

// ─── Source fidelity guardrails ──────────────────────────────────────────────

function getSourceGuardrails(source) {
    return {
        coreClaim:
            source?.coreClaim ||
            source?.sourceIdea ||
            'Use only the documented source idea supplied by the backend.',
        allowedApplication:
            source?.allowedApplication ||
            'A modern or personal application is allowed only when it preserves the logical structure of the source idea and does not attribute an unsupported modern opinion to the philosopher.',
        avoidOverclaim:
            source?.avoidOverclaim ||
            'Do not make the philosopher claim more than the supplied source supports. Do not turn a qualified, exploratory, diagnostic, or contextual idea into an absolute slogan.',
    };
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

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const STOP_WORDS = new Set([
    'about',
    'above',
    'after',
    'again',
    'against',
    'alone',
    'among',
    'because',
    'before',
    'being',
    'between',
    'could',
    'does',
    'from',
    'have',
    'into',
    'itself',
    'more',
    'most',
    'only',
    'other',
    'people',
    'person',
    'rather',
    'should',
    'than',
    'that',
    'their',
    'there',
    'these',
    'thing',
    'things',
    'this',
    'through',
    'truth',
    'whether',
    'which',
    'while',
    'with',
    'without',
    'your',
    'you',
]);

function importantTerms(text) {
    return normalizeText(text)
        .split(' ')
        .map(term => term.trim())
        .filter(term => term.length >= 4)
        .filter(term => !STOP_WORDS.has(term));
}

function simpleStem(term) {
    let t = String(term || '').toLowerCase().trim();

    if (t.length <= 4) return t;

    if (t.endsWith('ies') && t.length > 5) {
        return `${t.slice(0, -3)}y`;
    }

    for (const suffix of ['ingly', 'edly', 'ing', 'ed', 'es', 's']) {
        if (t.endsWith(suffix) && t.length - suffix.length >= 4) {
            t = t.slice(0, -suffix.length);
            break;
        }
    }

    return t;
}

function meaningfulStems(text) {
    return [...new Set(importantTerms(text).map(simpleStem).filter(Boolean))];
}

function hasQuestionSourceGrounding(challenge) {
    const sourceStems = new Set(
        meaningfulStems([
            challenge.sourceConcept,
            challenge.sourceIdea,
            challenge.debateAngle,
        ].join(' '))
    );

    if (sourceStems.size === 0) return true;

    const questionStems = meaningfulStems(challenge.challengeQuestion);
    return questionStems.some(term => sourceStems.has(term));
}

function lexicalQuestionSimilarity(a, b) {
    const aTerms = new Set(meaningfulStems(a));
    const bTerms = new Set(meaningfulStems(b));

    if (aTerms.size === 0 || bTerms.size === 0) return 0;

    let intersection = 0;

    for (const term of aTerms) {
        if (bTerms.has(term)) intersection += 1;
    }

    return (2 * intersection) / (aTerms.size + bTerms.size);
}

function findLexicallySimilarRecentQuestion(challengeQuestion, recentQuestions = []) {
    const normalizedCurrent = normalizeText(challengeQuestion);

    for (const item of recentQuestions) {
        const previous = String(item?.challengeQuestion || '').trim();
        if (!previous) continue;

        if (normalizeText(previous) === normalizedCurrent) {
            return { item, score: 1 };
        }

        const score = lexicalQuestionSimilarity(challengeQuestion, previous);

        // This is deliberately conservative. Semantic paraphrases with little
        // word overlap are caught by the second editorial model below.
        if (score >= 0.72) {
            return { item, score };
        }
    }

    return null;
}

function looksTooGeneric(challenge) {
    const question = normalizeText(challenge.challengeQuestion);

    const genericPatterns = [
        'what do you think',
        'how do you feel',
        'what is your opinion',
        'what can you learn',
        'how can you improve',
        'what is holding you back',
        'comfort zone',
        'become your best self',
        'unlock your potential',
    ];

    return genericPatterns.some(pattern => question.includes(pattern));
}

function countChallengeWords(text) {
    return String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .length;
}

function hasExactlyOneQuestionSentence(text) {
    const question = String(text || '').trim();

    if (!question.endsWith('?')) return false;

    const sentenceEndings = question.match(/[.!?](?=\s|$)/g) || [];
    return sentenceEndings.length === 1;
}

function assignsUserPosition(text) {
    const question = normalizeText(text);

    const assignmentPatterns = [
        'defend the first',
        'defend the second',
        'defend this position',
        'defend that position',
        'defend the position',
        'argue that',
        'argue for',
        'argue against',
        'take the side',
        'take this side',
        'choose the first',
        'choose the second',
        'you must defend',
        'you should defend',
        'steelman the opposite',
    ];

    return assignmentPatterns.some(pattern => question.includes(pattern));
}

function validateChallenge(challenge, recentQuestions = []) {
    const required = [
        'id',
        'date',
        'philosopherId',
        'philosopherName',
        'sourceKey',
        'sourceWork',
        'sourceConcept',
        'sourceIdea',
        'challengeQuestion',
        'userPositionPrompt',
        'opposingAngle',
        'difficulty',
        'questionMode',
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

    if (!VALID_DIFFICULTIES.has(challenge.difficulty)) {
        throw new Error(
            `Invalid difficulty "${challenge.difficulty}". Must be Accessible, Challenging, or Demanding.`
        );
    }

    if (!QUESTION_MODES[challenge.questionMode]) {
        throw new Error(`Invalid questionMode: ${challenge.questionMode}`);
    }

    const challengeQuestion = String(challenge.challengeQuestion || '').trim();
    const questionWordCount = countChallengeWords(challengeQuestion);

    if (!hasExactlyOneQuestionSentence(challengeQuestion)) {
        throw new Error(
            'challengeQuestion must be exactly one sentence and must end with a question mark.'
        );
    }

    if (questionWordCount > DAILY_CHALLENGE_MAX_WORDS) {
        throw new Error(
            `challengeQuestion is ${questionWordCount} words. Maximum is ${DAILY_CHALLENGE_MAX_WORDS}.`
        );
    }

    if (assignsUserPosition(challengeQuestion)) {
        throw new Error(
            'challengeQuestion assigns the user a position. The user must choose which side to defend.'
        );
    }

    if (String(challenge.userPositionPrompt || '').trim() !== DAILY_CHALLENGE_POSITION_PROMPT) {
        throw new Error(
            `userPositionPrompt must be exactly: "${DAILY_CHALLENGE_POSITION_PROMPT}"`
        );
    }

    if (looksTooGeneric(challenge)) {
        throw new Error('challengeQuestion appears too generic or self-help oriented.');
    }

    // Lexical overlap is only a first-pass signal. The question itself is checked,
    // never the title/opposingAngle/educationalNote. A faithful paraphrase may
    // have little literal overlap, so the semantic fidelity gate below is the
    // authoritative source-grounding check.
    if (!hasQuestionSourceGrounding(challenge)) {
        console.warn(
            `[DailyChallenge] No direct lexical source overlap in challengeQuestion for ${challenge.sourceConcept}; semantic fidelity gate will decide.`
        );
    }

    const similarRecent = findLexicallySimilarRecentQuestion(
        challengeQuestion,
        recentQuestions
    );

    if (similarRecent) {
        const priorDate =
            similarRecent.item?.date ||
            similarRecent.item?.challengeDate ||
            'a recent date';

        throw new Error(
            `challengeQuestion is too similar to the recent question from ${priorDate} (lexical similarity ${similarRecent.score.toFixed(2)}).`
        );
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

function buildRecentQuestionText(recentQuestions) {
    if (!recentQuestions.length) {
        return 'No recent questions for this philosopher.';
    }

    return recentQuestions
        .map((item, index) => {
            return `${index + 1}. Date: ${item.date} | Work: ${item.sourceWork || 'unknown'} | Concept: ${item.sourceConcept || 'unknown'} | Mode: ${item.questionMode || 'unknown'} | Question: ${item.challengeQuestion}`;
        })
        .join('\n');
}

async function evaluateChallengeFidelity({
    philosopher,
    source,
    challengeQuestion,
    recentQuestions = [],
}) {
    const guardrails = getSourceGuardrails(source);
    const recentQuestionText = buildRecentQuestionText(recentQuestions);

    const systemPrompt = `You are the strict historical-philosophy fidelity editor for The Agora.

Your job is NOT to make the question more eloquent. Your only job is to decide whether one proposed Daily Challenge is a fair application of the supplied historical source.

Judge the question itself. Do not let the title, educational note, notifications, or other metadata rescue an unrelated question.

A modern analogy is allowed when it preserves the philosophical structure of the source. The question does not need to be something the historical philosopher literally said or literally asked. It must be a question that the philosopher's documented framework can fairly be used to press.

Reject the question if it:
- introduces a belief not supported by the supplied source,
- turns a qualified or contextual idea into an absolute slogan,
- merely sounds philosophical while losing the source concept,
- attributes a modern opinion to the philosopher,
- collapses an important distinction identified in Avoid overclaim,
- or is substantially the same philosophical question as a recent Daily Challenge, even if paraphrased with different words.

Return ONLY valid JSON. No markdown, no preamble.`;

    const userPrompt = `Evaluate this proposed Daily Challenge.

Philosopher:
${philosopher.name} (${philosopher.era}, ${philosopher.discipline})

Source:
Work: ${source.work}
Reference: ${source.reference}
Concept: ${source.concept}
Source idea: ${source.sourceIdea}
Debate angle: ${source.debateAngle}
Core claim: ${guardrails.coreClaim}
Allowed application: ${guardrails.allowedApplication}
Avoid overclaim: ${guardrails.avoidOverclaim}

Proposed challengeQuestion:
${challengeQuestion}

Recent questions for this philosopher:
${recentQuestionText}

Return exactly:
{
  "sourceFaithful": true,
  "recognizableConcept": true,
  "philosopherPlausible": true,
  "unsupportedInference": false,
  "tooSimilarToRecent": false,
  "reason": "One concise sentence explaining the judgment."
}`;

    const message = await client.messages.create({
        model: DAILY_CHALLENGE_FIDELITY_MODEL,
        max_tokens: 450,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    const requiredBooleans = [
        'sourceFaithful',
        'recognizableConcept',
        'philosopherPlausible',
        'unsupportedInference',
        'tooSimilarToRecent',
    ];

    for (const field of requiredBooleans) {
        if (typeof result[field] !== 'boolean') {
            throw new Error(`Fidelity evaluator returned invalid ${field}.`);
        }
    }

    if (!result.sourceFaithful) {
        throw new Error(`Source fidelity rejected: ${result.reason || 'question does not follow the source idea.'}`);
    }

    if (!result.recognizableConcept) {
        throw new Error(`Source concept not recognizable: ${result.reason || source.concept}`);
    }

    if (!result.philosopherPlausible) {
        throw new Error(`Philosopher plausibility rejected: ${result.reason || philosopher.name}`);
    }

    if (result.unsupportedInference) {
        throw new Error(`Unsupported philosophical inference: ${result.reason || 'question overstates the source.'}`);
    }

    if (result.tooSimilarToRecent) {
        throw new Error(`Question is semantically too similar to a recent challenge: ${result.reason || 'duplicate concept framing.'}`);
    }

    return result;
}

async function generateChallenge(
    philosopher,
    source,
    questionMode,
    scheduledDifficulty,
    dateString,
    recentQuestions = [],
    previousRejectionReason = null
) {
    const recentQuestionText = buildRecentQuestionText(recentQuestions);
    const sourceGuardrails = getSourceGuardrails(source);

    const retryInstruction = previousRejectionReason
        ? `

Previous attempt rejected by backend validation:
${previousRejectionReason}

Regenerate the challenge and specifically fix this issue. Do not repeat the rejected wording.`
        : '';

    const systemPrompt = `You are the editorial team for The Agora, an iOS app where users debate historical philosophers as if they were alive today. Tagline: "For centuries, you could only read the philosophers. Now you can debate them."

You create the shared Daily Challenge — one official debate question for all users.

The Daily Challenge must be educational, accurate, debate-worthy, and grounded in the selected philosopher's actual works. You are not guessing what the philosopher would think about modern issues. You are turning a real source idea from the philosopher's work into a personal debate question.

Core rules:
- The source work and source idea are the foundation.
- Do not invent views the philosopher did not hold.
- Do not make unsupported claims about how the philosopher would react to modern technology, politics, or culture.
- Modern relevance is allowed, but the foundation must remain the work, concept, and source idea provided.
- Treat a modern example as an application of the philosopher's framework, not as evidence that the philosopher literally held a modern opinion.
- Do not make the source claim broader, more absolute, or more contemporary than the supplied source supports.
- The challengeQuestion itself must carry the philosophical idea. It must still be source-recognizable if the title, opposingAngle, educationalNote, and notifications are removed.
- challengeQuestion must be EXACTLY ONE sentence.
- challengeQuestion must be a direct question ending in "?".
- challengeQuestion must contain NO MORE THAN ${DAILY_CHALLENGE_MAX_WORDS} words.
- Keep the challengeQuestion concise enough to understand at a glance.
- Do not add examples, setup paragraphs, explanations, or a second sentence to challengeQuestion.
- Do not assume or assign the user's position.
- Never tell the user which side to defend.
- The user must be free to choose either defensible side of the tension.
- The selected question mode may shape the kind of tension, but it must never force a predetermined stance.
- userPositionPrompt must be exactly: "${DAILY_CHALLENGE_POSITION_PROMPT}"
- The question should help the user understand the philosopher's real thought while giving them a defensible choice.
- Do not write generic journaling prompts.
- Do not write motivational self-help.
- Do not write quote-app content.
- Do not mention AI or ChatGPT unless the selected source idea explicitly requires it.
- The user must be able to enter the debate in 1-2 sentences, but the question should have enough tension to sustain a serious argument.
- The Daily Challenge should be loseable: the philosopher should have a real angle of attack against the user's chosen answer.
- Avoid repeating or closely resembling any recent question provided by the backend.
- Return ONLY valid JSON. No preamble, no markdown, no backticks.

Question quality standard:
1. Traceable — a reader familiar with the source should recognize the concept.
2. Contestable — the question presents a real tension with more than one defensible answer.
3. Neutral — the wording does not tell the user which side is correct or which side to defend.
4. Concise — exactly one sentence and no more than ${DAILY_CHALLENGE_MAX_WORDS} words.
5. Enterable — the opening answer should be possible in 1-2 sentences.
6. Loseable — the user's chosen position can crack under philosophical pressure.
7. Teachable — the user should understand the philosopher's concept better after the debate.

Notification rules:
- The notification copy must directly revolve around the generated challengeQuestion.
- Each notification should tease, challenge, pressure, or reframe the exact Daily Challenge question.
- Do not write generic philosopher-themed notifications.
- The user should be able to read the notification and immediately understand it belongs to today's specific question.
- The notifications must connect to BOTH the selected philosopher and the specific debate question.
- Notification copy must sound like the philosopher's voice — characteristic, sharp, and faithful without parody.
- The notification copy must be written in the voice and style of ${philosopher.name} ONLY.
- The notifications must NOT mention, reference, or allude to any other philosopher by name.`;

    const userPrompt = `Generate one source-grounded Daily Challenge for The Agora.

Philosopher:
${philosopher.name} (${philosopher.era}, ${philosopher.discipline})

Source grounding:
Work: ${source.work}
Reference: ${source.reference}
Concept: ${source.concept}
Source idea: ${source.sourceIdea}
Debate angle: ${source.debateAngle}
Core claim: ${sourceGuardrails.coreClaim}
Allowed application: ${sourceGuardrails.allowedApplication}
Avoid overclaim: ${sourceGuardrails.avoidOverclaim}

Question mode:
${questionMode.label}
Mode instruction: ${questionMode.instruction}
Good shape: ${questionMode.goodShape}
Avoid: ${questionMode.avoid}

Scheduled difficulty:
${scheduledDifficulty}

Date:
${dateString}

Recent questions already used for ${philosopher.name}:
${recentQuestionText}

CRITICAL:
The challengeQuestion must clearly grow out of the source idea above.
The challengeQuestion must stand on its own as a recognizable application of the source concept; supporting metadata cannot supply the missing philosophical connection.
The challengeQuestion must preserve the Core claim and obey Allowed application and Avoid overclaim.
The challengeQuestion must follow the selected question mode WITHOUT assigning a side.
The challengeQuestion must be exactly one sentence.
The challengeQuestion must end with a question mark.
The challengeQuestion must contain no more than ${DAILY_CHALLENGE_MAX_WORDS} words.
The challengeQuestion must be neutral and let the user choose which side to defend.
Do not include examples, explanations, a second sentence, or instructions such as "defend the first position."
The difficulty must be exactly: ${scheduledDifficulty}
The question may connect to the user's life, choices, beliefs, habits, relationships, society, or future — but it must remain grounded in the selected work and concept.
Do NOT write a vague modern hypothetical such as "What would ${philosopher.name} think about social media?"
Instead, teach the actual philosophical idea through one concise debate question.
The new challengeQuestion must NOT repeat or closely resemble the recent questions above.
The user should have to choose and defend a real position, not merely reflect.
The userPositionPrompt must be exactly: "${DAILY_CHALLENGE_POSITION_PROMPT}"
The opposingAngle must be a source-grounded pressure point ${philosopher.name} can use to challenge the user's chosen position without assuming which side the user picked.
The morningNotification, afternoonNotification, and eveningNotification must be written ONLY in the voice/style of ${philosopher.name}.
They must directly relate to the exact challengeQuestion you generate.
Do not write generic ${philosopher.name} notifications.
Do not name, reference, or allude to any other philosopher in the notifications.
The notification should make sense as a reminder to answer today's specific Daily Challenge.
${retryInstruction}

Return this exact JSON with no other text:
{
  "title": "Short evocative title (max 6 words)",
  "challengeQuestion": "Exactly one neutral debate question, maximum ${DAILY_CHALLENGE_MAX_WORDS} words, ending in ?",
  "userPositionPrompt": "${DAILY_CHALLENGE_POSITION_PROMPT}",
  "opposingAngle": "One source-grounded pressure point ${philosopher.name} can use against the user's chosen position (1 sentence)",
  "difficulty": "${scheduledDifficulty}",
  "shareHook": "One-sentence hook for sharing on social media",
  "educationalNote": "One sentence explaining the source idea in simple language without sounding academic",
  "morningNotification": "${philosopher.name}'s voice — morning reminder tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "afternoonNotification": "${philosopher.name}'s voice — afternoon reminder that reframes or pressures the exact challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "eveningNotification": "${philosopher.name}'s voice — evening final call tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)"
}`;

    const message = await client.messages.create({
        model: DAILY_CHALLENGE_MODEL,
        max_tokens: 1400,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();

    const parsed = JSON.parse(clean);

    // The user always chooses their own side. Never let model wording assign a position.
    parsed.userPositionPrompt = DAILY_CHALLENGE_POSITION_PROMPT;

    return parsed;
}

// ─── Fallbacks ────────────────────────────────────────────────────────────────
// Fallbacks are source-grounded and tied to exact fallback questions.
// Fallback difficulty is overwritten by getScheduledDifficulty(dateString).

const FALLBACKS = {
    socrates: {
        sourceKey: 'socrates-apology-examined-life',
        sourceWork: 'Apology',
        sourceReference: 'Plato, Apology',
        sourceConcept: 'The Examined Life',
        sourceIdea: 'Socrates argues that a life without examination is not worthy of a human being.',
        debateAngle: 'whether self-questioning is necessary for a good life',
        questionMode: 'defend_a_definition',
        title: 'The Unexamined Life',
        challengeQuestion: 'Can an unexamined belief ever deserve to guide your life?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Socrates will question whether any belief deserves authority before it survives examination.',
        difficulty: 'Accessible',
        shareHook: 'Socrates made me defend a belief I thought was already settled.',
        educationalNote: 'In the Apology, Socrates presents self-examination as essential to living well.',
        morningNotification: 'You carry beliefs into the day. Have you examined whether they deserve to guide you?',
        afternoonNotification: 'A belief has ruled you long enough. Bring it forward and let it answer.',
        eveningNotification: 'Before the day ends, ask whether you lived by wisdom — or by an unexamined assumption.',
    },

    plato: {
        sourceKey: 'plato-republic-cave',
        sourceWork: 'Republic',
        sourceReference: 'Republic, Book VII',
        sourceConcept: 'Allegory of the Cave',
        sourceIdea: 'Plato describes people mistaking shadows and appearances for reality.',
        debateAngle: 'whether people prefer comforting appearances over difficult truth',
        questionMode: 'concrete_case',
        title: 'Shadows or Truth',
        challengeQuestion: 'Can familiar appearances be trusted as truth without deeper examination?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Plato will challenge confidence in appearances and demand an account of what makes them true.',
        difficulty: 'Accessible',
        shareHook: 'Plato made me ask whether something I trust is only a shadow.',
        educationalNote: 'In the Republic, Plato uses the cave to show how education turns the soul from appearance toward truth.',
        morningNotification: 'You have already seen many shadows today. Which one are you mistaking for truth?',
        afternoonNotification: 'The familiar can still be false. Are you defending reality, or only the wall of the cave?',
        eveningNotification: 'Before the shadows close, ask what truth you avoided because appearance felt easier.',
    },

    aristotle: {
        sourceKey: 'aristotle-nicomachean-ethics-habit',
        sourceWork: 'Nicomachean Ethics',
        sourceReference: 'Nicomachean Ethics, Book II',
        sourceConcept: 'Virtue as Habit',
        sourceIdea: 'Aristotle argues that virtues are formed through repeated action rather than mere intention.',
        debateAngle: 'whether people become good by what they repeatedly do',
        questionMode: 'concrete_case',
        title: 'Habit Becomes Character',
        challengeQuestion: 'Do repeated actions shape character more than intentions do?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Aristotle will press whether intentions matter morally when repeated actions train character in another direction.',
        difficulty: 'Accessible',
        shareHook: 'Aristotle made me look at my habits as evidence of my character.',
        educationalNote: 'In the Nicomachean Ethics, Aristotle teaches that virtue is built through practice.',
        morningNotification: 'Character is not declared in the morning. It is practiced, act by act.',
        afternoonNotification: 'Your intention may be noble. But what has your repeated action trained in you today?',
        eveningNotification: 'The day has practiced something in you. Was it virtue, or its opposite?',
    },

    aurelius: {
        sourceKey: 'aurelius-meditations-control',
        sourceWork: 'Meditations',
        sourceReference: 'Meditations',
        sourceConcept: 'Control and Judgment',
        sourceIdea: 'Marcus Aurelius repeatedly distinguishes what depends on us from what does not.',
        debateAngle: 'whether suffering comes more from events or from judgments about events',
        questionMode: 'self_audit',
        title: 'What Is Yours',
        challengeQuestion: 'Does suffering come more from events or from our judgments about them?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Marcus Aurelius will press whether judgment, rather than the event itself, is where disturbance begins.',
        difficulty: 'Accessible',
        shareHook: 'Marcus Aurelius made me separate what happened from the judgment I placed on it.',
        educationalNote: 'In the Meditations, Marcus returns often to the distinction between events and our judgments about them.',
        morningNotification: 'What troubles you today: the thing itself, or the judgment you have added to it?',
        afternoonNotification: 'You have given power to something outside yourself. Is that power truly its own, or yours?',
        eveningNotification: 'Before the day ends, return what was never yours to control.',
    },

    nietzsche: {
        sourceKey: 'nietzsche-genealogy-ressentiment',
        sourceWork: 'On the Genealogy of Morality',
        sourceReference: 'Genealogy of Morality, First Essay',
        sourceConcept: 'Ressentiment',
        sourceIdea: 'Nietzsche analyzes how resentment can disguise itself as moral judgment.',
        debateAngle: 'whether moral criticism can hide envy or weakness',
        questionMode: 'moral_trial',
        title: 'Resentment in Disguise',
        challengeQuestion: 'Can moral condemnation hide resentment, envy, or weakness?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Nietzsche will press whether moral condemnation can disguise resentment while appearing righteous.',
        difficulty: 'Demanding',
        shareHook: 'Nietzsche made me question whether my judgment was justice or resentment.',
        educationalNote: 'In the Genealogy of Morality, Nietzsche examines how resentment can create moral values.',
        morningNotification: 'You call it judgment. But is there resentment beneath it? Bring it into the open.',
        afternoonNotification: 'A harsh judgment can feel noble. Are you certain it is not envy refined into virtue?',
        eveningNotification: 'Before the day ends, ask whether what you condemned revealed them — or revealed you.',
    },

    jung: {
        sourceKey: 'jung-archetypes-shadow',
        sourceWork: 'Aion',
        sourceReference: 'Aion',
        sourceConcept: 'The Shadow',
        sourceIdea: 'Jung describes the shadow as the rejected or unconscious side of the personality.',
        debateAngle: 'whether what people condemn in others often reveals what they refuse to face in themselves',
        questionMode: 'concrete_case',
        title: 'The Hidden Self',
        challengeQuestion: 'Do our strongest reactions to others reveal hidden parts of ourselves?',
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,
        opposingAngle: 'Jung will press whether intense reactions to others reveal projection or rejected parts of the self.',
        difficulty: 'Demanding',
        shareHook: 'Jung made me ask whether what bothers me in others is hidden in me.',
        educationalNote: 'For Jung, the shadow is the part of the personality the conscious self rejects or avoids.',
        morningNotification: 'The person who irritates you may be carrying a message from your own shadow.',
        afternoonNotification: 'Your strongest reaction is rarely meaningless. What part of yourself does it point toward?',
        eveningNotification: 'Before night returns the shadow to hiding, name what you refused to see in yourself.',
    },
};

function getFallback(philosopher, dateString, expiresAt = null) {
    const f = FALLBACKS[philosopher.id] ?? FALLBACKS.socrates;

    return {
        id: `fallback-${philosopher.id}-${dateString}`,
        date: dateString,
        philosopherId: philosopher.id,
        philosopherName: philosopher.name,
        theme: f.sourceConcept,
        ...f,

        // The user always chooses their own side.
        userPositionPrompt: DAILY_CHALLENGE_POSITION_PROMPT,

        // Preserve the deliberate difficulty schedule even when fallback is used.
        difficulty: getScheduledDifficulty(dateString),

        expiresAt,
    };
}

// ─── Challenge serialization ─────────────────────────────────────────────────

function challengeWithWindow(challenge, windowInfo) {
    return {
        ...challenge,

        // Official shared challenge date.
        date: challenge.date,
        challengeDate: challenge.date,

        // User-local challenge window.
        userTimeZone: windowInfo.zone,
        startsAt: windowInfo.startsAt,
        expiresAt: windowInfo.expiresAt,

        // Compatibility naming for Swift if needed.
        localChallengeDate: windowInfo.date,
    };
}

function stripRuntimeWindowFields(challenge) {
    const copy = { ...challenge };

    delete copy.userTimeZone;
    delete copy.startsAt;
    delete copy.expiresAt;
    delete copy.localChallengeDate;
    delete copy.challengeDate;

    return copy;
}

// ─── Postgres mapping ─────────────────────────────────────────────────────────

function rowToChallenge(row) {
    if (!row) return null;

    return {
        id: row.id,
        date: normalizeDateValue(row.challenge_date),

        philosopherId: row.philosopher_id,
        philosopherName: row.philosopher_name,

        sourceKey: row.source_key,
        sourceWork: row.source_work,
        sourceReference: row.source_reference,
        sourceConcept: row.source_concept,
        sourceIdea: row.source_idea,
        debateAngle: row.debate_angle,

        questionMode: row.question_mode,

        theme: row.theme,
        title: row.title,
        challengeQuestion: row.challenge_question,
        userPositionPrompt: row.user_position_prompt,
        opposingAngle: row.opposing_angle,
        difficulty: row.difficulty,
        shareHook: row.share_hook,
        educationalNote: row.educational_note,

        morningNotification: row.morning_notification,
        afternoonNotification: row.afternoon_notification,
        eveningNotification: row.evening_notification,
    };
}

async function getChallengeFromDb(db, dateString) {
    const result = await db.query(
        `SELECT *
         FROM daily_challenges
         WHERE challenge_date = $1::date
         LIMIT 1`,
        [dateString]
    );

    return rowToChallenge(result.rows[0]);
}

async function getRecentChallengesForPhilosopher(db, philosopherId, limit = 30) {
    const result = await db.query(
        `SELECT *
         FROM daily_challenges
         WHERE philosopher_id = $1
         ORDER BY challenge_date DESC
         LIMIT $2`,
        [philosopherId, limit]
    );

    return result.rows.map(rowToChallenge).filter(Boolean);
}

async function getRecentChallengesGlobal(db, limit = 10) {
    const result = await db.query(
        `SELECT *
         FROM daily_challenges
         ORDER BY challenge_date DESC
         LIMIT $1`,
        [limit]
    );

    return result.rows.map(rowToChallenge).filter(Boolean);
}

async function insertChallengeIntoDb(db, challenge) {
    const clean = stripRuntimeWindowFields(challenge);

    const result = await db.query(
        `INSERT INTO daily_challenges (
            challenge_date,
            id,
            philosopher_id,
            philosopher_name,
            source_key,
            source_work,
            source_reference,
            source_concept,
            source_idea,
            debate_angle,
            question_mode,
            theme,
            title,
            challenge_question,
            user_position_prompt,
            opposing_angle,
            difficulty,
            share_hook,
            educational_note,
            morning_notification,
            afternoon_notification,
            evening_notification
         )
         VALUES (
            $1::date,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            $19,
            $20,
            $21,
            $22
         )
         ON CONFLICT (challenge_date) DO NOTHING
         RETURNING *`,
        [
            clean.date,
            clean.id,
            clean.philosopherId,
            clean.philosopherName,
            clean.sourceKey,
            clean.sourceWork,
            clean.sourceReference || null,
            clean.sourceConcept,
            clean.sourceIdea,
            clean.debateAngle,
            clean.questionMode,
            clean.theme,
            clean.title,
            clean.challengeQuestion,
            clean.userPositionPrompt,
            clean.opposingAngle,
            clean.difficulty,
            clean.shareHook,
            clean.educationalNote,
            clean.morningNotification,
            clean.afternoonNotification,
            clean.eveningNotification,
        ]
    );

    return rowToChallenge(result.rows[0]);
}

async function getUpcomingChallengesFromDb(db, limit = 21) {
    const result = await db.query(
        `SELECT *
         FROM daily_challenges
         ORDER BY challenge_date ASC
         LIMIT $1`,
        [limit]
    );

    return result.rows.map(rowToChallenge).filter(Boolean);
}

// ─── Calendar generation ─────────────────────────────────────────────────────

async function generateChallengeForDate(db, dateString) {
    const philosopher = getPhilosopherForDate(dateString);

    // Source idea history stays per philosopher.
    const recentQuestions = await getRecentChallengesForPhilosopher(db, philosopher.id, 8);
    const historyForSourceSelection = await getRecentChallengesForPhilosopher(db, philosopher.id, 60);

    // Question mode history is global because users experience Daily Challenge day-by-day.
    const globalModeHistory = await getRecentChallengesGlobal(db, 10);

    const source = pickSourceIdea(philosopher.id, historyForSourceSelection);
    const questionMode = pickQuestionMode(globalModeHistory, source);
    const scheduledDifficulty = getScheduledDifficulty(dateString);

    let challengeData;

    try {
        let lastError = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const generated = await generateChallenge(
                    philosopher,
                    source,
                    questionMode,
                    scheduledDifficulty,
                    dateString,
                    recentQuestions,
                    lastError ? lastError.message : null
                );

                challengeData = {
                    id: `daily-${philosopher.id}-${dateString}`,
                    date: dateString,
                    philosopherId: philosopher.id,
                    philosopherName: philosopher.name,

                    sourceKey: source.key,
                    sourceWork: source.work,
                    sourceReference: source.reference,
                    sourceConcept: source.concept,
                    sourceIdea: source.sourceIdea,
                    debateAngle: source.debateAngle,

                    questionMode: questionMode.id,

                    // Keeps compatibility if your Swift UI still expects "theme".
                    theme: source.concept,

                    ...generated,
                };

                challengeData.philosopherId =
                    normalizePhilosopherId(challengeData.philosopherId) || philosopher.id;

                // Force authoritative backend values.
                // Claude should not be allowed to override these.
                challengeData.id = `daily-${philosopher.id}-${dateString}`;
                challengeData.date = dateString;
                challengeData.philosopherId = philosopher.id;
                challengeData.philosopherName = philosopher.name;

                challengeData.sourceKey = source.key;
                challengeData.sourceWork = source.work;
                challengeData.sourceReference = source.reference;
                challengeData.sourceConcept = source.concept;
                challengeData.sourceIdea = source.sourceIdea;
                challengeData.debateAngle = source.debateAngle;
                challengeData.questionMode = questionMode.id;
                challengeData.difficulty = scheduledDifficulty;
                challengeData.theme = source.concept;

                validateChallenge(challengeData, recentQuestions);

                const fidelityResult = await evaluateChallengeFidelity({
                    philosopher,
                    source,
                    challengeQuestion: challengeData.challengeQuestion,
                    recentQuestions,
                });

                console.log(`[DailyChallenge] Generated challenge for ${dateString}`);
                console.log(`[DailyChallenge] generationAttempt: ${attempt}`);
                console.log(`[DailyChallenge] model: ${DAILY_CHALLENGE_MODEL}`);
                console.log(`[DailyChallenge] fidelityModel: ${DAILY_CHALLENGE_FIDELITY_MODEL}`);
                console.log(`[DailyChallenge] fidelity: ${fidelityResult.reason || 'PASSED'}`);
                console.log(`[DailyChallenge] philosopherId: ${challengeData.philosopherId}`);
                console.log(`[DailyChallenge] philosopherName: ${challengeData.philosopherName}`);
                console.log(`[DailyChallenge] sourceWork: ${challengeData.sourceWork}`);
                console.log(`[DailyChallenge] sourceConcept: ${challengeData.sourceConcept}`);
                console.log(`[DailyChallenge] questionMode: ${challengeData.questionMode}`);
                console.log(`[DailyChallenge] difficulty: ${challengeData.difficulty}`);
                console.log(`[DailyChallenge] challengeQuestion: ${challengeData.challengeQuestion}`);
                console.log(`[DailyChallenge] morningNotification: ${challengeData.morningNotification}`);
                console.log(`[DailyChallenge] afternoonNotification: ${challengeData.afternoonNotification}`);
                console.log(`[DailyChallenge] eveningNotification: ${challengeData.eveningNotification}`);
                console.log('[DailyChallenge] Validation: PASSED');

                break;
            } catch (attemptErr) {
                lastError = attemptErr;
                challengeData = null;

                console.warn(
                    `[DailyChallenge] Generation attempt ${attempt} failed for ${dateString}:`,
                    attemptErr.message
                );
            }
        }

        if (!challengeData) {
            throw lastError || new Error('Generation failed without a specific error.');
        }

    } catch (genErr) {
        console.error('[DailyChallenge] Generation or validation failed after retry:', genErr.message);
        console.log('[DailyChallenge] Validation: FAILED — using fallback');

        challengeData = getFallback(philosopher, dateString, null);
        challengeData = stripRuntimeWindowFields(challengeData);

        try {
            validateChallenge(challengeData);
        } catch (fallbackErr) {
            console.error('[DailyChallenge] Fallback validation failed:', fallbackErr.message);
        }
    }

    return stripRuntimeWindowFields(challengeData);
}

async function ensureChallengeForDate(pool, dateString) {
    if (!dateString || typeof dateString !== 'string') {
        throw new Error('dateString is required.');
    }

    const db = await pool.connect();
    const lockKey = `daily_challenge:${dateString}`;

    try {
        // Prevent duplicate Claude calls if Railway starts multiple instances or redeploys concurrently.
        await db.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);

        const existing = await getChallengeFromDb(db, dateString);

        if (existing && existing.id && existing.challengeQuestion) {
            return existing;
        }

        const generated = await generateChallengeForDate(db, dateString);
        const inserted = await insertChallengeIntoDb(db, generated);

        if (inserted) {
            console.log(`[DailyChallengeDB] Inserted ${dateString} — ${inserted.philosopherName}`);
            return inserted;
        }

        // If another process inserted between generation and insert, read it back.
        const afterConflict = await getChallengeFromDb(db, dateString);

        if (afterConflict) {
            console.log(`[DailyChallengeDB] Conflict resolved by existing row for ${dateString}`);
            return afterConflict;
        }

        throw new Error(`Failed to insert or read challenge for ${dateString}`);
    } finally {
        try {
            await db.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        } catch (unlockErr) {
            console.error(`[DailyChallengeDB] Advisory unlock failed for ${dateString}:`, unlockErr.message);
        }

        db.release();
    }
}

async function ensureChallengeCalendar(pool, daysAhead = ROLLING_DAYS_AHEAD) {
    const dates = getRollingCalendarDates(daysAhead);
    const created = [];
    const existing = [];
    const failed = [];

    console.log('──────────────────────────────────────────────');
    console.log('[DailyChallengeCalendar] Ensuring Postgres rolling calendar');
    console.log(`[DailyChallengeCalendar] Window: ${dates[0]} through ${dates[dates.length - 1]}`);
    console.log('──────────────────────────────────────────────');

    for (const dateString of dates) {
        try {
            const before = await getChallengeFromDb(pool, dateString);
            const alreadyExists = Boolean(before);

            const challenge = await ensureChallengeForDate(pool, dateString);

            if (alreadyExists) {
                existing.push(dateString);
            } else {
                created.push(dateString);
            }

            console.log(
                `[DailyChallengeCalendar] ${alreadyExists ? 'Exists' : 'Created'} ${dateString} — ${challenge.philosopherName}`
            );
        } catch (err) {
            failed.push(dateString);
            console.error(`[DailyChallengeCalendar] Failed ${dateString}:`, err.message);
        }
    }

    await syncCompatibilityCache(pool);

    console.log('──────────────────────────────────────────────');
    console.log('[DailyChallengeCalendar] Complete');
    console.log(`[DailyChallengeCalendar] Created: ${created.length ? created.join(', ') : 'none'}`);
    console.log(`[DailyChallengeCalendar] Existing: ${existing.length}`);
    console.log(`[DailyChallengeCalendar] Failed: ${failed.length ? failed.join(', ') : 'none'}`);
    console.log('──────────────────────────────────────────────');

    return {
        dates,
        created,
        existing,
        failed,
    };
}

// ─── Backward compatibility cache ─────────────────────────────────────────────
// Your current pushScheduler.js still reads daily_challenge_cache.json.
// This keeps that file populated with the current Chicago-window challenge
// until we update pushScheduler.js to use user-local timezone delivery.

async function syncCompatibilityCache(pool) {
    const chicagoWindow = getChicagoChallengeWindow();
    const challenge = await ensureChallengeForDate(pool, chicagoWindow.date);

    const cachedChallenge = challengeWithWindow(challenge, chicagoWindow);

    const saved = writeCache(cachedChallenge);

    console.log(
        `[DailyChallengeCache] Synced compatibility cache for ${chicagoWindow.date}: ${saved ? 'SUCCESS' : 'FAILED'}`
    );

    return cachedChallenge;
}

// ─── Router factory ───────────────────────────────────────────────────────────

export function createDailyChallengeRouter(pool) {
    const router = express.Router();

    // ─── 4 AM Chicago rolling generation cron ─────────────────────────────────

    cron.schedule(
        '0 4 * * *',
        async () => {
            console.log('[DailyChallengeScheduler] 4 AM Chicago Postgres rolling generation triggered');

            try {
                const result = await ensureChallengeCalendar(pool, ROLLING_DAYS_AHEAD);

                console.log('[DailyChallengeScheduler] Calendar ensured');
                console.log(`[DailyChallengeScheduler] Created: ${result.created.length}`);
                console.log(`[DailyChallengeScheduler] Existing: ${result.existing.length}`);
                console.log(`[DailyChallengeScheduler] Failed: ${result.failed.length}`);

            } catch (err) {
                console.error('[DailyChallengeScheduler] 4 AM rolling generation error:', err.message);
            }
        },
        { timezone: CHICAGO_ZONE }
    );

    console.log('[DailyChallengeScheduler] 4 AM Postgres rolling calendar cron registered (America/Chicago)');

    // ─── Startup calendar safety check ────────────────────────────────────────

    ensureChallengeCalendar(pool, ROLLING_DAYS_AHEAD)
        .then((result) => {
            console.log('[DailyChallengeStartup] Postgres rolling calendar checked on startup');
            console.log(`[DailyChallengeStartup] Created: ${result.created.length}`);
            console.log(`[DailyChallengeStartup] Existing: ${result.existing.length}`);
            console.log(`[DailyChallengeStartup] Failed: ${result.failed.length}`);
        })
        .catch((err) => {
            console.error('[DailyChallengeStartup] Rolling calendar check failed:', err.message);
        });

    // ─── Routes ───────────────────────────────────────────────────────────────

    router.get('/api/daily-challenge', async (req, res) => {
        try {
            const requestedZone =
                req.query.timezone ||
                req.query.tz ||
                req.headers['x-timezone'] ||
                CHICAGO_ZONE;

            const windowInfo = getChallengeWindowForZone(requestedZone);
            const challenge = await ensureChallengeForDate(pool, windowInfo.date);

            return res.json(challengeWithWindow(challenge, windowInfo));
        } catch (err) {
            console.error('[DailyChallenge] Endpoint error:', err.message);

            const requestedZone =
                req.query.timezone ||
                req.query.tz ||
                req.headers['x-timezone'] ||
                CHICAGO_ZONE;

            const windowInfo = getChallengeWindowForZone(requestedZone);
            const philosopher = getPhilosopherForDate(windowInfo.date);
            const fallback = getFallback(philosopher, windowInfo.date, windowInfo.expiresAt);

            return res.json(challengeWithWindow(fallback, windowInfo));
        }
    });

    // Simple admin/helper route so you can view upcoming challenges.
    // Use:
    // /api/daily-challenges/upcoming
    // Or if ANALYTICS_ADMIN_KEY exists:
    // /api/daily-challenges/upcoming?adminKey=YOUR_ANALYTICS_ADMIN_KEY

    router.get('/api/daily-challenges/upcoming', async (req, res) => {
        try {
            const configuredAdminKey = process.env.ANALYTICS_ADMIN_KEY;
            const suppliedAdminKey =
                req.query.adminKey ||
                req.headers['x-admin-key'];

            if (configuredAdminKey && suppliedAdminKey !== configuredAdminKey) {
                return res.status(401).json({ error: 'Unauthorized.' });
            }

            await ensureChallengeCalendar(pool, ROLLING_DAYS_AHEAD);

            const upcoming = await getUpcomingChallengesFromDb(pool, 21);

            return res.json({
                count: upcoming.length,
                rollingDaysAhead: ROLLING_DAYS_AHEAD,
                generatedAt: new Date().toISOString(),
                upcoming: upcoming.map(challenge => {
                    return {
                        date: challenge.date,
                        id: challenge.id,
                        philosopherId: challenge.philosopherId,
                        philosopherName: challenge.philosopherName,
                        sourceWork: challenge.sourceWork,
                        sourceConcept: challenge.sourceConcept,
                        questionMode: challenge.questionMode,
                        title: challenge.title,
                        difficulty: challenge.difficulty,
                        challengeQuestion: challenge.challengeQuestion,
                        morningNotification: challenge.morningNotification,
                        afternoonNotification: challenge.afternoonNotification,
                        eveningNotification: challenge.eveningNotification,
                    };
                }),
            });
        } catch (err) {
            console.error('[DailyChallengeUpcoming] Endpoint error:', err.message);
            return res.status(500).json({ error: 'Failed to read upcoming challenges.' });
        }
    });

    return router;
}

export default createDailyChallengeRouter;
