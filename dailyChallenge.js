// dailyChallenge.jss
// ES module — matches the import/export style of server.js
//
// Daily Challenge system:
//   - Same official challenge for everyone by challenge date.
//   - Challenge unlocks at 5:00 AM in the user's local timezone.
//   - Backend replenishes a rolling calendar at 4:00 AM America/Chicago.
//   - Postgres stores today through the next 7 days.
//   - Notification copy is generated ahead of time with each challenge.
//
// Why Postgres:
//   - Backend deploys/restarts will NOT regenerate existing challenge dates.
//   - challenge_date is the source of truth.
//   - Existing dates are skipped.
//   - A Postgres advisory lock prevents duplicate Claude generation during concurrent deploys.
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
    const dow = DateTime.fromISO(dateString, { zone: CHICAGO_ZONE }).weekday;

    if (dow === 7) {
        const hash = stableHashString(dateString);
        const id = ALL_PHILOSOPHER_IDS[hash % ALL_PHILOSOPHER_IDS.length];
        return PHILOSOPHERS[id] ?? PHILOSOPHERS.socrates;
    }

    return PHILOSOPHERS[ROTATION[dow]] ?? PHILOSOPHERS.socrates;
}

// ─── Source-grounded idea pool ────────────────────────────────────────────────
// These are paraphrased source ideas, not invented modern opinions.
// Modern relevance is application, not foundation.

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
        },
    ],
};

function getRecentForPhilosopher(history, philosopherId, limit = 8) {
    return history
        .filter(item => item.philosopherId === philosopherId)
        .slice(0, limit);
}

function pickSourceIdea(philosopherId, history) {
    const list = SOURCE_IDEAS[philosopherId] ?? SOURCE_IDEAS.socrates;
    const recentForPhilosopher = getRecentForPhilosopher(history, philosopherId, 8);

    const recentlyUsedSourceKeys = new Set(
        recentForPhilosopher
            .map(item => item.sourceKey)
            .filter(Boolean)
    );

    let available = list.filter(source => !recentlyUsedSourceKeys.has(source.key));

    if (available.length === 0) {
        available = list;
    }

    return available[Math.floor(Math.random() * available.length)];
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

function validateChallenge(challenge) {
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

function buildRecentQuestionText(recentQuestions) {
    if (!recentQuestions.length) {
        return 'No recent questions for this philosopher.';
    }

    return recentQuestions
        .map((item, index) => {
            return `${index + 1}. Date: ${item.date} | Work: ${item.sourceWork || 'unknown'} | Concept: ${item.sourceConcept || 'unknown'} | Question: ${item.challengeQuestion}`;
        })
        .join('\n');
}

async function generateChallenge(philosopher, source, dateString, recentQuestions = []) {
    const recentQuestionText = buildRecentQuestionText(recentQuestions);

    const systemPrompt = `You are the editorial team for The Agora, an iOS app where users debate historical philosophers as if they were alive today. Tagline: "For centuries, you could only read the philosophers. Now you can debate them."

You create the shared Daily Challenge — one official debate question for all users.

The Daily Challenge must be educational, accurate, and grounded in the selected philosopher's actual works. You are not guessing what the philosopher would think about modern issues. You are turning a real source idea from the philosopher's work into a personal debate question.

Rules:
- The source work and source idea are the foundation.
- Do not invent views the philosopher did not hold.
- Do not make unsupported claims about how the philosopher would react to modern technology, politics, or culture.
- You may create a modern or personal application, but it must clearly come from the selected source idea.
- The question should help the user understand the philosopher's real thought while forcing them to examine their own life.
- Modern relevance is allowed, but the foundation must remain the work, concept, and source idea provided.
- Do not mention AI or ChatGPT unless the selected source idea explicitly requires it.
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
- Avoid repeating or closely resembling any recent question provided by the backend.
- Return ONLY valid JSON. No preamble, no markdown, no backticks.`;

    const userPrompt = `Generate one source-grounded Daily Challenge for The Agora.

Philosopher:
${philosopher.name} (${philosopher.era}, ${philosopher.discipline})

Source grounding:
Work: ${source.work}
Reference: ${source.reference}
Concept: ${source.concept}
Source idea: ${source.sourceIdea}
Debate angle: ${source.debateAngle}

Date:
${dateString}

Recent questions already used for ${philosopher.name}:
${recentQuestionText}

CRITICAL:
The challengeQuestion must clearly grow out of the source idea above.
The question may connect to the user's life, choices, beliefs, habits, relationships, society, or future — but it must remain grounded in the selected work and concept.
Do NOT write a vague modern hypothetical such as "What would ${philosopher.name} think about social media?"
Instead, teach the actual philosophical idea by turning it into a debate the user can enter.
The new challengeQuestion must NOT repeat or closely resemble the recent questions above.
The morningNotification, afternoonNotification, and eveningNotification must be written ONLY in the voice/style of ${philosopher.name}.
They must directly relate to the exact challengeQuestion you generate.
Do not write generic ${philosopher.name} notifications.
Do not name, reference, or allude to any other philosopher in the notifications.
The notification should make sense as a reminder to answer today's specific Daily Challenge.

Return this exact JSON with no other text:
{
  "title": "Short evocative title (max 6 words)",
  "challengeQuestion": "The full debate question (1-2 sentences, no assumed position)",
  "userPositionPrompt": "One sentence inviting the user to state their view",
  "opposingAngle": "The position ${philosopher.name} will argue, grounded in the selected source idea (1 sentence)",
  "difficulty": "Accessible or Challenging or Demanding",
  "shareHook": "One-sentence hook for sharing on social media",
  "educationalNote": "One sentence explaining the source idea in simple language without sounding academic",
  "morningNotification": "${philosopher.name}'s voice — morning reminder tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "afternoonNotification": "${philosopher.name}'s voice — afternoon reminder that reframes or pressures the exact challengeQuestion (max 2 sentences, do NOT name any other philosopher)",
  "eveningNotification": "${philosopher.name}'s voice — evening final call tied directly to the challengeQuestion (max 2 sentences, do NOT name any other philosopher)"
}`;

    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: userPrompt }],
        system: systemPrompt,
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();

    return JSON.parse(clean);
}

// ─── Fallbacks ────────────────────────────────────────────────────────────────
// Fallbacks are source-grounded and tied to exact fallback questions.

const FALLBACKS = {
    socrates: {
        sourceKey: 'socrates-apology-examined-life',
        sourceWork: 'Apology',
        sourceReference: 'Plato, Apology',
        sourceConcept: 'The Examined Life',
        sourceIdea: 'Socrates argues that a life without examination is not worthy of a human being.',
        debateAngle: 'whether self-questioning is necessary for a good life',
        title: 'The Unexamined Life',
        challengeQuestion: 'Socrates argues that an unexamined life is not truly worthy of a human being. What belief in your life have you accepted without examining it?',
        userPositionPrompt: 'Name one belief you hold with confidence, and explain why it deserves to survive questioning.',
        opposingAngle: 'Socrates will argue that confidence without examination is not wisdom.',
        difficulty: 'Accessible',
        shareHook: 'Socrates made me question a belief I thought was already settled.',
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
        title: 'Shadows or Truth',
        challengeQuestion: 'Plato’s cave suggests that people often mistake appearances for reality. What is one thing you trust that may only be a shadow of the truth?',
        userPositionPrompt: 'Name something you trust, and explain why you believe it is reality rather than appearance.',
        opposingAngle: 'Plato will argue that what feels familiar may still be only a shadow.',
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
        title: 'Habit Becomes Character',
        challengeQuestion: 'Aristotle argues that character is formed by repeated action, not by intention alone. What are your daily habits making you become?',
        userPositionPrompt: 'Describe what your repeated actions say about your character.',
        opposingAngle: 'Aristotle will argue that your habits reveal your character more truthfully than your intentions do.',
        difficulty: 'Accessible',
        shareHook: 'Aristotle made me look at my habits as evidence of who I am becoming.',
        educationalNote: 'In the Nicomachean Ethics, Aristotle teaches that virtue is built through practice.',
        morningNotification: 'Your habits are already voting for the person you are becoming. Do you agree with their choice?',
        afternoonNotification: 'Intentions speak softly. Repeated actions speak louder. What have yours said today?',
        eveningNotification: 'The day has practiced something in you. Was it virtue, or its opposite?',
    },

    aurelius: {
        sourceKey: 'aurelius-meditations-control',
        sourceWork: 'Meditations',
        sourceReference: 'Meditations',
        sourceConcept: 'Control and Judgment',
        sourceIdea: 'Marcus Aurelius repeatedly distinguishes what depends on us from what does not.',
        debateAngle: 'whether suffering comes more from events or from judgments about events',
        title: 'What Is Yours',
        challengeQuestion: 'Marcus Aurelius teaches that much of our disturbance comes from judging things outside our control. What are you treating as yours that may not belong to you?',
        userPositionPrompt: 'Name something currently disturbing you, and explain whether it is truly within your control.',
        opposingAngle: 'Marcus Aurelius will argue that your judgment, not the event itself, is where discipline begins.',
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
        title: 'Resentment in Disguise',
        challengeQuestion: 'Nietzsche warns that resentment can disguise itself as moral judgment. When you condemn something, how do you know it is justice rather than envy or weakness speaking?',
        userPositionPrompt: 'Name something you judge harshly, and explain why your judgment is honest rather than resentful.',
        opposingAngle: 'Nietzsche will argue that some moral outrage is resentment wearing noble clothing.',
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
        title: 'The Hidden Self',
        challengeQuestion: 'Jung’s idea of the shadow suggests that what we reject in others may reveal what we refuse to face in ourselves. What kind of person irritates you most, and why?',
        userPositionPrompt: 'Describe the trait in others that bothers you most, and what you believe it says about them.',
        opposingAngle: 'Jung will argue that your strongest reaction may reveal an unconscious part of yourself.',
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

async function getRecentChallengesForPhilosopher(db, philosopherId, limit = 8) {
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
            $21
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
    const recentQuestions = await getRecentChallengesForPhilosopher(db, philosopher.id, 5);
    const historyForSourceSelection = await getRecentChallengesForPhilosopher(db, philosopher.id, 8);
    const source = pickSourceIdea(philosopher.id, historyForSourceSelection);

    let challengeData;

    try {
        const generated = await generateChallenge(
            philosopher,
            source,
            dateString,
            recentQuestions
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
        challengeData.theme = source.concept;

        validateChallenge(challengeData);

        console.log(`[DailyChallenge] Generated challenge for ${dateString}`);
        console.log(`[DailyChallenge] philosopherId: ${challengeData.philosopherId}`);
        console.log(`[DailyChallenge] philosopherName: ${challengeData.philosopherName}`);
        console.log(`[DailyChallenge] sourceWork: ${challengeData.sourceWork}`);
        console.log(`[DailyChallenge] sourceConcept: ${challengeData.sourceConcept}`);
        console.log(`[DailyChallenge] challengeQuestion: ${challengeData.challengeQuestion}`);
        console.log(`[DailyChallenge] morningNotification: ${challengeData.morningNotification}`);
        console.log(`[DailyChallenge] afternoonNotification: ${challengeData.afternoonNotification}`);
        console.log(`[DailyChallenge] eveningNotification: ${challengeData.eveningNotification}`);
        console.log('[DailyChallenge] Validation: PASSED');

    } catch (genErr) {
        console.error('[DailyChallenge] Generation or validation failed:', genErr.message);
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
                        title: challenge.title,
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
