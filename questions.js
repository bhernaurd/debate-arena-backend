// questions.js
// ES module — matches the import/export style of server.js and dailyChallenge.js
//
// Question Generator for The Agora.
//   POST  /api/questions/generate   -> 3 philosopher-specific debate questions
//   PATCH /api/questions/:id/used   -> sets used_at when a debate starts
//
// Storage: Railway Postgres, using the existing generated_questions table
// (id, generation_id, user_id, philosopher, question_text,
//  question_normalized, theme, difficulty, source, generated_at, used_at).
//
// This version hard-enforces exactly one question per difficulty:
// Beginner → Intermediate → Advanced
//
// Even if Claude returns duplicate difficulties, the backend repairs/retries
// and only sends the app one beginner, one intermediate, and one advanced.

import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway.internal')
        ? false
        : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
    console.error('[Questions] Postgres pool error:', err.message);
});

// ─── Constants ───────────────────────────────────────────────────────────────

const REQUIRED_DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];

const DIFFICULTY_LABELS = {
    beginner: 'Beginner',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
};

const PHILOSOPHER_ALIASES = {
    'socrates': 'Socrates',
    'plato': 'Plato',
    'aristotle': 'Aristotle',
    'nietzsche': 'Nietzsche',
    'friedrich nietzsche': 'Nietzsche',
    'marcus aurelius': 'Marcus Aurelius',
    'aurelius': 'Marcus Aurelius',
    'marcus': 'Marcus Aurelius',
    'jung': 'Carl Jung',
    'carl jung': 'Carl Jung',
};

const PHILOSOPHER_THEMES = {
    'Socrates':
        'self-examination, virtue, knowledge vs ignorance, truth, justice, the examined life, moral confidence, questioning assumptions, admitting what you do not know',
    'Plato':
        'truth vs illusion, the soul, justice, the Forms, the Allegory of the Cave, the ideal society, education, appearance vs reality, who should rule',
    'Aristotle':
        'virtue, habit, excellence, eudaimonia (flourishing), friendship, purpose, moderation and the golden mean, practical wisdom, character built through action',
    'Nietzsche':
        'values, suffering as fuel, herd morality, self-overcoming, "God is dead", the Ubermensch, comfort vs greatness, weakness, creating your own meaning, resentment',
    'Marcus Aurelius':
        'what is in your control, discipline, duty, mortality and memento mori, adversity, emotional restraint, acceptance, responsibility, fate, the opinions of others',
    'Carl Jung':
        'the shadow, individuation, dreams, projection, archetypes, the unconscious, identity, inner conflict, the persona vs the true self, integrating what you deny',
};

const RECENT_EXCLUSION_COUNT = 20;

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePhilosopher(input) {
    if (typeof input !== 'string') return null;
    return PHILOSOPHER_ALIASES[input.trim().toLowerCase()] || null;
}

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDifficulty(value) {
    if (typeof value !== 'string') return null;

    const difficulty = value.trim().toLowerCase();

    if (difficulty === 'beginner') return 'beginner';
    if (difficulty === 'intermediate') return 'intermediate';
    if (difficulty === 'advanced') return 'advanced';

    return null;
}

function tooSimilar(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;

    const wordsA = new Set(a.split(' ').filter(Boolean));
    const wordsB = new Set(b.split(' ').filter(Boolean));

    if (wordsA.size === 0 || wordsB.size === 0) return false;

    let shared = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) shared++;
    }

    const overlap = shared / Math.min(wordsA.size, wordsB.size);
    return overlap > 0.8;
}

function sortByRequiredDifficulty(questions) {
    return [...questions].sort((a, b) => {
        return REQUIRED_DIFFICULTIES.indexOf(a.difficulty) - REQUIRED_DIFFICULTIES.indexOf(b.difficulty);
    });
}

function sanitizeQuestion(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const theme = typeof raw.theme === 'string' && raw.theme.trim().length > 0
        ? raw.theme.trim()
        : 'general';

    const difficulty = normalizeDifficulty(raw.difficulty);

    if (!question || !difficulty) return null;

    return {
        question,
        theme,
        difficulty,
    };
}

function selectOnePerDifficulty(generated, neededDifficulties, recentNormalized, accepted) {
    const selected = [];

    for (const difficulty of neededDifficulties) {
        const candidates = generated.filter(q => q.difficulty === difficulty);

        for (const candidate of candidates) {
            const norm = normalizeText(candidate.question);

            const dupAgainstRecent = recentNormalized.some(r => tooSimilar(norm, r));
            const dupAgainstAccepted = accepted.some(a => tooSimilar(norm, normalizeText(a.question)));
            const dupAgainstSelected = selected.some(s => tooSimilar(norm, normalizeText(s.question)));

            if (!dupAgainstRecent && !dupAgainstAccepted && !dupAgainstSelected) {
                selected.push(candidate);
                break;
            }
        }
    }

    return selected;
}

// ─── Claude generation ──────────────────────────────────────────────────────

function buildPrompt(philosopher, themes, recentQuestions, neededDifficulties) {
    const difficultyList = neededDifficulties.join(', ');

    const exclusionBlock = recentQuestions.length > 0
        ? `Do NOT repeat or closely paraphrase any of these recent questions:\n${recentQuestions.map(q => `- ${q}`).join('\n')}`
        : 'There are no recent questions to avoid.';

    return `You are generating debate questions for "The Agora", an iOS app where users debate history's greatest philosophers in real-time conversation.

Tagline:
"For centuries, you could only read the philosophers. Now you can debate them."

Philosopher:
${philosopher}

Core themes for this philosopher:
${themes}

Generate exactly ${neededDifficulties.length} debate question(s).

You must generate exactly ONE question for each of these difficulty levels:
${difficultyList}

The final JSON array must be ordered exactly like this:
${neededDifficulties.map(d => DIFFICULTY_LABELS[d]).join(' → ')}

Rules for every question:
- One sentence.
- Under 140 characters whenever possible.
- It must create tension and invite real disagreement.
- It should be arguable, never a definition, trivia, or "explain X" question.
- It must feel like ${philosopher} is challenging the user personally and directly.
- It must be philosophically accurate to ${philosopher}'s actual ideas and concerns.
- Never invent quotes.
- Never attribute claims this philosopher did not make.
- No generic self-help phrasing.
- No academic jargon.
- Each question must cover a different theme.

Difficulty guide:
- beginner: requires no philosophy background, purely intuitive
- intermediate: touches a named concept or recognizable idea in plain language
- advanced: forces the user to defend a position against the philosopher's strongest idea

${exclusionBlock}

Return ONLY valid JSON with no markdown, no backticks, and no text before or after it.

Return exactly this shape:
{"questions":[{"question":"string","theme":"string","difficulty":"beginner"}]}

Important:
- difficulty must be exactly one of: beginner, intermediate, advanced
- Do not return two questions with the same difficulty.
- Do not omit any requested difficulty.`;
}

async function callClaudeForQuestions(philosopher, recentQuestionTexts, neededDifficulties) {
    const prompt = buildPrompt(
        philosopher,
        PHILOSOPHER_THEMES[philosopher],
        recentQuestionTexts,
        neededDifficulties
    );

    const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
    });

    const raw = message.content?.find(b => b.type === 'text')?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();

    const parsed = JSON.parse(clean);

    if (!Array.isArray(parsed.questions)) {
        throw new Error('AI response missing questions array');
    }

    return parsed.questions
        .map(sanitizeQuestion)
        .filter(Boolean);
}

async function generateDifficultyLockedQuestions(philosopher, recentTexts, recentNormalized) {
    let accepted = [];

    for (let attempt = 0; attempt < 3; attempt++) {
        const acceptedDifficulties = new Set(accepted.map(q => q.difficulty));
        const neededDifficulties = REQUIRED_DIFFICULTIES.filter(d => !acceptedDifficulties.has(d));

        if (neededDifficulties.length === 0) break;

        const generated = await callClaudeForQuestions(
            philosopher,
            [...recentTexts, ...accepted.map(q => q.question)],
            neededDifficulties
        );

        const selected = selectOnePerDifficulty(
            generated,
            neededDifficulties,
            recentNormalized,
            accepted
        );

        accepted.push(...selected);
        accepted = sortByRequiredDifficulty(accepted);
    }

    const finalDifficulties = new Set(accepted.map(q => q.difficulty));
    const hasAllDifficulties = REQUIRED_DIFFICULTIES.every(d => finalDifficulties.has(d));

    if (!hasAllDifficulties) {
        throw new Error('Could not generate one fresh question per difficulty');
    }

    return sortByRequiredDifficulty(accepted);
}

// ─── POST /api/questions/generate ───────────────────────────────────────────

router.post('/api/questions/generate', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId || typeof userId !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'userId is required',
            });
        }

        const philosopher = resolvePhilosopher(req.body.philosopher);

        if (!philosopher) {
            return res.status(400).json({
                success: false,
                error: 'Invalid philosopher',
            });
        }

        const recent = await pool.query(
            `SELECT question_text, question_normalized
             FROM generated_questions
             WHERE user_id = $1 AND philosopher = $2
             ORDER BY generated_at DESC
             LIMIT $3`,
            [userId, philosopher, RECENT_EXCLUSION_COUNT]
        );

        const recentTexts = recent.rows.map(r => r.question_text).filter(Boolean);
        const recentNormalized = recent.rows.map(r => r.question_normalized).filter(Boolean);

        const accepted = await generateDifficultyLockedQuestions(
            philosopher,
            recentTexts,
            recentNormalized
        );

        const generationId = crypto.randomUUID();

        const saved = [];

        for (const q of accepted) {
            const insert = await pool.query(
                `INSERT INTO generated_questions
                     (generation_id, user_id, philosopher, question_text,
                      question_normalized, theme, difficulty, source, generated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai_generated', now())
                 RETURNING id`,
                [
                    generationId,
                    userId,
                    philosopher,
                    q.question,
                    normalizeText(q.question),
                    q.theme,
                    q.difficulty,
                ]
            );

            saved.push({
                id: insert.rows[0].id,
                question: q.question,
                theme: q.theme,
                difficulty: q.difficulty,
            });
        }

        const orderedSaved = sortByRequiredDifficulty(saved);

        console.log(
            `[Questions] Generated Beginner → Intermediate → Advanced for ${philosopher} ` +
            `(user ${userId.slice(0, 8)}…) | generation_id: ${generationId}`
        );

        return res.json({
            success: true,
            questions: orderedSaved,
        });
    } catch (err) {
        console.error('[Questions] generate error:', err.message);

        return res.status(500).json({
            success: false,
            error: 'Question generation failed. Please try again.',
        });
    }
});

// ─── PATCH /api/questions/:id/used ───────────────────────────────────────────

router.patch('/api/questions/:id/used', async (req, res) => {
    try {
        await pool.query(
            `UPDATE generated_questions
             SET used_at = now()
             WHERE id = $1 AND used_at IS NULL`,
            [req.params.id]
        );

        return res.json({ success: true });
    } catch (err) {
        console.error('[Questions] used error:', err.message);
        return res.status(500).json({ success: false });
    }
});

export default router;
